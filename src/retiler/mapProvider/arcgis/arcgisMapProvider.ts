import { AxiosError, type AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { tileToBoundingBox } from '@map-colonies/tile-calc';
import { type Logger } from '@map-colonies/js-logger';
import { inject, injectable } from 'tsyringe';
import { MAP_FORMAT, MAP_URL, SERVICES, TILE_SIZE } from '../../../common/constants';
import { MapProvider } from '../../interfaces';
import { timerify } from '../../../common/util';
import { TileWithMetadata } from '../../types';
import { ARCGIS_MAP_PARAMS } from './constants';

@injectable()
export class ArcgisMapProvider implements MapProvider {
  public constructor(
    @inject(SERVICES.HTTP_CLIENT) private readonly axiosClient: AxiosInstance,
    @inject(SERVICES.LOGGER) private readonly logger: Logger,
    @inject(MAP_URL) private readonly mapUrl: string,
    @inject(MAP_FORMAT) private readonly mapFormat: string
  ) {
    this.logger.info({ msg: 'initializing map provider', mapUrl, mapFormat, provider: 'arcgis' });
  }

  public async getMap(tile: TileWithMetadata): Promise<Buffer> {
    const { parent, ...baseTile } = tile;

    const bbox = tileToBoundingBox(baseTile);
    const mapSizePerAxis = tile.metatile * TILE_SIZE;

    const requestParams = {
      ...ARCGIS_MAP_PARAMS,
      format: this.mapFormat,
      bbox: `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`,
      size: `${mapSizePerAxis},${mapSizePerAxis}`,
    };

    try {
      const requestConfig: AxiosRequestConfig<Buffer> = { responseType: 'arraybuffer', params: requestParams };

      this.logger.debug({ msg: 'fetching map from provider', tile: baseTile, parent: tile.parent, mapUrl: this.mapUrl, ...requestConfig });

      const [response, duration] = await timerify<AxiosResponse<Buffer>, [string, AxiosRequestConfig]>(
        this.axiosClient.get.bind(this.axiosClient),
        this.mapUrl,
        requestConfig
      );

      this.logger.debug({ msg: 'finished fetching map from provider', tile: baseTile, duration, parent: tile.parent, mapUrl: this.mapUrl });
      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError<Buffer>;
      this.logger.error({
        msg: 'an error occurred while fetching map from provider',
        err: axiosError,
        tile: baseTile,
        parent: tile.parent,
        mapUrl: this.mapUrl,
      });
      throw axiosError;
    }
  }
}
