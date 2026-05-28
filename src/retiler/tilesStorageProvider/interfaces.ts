import { type vectorRetilerSchemaType } from '../../common/config';

export interface TileStoragLayout {
  format: string;
  shouldFlipY: boolean;
}

export type StorageProviderConfig = vectorRetilerSchemaType['app']['tilesStorage']['providers'][number];
