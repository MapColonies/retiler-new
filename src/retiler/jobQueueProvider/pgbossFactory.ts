import { readFileSync } from 'fs';
import { PgBoss, type ConstructorOptions } from 'pg-boss';
import { type HealthCheck } from '@godaddy/terminus';
import { type vectorRetilerV2Type } from '@map-colonies/schemas';
import { SERVICE_NAME } from '../../common/constants';

export const createDatabaseOptions = (dbConfig: PgBossConfig): ConstructorOptions => {
  const { ssl, ...databaseOptions } = dbConfig;

  const poolConfig: ConstructorOptions = {
    ...databaseOptions,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    application_name: `${SERVICE_NAME}-${dbConfig.projectName ?? 'unknown_env'}-${process.env.NODE_ENV ?? 'unknown_env'}`,
    user: dbConfig.username,
    password: dbConfig.password,
  };

  if (ssl.enabled) {
    delete poolConfig.password;
    try {
      poolConfig.ssl = {
        key: readFileSync(ssl.key),
        cert: readFileSync(ssl.cert),
        ca: ssl.ca ? readFileSync(ssl.ca) : undefined,
      };
    } catch (error) {
      throw new Error(`Failed to load SSL certificates. Ensure the files exist and are accessible. Details: ${(error as Error).message}`);
    }
  } else {
    poolConfig.ssl = false;
  }

  return poolConfig;
};

export type PgBossConfig = vectorRetilerV2Type['app']['jobQueue']['pgBoss'] & { projectName?: string };
export type PgBossFactoryOptions = PgBossConfig & Partial<ConstructorOptions>;

export const pgBossFactory = (bossConfig: PgBossFactoryOptions): PgBoss => {
  const databaseOptions = createDatabaseOptions(bossConfig);
  const supervise = !bossConfig.noSupervisor;
  return new PgBoss({ ...bossConfig, ...databaseOptions, supervise, schedule: false });
};

export const getPgBossHealthCheckFunction = (boss: PgBoss, pgbossTimeoutMs: number): HealthCheck => {
  return async (): Promise<void> => {
    const check = boss
      .getDb()
      .executeSql('SELECT 1')
      .then(() => undefined);
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`pg-boss health check timed out after ${pgbossTimeoutMs}ms`)), pgbossTimeoutMs)
    );
    await Promise.race([check, timeout]);
  };
};
