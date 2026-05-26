import { setTimeout as setTimeoutPromise } from 'node:timers/promises';
import { Registry } from 'prom-client';
import jsLogger from '@map-colonies/js-logger';
import { PgBoss } from 'pg-boss';
import { serializeError } from 'serialize-error';
import { PgBossJobQueueProvider } from '../../../src/retiler/jobQueueProvider/pgBossJobQueue';
import { LONG_RUNNING_TEST } from '../../integration/helpers';
import { type Tracer } from '@opentelemetry/api';

describe('PgBossJobQueueProvider', () => {
  let provider: PgBossJobQueueProvider;
  let tracerMock: { startActiveSpan: jest.Mock };
  let pgbossMock: {
    on: jest.Mock;
    start: jest.Mock;
    stop: jest.Mock;
    createQueue: jest.Mock;
    getQueueSize: jest.Mock;
    complete: jest.Mock;
    fail: jest.Mock;
    fetch: jest.Mock;
  };

  beforeAll(() => {
    pgbossMock = {
      on: jest.fn(),
      start: jest.fn(),
      stop: jest.fn(),
      createQueue: jest.fn().mockResolvedValue(undefined),
      getQueueSize: jest.fn(),
      complete: jest.fn(),
      fail: jest.fn(),
      fetch: jest.fn(),
    };
  });

  beforeEach(function () {
    tracerMock = {
      startActiveSpan: jest
        .fn()
        .mockImplementation((_name: string, _options: unknown, fn: (span: unknown) => unknown) =>
          fn({ setStatus: jest.fn(), recordException: jest.fn(), end: jest.fn() })
        ),
    };
    provider = new PgBossJobQueueProvider(
      pgbossMock as unknown as pgBoss,
      jsLogger({ enabled: false }),
      tracerMock as unknown as Tracer,
      'queue-name',
      50,
      new Registry()
    );
  });

  afterEach(function () {
    jest.clearAllMocks();
  });

  describe('#startQueue', () => {
    it('should start queue provider', async () => {
      await expect(provider.startQueue()).resolves.not.toThrow();
    });

    it('should throw if trying to start a started queue', async () => {
      await provider.startQueue();
      await expect(provider.startQueue()).rejects.toThrow();
    });
  });

  describe('#stopQueue', () => {
    it('should stop the queue provider', async () => {
      await provider.startQueue();
      await expect(provider.stopQueue()).resolves.not.toThrow();
    });

    it('should resolve if the queue is stopped when it was never started', async () => {
      await expect(provider.stopQueue()).resolves.not.toThrow();
    });
  });

  describe('#activeQueueName', () => {
    it('should return the queue name', () => {
      expect(provider.activeQueueName).toBe('queue-name');
    });
  });

  describe('#consumeQueue', () => {
    it(
      'should consume the queue and call the provided funcs',
      async () => {
        const job1 = [{ id: 'id1', data: { key: 'value' } }];
        const job2 = [{ id: 'id2', data: { key: 'value' } }];

        const fnMock = jest.fn();
        pgbossMock.fetch.mockResolvedValueOnce(job1).mockResolvedValueOnce(job2).mockResolvedValue([]);
        await provider.startQueue();
        const queuePromise = provider.consumeQueue(fnMock);
        await setTimeoutPromise(50);
        await provider.stopQueue();

        await expect(queuePromise).resolves.not.toThrow();

        expect(fnMock).toHaveBeenCalledTimes(2);
        expect(pgbossMock.complete).toHaveBeenCalledTimes(2);
        expect(pgbossMock.fail).not.toHaveBeenCalled();
      },
      LONG_RUNNING_TEST
    );

    it('should consume the queue in parallel when enabled', async () => {
      const job1 = [{ id: 'id1', data: { key: 'value' } }];
      const job2 = [{ id: 'id2', data: { key: 'value' } }];
      const job3 = [{ id: 'id3', data: { key: 'value' } }];

      const fnMock = jest.fn();
      pgbossMock.fetch.mockResolvedValueOnce(job1).mockResolvedValueOnce(job2).mockResolvedValueOnce(job3).mockResolvedValueOnce([]);

      await provider.startQueue();
      const queuePromise = provider.consumeQueue(fnMock, 2);
      await setTimeoutPromise(50);
      await provider.stopQueue();

      await expect(queuePromise).resolves.not.toThrow();

      expect(fnMock).toHaveBeenCalledTimes(3);
      expect(pgbossMock.complete).toHaveBeenCalledTimes(3);
      expect(pgbossMock.fail).not.toHaveBeenCalled();
    });

    it('should reject with an error if provided function for consuming has failed', async () => {
      const id = 'someId';
      pgbossMock.fetch.mockResolvedValueOnce([{ id }]);

      const fnMock = jest.fn();
      const fetchError = new Error('fetch error');
      fnMock.mockRejectedValue(fetchError);

      await provider.startQueue();
      const queuePromise = provider.consumeQueue(fnMock);
      await setTimeoutPromise(50);
      await provider.stopQueue();
      await expect(queuePromise).resolves.not.toThrow();

      expect(pgbossMock.complete).not.toHaveBeenCalled();
      expect(pgbossMock.fail).toHaveBeenCalledWith('queue-name', id, serializeError(fetchError));
    });
  });
});
