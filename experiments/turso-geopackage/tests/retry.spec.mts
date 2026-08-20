import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { backoffDelayMs, classifyError, DEFAULT_RETRY_POLICY, withRetry, type RetryPolicy } from '../lib/retry.mts';

const policy: RetryPolicy = { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 200, jitterRatio: 0.5 };

describe('classifyError', () => {
  it('treats a locked database as retryable, since another process holds the write lock', () => {
    assert.equal(classifyError(new Error('database is locked')), 'retryable');
  });

  it('treats busy and write-write conflicts as retryable', () => {
    assert.equal(classifyError(new Error('database table is busy')), 'retryable');
    assert.equal(classifyError(new Error('Transaction error: write-write conflict')), 'retryable');
  });

  it('matches regardless of case', () => {
    assert.equal(classifyError(new Error('Database Is Locked')), 'retryable');
  });

  it('treats a contended open as retryable, since another process is mid-open', () => {
    assert.equal(
      classifyError(
        new Error("Locking error: Failed opening database 'x'. Database is already open without experimental multiprocess WAL in another process")
      ),
      'retryable'
    );
  });

  it('treats a constraint violation as fatal, since retrying cannot fix it', () => {
    assert.equal(classifyError(new Error('UNIQUE constraint failed: tiles.zoom_level')), 'fatal');
  });

  it('treats an unrecognised failure as fatal rather than looping on it', () => {
    assert.equal(classifyError(new Error('disk I/O error')), 'fatal');
    assert.equal(classifyError('not an error at all'), 'fatal');
  });
});

describe('backoffDelayMs', () => {
  it('grows exponentially from the base delay', () => {
    assert.equal(
      backoffDelayMs(1, policy, () => 0),
      10
    );
    assert.equal(
      backoffDelayMs(2, policy, () => 0),
      20
    );
    assert.equal(
      backoffDelayMs(3, policy, () => 0),
      40
    );
  });

  it('clamps at the maximum delay', () => {
    assert.equal(
      backoffDelayMs(20, policy, () => 0),
      200
    );
  });

  it('adds jitter proportional to the clamped delay', () => {
    // random() === 1 adds the full jitter ratio on top of the base step.
    assert.equal(
      backoffDelayMs(1, policy, () => 1),
      15
    );
    // random() === 0.5 adds half of it.
    assert.equal(
      backoffDelayMs(1, policy, () => 0.5),
      12
    );
  });

  it('never exceeds the maximum delay once jitter is applied', () => {
    assert.equal(
      backoffDelayMs(20, policy, () => 1),
      200
    );
  });

  it('never returns a negative delay', () => {
    assert.ok(backoffDelayMs(1, { ...policy, baseDelayMs: 0 }, () => 1) >= 0);
  });

  it('ships a default policy with bounded attempts', () => {
    assert.ok(DEFAULT_RETRY_POLICY.maxAttempts > 1);
    assert.ok(DEFAULT_RETRY_POLICY.maxDelayMs >= DEFAULT_RETRY_POLICY.baseDelayMs);
  });
});

describe('withRetry', () => {
  const deps = { sleep: async (): Promise<void> => undefined, random: (): number => 0 };

  it('returns the value and reports a single attempt when the operation succeeds', async () => {
    const outcome = await withRetry(async () => 'ok', policy, deps);
    assert.deepEqual(outcome, { value: 'ok', attempts: 1, retries: 0 });
  });

  it('retries a retryable failure until it succeeds', async () => {
    let calls = 0;
    const outcome = await withRetry(
      async () => {
        calls++;
        if (calls < 3) {
          throw new Error('database is locked');
        }
        return calls;
      },
      policy,
      deps
    );
    assert.deepEqual(outcome, { value: 3, attempts: 3, retries: 2 });
  });

  it('waits for the backoff delay between attempts', async () => {
    const waits: number[] = [];
    let calls = 0;
    await withRetry(
      async () => {
        calls++;
        if (calls < 3) {
          throw new Error('database is locked');
        }
        return calls;
      },
      policy,
      {
        random: () => 0,
        sleep: async (ms: number): Promise<void> => {
          waits.push(ms);
        },
      }
    );
    assert.deepEqual(waits, [10, 20]);
  });

  it('gives up once the attempt budget is exhausted', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw new Error('database is locked');
        },
        { ...policy, maxAttempts: 3 },
        deps
      ),
      /database is locked/u
    );
    assert.equal(calls, 3);
  });

  it('does not retry a fatal failure', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw new Error('UNIQUE constraint failed');
        },
        policy,
        deps
      ),
      /UNIQUE constraint failed/u
    );
    assert.equal(calls, 1);
  });
});
