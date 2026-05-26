import { readFile } from 'fs/promises';
import sharp from 'sharp';
import { faker } from '@faker-js/faker';
import jsLogger from '@map-colonies/js-logger';
import { Tile } from '@map-colonies/tile-calc';
import { SharpMapSplitter } from '../../../src/retiler/mapSplitterProvider/sharp';
import { createBlankBuffer } from '../../integration/helpers';

describe('SharpMapSplitter', () => {
  describe('#splitMap', () => {
    let splitter: SharpMapSplitter;

    beforeEach(function () {
      splitter = new SharpMapSplitter(jsLogger({ enabled: false }));
    });

    afterEach(function () {
      jest.clearAllMocks();
    });

    it('should split 2048x2048 image into 64 tiles on zoom levels larger or equal to 3', async function () {
      const metatileValue = 8;
      const zoom = faker.number.int({ min: 3, max: 20 });
      const buffer = await readFile('tests/2048x2048.png');

      const splitResult = await splitter.splitMap({ z: zoom, x: 0, y: 0, metatile: metatileValue, buffer });
      const tiles = splitResult.splittedTiles.map((tileWithBuffer) => {
        const { buffer, ...tile } = tileWithBuffer;
        return tile;
      });

      const expectedTiles: Required<Tile>[] = [];
      for (let i = 0; i < metatileValue; i++) {
        for (let j = 0; j < metatileValue; j++) {
          expectedTiles.push({ z: zoom, x: i, y: j, metatile: 1 });
        }
      }

      expect(tiles).toContainSameTiles(expectedTiles);

      const assertions = splitResult.splittedTiles.map(async (tile) => {
        const metadata = await sharp(tile.buffer).metadata();
        expect(metadata).toMatchObject({
          width: 256,
          height: 256,
          format: 'png',
        });
      });
      await Promise.all(assertions);

      expect(splitResult.blankTiles).toHaveLength(0);
      expect(splitResult.outOfBoundsCount).toBe(0);
      expect(splitResult.isMetatileBlank).toBe(false);
    });

    it('should split 2048x2048 image into 8 tiles on zoom 1, the rest are out of bounds', async function () {
      const buffer = await readFile('tests/2048x2048.png');

      const metatileValue = 8;
      const splitResult = await splitter.splitMap({ z: 1, x: 0, y: 0, metatile: metatileValue, buffer });
      const tiles = splitResult.splittedTiles.map((tileWithBuffer) => {
        const { buffer, ...tile } = tileWithBuffer;
        return tile;
      });

      expect(tiles).toContainSameTiles([
        { z: 1, x: 0, y: 0, metatile: 1 },
        { z: 1, x: 1, y: 0, metatile: 1 },
        { z: 1, x: 2, y: 0, metatile: 1 },
        { z: 1, x: 3, y: 0, metatile: 1 },
        { z: 1, x: 0, y: 1, metatile: 1 },
        { z: 1, x: 1, y: 1, metatile: 1 },
        { z: 1, x: 2, y: 1, metatile: 1 },
        { z: 1, x: 3, y: 1, metatile: 1 },
      ]);

      const assertions = splitResult.splittedTiles.map(async (tile) => {
        const metadata = await sharp(tile.buffer).metadata();
        expect(metadata).toMatchObject({
          width: 256,
          height: 256,
          format: 'png',
        });
      });
      await Promise.all(assertions);

      expect(splitResult.blankTiles).toHaveLength(0);
      expect(splitResult.outOfBoundsCount).toBe(metatileValue * metatileValue - metatileValue);
      expect(splitResult.isMetatileBlank).toBe(false);
    });

    it('should split 256x256 image into only 2 tiles which are not out of bounds on zoom level 1, on every metatile value larger than 1', async function () {
      const metatileValue = faker.number.int({ min: 2, max: 22 });
      const buffer = await readFile('tests/512x512.png');

      const splitResult = await splitter.splitMap({ z: 0, x: 0, y: 0, metatile: metatileValue, buffer });

      expect(splitResult.splittedTiles).toContainSameTiles([
        { z: 0, x: 0, y: 0, metatile: 1 },
        { z: 0, x: 1, y: 0, metatile: 1 },
      ]);

      const assertions = splitResult.splittedTiles.map(async (tile) => {
        const metadata = await sharp(tile.buffer).metadata();
        expect(metadata).toMatchObject({
          width: 256,
          height: 256,
          format: 'png',
        });
      });
      await Promise.all(assertions);

      expect(splitResult.blankTiles).toHaveLength(0);
      expect(splitResult.outOfBoundsCount).toBe(metatileValue * metatileValue - 2);
      expect(splitResult.isMetatileBlank).toBe(false);
    });

    it('should filter out blank sub tiles for true filter blank flag', async function () {
      const buffer = await readFile('tests/blank-but-top-right.png');

      const splitResult = await splitter.splitMap({ z: 1, x: 0, y: 0, metatile: 2, buffer }, true);
      const tiles = splitResult.splittedTiles.map((tileWithBuffer) => {
        const { buffer, ...tile } = tileWithBuffer;
        return tile;
      });

      expect(tiles).toContainSameTiles([{ z: 1, x: 1, y: 0, metatile: 1 }]);

      const assertions = splitResult.splittedTiles.map(async (tile) => {
        const metadata = await sharp(tile.buffer).metadata();
        expect(metadata).toMatchObject({
          width: 256,
          height: 256,
          format: 'png',
        });
      });
      await Promise.all(assertions);

      expect(splitResult.blankTiles).toHaveLength(3);
      expect(splitResult.blankTiles).toContainSameTiles([
        { z: 1, x: 0, y: 1, metatile: 1 },
        { z: 1, x: 0, y: 0, metatile: 1 },
        { z: 1, x: 1, y: 1, metatile: 1 },
      ]);
      expect(splitResult.outOfBoundsCount).toBe(0);
      expect(splitResult.isMetatileBlank).toBe(false);
    });

    it('should not filter out blank sub tiles for false filter blank flag', async function () {
      const buffer = await readFile('tests/blank-but-top-right.png');

      const splitResult = await splitter.splitMap({ z: 1, x: 0, y: 0, metatile: 2, buffer }, false);
      const tiles = splitResult.splittedTiles.map((tileWithBuffer) => {
        const { buffer, ...tile } = tileWithBuffer;
        return tile;
      });

      expect(tiles).toContainSameTiles([
        { z: 1, x: 0, y: 0, metatile: 1 },
        { z: 1, x: 1, y: 0, metatile: 1 },
        { z: 1, x: 0, y: 1, metatile: 1 },
        { z: 1, x: 1, y: 1, metatile: 1 },
      ]);

      const assertions = splitResult.splittedTiles.map(async (tile) => {
        const metadata = await sharp(tile.buffer).metadata();
        expect(metadata).toMatchObject({
          width: 256,
          height: 256,
          format: 'png',
        });
      });
      await Promise.all(assertions);

      expect(splitResult.blankTiles).toHaveLength(0);
      expect(splitResult.outOfBoundsCount).toBe(0);
      expect(splitResult.isMetatileBlank).toBe(false);
    });

    it('should filter out the whole tile for true filter blank flag', async function () {
      const buffer = await createBlankBuffer();

      const splitResult = await splitter.splitMap({ z: 1, x: 0, y: 0, metatile: 2, buffer }, true);

      expect(splitResult.blankTiles).toContainSameTiles([
        { z: 1, x: 0, y: 0, metatile: 1 },
        { z: 1, x: 1, y: 0, metatile: 1 },
        { z: 1, x: 0, y: 1, metatile: 1 },
        { z: 1, x: 1, y: 1, metatile: 1 },
      ]);
      expect(splitResult).toMatchObject({ isMetatileBlank: true, outOfBoundsCount: 0, splittedTiles: [] });
    });

    it('should not filter out the whole tile for false filter blank flag', async function () {
      const buffer = await createBlankBuffer({ width: 512, height: 512 });

      const splitResult = await splitter.splitMap({ z: 1, x: 0, y: 0, metatile: 2, buffer }, false);
      const tiles = splitResult.splittedTiles.map((tileWithBuffer) => {
        const { buffer, ...tile } = tileWithBuffer;
        return tile;
      });

      expect(tiles).toContainSameTiles([
        { z: 1, x: 0, y: 0, metatile: 1 },
        { z: 1, x: 1, y: 0, metatile: 1 },
        { z: 1, x: 0, y: 1, metatile: 1 },
        { z: 1, x: 1, y: 1, metatile: 1 },
      ]);

      const assertions = splitResult.splittedTiles.map(async (tile) => {
        const metadata = await sharp(tile.buffer).metadata();
        expect(metadata).toMatchObject({
          width: 256,
          height: 256,
          format: 'png',
        });
      });
      await Promise.all(assertions);

      expect(splitResult.blankTiles).toHaveLength(0);
      expect(splitResult.outOfBoundsCount).toBe(0);
      expect(splitResult.isMetatileBlank).toBe(false);
    });
  });
});
