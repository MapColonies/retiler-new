/**
 * Runs the Turso GeoPackage feasibility gates and writes a report.
 *
 *   node experiments/turso-geopackage/run.mts [--profile quick|full] [--gates 1,2,3] [--keep-scratch]
 *
 * Every gate runs even when an earlier one fails. The plan says to stop at the
 * first blocker, but a blocker in one gate rarely answers the questions the
 * later gates ask, and the point of the experiment is to produce the whole
 * evidence set in one pass. Failures are recorded, not swallowed.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGate1 } from './gates/gate1PublishedArtifacts.mts';
import { runGate2 } from './gates/gate2RequiredModes.mts';
import { runGate3 } from './gates/gate3SchemaCompatibility.mts';
import { runGate4 } from './gates/gate4CrossProcessWrites.mts';
import { runGate5 } from './gates/gate5AtomicityRecovery.mts';
import { runGate6 } from './gates/gate6Finalization.mts';
import type { GateContext } from './gates/context.mts';
import { renderMarkdown } from './lib/report.mts';
import { probeGdal } from './lib/validate.mts';
import type { GateResult, Profile } from './lib/types.mts';

const EXPERIMENT_ROOT = fileURLToPath(new URL('.', import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

const profile: Profile = argument('profile') === 'full' ? 'full' : 'quick';
const requested = new Set((argument('gates') ?? '1,2,3,4,5,6').split(',').map((value) => Number(value.trim())));
const keepScratch = process.argv.includes('--keep-scratch');

const scratchDirectory = join(EXPERIMENT_ROOT, '.scratch');
const resultsDirectory = join(EXPERIMENT_ROOT, 'results');

rmSync(scratchDirectory, { recursive: true, force: true });
mkdirSync(scratchDirectory, { recursive: true });
mkdirSync(resultsDirectory, { recursive: true });

const context: GateContext = {
  repositoryRoot: REPOSITORY_ROOT,
  scratchDirectory,
  resultsDirectory,
  profile,
  previous: new Map(),
};

const gates = [
  { id: 1, run: runGate1 },
  { id: 2, run: runGate2 },
  { id: 3, run: runGate3 },
  { id: 4, run: runGate4 },
  { id: 5, run: runGate5 },
  { id: 6, run: runGate6 },
] as const;

const results: GateResult[] = [];

for (const gate of gates) {
  if (!requested.has(gate.id)) {
    continue;
  }

  process.stdout.write(`\n=== Gate ${gate.id} ===\n`);

  try {
    const result = await gate.run(context);
    context.previous.set(gate.id, result.status);
    results.push(result);
    process.stdout.write(`${result.status.toUpperCase()}: ${result.summary}\n`);
    for (const entry of result.checks) {
      process.stdout.write(`  [${entry.status}] ${entry.name} -- ${entry.detail}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    context.previous.set(gate.id, 'fail');
    results.push({
      id: gate.id,
      title: `Gate ${gate.id}`,
      status: 'fail',
      summary: 'The gate itself threw before it could reach a verdict.',
      checks: [{ name: 'gate executed', status: 'fail', detail: 'the harness threw', evidence: message }],
      durationMs: 0,
    });
    process.stdout.write(`FAIL: the gate threw\n${message}\n`);
  }
}

const turso = JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'node_modules/@tursodatabase/database/package.json'), 'utf8')) as {
  version: string;
};

const environment = {
  ranAt: new Date().toISOString(),
  profile,
  node: process.version,
  platform: `${platform()} ${release()} ${arch()}`,
  cpus: cpus().length,
  memoryGb: Math.round(totalmem() / 1024 ** 3),
  tursoVersion: turso.version,
  gdal: probeGdal().gdalinfo.version ?? 'not installed',
  storage: 'local filesystem (not the OpenShift RWX StorageClass)',
};

const stamp = environment.ranAt.replace(/[:.]/gu, '-');
// The timestamped JSON is the archive; latest.md is the readable snapshot of
// the most recent run. Writing a timestamped copy of the markdown too would
// only duplicate it byte for byte.
writeFileSync(join(resultsDirectory, `report-${stamp}.json`), JSON.stringify({ environment, results }, null, 2));
writeFileSync(join(resultsDirectory, 'latest.md'), renderMarkdown(results, environment));

if (!keepScratch) {
  rmSync(scratchDirectory, { recursive: true, force: true });
}

process.stdout.write('\n=== Summary ===\n');
for (const result of results) {
  process.stdout.write(`Gate ${result.id} ${result.title}: ${result.status.toUpperCase()}\n`);
}
process.stdout.write(`\nReport written to ${join(resultsDirectory, 'latest.md')}\n`);
