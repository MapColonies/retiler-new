import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { aggregate, percentile, summarize } from '../lib/metrics.mts';
import type { WriterReport } from '../lib/types.mts';

const report = (overrides: Partial<WriterReport>): WriterReport => ({
  writerId: 0,
  mode: 'turso',
  batchesCommitted: 0,
  batchesFailed: 0,
  tilesPut: 0,
  tilesDeleted: 0,
  attempts: 0,
  retries: 0,
  conflicts: 0,
  busyErrors: 0,
  fatalErrors: 0,
  batchLatenciesMs: [],
  startedAtMs: 0,
  finishedAtMs: 0,
  cpuUserMs: 0,
  cpuSystemMs: 0,
  maxRssBytes: 0,
  ...overrides,
});

describe('percentile', () => {
  it('picks the nearest rank of the sorted sample', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    assert.equal(percentile(values, 50), 5);
    assert.equal(percentile(values, 95), 10);
    assert.equal(percentile(values, 100), 10);
  });

  it('sorts numerically rather than lexicographically', () => {
    assert.equal(percentile([100, 9, 80], 50), 80);
  });

  it('does not mutate the caller sample', () => {
    const values = [3, 1, 2];
    percentile(values, 50);
    assert.deepEqual(values, [3, 1, 2]);
  });

  it('returns zero for an empty sample', () => {
    assert.equal(percentile([], 50), 0);
  });
});

describe('summarize', () => {
  it('reports count, bounds, mean and the tail percentiles', () => {
    assert.deepEqual(summarize([2, 4, 6, 8]), { count: 4, min: 2, max: 8, mean: 5, p50: 4, p95: 8, p99: 8 });
  });

  it('reports zeros for an empty sample', () => {
    assert.deepEqual(summarize([]), { count: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 });
  });
});

describe('aggregate', () => {
  it('sums the counters across writers', () => {
    const totals = aggregate([
      report({ writerId: 0, batchesCommitted: 3, tilesPut: 30, tilesDeleted: 2, retries: 4, conflicts: 5, busyErrors: 5 }),
      report({ writerId: 1, batchesCommitted: 2, tilesPut: 20, tilesDeleted: 1, retries: 1, conflicts: 2, busyErrors: 1, fatalErrors: 1 }),
    ]);
    assert.equal(totals.writers, 2);
    assert.equal(totals.batchesCommitted, 5);
    assert.equal(totals.tilesPut, 50);
    assert.equal(totals.tilesDeleted, 3);
    assert.equal(totals.retries, 5);
    assert.equal(totals.conflicts, 7);
    assert.equal(totals.busyErrors, 6);
    assert.equal(totals.fatalErrors, 1);
  });

  it('measures wall clock across the whole fleet, not per writer', () => {
    const totals = aggregate([
      report({ writerId: 0, startedAtMs: 1000, finishedAtMs: 3000, batchesCommitted: 4, tilesPut: 4 }),
      report({ writerId: 1, startedAtMs: 1500, finishedAtMs: 5000, batchesCommitted: 4, tilesPut: 4 }),
    ]);
    assert.equal(totals.wallClockMs, 4000);
    assert.equal(totals.batchesPerSecond, 2);
    assert.equal(totals.tilesPerSecond, 2);
  });

  it('pools every writer latency sample into one summary', () => {
    const totals = aggregate([report({ batchLatenciesMs: [2, 4] }), report({ batchLatenciesMs: [6, 8] })]);
    assert.equal(totals.latency.count, 4);
    assert.equal(totals.latency.mean, 5);
  });

  it('takes the peak resident memory rather than summing it', () => {
    const totals = aggregate([report({ maxRssBytes: 100 }), report({ maxRssBytes: 250 })]);
    assert.equal(totals.maxRssBytes, 250);
  });

  it('handles an empty fleet without dividing by zero', () => {
    const totals = aggregate([]);
    assert.equal(totals.writers, 0);
    assert.equal(totals.batchesPerSecond, 0);
    assert.equal(totals.tilesPerSecond, 0);
  });
});
