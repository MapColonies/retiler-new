import type { Tile } from '@map-colonies/tile-calc';

declare global {
  namespace jest {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    interface Matchers<R> {
      toContainSameTiles: (expectedTiles: Tile[]) => CustomMatcherResult;
    }
  }
}
export {};
