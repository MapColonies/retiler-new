// this import must be called before the first import of tsyringe
import 'reflect-metadata';
import { createServer } from 'node:http';
import express from 'express';
import { Registry } from 'prom-client';
import { Logger } from '@map-colonies/js-logger';
import { DependencyContainer } from 'tsyringe';
import { CleanupRegistry } from '@map-colonies/cleanup-registry';
import { collectMetricsExpressMiddleware } from '@map-colonies/telemetry/prom-metrics';
import { createTerminus, HealthCheck } from '@godaddy/terminus';
import { CONSUME_AND_PROCESS_FACTORY, ExitCodes, HEALTHCHECK, METRICS_REGISTRY, ON_SIGNAL, SERVICES } from './common/constants';
import { registerExternalValues } from './containerConfig';
import { ConfigType } from './common/config';

let depContainer: DependencyContainer | undefined;

void registerExternalValues()
  .then(async (container) => {
    depContainer = container;

    const config = container.resolve<ConfigType>(SERVICES.CONFIG);
    const cleanupRegistry = container.resolve<CleanupRegistry>(SERVICES.CLEANUP_REGISTRY);
    const registry = container.resolve<Registry>(METRICS_REGISTRY);
    const healthCheck = container.resolve<HealthCheck>(HEALTHCHECK);

    const app = express();

    app.use(
      '/metrics',
      collectMetricsExpressMiddleware({
        registry,
        labels: {
          project: config.get('app.project.name'),
        },
      })
    );

    const server = createTerminus(createServer(app), { healthChecks: { '/liveness': healthCheck }, onSignal: container.resolve(ON_SIGNAL) });

    cleanupRegistry.register({
      func: async () => {
        return new Promise((resolve) => {
          server.once('close', resolve);
          server.close();
        });
      },
    });

    const port = config.get('server.port');

    const logger = container.resolve<Logger>(SERVICES.LOGGER);

    server.listen(port, () => {
      logger.debug(`liveness on port ${port}`);
    });

    const consumeAndProcess = container.resolve<() => Promise<void>>(CONSUME_AND_PROCESS_FACTORY);
    await consumeAndProcess();
  })
  .catch(async (error: Error) => {
    const errorLogger =
      depContainer?.isRegistered(SERVICES.LOGGER) == true
        ? depContainer.resolve<Logger>(SERVICES.LOGGER).error.bind(depContainer.resolve<Logger>(SERVICES.LOGGER))
        : console.error;
    errorLogger({ msg: 'an unexpected error occurred', err: error });

    if (depContainer?.isRegistered(ON_SIGNAL) === true) {
      const shutDown: () => Promise<void> = depContainer.resolve(ON_SIGNAL);
      await shutDown();
    }

    process.exit(ExitCodes.GENERAL_ERROR);
  });
