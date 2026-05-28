import { type VectorRetilerSchemaType } from '../../common/config';

export interface TileStoragLayout {
  format: string;
  shouldFlipY: boolean;
}

export type StorageProviderConfig = VectorRetilerSchemaType['app']['tilesStorage']['providers'][number];
