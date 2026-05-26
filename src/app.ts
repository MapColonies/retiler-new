import { Logger } from '@map-colonies/js-logger';
import { FactoryFunction } from 'tsyringe';
import { JOB_QUEUE_PROVIDER, SERVICES, TILES_STORAGE_PROVIDERS } from './common/constants';
import { timerify } from './common/util';
import { JobQueueProvider, TilesStorageProvider } from './retiler/interfaces';
import { TileProcessor } from './retiler/tileProcessor';
import { TileWithMetadata } from './retiler/types';
import { ConfigType } from './common/config';

export const consumeAndProcessFactory: FactoryFunction<() => Promise<void>> = (container) => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- used for tiles storage providers factory initialization before the tiles processor
  const tilesStorageProviders = container.resolve<TilesStorageProvider[]>(TILES_STORAGE_PROVIDERS);
  const processor = container.resolve(TileProcessor);
  const queueProv = container.resolve<JobQueueProvider>(JOB_QUEUE_PROVIDER);
  const logger = container.resolve<Logger>(SERVICES.LOGGER);
  const config = container.resolve<ConfigType>(SERVICES.CONFIG);
  const parallelism = config.get('app.parallelism');

  const consumeAndProcess = async (): Promise<void> => {
    await queueProv.consumeQueue<TileWithMetadata>(async (tile, jobId) => {
      const { parent, ...baseTile } = tile;

      logger.info({ msg: 'started processing tile', jobId, tile: baseTile, parent, parallelism });

      const [, duration] = await timerify(processor.processTile.bind(processor), tile);

      logger.info({ msg: 'processing tile completed successfully', jobId, duration, tile: baseTile, parent, parallelism });
    }, parallelism);
  };

  return consumeAndProcess;
};
