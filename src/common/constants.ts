import { readPackageJsonSync } from '@map-colonies/read-pkg';

export const SERVICE_NAME = readPackageJsonSync().name ?? 'unknown_service';
export const DEFAULT_SERVER_PORT = 80;

export const IGNORED_OUTGOING_TRACE_ROUTES = [/^.*\/v1\/metrics.*$/, /^.*\/v1\/traces.*$/];
export const IGNORED_INCOMING_TRACE_ROUTES = [/^.*\/docs.*$/, /^.*\/liveness.*$/, /^.*\/metrics.*$/];

export const ON_SIGNAL = Symbol('onSignal');

export const JOB_QUEUE_PROVIDER = Symbol('JobsQueueProvider');
export const MAP_PROVIDER = Symbol('MapProvider');
export const MAP_SPLITTER_PROVIDER = Symbol('MapSplitterProvider');
export const TILES_STORAGE_PROVIDERS = Symbol('TilesStorageProviders');
export const METRICS_BUCKETS = Symbol('metrics_buckets');

export const CONSUME_AND_PROCESS_FACTORY = Symbol('ConsumeAndProcessFactory');
export const LIVENESS_PROBE_FACTORY = Symbol('LivenessProbeFactory');

export const QUEUE_NAME = Symbol('QueueName');
export const QUEUE_EMPTY_TIMEOUT = Symbol('QueueTimeout');
export const METRICS_REGISTRY = Symbol('MetricsRegistry');

export const MAP_URL = Symbol('MapURL');
export const MAP_FORMAT = Symbol('MapFormat');
export const MAP_PROVIDER_CONFIG = Symbol('MapProviderConfig');

export const S3_BUCKET = Symbol('S3Bucket');
export const TILES_STORAGE_LAYOUT = Symbol('TilesStorageLayout');
export const HEALTHCHECK = Symbol('HealthCheck');
export const getServiceIdentifier = (projectName: string): string => `${SERVICE_NAME}-${projectName}`;
export const buildApplicationName = (projectName?: string): string =>
  `${SERVICE_NAME}-${projectName ?? 'unknown_env'}-${process.env.NODE_ENV ?? 'unknown_env'}`;

export const TILE_SIZE = 256;

/* eslint-disable @typescript-eslint/naming-convention */
export const SERVICES = {
  LOGGER: Symbol('Logger'),
  CONFIG: Symbol('Config'),
  TRACER: Symbol('Tracer'),
  METER: Symbol('Meter'),
  S3: Symbol('S3'),
  HTTP_CLIENT: Symbol('HttpClient'),
  CLEANUP_REGISTRY: Symbol('CleanupRegistry'),
  DETILER: Symbol('Detiler'),
  PGBOSS: Symbol('Pgboss'),
} satisfies Record<string, symbol>;

export const ExitCodes: Record<string, number> = {
  SUCCESS: 0,
  GENERAL_ERROR: 1,
};
/* eslint-enable @typescript-eslint/naming-convention */

export const MILLISECONDS_IN_SECOND = 1000;

export const TIMESTAMP_REGEX = /timestamp=\d{4}-\d{2}-\d{2}T\d{2}\\?:\d{2}\\?:\d{2}Z/;
