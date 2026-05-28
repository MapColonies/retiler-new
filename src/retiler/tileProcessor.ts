import { Registry, Counter, Histogram } from 'prom-client';
import { type Logger } from '@map-colonies/js-logger';
import { type IDetilerClient } from '@map-colonies/detiler-client';
import { inject, injectable } from 'tsyringe';
import { type AxiosInstance } from 'axios';
import { TILEGRID_WORLD_CRS84, tileToBoundingBox } from '@map-colonies/tile-calc';
import { type Tracer, type Span, type Attributes, SpanStatusCode } from '@opentelemetry/api';
import { type ConfigType } from '@src/common/config';
import { jobAttributes, spanName } from '@src/common/tracing/job';
import { IProjectConfig } from '../common/interfaces';
import { fetchTimestampValue, timestampToUnix } from '../common/util';
import {
  MAP_PROVIDER,
  MAP_SPLITTER_PROVIDER,
  METRICS_BUCKETS,
  METRICS_REGISTRY,
  MILLISECONDS_IN_SECOND,
  SERVICES,
  TILES_STORAGE_PROVIDERS,
} from '../common/constants';
import { endMetricTimer, MetatileStatus, ProcessKind, ProcessReason, ProcessSkipReason, SubTileStatus } from '../common/metrics';
import { type MapProvider, type MapSplitterProvider, type TilesStorageProvider } from './interfaces';
import { TileWithMetadata } from './types';

interface PreProcessReult {
  shouldSkipProcessing: boolean;
  reason?: ProcessReason | ProcessSkipReason;
}

@injectable()
export class TileProcessor {
  private readonly project: IProjectConfig;
  private readonly forceProcess: boolean;
  private readonly shouldFilterBlankTiles: boolean;
  private readonly detilerProceedOnFailure: boolean;

  private readonly tilesCounter?: Counter<'status' | 'z'>;
  private readonly subTilesCounter?: Counter<'status' | 'z'>;
  private readonly preProcessResultsCounter?: Counter<'result' | 'z'>;
  private readonly tilesDurationHistogram?: Histogram<'z' | 'kind'>;

  public constructor(
    @inject(SERVICES.LOGGER) private readonly logger: Logger,
    @inject(SERVICES.TRACER) private readonly tracer: Tracer,
    @inject(MAP_PROVIDER) private readonly mapProvider: MapProvider,
    @inject(MAP_SPLITTER_PROVIDER) private readonly mapSplitter: MapSplitterProvider,
    @inject(TILES_STORAGE_PROVIDERS) private readonly tilesStorageProviders: TilesStorageProvider[],
    @inject(SERVICES.HTTP_CLIENT) private readonly axiosClient: AxiosInstance,
    @inject(SERVICES.CONFIG) private readonly config: ConfigType,
    @inject(SERVICES.DETILER) private readonly detiler?: IDetilerClient,
    @inject(METRICS_REGISTRY) registry?: Registry,
    @inject(METRICS_BUCKETS) metricsBuckets?: number[]
  ) {
    this.project = this.config.get('app.project');
    this.forceProcess = this.config.get('app.forceProcess');
    this.shouldFilterBlankTiles = this.config.get('app.tilesStorage.shouldFilterBlankTiles');
    this.detilerProceedOnFailure = this.config.get('detiler.proceedOnFailure');

    if (registry !== undefined) {
      this.tilesDurationHistogram = new Histogram({
        name: 'retiler_action_duration_seconds',
        help: 'Retiler action duration by kind, one of fetch, slice or store.',
        buckets: metricsBuckets,
        labelNames: ['kind', 'z'] as const,
        registers: [registry],
      });

      this.tilesCounter = new Counter({
        name: 'retiler_tiles_count',
        help: 'The total number of tiles processed',
        labelNames: ['status', 'z'] as const,
        registers: [registry],
      });

      this.preProcessResultsCounter = new Counter({
        name: 'retiler_pre_process_results_count',
        help: 'The results of the pre process',
        labelNames: ['result', 'z'] as const,
        registers: [registry],
      });

      this.subTilesCounter = new Counter({
        name: 'retiler_sub_tiles_count',
        help: 'The total number sub tiles processed or filtered',
        labelNames: ['status', 'z'] as const,
        registers: [registry],
      });
    }
  }

