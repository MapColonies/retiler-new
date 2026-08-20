/** How much of the gate matrix to run. */
export type Profile = 'quick' | 'full';

/** Verdict for a gate or one of its checks. */
export type GateStatus = 'pass' | 'fail' | 'blocked' | 'not-run';

export interface GateCheck {
  name: string;
  status: GateStatus;
  detail: string;
  /** Raw observation backing the verdict, e.g. the error Turso returned. */
  evidence?: unknown;
}

export interface GateResult {
  id: number;
  title: string;
  status: GateStatus;
  /** Why the gate as a whole landed on its status. */
  summary: string;
  checks: GateCheck[];
  measurements?: Record<string, unknown>;
  durationMs: number;
}

/* -------------------------------------------------------------------------- */
/* Workload                                                                    */
/* -------------------------------------------------------------------------- */

/** How much the writers are made to contend for the same tile coordinates. */
export type CollisionMode = 'disjoint' | 'moderate' | 'full';

export interface WorkloadSpec {
  writers: number;
  batchesPerWriter: number;
  /** Metatile edge; one metatile yields `metatile ** 2` tiles in one batch. */
  metatile: number;
  /** Fraction of each batch that is a blank-tile delete rather than a put. */
  deleteRatio: number;
  collision: CollisionMode;
  zoomLevel: number;
  seed: number;
}

export type MutationKind = 'put' | 'delete';

export interface MutationOp {
  kind: MutationKind;
  z: number;
  x: number;
  y: number;
}

/** All puts and deletes produced from one fetched metatile. */
export interface BatchPlan {
  batchId: string;
  writerId: number;
  index: number;
  ops: MutationOp[];
}

export interface WriterPlan {
  writerId: number;
  batches: BatchPlan[];
}

/* -------------------------------------------------------------------------- */
/* Writer processes                                                            */
/* -------------------------------------------------------------------------- */

export type WriterMode = 'turso' | 'sqlite-control';

/** Where an injected failure fires inside a writer's batch transaction. */
export type CrashPoint = 'before-begin' | 'mid-statements' | 'before-commit' | 'after-commit' | 'during-checkpoint';

export interface WriterConfig {
  writerId: number;
  mode: WriterMode;
  databasePath: string;
  tileTable: string;
  plan: BatchPlan[];
  /** Injected failure, used by the atomicity and recovery gate. */
  crash?: { point: CrashPoint; atBatchIndex: number };
}

export interface WriterReport {
  writerId: number;
  mode: WriterMode;
  batchesCommitted: number;
  batchesFailed: number;
  tilesPut: number;
  tilesDeleted: number;
  attempts: number;
  retries: number;
  /** Retryable failures observed across all attempts. */
  conflicts: number;
  /** Subset of conflicts that were lock or busy errors. */
  busyErrors: number;
  fatalErrors: number;
  batchLatenciesMs: number[];
  startedAtMs: number;
  finishedAtMs: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  maxRssBytes: number;
  /** Attempts needed to open the file, above one when the open raced. */
  openAttempts?: number;
  /** Batches the writer acknowledged as committed, for post-run verification. */
  acknowledged?: AcknowledgedBatch[];
  errorSamples?: string[];
}

export interface AcknowledgedBatch {
  batchId: string;
  writerId: number;
  index: number;
  ops: MutationOp[];
}

/* -------------------------------------------------------------------------- */
/* Metrics                                                                     */
/* -------------------------------------------------------------------------- */

export interface LatencySummary {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface RunTotals {
  writers: number;
  batchesCommitted: number;
  batchesFailed: number;
  tilesPut: number;
  tilesDeleted: number;
  attempts: number;
  retries: number;
  conflicts: number;
  busyErrors: number;
  fatalErrors: number;
  wallClockMs: number;
  batchesPerSecond: number;
  tilesPerSecond: number;
  latency: LatencySummary;
  cpuUserMs: number;
  cpuSystemMs: number;
  maxRssBytes: number;
}
