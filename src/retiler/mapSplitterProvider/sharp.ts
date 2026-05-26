import sharp from 'sharp';
import { inject, injectable } from 'tsyringe';
import { type Logger } from '@map-colonies/js-logger';
import { Tile } from '@map-colonies/tile-calc';
import { SERVICES, TILE_SIZE } from '../../common/constants';
import { MapSplitterProvider } from '../interfaces';
import { MapSplitResult, TileWithBuffer } from '../types';
import { isTileInBounds } from '../util';
import { timerify } from '../../common/util';

function* subTilesGenerator(baseTile: Required<Tile>): Generator<{ subTile: Required<Tile>; column: number; row: number }, void, undefined> {
  const splitsPerAxis = baseTile.metatile;

  for (let row = 0; row < splitsPerAxis; row++) {
    for (let column = 0; column < splitsPerAxis; column++) {
      const subTile: Required<Tile> = {
        z: baseTile.z,
        x: baseTile.x * splitsPerAxis + column,
        y: baseTile.y * splitsPerAxis + row,
        metatile: 1,
      };
      yield { subTile, row, column };
    }
  }
}

const isBlankTile = async (buffer: Buffer): Promise<boolean> => {
  const { channels } = await sharp(buffer).stats();
  return channels.every((c) => c.max === 0);
};

@injectable()
export class SharpMapSplitter implements MapSplitterProvider {
  public constructor(@inject(SERVICES.LOGGER) private readonly logger: Logger) {}

  public async splitMap(tile: TileWithBuffer, shouldFilterBlankTiles?: boolean): Promise<MapSplitResult> {
    const { buffer, parent, ...baseTile } = tile;

    const result: MapSplitResult = { isMetatileBlank: false, splittedTiles: [], blankTiles: [], outOfBoundsCount: 0 };

    const splitsPerAxis = tile.metatile;
    const splitsCount = splitsPerAxis * splitsPerAxis;

    if (shouldFilterBlankTiles === true) {
      const isBlank = await isBlankTile(buffer);

      if (isBlank) {
        this.logger.info({ msg: 'filtering full metatile due to blank detection', tile: baseTile, parent });

        for (const { subTile } of subTilesGenerator(baseTile)) {
          result.blankTiles.push(subTile);
        }

        return { ...result, isMetatileBlank: true };
      }
    }

    this.logger.debug({ msg: 'splitting metatile', tile: baseTile, parent, splitsPerAxis, splitsCount, shouldFilterBlankTiles });

    const promises: Promise<TileWithBuffer | undefined>[] = [];

    const pipeline = sharp(buffer);
    pipeline.setMaxListeners(splitsPerAxis * splitsPerAxis + 1 + 1);

    for (const { subTile, column, row } of subTilesGenerator(baseTile)) {
      if (!isTileInBounds(subTile)) {
        this.logger.debug({ msg: 'sub tile is out of bounds', tile: baseTile, parent });

        result.outOfBoundsCount++;
        continue;
      }

      promises.push(
        (async (): Promise<TileWithBuffer | undefined> => {
          const extractedSubTileBuffer = await pipeline
            .clone()
            .extract({ left: column * TILE_SIZE, top: row * TILE_SIZE, width: TILE_SIZE, height: TILE_SIZE })
            .toBuffer({ resolveWithObject: false });

          if (shouldFilterBlankTiles === true) {
            const isBlank = await isBlankTile(extractedSubTileBuffer);
            if (isBlank) {
              result.blankTiles.push(subTile);
              return;
            }
          }

          return { ...subTile, buffer: extractedSubTileBuffer, parent };
        })()
      );
    }

    const [tilesWithBuffers, duration] = await timerify(async () => {
      const tileWithBuffer = await Promise.all(promises);
      return tileWithBuffer.filter((tile) => tile !== undefined);
    });

    this.logger.debug({
      msg: 'finished splitting metatile',
      tile: baseTile,
      duration,
      parent,
      totalSplitsCount: splitsCount,
      splittedTiles: result.splittedTiles.length,
      blankTilesCount: result.blankTiles.length,
    });

    return { ...result, splittedTiles: tilesWithBuffers };
  }
}