  public async processTile(tile: TileWithMetadata): Promise<void> {
    return this.withSpan(
      spanName.TILE_PROCESS,
      {
        [jobAttributes.TILE_Z]: tile.z,
        [jobAttributes.TILE_X]: tile.x,
        [jobAttributes.TILE_Y]: tile.y,
        [jobAttributes.TILE_METATILE]: tile.metatile,
        [jobAttributes.TILE_FORCE]: tile.force ?? false,
        [jobAttributes.TILE_STATE]: tile.state,
        [jobAttributes.MAP_PROVIDER]: this.config.get('app.map.provider'),
      },
      async (span) => {
        try {
          const preRenderTimestamp = Math.floor(Date.now() / MILLISECONDS_IN_SECOND);

          const { shouldSkipProcessing, reason } = await this.withSpan(spanName.TILE_PREPROCESS, {}, async (innerSpan) => {
            const result = await this.preProcess(tile, preRenderTimestamp);
            innerSpan.setAttribute(jobAttributes.TILE_SKIP_REASON, result.reason ?? '');
            return result;
          });

          if (shouldSkipProcessing) {
            span.setAttribute(jobAttributes.TILE_STATUS, MetatileStatus.SKIPPED);
            span.setAttribute(jobAttributes.TILE_SKIP_REASON, reason ?? '');
            this.tilesCounter?.inc({ status: MetatileStatus.SKIPPED, z: tile.z });
            return;
          }

          const fetchTimerEnd = this.tilesDurationHistogram?.startTimer({ kind: ProcessKind.FETCH, z: tile.z });
          const mapBuffer = await this.withSpan(spanName.TILE_FETCH, {}, async () => this.mapProvider.getMap(tile));
          endMetricTimer(fetchTimerEnd);

          const splitTimerEnd = this.tilesDurationHistogram?.startTimer({ kind: ProcessKind.SPLIT });
          const { splittedTiles, isMetatileBlank, blankTiles, outOfBoundsCount } = await this.withSpan(spanName.TILE_SPLIT, {}, async (innerSpan) => {
            const result = await this.mapSplitter.splitMap({ ...tile, buffer: mapBuffer }, this.shouldFilterBlankTiles);
            innerSpan.setAttributes({
              [jobAttributes.TILES_STORED_COUNT]: result.splittedTiles.length,
              [jobAttributes.TILES_BLANK_COUNT]: result.blankTiles.length,
              [jobAttributes.TILES_OUT_OF_BOUNDS_COUNT]: result.outOfBoundsCount,
            });
            return result;
          });
          endMetricTimer(splitTimerEnd);

          if (splittedTiles.length > 0) {
            this.logger.debug({ msg: 'storing tiles', count: splittedTiles.length, providersCount: this.tilesStorageProviders.length });

            const storeTimerEnd = this.tilesDurationHistogram?.startTimer({ kind: ProcessKind.STORE });
            await this.withSpan(spanName.TILE_STORE, { [jobAttributes.TILES_STORED_COUNT]: splittedTiles.length }, async (innerSpan) => {
              try {
                await Promise.all(
                  this.tilesStorageProviders.map(async (tilesStorageProv) =>
                    tilesStorageProv.storeTiles(splittedTiles.map((subTile) => structuredClone(subTile)))
                  )
                );
              } catch {
                innerSpan.addEvent('batch failed, retrying per-tile to identify failure');
                for (const subTile of splittedTiles) {
                  await this.withSpan('tile.store.single', { 'tile.x': subTile.x, 'tile.y': subTile.y, 'tile.z': subTile.z }, async () => {
                    await Promise.all(
                      this.tilesStorageProviders.map(async (tilesStorageProv) => tilesStorageProv.storeTiles([structuredClone(subTile)]))
                    );
                  });
                }
                throw new Error('batch store failed');
              }
            });
            endMetricTimer(storeTimerEnd);
          }

          if (blankTiles.length > 0) {
            this.logger.debug({ msg: 'deleting tiles', count: blankTiles.length, providersCount: this.tilesStorageProviders.length });

            const deleteTimerEnd = this.tilesDurationHistogram?.startTimer({ kind: ProcessKind.DELETE });
            await this.withSpan(
              spanName.TILE_DELETE,
              {
                [jobAttributes.TILES_BLANK_COUNT]: blankTiles.length,
                [jobAttributes.TILE_Z]: tile.z,
                [jobAttributes.TILE_X]: tile.x,
                [jobAttributes.TILE_Y]: tile.y,
              },
              async () => {
                await Promise.all(
                  this.tilesStorageProviders.map(async (tilesStorageProv) => tilesStorageProv.deleteTiles(structuredClone(blankTiles)))
                );
              }
            );
            endMetricTimer(deleteTimerEnd);
          }

          await this.withSpan(spanName.TILE_POSTPROCESS, {}, async () => this.postProcess(tile, preRenderTimestamp));

          this.tilesCounter?.inc({ status: MetatileStatus.COMPLETED, z: tile.z });

          if (isMetatileBlank) {
            this.tilesCounter?.inc({ status: MetatileStatus.BLANK, z: tile.z });
          }

          this.subTilesCounter?.inc({ status: SubTileStatus.STORED, z: tile.z }, splittedTiles.length);
          this.subTilesCounter?.inc({ status: SubTileStatus.BLANK, z: tile.z }, blankTiles.length);
          this.subTilesCounter?.inc({ status: SubTileStatus.OUT_OF_BOUNDS, z: tile.z }, outOfBoundsCount);
        } catch (error) {
          this.tilesCounter?.inc({ status: MetatileStatus.FAILED, z: tile.z });
          throw error;
        }
      }
    );
  }

