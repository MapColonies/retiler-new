import type { LatencySummary, RunTotals, WriterReport } from './types.mts';

const MILLISECONDS_IN_SECOND = 1000;

const EMPTY_SUMMARY: LatencySummary = { count: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 };

/** Nearest-rank percentile of `values`, which is left unmodified. */
export const percentile = (values: number[], p: number): number => {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] as number;
};

export const summarize = (values: number[]): LatencySummary => {
  if (values.length === 0) {
    return { ...EMPTY_SUMMARY };
  }

  const total = values.reduce((sum, value) => sum + value, 0);

  return {
    count: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    mean: total / values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
  };
};

const sumBy = (reports: WriterReport[], pick: (report: WriterReport) => number): number => reports.reduce((sum, report) => sum + pick(report), 0);

/**
 * Rolls per-writer reports into fleet totals. Throughput is measured against
 * the fleet's wall clock -- first writer start to last writer finish -- so it
 * reflects the end-to-end benefit rather than per-writer overlap.
 */
export const aggregate = (reports: WriterReport[]): RunTotals => {
  const batchesCommitted = sumBy(reports, (report) => report.batchesCommitted);
  const tilesPut = sumBy(reports, (report) => report.tilesPut);
  const tilesDeleted = sumBy(reports, (report) => report.tilesDeleted);

  const wallClockMs =
    reports.length === 0 ? 0 : Math.max(...reports.map((report) => report.finishedAtMs)) - Math.min(...reports.map((report) => report.startedAtMs));

  const perSecond = (count: number): number => (wallClockMs > 0 ? (count * MILLISECONDS_IN_SECOND) / wallClockMs : 0);

  return {
    writers: reports.length,
    batchesCommitted,
    batchesFailed: sumBy(reports, (report) => report.batchesFailed),
    tilesPut,
    tilesDeleted,
    attempts: sumBy(reports, (report) => report.attempts),
    retries: sumBy(reports, (report) => report.retries),
    conflicts: sumBy(reports, (report) => report.conflicts),
    busyErrors: sumBy(reports, (report) => report.busyErrors),
    fatalErrors: sumBy(reports, (report) => report.fatalErrors),
    wallClockMs,
    batchesPerSecond: perSecond(batchesCommitted),
    tilesPerSecond: perSecond(tilesPut + tilesDeleted),
    latency: summarize(reports.flatMap((report) => report.batchLatenciesMs)),
    cpuUserMs: sumBy(reports, (report) => report.cpuUserMs),
    cpuSystemMs: sumBy(reports, (report) => report.cpuSystemMs),
    maxRssBytes: reports.length === 0 ? 0 : Math.max(...reports.map((report) => report.maxRssBytes)),
  };
};
