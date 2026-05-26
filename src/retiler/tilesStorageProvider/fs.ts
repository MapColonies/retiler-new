import { join, dirname } from 'path';
import { writeFile, mkdir, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { Logger } from '@map-colonies/js-logger';
import { Tile } from '@map-colonies/tile-calc';
import format from 'string-format';
import { timerify } from '../../common/util';
import { TilesStorageProvider } from '../interfaces';
import { TileWithBuffer, TileWithMetadata } from '../types';
import { getFlippedY } from '../util';
import { TileStoragLayout } from './interfaces';
import { FS_FILE_NOT_FOUND_ERROR_CODE } from './constants';

export class FsTilesStorage implements TilesStorageProvider {
  public constructor(
    private readonly logger: Logger,
    private readonly baseStoragePath: string,
    private readonly storageLayout: TileStoragLayout
  ) {
    this.logger.info({ msg: 'initializing FS tile storage', baseStoragePath: this.baseStoragePath, storageLayout });
  }

  public async storeTile(tileWithBuffer: TileWithBuffer): Promise<void> {
    const { buffer, parent, ...baseTile } = tileWithBuffer;

    const key = this.determineKey(baseTile);

    const storagePath = join(this.baseStoragePath, key);

    try {
      const dir = dirname(storagePath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }
      await writeFile(storagePath, buffer);
    } catch (error) {
      const fsError = error as Error;
      this.logger.error({
        msg: 'an error occurred during tile storing',
        err: fsError,
        baseStoragePath: this.baseStoragePath,
        tile: baseTile,
        parent,
        key,
      });
      throw new Error(`an error occurred during the write of key ${key}, ${fsError.message}`);
    }
  }

  public async storeTiles(tiles: TileWithBuffer[]): Promise<void> {
    if (tiles.length === 0) {
      return;
    }

    const parent = tiles[0]?.parent;

    this.logger.debug({ msg: 'storing batch of tiles in fs', baseStoragePath: this.baseStoragePath, parent, count: tiles.length });

    const [, duration] = await timerify(async () => Promise.all(tiles.map(async (tile) => this.storeTile(tile))));

    this.logger.debug({ msg: 'finished storing batch of tiles', duration, baseStoragePath: this.baseStoragePath, parent, count: tiles.length });
  }

  public async deleteTile(tile: TileWithMetadata): Promise<void> {
    const key = this.determineKey(tile);
    const storagePath = join(this.baseStoragePath, key);

    try {
      await unlink(storagePath);
      this.logger.debug({ msg: 'successfully deleted tile from fs', key, storagePath });
    } catch (error) {
      const fsError = error as Error;
      if ((error as NodeJS.ErrnoException).code === FS_FILE_NOT_FOUND_ERROR_CODE) {
        this.logger.debug({ msg: 'tile file was not found for deletion on fs, skipping', key, storagePath });
      } else {
        this.logger.error({
          msg: 'an error occurred during tile deletion',
          err: fsError,
          baseStoragePath: this.baseStoragePath,
          tile,
          key,
        });

        throw error;
      }
    }
  }

  public async deleteTiles(tiles: TileWithMetadata[]): Promise<void> {
    if (tiles.length === 0) {
      return;
    }

    const parent = tiles[0]?.parent;

    this.logger.debug({ msg: 'deleting batch of tiles from fs', baseStoragePath: this.baseStoragePath, parent, count: tiles.length });

    const [, duration] = await timerify(async () => Promise.all(tiles.map(async (tile) => this.deleteTile(tile))));

    this.logger.info({ msg: 'finished batch deletion of tiles', duration, parent, count: tiles.length, baseStoragePath: this.baseStoragePath });
  }

  private determineKey(tile: Required<Tile>): string {
    if (this.storageLayout.shouldFlipY) {
      tile.y = getFlippedY(tile);
    }
    const key = format(this.storageLayout.format, tile);
    return key;
  }
}
