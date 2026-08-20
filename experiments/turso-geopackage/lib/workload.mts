import { matrixHeight, matrixWidth } from './coordinates.mts';
import type { BatchPlan, MutationOp, WorkloadSpec, WriterPlan } from './types.mts';

/** Fraction of each batch drawn from the shared hot set in moderate collision mode. */
const MODERATE_COLLISION_RATIO = 0.25;

/**
 * Small deterministic PRNG. The workload must be reproducible across writer
 * processes and across reruns, so nothing here may call `Math.random`.
 */
export const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Fisher-Yates over a copy of `values`, driven by `random`. */
const shuffle = <T,>(values: T[], random: () => number): T[] => {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j] as T, result[i] as T];
  }
  return result;
};

const range = (start: number, count: number): number[] => Array.from({ length: count }, (_, offset) => start + offset);

export const buildWorkloadPlan = (spec: WorkloadSpec): WriterPlan[] => {
  const { writers, batchesPerWriter, metatile, deleteRatio, collision, zoomLevel, seed } = spec;

  const tilesPerBatch = metatile ** 2;
  const tilesPerWriter = batchesPerWriter * tilesPerBatch;
  const width = matrixWidth(zoomLevel);
  const totalTiles = width * matrixHeight(zoomLevel);

  const hotSetSize = collision === 'moderate' ? Math.max(4, tilesPerBatch) : 0;
  const privateTiles = collision === 'full' ? tilesPerWriter : writers * tilesPerWriter;
  const requiredTiles = privateTiles + hotSetSize;

  if (requiredTiles > totalTiles) {
    throw new RangeError(
      `workload does not fit in the zoom level ${zoomLevel} tile matrix: needs ${requiredTiles} tiles but the matrix holds ${totalTiles}`
    );
  }

  const toOp = (tileIndex: number, kind: MutationOp['kind']): MutationOp => ({
    kind,
    z: zoomLevel,
    x: tileIndex % width,
    y: Math.floor(tileIndex / width),
  });

  // The hot set sits above every writer's private region so the two never overlap.
  const hotIndices = range(totalTiles - hotSetSize, hotSetSize);
  const hotOpsPerBatch = collision === 'moderate' ? Math.min(hotSetSize, Math.max(1, Math.round(tilesPerBatch * MODERATE_COLLISION_RATIO))) : 0;
  const deletesPerBatch = Math.round(tilesPerBatch * deleteRatio);

  // Full collision means every writer walks the identical coordinate sequence,
  // so it is permuted once with the shared seed rather than per writer.
  const sharedSequence = collision === 'full' ? shuffle(range(0, tilesPerWriter), mulberry32(seed)) : [];

  return range(0, writers).map((writerId) => {
    const privatePool =
      collision === 'full' ? sharedSequence : shuffle(range(writerId * tilesPerWriter, tilesPerWriter), mulberry32(seed + writerId));

    let cursor = 0;

    const batches: BatchPlan[] = range(0, batchesPerWriter).map((index) => {
      const ops = range(0, tilesPerBatch).map((slot) => {
        const isHot = slot < hotOpsPerBatch;
        const tileIndex = isHot ? (hotIndices[(index * hotOpsPerBatch + slot) % hotIndices.length] as number) : (privatePool[cursor++] as number);

        // Deletes occupy the tail of the batch so every batch that has any
        // mixes both kinds, matching a metatile with some blank sub tiles.
        return toOp(tileIndex, slot >= tilesPerBatch - deletesPerBatch ? 'delete' : 'put');
      });

      return { batchId: `w${writerId}-b${index}`, writerId, index, ops };
    });

    return { writerId, batches };
  });
};
