import { DependencyContainer, Lifecycle, instancePerContainerCachingFactory } from 'tsyringe';
import jsLogger, { Logger } from '@map-colonies/js-logger';
import { getOtelMixin } from '@map-colonies/telemetry';
import { HealthCheck } from '@godaddy/terminus';
import axios from 'axios';
import { Registry } from 'prom-client';
import { trace } from '@opentelemetry/api';
import { CleanupRegistry } from '@map-colonies/cleanup-registry';
import { DetilerClient } from '@map-colonies/detiler-client';
import { PgBoss } from 'pg-boss';
import {
  JOB_QUEUE_PROVIDER,
  MAP_PROVIDER,
  MAP_SPLITTER_PROVIDER,
  MAP_URL,
  QUEUE_NAME,
  SERVICES,
  SERVICE_NAME,
  TILES_STORAGE_PROVIDERS,
  TILES_STORAGE_LAYOUT,
  CONSUME_AND_PROCESS_FACTORY,
  MAP_FORMAT,
  MAP_PROVIDER_CONFIG,
  QUEUE_EMPTY_TIMEOUT,
  METRICS_BUCKETS,
  METRICS_REGISTRY,
  ON_SIGNAL,
  HEALTHCHECK,
} from './common/constants';
import { InjectionObject, registerDependencies } from './common/dependencyRegistration';
import { getTracing } from './common/tracing';
import { JobQueueProvider } from './retiler/interfaces';
import { PgBossJobQueueProvider } from './retiler/jobQueueProvider/pgBossJobQueue';
import { getPgBossHealthCheckFunction, pgBossFactory } from './retiler/jobQueueProvider/pgbossFactory';
import { ArcgisMapProvider } from './retiler/mapProvider/arcgis/arcgisMapProvider';
import { SharpMapSplitter } from './retiler/mapSplitterProvider/sharp';
import { consumeAndProcessFactory } from './app';
import { WmsMapProvider } from './retiler/mapProvider/wms/wmsMapProvider';
import { tilesStorageProvidersFactory } from './retiler/tilesStorageProvider/factory';
import { ConfigType, getConfig } from './common/config';

export interface RegisterOptions {
  override?: InjectionObject<unknown>[];
  useChild?: boolean;
}

