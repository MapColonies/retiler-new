import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { matrixHeight, matrixWidth } from '../lib/coordinates.mts';
import { buildWorkloadPlan, mulberry32 } from '../lib/workload.mts';
import type { WorkloadSpec } from '../lib/types.mts';

const spec = (overrides: Partial<WorkloadSpec> = {}): WorkloadSpec => ({
  writers: 4,
  batchesPerWriter: 3,
  metatile: 2,
  deleteRatio: 0.25,
  collision: 'disjoint',
  zoomLevel: 6,
  seed: 42,
  ...overrides,
});

const coordinatesOf = (plans: ReturnType<typeof buildWorkloadPlan>, writerId: number): Set<string> =>
  new Set(plans[writerId]?.batches.flatMap((batch) => batch.ops.map((op) => `${op.z}/${op.x}/${op.y}`)) ?? []);

describe('mulberry32', () => {
  it('produces a repeatable stream for a given seed', () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  });

  it('produces a different stream for a different seed', () => {
    assert.notEqual(mulberry32(1)(), mulberry32(2)());
  });

  it('stays within the unit interval', () => {
    const random = mulberry32(99);
    for (let i = 0; i < 200; i++) {
      const value = random();
      assert.ok(value >= 0 && value < 1, `${value} out of range`);
    }
  });
});

describe('buildWorkloadPlan', () => {
  it('produces one plan per writer with the requested batch count', () => {
    const plans = buildWorkloadPlan(spec());
    assert.equal(plans.length, 4);
    for (const plan of plans) {
      assert.equal(plan.batches.length, 3);
    }
  });

  it('derives the batch size from the metatile, as one metatile yields metatile squared tiles', () => {
    const plans = buildWorkloadPlan(spec({ metatile: 4 }));
    for (const batch of plans[0]?.batches ?? []) {
      assert.equal(batch.ops.length, 16);
    }
  });

  it('is deterministic for a given seed', () => {
    assert.deepEqual(buildWorkloadPlan(spec()), buildWorkloadPlan(spec()));
  });

  it('gives every batch a globally unique id so commits can be traced', () => {
    const plans = buildWorkloadPlan(spec());
    const ids = plans.flatMap((plan) => plan.batches.map((batch) => batch.batchId));
    assert.equal(new Set(ids).size, ids.length);
  });

  it('mixes puts and deletes inside a single batch', () => {
    const [plan] = buildWorkloadPlan(spec({ metatile: 4, deleteRatio: 0.25 }));
    const batch = plan?.batches[0];
    assert.ok(batch);
    assert.equal(batch.ops.filter((op) => op.kind === 'delete').length, 4);
    assert.equal(batch.ops.filter((op) => op.kind === 'put').length, 12);
  });

  it('emits only puts when the delete ratio is zero', () => {
    const [plan] = buildWorkloadPlan(spec({ deleteRatio: 0 }));
    const batch = plan?.batches[0];
    assert.ok(batch);
    assert.ok(batch.ops.every((op) => op.kind === 'put'));
  });

  it('keeps every coordinate inside the tile matrix for its zoom level', () => {
    const zoomLevel = 5;
    for (const plan of buildWorkloadPlan(spec({ zoomLevel, collision: 'moderate' }))) {
      for (const batch of plan.batches) {
        for (const op of batch.ops) {
          assert.equal(op.z, zoomLevel);
          assert.ok(op.x >= 0 && op.x < matrixWidth(zoomLevel), `column ${op.x}`);
          assert.ok(op.y >= 0 && op.y < matrixHeight(zoomLevel), `row ${op.y}`);
        }
      }
    }
  });

  describe('collision modes', () => {
    it('gives disjoint writers no coordinate in common', () => {
      const plans = buildWorkloadPlan(spec({ collision: 'disjoint' }));
      const seen = new Set<string>();
      for (let writerId = 0; writerId < plans.length; writerId++) {
        for (const key of coordinatesOf(plans, writerId)) {
          assert.ok(!seen.has(key), `coordinate ${key} shared between writers`);
          seen.add(key);
        }
      }
    });

    it('gives full-collision writers exactly the same coordinate set', () => {
      const plans = buildWorkloadPlan(spec({ collision: 'full' }));
      const first = coordinatesOf(plans, 0);
      for (let writerId = 1; writerId < plans.length; writerId++) {
        assert.deepEqual(coordinatesOf(plans, writerId), first);
      }
    });

    it('gives moderate-collision writers a partial overlap', () => {
      const plans = buildWorkloadPlan(spec({ collision: 'moderate', batchesPerWriter: 8 }));
      const first = coordinatesOf(plans, 0);
      const second = coordinatesOf(plans, 1);
      const shared = [...first].filter((key) => second.has(key));
      assert.ok(shared.length > 0, 'expected some shared coordinates');
      assert.ok(shared.length < first.size, 'expected some private coordinates');
    });
  });

  it('refuses a workload that cannot fit disjointly in the tile matrix', () => {
    assert.throws(() => buildWorkloadPlan(spec({ zoomLevel: 0, writers: 8, batchesPerWriter: 100 })), /does not fit/u);
  });
});
