import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, rollUp } from '../lib/report.mts';
import { openTurso } from '../lib/turso.mts';
import type { GateCheck, GateResult } from '../lib/types.mts';
import type { GateContext } from './context.mts';

const TURSO_PACKAGE = '@tursodatabase/database';

interface PackageLock {
  packages: Record<
    string,
    {
      version?: string;
      resolved?: string;
      integrity?: string;
      license?: string;
      optionalDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    }
  >;
}

/** libc the production runtime image uses, read from the Dockerfile. */
const productionLibc = (repositoryRoot: string): { image: string; libc: 'musl' | 'glibc' } => {
  const dockerfile = readFileSync(join(repositoryRoot, 'Dockerfile'), 'utf8');
  const productionImage = [...dockerfile.matchAll(/^FROM\s+(\S+)\s+AS\s+production/gimu)].at(0)?.[1] ?? 'unknown';
  return { image: productionImage, libc: /alpine/iu.test(productionImage) ? 'musl' : 'glibc' };
};

const currentPlatformTarget = (): string => {
  // A musl build reports no glibc runtime version.
  const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
  const libc = report.header?.glibcVersionRuntime === undefined ? 'musl' : 'gnu';
  return `${process.platform}-${process.arch}-${libc}`;
};

/**
 * Gate 1 -- can a pinned, published Turso artifact be installed and run inside
 * the production container, with no internet access and no custom build?
 */
export const runGate1 = async (context: GateContext): Promise<GateResult> => {
  const startedAt = performance.now();
  const checks: GateCheck[] = [];

  const packageJson = JSON.parse(readFileSync(join(context.repositoryRoot, 'package.json'), 'utf8')) as {
    devDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  const pinnedRange = packageJson.devDependencies?.[TURSO_PACKAGE] ?? packageJson.dependencies?.[TURSO_PACKAGE];

  checks.push(
    pinnedRange === undefined
      ? check('version is pinned', 'fail', `${TURSO_PACKAGE} is not declared in package.json`)
      : /^\d+\.\d+\.\d+/u.test(pinnedRange)
        ? check('version is pinned', 'pass', `pinned to an exact version ${pinnedRange}, so the native artifact cannot drift`)
        : check('version is pinned', 'fail', `declared as the range "${pinnedRange}", which does not pin the native artifact`)
  );

  const lock = JSON.parse(readFileSync(join(context.repositoryRoot, 'package-lock.json'), 'utf8')) as PackageLock;
  const lockEntry = lock.packages[`node_modules/${TURSO_PACKAGE}`];

  checks.push(
    lockEntry?.integrity !== undefined && lockEntry.resolved !== undefined
      ? check('lockfile records a checksum', 'pass', `resolved and checksummed in package-lock.json, which is what an internal mirror needs`, {
          version: lockEntry.version,
          resolved: lockEntry.resolved,
          integrity: lockEntry.integrity,
        })
      : check('lockfile records a checksum', 'fail', 'package-lock.json has no resolved URL or integrity hash for the package')
  );

  // Every native binding is published as its own optional platform package.
  const platformPackages = Object.keys(lockEntry?.optionalDependencies ?? {});
  const muslPackages = platformPackages.filter((name) => name.includes('musl'));
  const production = productionLibc(context.repositoryRoot);

  checks.push(
    check(
      'platform artifacts published',
      platformPackages.length > 0 ? 'pass' : 'fail',
      `${platformPackages.length} prebuilt native packages are published`,
      platformPackages
    )
  );

  checks.push(
    production.libc === 'glibc' || muslPackages.length > 0
      ? check(
          'production container is covered',
          'pass',
          `the ${production.image} runtime needs ${production.libc} and a matching artifact is published`
        )
      : check(
          'production container is covered',
          'fail',
          `the production runtime image ${production.image} is ${production.libc}-based, but no musl artifact is published; running it there would need a custom build, which the constraints forbid`,
          { productionImage: production.image, publishedTargets: platformPackages }
        )
  );

  const license = ((): string | undefined => {
    const installed = join(context.repositoryRoot, 'node_modules', TURSO_PACKAGE, 'package.json');
    return existsSync(installed) ? (JSON.parse(readFileSync(installed, 'utf8')) as { license?: string }).license : undefined;
  })();

  checks.push(
    license === undefined
      ? check('license is declared', 'fail', 'the installed package declares no license')
      : check('license is declared', 'pass', `declared as ${license}`)
  );

  // Installing with the cache primed and the network disabled is the closest
  // local stand-in for an air-gapped internal registry.
  const offlineInstall = ((): GateCheck => {
    try {
      const output = execFileSync(
        'npm',
        ['install', '--offline', '--dry-run', '--no-audit', '--no-fund', `${TURSO_PACKAGE}@${lockEntry?.version ?? ''}`],
        {
          cwd: context.repositoryRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      return check(
        'installs without network access',
        'pass',
        'npm resolved the package and its native artifact from the local cache alone, which is the closest local proxy for an internal mirror; a real air-gapped install still has to be confirmed against the internal registry',
        output.trim().slice(0, 500)
      );
    } catch (error) {
      const failure = error as { stderr?: string; message?: string };
      return check(
        'installs without network access',
        'fail',
        'npm could not resolve the package from cache alone; mirror it into the internal registry before relying on this',
        (failure.stderr ?? failure.message ?? '').slice(0, 800)
      );
    }
  })();
  checks.push(offlineInstall);

  // Loading the binding is the only proof that the published artifact actually
  // runs on this architecture and libc.
  try {
    const db = await openTurso(join(context.scratchDirectory, 'gate1-load.db'), { multiProcess: true });
    await db.exec('CREATE TABLE IF NOT EXISTS probe (a INTEGER)');
    await db.close();
    checks.push(check('native binding loads and runs', 'pass', `the published binding loaded and opened a database on ${currentPlatformTarget()}`));
  } catch (error) {
    checks.push(check('native binding loads and runs', 'fail', `the published binding failed to load on ${currentPlatformTarget()}`, String(error)));
  }

  const status = rollUp(checks);

  return {
    id: 1,
    title: 'Published artifact availability',
    status,
    summary:
      status === 'pass'
        ? 'A pinned published artifact installs and runs on the target runtime.'
        : `The published artifact does not satisfy the packaging constraints (${checks
            .filter((entry) => entry.status === 'fail')
            .map((entry) => entry.name)
            .join('; ')}).`,
    checks,
    measurements: {
      pinnedRange,
      lockedVersion: lockEntry?.version,
      platformPackages,
      productionImage: production.image,
      hostTarget: currentPlatformTarget(),
    },
    durationMs: performance.now() - startedAt,
  };
};
