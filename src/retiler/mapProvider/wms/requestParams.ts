import { BoundingBox } from '@map-colonies/tile-calc';
import { WmsVersion } from '../../types';

export interface WmsConfig {
  version: WmsVersion;
  layers: string;
  styles: string;
}

export interface WmsRequestParams extends WmsVersionDependentRequestParams, WmsConfig {
  format: string;
  service: string;
  request: string;
  width: number;
  height: number;
}

export interface WmsVersionDependentRequestParams {
  version: WmsVersion;
  srs?: string;
  crs?: string;
  bbox: string;
}

export const BASE_REQUEST_PARAMS = {
  layers: '',
  format: 'image/png',
  transparent: true,
  service: 'WMS',
  request: 'GetMap',
  styles: '',
};

/* the difference between WMS 1.1.1 and 1.3.0 is two fold,
on 1.1.1 use srs and bbox is constructed as xmin,ymin,xmax,ymax
while on 1.3.0 use crs instead and bbox is constructed as ymin,xmin,ymax,xmax
*/
export const getVersionDepParams = (version: WmsVersion, bbox: BoundingBox): WmsVersionDependentRequestParams => {
  const params: Partial<WmsVersionDependentRequestParams> = {};

  if (version === '1.3.0') {
    params.crs = 'EPSG:4326';
    params.bbox = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  } else {
    params.srs = 'EPSG:4326';
    params.bbox = `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`;
  }

  return { version, ...params } as WmsVersionDependentRequestParams;
};