export const registerExternalValues = async (options?: RegisterOptions): Promise<DependencyContainer> => {
  const cleanupRegistry = new CleanupRegistry();

  try {
    const dependencies: InjectionObject<unknown>[] = [
      {
        token: SERVICES.LOGGER,
        provider: {
          useFactory: instancePerContainerCachingFactory((container) => {
            const queueName = container.resolve<string>(QUEUE_NAME);
            const config = container.resolve<ConfigType>(SERVICES.CONFIG);
            const loggerConfig = config.get('telemetry.logger');
            const logger = jsLogger({ ...loggerConfig, mixin: getOtelMixin(), base: { queue: queueName } });
            const cleanupRegistryLogger = logger.child({ subComponent: 'cleanupRegistry' });
            cleanupRegistry.on('itemFailed', (id, error, msg) => cleanupRegistryLogger.error({ msg, itemId: id, err: error }));
            cleanupRegistry.on('finished', (status) => cleanupRegistryLogger.info({ msg: `cleanup registry finished cleanup`, status }));
            return logger;
          }),
        },
      },
      {
        token: SERVICES.CLEANUP_REGISTRY,
        provider: { useValue: cleanupRegistry },
        afterAllInjectionHook(container): void {
          const logger = container.resolve<Logger>(SERVICES.LOGGER);
          const cleanupRegistryLogger = logger.child({ subComponent: 'cleanupRegistry' });

          cleanupRegistry.on('itemFailed', (id, error, msg) => cleanupRegistryLogger.error({ msg, itemId: id, err: error }));
          cleanupRegistry.on('itemCompleted', (id) => cleanupRegistryLogger.info({ itemId: id, msg: 'cleanup finished for item' }));
          cleanupRegistry.on('finished', (status) => cleanupRegistryLogger.info({ msg: `cleanup registry finished cleanup`, status }));
        },
      },
      { token: SERVICES.CONFIG, provider: { useValue: getConfig() } },
      {
        token: SERVICES.TRACER,
        provider: {
          useFactory: instancePerContainerCachingFactory((container) => {
            const tracer = trace.getTracer(SERVICE_NAME);
            const tracing = getTracing();
            const cleanupRegistry = container.resolve<CleanupRegistry>(SERVICES.CLEANUP_REGISTRY);
            cleanupRegistry.register({ func: tracing.stop.bind(tracing), id: SERVICES.TRACER });
            return tracer;
          }),
        },
      },
      {
        token: METRICS_REGISTRY,
        provider: {
          useFactory: instancePerContainerCachingFactory((container) => {
            const config = container.resolve<ConfigType>(SERVICES.CONFIG);
            const metrics = config.get('telemetry.metrics') as { enabled?: boolean } | undefined;

            if (metrics?.enabled === true) {
              const metricsRegistry = new Registry();
              config.initializeMetrics(metricsRegistry);
              return metricsRegistry;
            }
          }),
        },
      },
      {
        token: SERVICES.PGBOSS,
        provider: {
          useFactory: instancePerContainerCachingFactory((container) => {
            const config = container.resolve<ConfigType>(SERVICES.CONFIG);
            const pgBossConfig = config.get('app.jobQueue.pgBoss');
            const projectName = config.get('app.project.name');
            return pgBossFactory({ ...pgBossConfig, projectName });
          }),
        },
      },
      {
        token: QUEUE_NAME,
        provider: {
          useFactory: instancePerContainerCachingFactory((container) => {
            const config = container.resolve<ConfigType>(SERVICES.CONFIG);
            return config.get('app.queueName');
          }),
        },
      },
      {
        token: QUEUE_EMPTY_TIMEOUT,
        provider: {
          useFactory: instancePerContainerCachingFactory((container) => {
            const config = container.resolve<ConfigType>(SERVICES.CONFIG);
            return config.get('app.jobQueue.waitTimeout');
          }),
        },
      },
      {
        token: JOB_QUEUE_PROVIDER,
        provider: { useClass: PgBossJobQueueProvider },
        options: { lifecycle: Lifecycle.Singleton },
        postInjectionHook: async (deps: DependencyContainer): Promise<void> => {
          const provider = deps.resolve<JobQueueProvider>(JOB_QUEUE_PROVIDER);
          cleanupRegistry.register({ func: provider.stopQueue.bind(provider), id: JOB_QUEUE_PROVIDER });
          await provider.startQueue();
        },
      },
      {
        token: METRICS_BUCKETS,
        provider: {
          useFactory: instancePerContainerCachingFactory((container) => {
            const config = container.resolve<ConfigType>(SERVICES.CONFIG);
            return config.get('telemetry.metrics.buckets');
          }),
        },
      },
      {
        token: SERVICES.HTTP_CLIENT,
        provider: {
          useFactory: instancePerContainerCachingFactory((container) => {
            const config = container.resolve<ConfigType>(SERVICES.CONFIG);

            const mapClientTimeout = config.get('app.map.client.timeoutMs');
            return axios.create({ timeout: mapClientTimeout });
          }),
        },
      },
      {
        token: MAP_URL,
        provider: {
          useFactory: instancePerContainerCachingFactory((container) => {
            const config = container.resolve<ConfigType>(SERVICES.CONFIG);
            return config.get('app.map.url');
          }),
        },
      },
      {
        token: MAP_FORMAT,
        provider: {
          useFactory: instancePerContainerCachingFactory((container) => {
            const config = container.resolve<ConfigType>(SERVICES.CONFIG);
            return config.get('app.map.format');
          }),
        },
      },
      {
        token: TILES_STORAGE_LAYOUT,
        provider: {
          useFactory: instancePerContainerCachingFactory((container) => {
            const config = container.resolve<ConfigType>(SERVICES.CONFIG);
            return config.get('app.tilesStorage.layout');
          }),
        },
      },
      { token: MAP_SPLITTER_PROVIDER, provider: { useClass: SharpMapSplitter } },
      {
        token: MAP_PROVIDER_CONFIG,
        provider: {
          useFactory: instancePerContainerCachingFactory((container) => {
            const config = container.resolve<ConfigType>(SERVICES.CONFIG);
            return config.get('app.map.wms');
          }),
        },
        postInjectionHook: async (container): Promise<void> => {
          const config = container.resolve<ConfigType>(SERVICES.CONFIG);
          const mapProviderType = config.get('app.map.provider');

          if (mapProviderType === 'wms') {
            container.register(MAP_PROVIDER, { useClass: WmsMapProvider });
          } else {
            container.register(MAP_PROVIDER, { useClass: ArcgisMapProvider });
          }
          return Promise.resolve();
        },
      },
      { token: TILES_STORAGE_PROVIDERS, provider: { useFactory: instancePerContainerCachingFactory(tilesStorageProvidersFactory) } },
      { token: CONSUME_AND_PROCESS_FACTORY, provider: { useFactory: consumeAndProcessFactory } },
      {
        token: ON_SIGNAL,
        provider: {
          useFactory: instancePerContainerCachingFactory((container) => {
            const cleanupRegistry = container.resolve<CleanupRegistry>(SERVICES.CLEANUP_REGISTRY);
            return cleanupRegistry.trigger.bind(cleanupRegistry);
          }),
        },
      },
      {
        token: SERVICES.DETILER,
        provider: {
          useFactory: instancePerContainerCachingFactory((container) => {
            const config = container.resolve<ConfigType>(SERVICES.CONFIG);
            const detilerConfig = config.get('detiler');
            if (detilerConfig.enabled) {
              const logger = container.resolve<Logger>(SERVICES.LOGGER);
              const detiler = new DetilerClient({ ...detilerConfig.client, logger: logger.child({ subComponent: 'detiler' }) });
              return detiler;
            }
          }),
        },
      },
      {
        token: HEALTHCHECK,
        provider: {
          useFactory: (depContainer): HealthCheck => {
            const pgboss = depContainer.resolve<PgBoss>(SERVICES.PGBOSS);
            const config = depContainer.resolve<ConfigType>(SERVICES.CONFIG);
            const timeoutMs = config.get('app.jobQueue.pgBoss.healthCheckTimeoutMs');
            return getPgBossHealthCheckFunction(pgboss, timeoutMs);
          },
        },
      },
    ];

    const container = await registerDependencies(dependencies, options?.override, options?.useChild);
    return container;
  } catch (error) {
    await cleanupRegistry.trigger();
    throw error;
  }
};