  private async withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
    return this.tracer.startActiveSpan(name, { attributes }, async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        if (error instanceof Error) span.recordException(error);
        throw error;
      } finally {
        span.end();
      }
    });
  }

  private async preProcess(tile: TileWithMetadata, timestamp: number): Promise<PreProcessReult> {
    let preProcessTimerEnd;
    let result: PreProcessReult = { shouldSkipProcessing: false };

    try {
      // check for forced rendering or if detiler option is off
      const isForced = this.forceProcess || tile.force === true;

      if (isForced || this.detiler === undefined) {
        result = { shouldSkipProcessing: false, reason: isForced ? ProcessReason.FORCE : ProcessReason.NO_DETILER };
        return result;
      }

      preProcessTimerEnd = this.tilesDurationHistogram?.startTimer({ kind: ProcessKind.PRE_PROCESS });

      // attempt to get latest tile details
      const tileDetails = await this.detiler.getTileDetails({ kit: this.project.name, z: tile.z, x: tile.x, y: tile.y });
      if (tileDetails !== null) {
        // get the project last update time
        const projectState = await this.axiosClient.get<Buffer>(this.project.stateUrl, { responseType: 'arraybuffer' });
        const projectStateContent = projectState.data.toString();
        const projectTimestamp = timestampToUnix(fetchTimestampValue(projectStateContent));

        this.logger.info({ msg: 'determining if should skip tile processing', tile, tileDetails, sourceUpdatedAt: projectTimestamp });

        // skip processing if tile update time is later than project update time
        if (tileDetails.renderedAt >= projectTimestamp) {
          await this.detiler.setTileDetails(
            { kit: this.project.name, z: tile.z, x: tile.x, y: tile.y },
            { status: 'skipped', state: tile.state, timestamp }
          );

          this.logger.info({
            msg: 'tile processing can be skipping due to tile being up do date',
            tile,
            tileDetails,
            sourceUpdatedAt: projectTimestamp,
          });

          result = { shouldSkipProcessing: true, reason: ProcessSkipReason.TILE_UP_TO_DATE };

          return result;
        }

        // tile geometry in bbox
        const { west, south, east, north } = tileToBoundingBox(tile, TILEGRID_WORLD_CRS84, true);

        // time elapsed since last rendered
        const cooled = timestamp - tileDetails.renderedAt;

        // only render if the time elapsed is longer than the relavant cooldowns duration otherwise the tile is still cooling
        const cooldownsGenerator = this.detiler.queryCooldownsAsyncGenerator({
          enabled: true,
          minZoom: tile.z,
          maxZoom: tile.z,
          kits: [this.project.name],
          area: [west, south, east, north],
        });

        for await (const cooldowns of cooldownsGenerator) {
          const isCooling = cooldowns.filter((cooldown) => cooldown.duration > cooled).length > 0;

          this.logger.info({
            msg: 'tile processing should be skipped due to active cooldown',
            tile,
            tileDetails,
            tileCooled: cooled,
            cooldowns,
            sourceUpdatedAt: projectTimestamp,
          });

          if (isCooling) {
            await this.detiler.setTileDetails(
              { kit: this.project.name, z: tile.z, x: tile.x, y: tile.y },
              { status: 'cooled', state: tile.state, timestamp }
            );

            result = { shouldSkipProcessing: true, reason: ProcessSkipReason.COOLDOWN };

            return result;
          }
        }
      }

      result = { shouldSkipProcessing: false, reason: ProcessReason.PROJECT_UPDATED };

      return result;
    } catch (error) {
      this.logger.error({ msg: 'an error occurred while pre processing, tile will be processed', error });

      result = { shouldSkipProcessing: false, reason: ProcessReason.ERROR_OCCURRED };

      return result;
    } finally {
      this.logger.info({ msg: 'pre processing done', tile, result });

      this.preProcessResultsCounter?.inc({ result: result.reason, z: tile.z });

      endMetricTimer(preProcessTimerEnd);
    }
  }

  private async postProcess(tile: TileWithMetadata, timestamp: number): Promise<void> {
    if (this.detiler === undefined) {
      return;
    }

    const postProcessTimerEnd = this.tilesDurationHistogram?.startTimer({ kind: ProcessKind.POST_PROCESS });

    try {
      await this.detiler.setTileDetails(
        { kit: this.project.name, z: tile.z, x: tile.x, y: tile.y },
        { status: 'rendered', state: tile.state, timestamp }
      );
    } catch (error) {
      this.logger.error({ msg: 'an error occurred while post processing, skipping details set', error });
      if (!this.detilerProceedOnFailure) {
        throw error;
      }
    } finally {
      endMetricTimer(postProcessTimerEnd);
    }
  }
}
