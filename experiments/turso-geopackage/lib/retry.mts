/** Whether a failed mutation is worth attempting again. */
export type ErrorClass = 'retryable' | 'fatal';

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Fraction of the backoff step added as jitter, e.g. 0.5 for up to +50%. */
  jitterRatio: number;
}

export interface RetryDeps {
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

export interface RetryOutcome<T> {
  value: T;
  attempts: number;
  retries: number;
}

/**
 * How long a writer waits for another process to release the write lock
 * before the engine reports contention. Turso honours this through
 * `DatabaseOpts.timeout`; without it a locked database fails in about a
 * millisecond and a writer can be starved out of the file entirely. The
 * ordinary SQLite control uses the same value as its `busy_timeout` so the
 * two are compared on equal terms.
 */
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 8,
  baseDelayMs: 25,
  maxDelayMs: 2000,
  jitterRatio: 0.5,
};

/**
 * Contention Turso reports when another connection -- in this or another
 * process -- holds the write lock, or is itself part way through opening the
 * file. All of these clear on their own, so they are worth backing off and
 * retrying.
 *
 * `Locking error` covers the open path specifically: a process that opens the
 * database while another is opening it can be rejected outright with
 * "already open without experimental multiprocess WAL in another process",
 * and `DatabaseOpts.timeout` does not cover that window.
 */
const RETRYABLE_PATTERNS = [/database is locked/iu, /table is locked/iu, /\bbusy\b/iu, /write-write conflict/iu, /SQLITE_BUSY/iu, /Locking error/iu];

/**
 * Classifies a mutation failure. Anything unrecognised is fatal on purpose:
 * retrying an error we do not understand risks looping on a real defect, and
 * a fatal error surfaces to pg-boss which retries the whole render job.
 */
export const classifyError = (error: unknown): ErrorClass => {
  if (!(error instanceof Error)) {
    return 'fatal';
  }

  return RETRYABLE_PATTERNS.some((pattern) => pattern.test(error.message)) ? 'retryable' : 'fatal';
};

/**
 * Exponential backoff for `attempt` (1-based), clamped to the policy maximum
 * both before and after jitter is added.
 */
export const backoffDelayMs = (attempt: number, policy: RetryPolicy, random: () => number): number => {
  const step = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
  const jittered = step + step * policy.jitterRatio * random();
  return Math.max(0, Math.floor(Math.min(jittered, policy.maxDelayMs)));
};

/**
 * Runs `operation`, retrying retryable failures with bounded jittered backoff.
 * Rethrows the last error once the attempt budget is spent, or immediately on
 * a fatal one.
 */
export const withRetry = async <T,>(operation: () => Promise<T>, policy: RetryPolicy, deps: RetryDeps): Promise<RetryOutcome<T>> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return { value: await operation(), attempts: attempt, retries: attempt - 1 };
    } catch (error) {
      if (classifyError(error) === 'fatal' || attempt >= policy.maxAttempts) {
        throw error;
      }
      await deps.sleep(backoffDelayMs(attempt, policy, deps.random));
    }
  }
};
