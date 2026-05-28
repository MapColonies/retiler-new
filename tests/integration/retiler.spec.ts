/* eslint-disable @typescript-eslint/naming-convention */
import * as fsPromises from 'fs/promises';
import { setTimeout as setTimeoutPromise } from 'node:timers/promises';
import { Registry } from 'prom-client';
import jsLogger from '@map-colonies/js-logger';
import { trace } from '@opentelemetry/api';
import { DependencyContainer } from 'tsyringe';
import { PgBoss } from 'pg-boss';
import nock, { Interceptor, Scope } from 'nock';
import { Tile } from '@map-colonies/tile-calc';
import format from 'string-format';
import httpStatusCodes from 'http-status-codes';
import { CleanupRegistry } from '@map-colonies/cleanup-registry';
import { ConfigType, getConfig, initConfig } from '@src/common/config';
import { registerExternalValues } from '../../src/containerConfig';
import { consumeAndProcessFactory } from '../../src/app';
import {
  JOB_QUEUE_PROVIDER,
  MAP_URL,
  METRICS_REGISTRY,
  QUEUE_NAME,
  SERVICES,
  TILES_STORAGE_LAYOUT,
  TILES_STORAGE_PROVIDERS,
} from '../../src/common/constants';
import { PgBossJobQueueProvider } from '../../src/retiler/jobQueueProvider/pgBossJobQueue';
import { TilesStorageProvider } from '../../src/retiler/interfaces';
import { getFlippedY } from '../../src/retiler/util';
import { TileStoragLayout } from '../../src/retiler/tilesStorageProvider/interfaces';
import { FS_FILE_NOT_FOUND_ERROR_CODE } from '../../src/retiler/tilesStorageProvider/constants';
import { createBlankBuffer, LONG_RUNNING_TEST, waitForJobToBeResolved } from './helpers';

const s3SendMock = jest.fn<Promise<unknown>, []>();

const cleanupQueue = async (pgBoss: PgBoss, queueName: string): Promise<void> => {
  await pgBoss.start();
  await pgBoss.deleteAllJobs(queueName);
  await pgBoss.stop({ graceful: false });
};

jest.mock('fs/promises', () => ({
  ...jest.requireActual<Record<string, unknown>>('fs/promises'),
  writeFile: jest.fn(),
  unlink: jest.fn(),
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({
    send: s3SendMock,
    destroy: jest.fn(),
    middlewareStack: {
      add: jest.fn(),
    },
    config: {
      region: jest.fn().mockReturnValue('test-region'),
      endpointProvider: jest.fn().mockReturnValue('test-endpoint'),
    },
  })),
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  PutObjectCommand: jest.fn().mockImplementation((input: unknown) => input),
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  DeleteObjectsCommand: jest.fn().mockImplementation((input: unknown) => input),
}));

describe('retiler', function () {
  let config: ConfigType;
  let mapUrl: string;
  let stateUrl: string;
  let detilerUrl: string;
  let getMapInterceptor: Interceptor;
  let stateInterceptor: Interceptor;
  let detilerScope: Scope;
  let detilerGetInterceptor: Interceptor;
  let cooldownsGetInterceptor: Interceptor;
  let detilerPutInterceptor: Interceptor;
  let stateBuffer: Buffer;
  let mapBuffer2048x2048: Buffer;
  let mapBuffer512x512: Buffer;
  let determineKey: (tile: Required<Tile>) => string;

  beforeAll(async () => {
    await initConfig(true);
    config = getConfig();
    mapUrl = config.get('app.map.url');
    detilerUrl = config.get('detiler.client.url') as string;
    stateUrl = config.get('app.project.stateUrl');
    stateBuffer = await fsPromises.readFile('tests/state.txt');
    mapBuffer512x512 = await fsPromises.readFile('tests/512x512.png');
    mapBuffer2048x2048 = await fsPromises.readFile('tests/2048x2048.png');
  });

  beforeEach(() => {
    getMapInterceptor = nock(mapUrl).defaultReplyHeaders({ 'content-type': 'image/png' }).get(/.*/);
    stateInterceptor = nock(stateUrl).get(/.*/);
    detilerScope = nock(detilerUrl);
    detilerGetInterceptor = detilerScope.get(/^\/detail/);
    cooldownsGetInterceptor = detilerScope.get(/^\/cooldown/);
    detilerPutInterceptor = detilerScope.put(/.*/);
  });

  afterEach(function () {
    nock.cleanAll();
    jest.clearAllMocks();
  });

  describe('arcgis', function () {
    let container: DependencyContainer;

    beforeEach(async () => {
      container = await registerExternalValues({
        override: [
          {
            token: SERVICES.CONFIG,
            provider: {
              useValue: {
                get: (key: string) => {
                  switch (key) {
                    case 'app.map.provider':
                      return 'arcgis';
                    default:
                      return config.get(key);
                  }
                },
              },
            },
          },
          { token: SERVICES.LOGGER, provider: { useValue: jsLogger({ enabled: false }) } },
          { token: SERVICES.TRACER, provider: { useValue: trace.getTracer('testTracer') } },
          { token: METRICS_REGISTRY, provider: { useValue: new Registry() } },
          { token: TILES_STORAGE_LAYOUT, provider: { useValue: { format: '{z}/{x}/{y}.png', shouldFlipY: true } } },
        ],
        useChild: true,
      });

      const storageLayout = container.resolve<TileStoragLayout>(TILES_STORAGE_LAYOUT);

      determineKey = (tile: Required<Tile>): string => {
        if (storageLayout.shouldFlipY) {
          tile.y = getFlippedY(tile);
        }
        const key = format(storageLayout.format, tile);
        return key;
      };
    });

    afterEach(async () => {
      const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
      const queueName = container.resolve<string>(QUEUE_NAME);
      await cleanupQueue(pgBoss, queueName);
    });

    afterAll(async () => {
      const cleanupRegistry = container.resolve<CleanupRegistry>(SERVICES.CLEANUP_REGISTRY);
      await cleanupRegistry.trigger();
      container.reset();
    });

    describe('Happy Path', function () {
      it(
        'should complete a single job',
        async function () {
          detilerGetInterceptor.reply(httpStatusCodes.NOT_FOUND);
          detilerPutInterceptor.reply(httpStatusCodes.OK);
          const getMapScope = getMapInterceptor.reply(httpStatusCodes.OK, mapBuffer512x512);

          const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
          const provider = container.resolve<PgBossJobQueueProvider>(JOB_QUEUE_PROVIDER);
          const queueName = container.resolve<string>(QUEUE_NAME);
          const jobId = await pgBoss.send({ name: queueName, data: { z: 1, x: 0, y: 0, metatile: 2, parent: 'parent' } });

          const consumePromise = consumeAndProcessFactory(container)();

          const storageProviders = container.resolve<TilesStorageProvider[]>(TILES_STORAGE_PROVIDERS);
          const storeTileSpies = storageProviders.map((provider) => jest.spyOn(provider, 'storeTile'));

          const job = await waitForJobToBeResolved(pgBoss, queueName, jobId as string);
          await provider.stopQueue();

          await expect(consumePromise).resolves.not.toThrow();

          expect(job).toHaveProperty('state', 'completed');

          storeTileSpies.forEach((spy) => expect(spy.mock.calls).toHaveLength(4));

          for (const storeTileSpy of storeTileSpies) {
            for (let i = 0; i < 4; i++) {
              const storeCall = storeTileSpy.mock.calls[i]![0];
              const key = determineKey({ x: storeCall.x, y: storeCall.y, z: storeCall.z, metatile: storeCall.metatile });
              const expectedBuffer = await fsPromises.readFile(`tests/integration/expected/${key}`);
              expect(expectedBuffer.compare(storeCall.buffer)).toBe(0);
            }
          }

          getMapScope.done();
          detilerScope.done();
        },
        LONG_RUNNING_TEST
      );

      it(
        'should complete a single job that has state',
        async function () {
          detilerGetInterceptor.reply(httpStatusCodes.NOT_FOUND);
          detilerPutInterceptor.reply(httpStatusCodes.OK);
          const getMapScope = getMapInterceptor.reply(httpStatusCodes.OK, mapBuffer512x512);

          const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
          const provider = container.resolve<PgBossJobQueueProvider>(JOB_QUEUE_PROVIDER);
          const queueName = container.resolve<string>(QUEUE_NAME);
          const jobId = await pgBoss.send({ name: queueName, data: { z: 1, x: 0, y: 0, metatile: 2, parent: 'parent', state: 666 } });

          const consumePromise = consumeAndProcessFactory(container)();

          const storageProviders = container.resolve<TilesStorageProvider[]>(TILES_STORAGE_PROVIDERS);
          const storeTileSpies = storageProviders.map((provider) => jest.spyOn(provider, 'storeTile'));

          const job = await waitForJobToBeResolved(pgBoss, queueName, jobId as string);
          await provider.stopQueue();

          await expect(consumePromise).resolves.not.toThrow();

          expect(job).toHaveProperty('state', 'completed');
          expect(job).toHaveProperty('data.state', 666);

          storeTileSpies.forEach((spy) => expect(spy.mock.calls).toHaveLength(4));

          for (const storeTileSpy of storeTileSpies) {
            for (let i = 0; i < 4; i++) {
              const storeCall = storeTileSpy.mock.calls[i]![0];
              const key = determineKey({ x: storeCall.x, y: storeCall.y, z: storeCall.z, metatile: storeCall.metatile });
              const expectedBuffer = await fsPromises.readFile(`tests/integration/expected/${key}`);
              expect(expectedBuffer.compare(storeCall.buffer)).toBe(0);
            }
          }

          getMapScope.done();
          detilerScope.done();
        },
        LONG_RUNNING_TEST
      );

      it(
        'should complete a single job where tile is skipped',
        async function () {
          detilerGetInterceptor.reply(httpStatusCodes.OK, { renderedAt: 1705353636, updateedAt: 9999999999 });
          detilerPutInterceptor.reply(httpStatusCodes.OK);
          const stateScope = stateInterceptor.reply(httpStatusCodes.OK, stateBuffer);

          const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
          const provider = container.resolve<PgBossJobQueueProvider>(JOB_QUEUE_PROVIDER);
          const queueName = container.resolve<string>(QUEUE_NAME);
          const jobId = await pgBoss.send({ name: queueName, data: { z: 1, x: 0, y: 0, metatile: 2, parent: 'parent' } });

          const consumePromise = consumeAndProcessFactory(container)();

          const storageProviders = container.resolve<TilesStorageProvider[]>(TILES_STORAGE_PROVIDERS);
          const storeTileSpies = storageProviders.map((provider) => jest.spyOn(provider, 'storeTile'));

          const job = await waitForJobToBeResolved(pgBoss, queueName, jobId as string);
          await provider.stopQueue();

          await expect(consumePromise).resolves.not.toThrow();

          expect(job).toHaveProperty('state', 'completed');

          storeTileSpies.forEach((spy) => expect(spy.mock.calls).toHaveLength(0));

          detilerScope.done();
          stateScope.done();
        },
        LONG_RUNNING_TEST
      );

      it(
        'should complete a single job where tile is not skipped',
        async function () {
          detilerGetInterceptor.reply(httpStatusCodes.OK, { renderedAt: 0 });
          detilerPutInterceptor.reply(httpStatusCodes.OK);
          const stateScope = stateInterceptor.reply(httpStatusCodes.OK, stateBuffer);
          const getMapScope = getMapInterceptor.reply(httpStatusCodes.OK, mapBuffer512x512);

          const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
          const provider = container.resolve<PgBossJobQueueProvider>(JOB_QUEUE_PROVIDER);
          const queueName = container.resolve<string>(QUEUE_NAME);
          const jobId = await pgBoss.send({ name: queueName, data: { z: 1, x: 0, y: 0, metatile: 2, parent: 'parent' } });

          const consumePromise = consumeAndProcessFactory(container)();

          const storageProviders = container.resolve<TilesStorageProvider[]>(TILES_STORAGE_PROVIDERS);
          const storeTileSpies = storageProviders.map((provider) => jest.spyOn(provider, 'storeTile'));

          const job = await waitForJobToBeResolved(pgBoss, queueName, jobId as string);
          await provider.stopQueue();

          await expect(consumePromise).resolves.not.toThrow();

          expect(job).toHaveProperty('state', 'completed');

          storeTileSpies.forEach((spy) => expect(spy.mock.calls).toHaveLength(4));

          for (const storeTileSpy of storeTileSpies) {
            for (let i = 0; i < 4; i++) {
              const storeCall = storeTileSpy.mock.calls[i]![0];
              const key = determineKey({ x: storeCall.x, y: storeCall.y, z: storeCall.z, metatile: storeCall.metatile });
              const expectedBuffer = await fsPromises.readFile(`tests/integration/expected/${key}`);
              expect(expectedBuffer.compare(storeCall.buffer)).toBe(0);
            }
          }

          getMapScope.done();
          detilerScope.done();
          stateScope.done();
        },
        LONG_RUNNING_TEST
      );

      it(
        'should complete a single job where tile is not skipped even if a cooldown is found',
        async function () {
          detilerGetInterceptor.reply(httpStatusCodes.OK, { renderedAt: 0 });
          cooldownsGetInterceptor.reply(httpStatusCodes.OK, [{ duration: 1 }]);
          detilerPutInterceptor.reply(httpStatusCodes.OK);
          const stateScope = stateInterceptor.reply(httpStatusCodes.OK, stateBuffer);
          const getMapScope = getMapInterceptor.reply(httpStatusCodes.OK, mapBuffer512x512);

          const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
          const provider = container.resolve<PgBossJobQueueProvider>(JOB_QUEUE_PROVIDER);
          const queueName = container.resolve<string>(QUEUE_NAME);
          const jobId = await pgBoss.send({ name: queueName, data: { z: 1, x: 0, y: 0, metatile: 2, parent: 'parent' } });

          const consumePromise = consumeAndProcessFactory(container)();

          const storageProviders = container.resolve<TilesStorageProvider[]>(TILES_STORAGE_PROVIDERS);
          const storeTileSpies = storageProviders.map((provider) => jest.spyOn(provider, 'storeTile'));

          const job = await waitForJobToBeResolved(pgBoss, queueName, jobId as string);
          await provider.stopQueue();

          await expect(consumePromise).resolves.not.toThrow();

          expect(job).toHaveProperty('state', 'completed');

          storeTileSpies.forEach((spy) => expect(spy.mock.calls).toHaveLength(4));

          for (const storeTileSpy of storeTileSpies) {
            for (let i = 0; i < 4; i++) {
              const storeCall = storeTileSpy.mock.calls[i]![0];
              const key = determineKey({ x: storeCall.x, y: storeCall.y, z: storeCall.z, metatile: storeCall.metatile });
              const expectedBuffer = await fsPromises.readFile(`tests/integration/expected/${key}`);
              expect(expectedBuffer.compare(storeCall.buffer)).toBe(0);
            }
          }

          getMapScope.done();
          detilerScope.done();
          stateScope.done();
        },
        LONG_RUNNING_TEST
      );

      it(
        'should complete a single job where tile processing is skipped due to cooldown',
        async function () {
          detilerGetInterceptor.reply(httpStatusCodes.OK, { renderedAt: 0 });
          cooldownsGetInterceptor.reply(httpStatusCodes.OK, [{ duration: 9999999999 }]);
          detilerPutInterceptor.reply(httpStatusCodes.OK);
          const stateScope = stateInterceptor.reply(httpStatusCodes.OK, stateBuffer);

          const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
          const provider = container.resolve<PgBossJobQueueProvider>(JOB_QUEUE_PROVIDER);
          const queueName = container.resolve<string>(QUEUE_NAME);
          const jobId = await pgBoss.send({ name: queueName, data: { z: 1, x: 0, y: 0, metatile: 2, parent: 'parent' } });

          const consumePromise = consumeAndProcessFactory(container)();

          const storageProviders = container.resolve<TilesStorageProvider[]>(TILES_STORAGE_PROVIDERS);
          const storeTileSpies = storageProviders.map((provider) => jest.spyOn(provider, 'storeTile'));

          const job = await waitForJobToBeResolved(pgBoss, queueName, jobId as string);
          await provider.stopQueue();

          await expect(consumePromise).resolves.not.toThrow();

          expect(job).toHaveProperty('state', 'completed');

          storeTileSpies.forEach((spy) => expect(spy.mock.calls).toHaveLength(0));

          detilerScope.done();
          stateScope.done();
        },
        LONG_RUNNING_TEST
      );

      it(
        'should complete a single job where tile is forced',
        async function () {
          detilerPutInterceptor.reply(httpStatusCodes.OK);
          const getMapScope = getMapInterceptor.reply(httpStatusCodes.OK, mapBuffer512x512);

          const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
          const provider = container.resolve<PgBossJobQueueProvider>(JOB_QUEUE_PROVIDER);
          const queueName = container.resolve<string>(QUEUE_NAME);
          const jobId = await pgBoss.send({ name: queueName, data: { z: 1, x: 0, y: 0, metatile: 2, parent: 'parent', force: true } });

          const consumePromise = consumeAndProcessFactory(container)();

          const storageProviders = container.resolve<TilesStorageProvider[]>(TILES_STORAGE_PROVIDERS);
          const storeTileSpies = storageProviders.map((provider) => jest.spyOn(provider, 'storeTile'));

          const job = await waitForJobToBeResolved(pgBoss, queueName, jobId as string);
          await provider.stopQueue();

          await expect(consumePromise).resolves.not.toThrow();

          expect(job).toHaveProperty('state', 'completed');
          expect(job).toHaveProperty('data.force', true);

          storeTileSpies.forEach((spy) => expect(spy.mock.calls).toHaveLength(4));

          for (const storeTileSpy of storeTileSpies) {
            for (let i = 0; i < 4; i++) {
              const storeCall = storeTileSpy.mock.calls[i]![0];
              const key = determineKey({ x: storeCall.x, y: storeCall.y, z: storeCall.z, metatile: storeCall.metatile });
              const expectedBuffer = await fsPromises.readFile(`tests/integration/expected/${key}`);
              expect(expectedBuffer.compare(storeCall.buffer)).toBe(0);
            }
          }

          getMapScope.done();
          detilerScope.done();
        },
        LONG_RUNNING_TEST
      );

      it(
        'should complete multiple jobs',
        async function () {
          detilerGetInterceptor.reply(httpStatusCodes.NOT_FOUND);
          detilerGetInterceptor.reply(httpStatusCodes.NOT_FOUND);
          detilerGetInterceptor.reply(httpStatusCodes.NOT_FOUND);
          detilerPutInterceptor.reply(httpStatusCodes.OK);
          detilerPutInterceptor.reply(httpStatusCodes.OK);
          detilerPutInterceptor.reply(httpStatusCodes.OK);
          const getMapScope = getMapInterceptor.reply(httpStatusCodes.OK, mapBuffer2048x2048);
          getMapInterceptor.reply(httpStatusCodes.OK, mapBuffer2048x2048);
          getMapInterceptor.reply(httpStatusCodes.OK, mapBuffer2048x2048);

          const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
          const provider = container.resolve<PgBossJobQueueProvider>(JOB_QUEUE_PROVIDER);
          const queueName = container.resolve<string>(QUEUE_NAME);
          const request1 = { name: queueName, data: { z: 0, x: 0, y: 0, metatile: 8, parent: 'parent' } };
          const request2 = { name: queueName, data: { z: 1, x: 0, y: 0, metatile: 8, parent: 'parent' } };
          const request3 = { name: queueName, data: { z: 2, x: 0, y: 0, metatile: 8, parent: 'parent' } };

          const [jobId1, jobId2, jobId3] = await Promise.all([pgBoss.send(request1), pgBoss.send(request2), pgBoss.send(request3)]);

          const consumePromise = consumeAndProcessFactory(container)();

          const [job1, job2, job3] = await Promise.all([
            waitForJobToBeResolved(pgBoss, queueName, jobId1 as string),
            waitForJobToBeResolved(pgBoss, queueName, jobId2 as string),
            waitForJobToBeResolved(pgBoss, queueName, jobId3 as string),
          ]);

          await provider.stopQueue();

          await expect(consumePromise).resolves.not.toThrow();

          expect(job1).toHaveProperty('state', 'completed');
          expect(job2).toHaveProperty('state', 'completed');
          expect(job3).toHaveProperty('state', 'completed');

          getMapScope.done();
          detilerScope.done();
        },
        LONG_RUNNING_TEST
      );

      it(
        'should complete multiple jobs where some are forced',
        async function () {
          detilerGetInterceptor.reply(httpStatusCodes.NOT_FOUND);
          detilerGetInterceptor.reply(httpStatusCodes.OK, { renderedAt: 0 });
          detilerPutInterceptor.reply(httpStatusCodes.OK);
          detilerPutInterceptor.reply(httpStatusCodes.OK);
          detilerPutInterceptor.reply(httpStatusCodes.OK);
          const stateScope = stateInterceptor.reply(httpStatusCodes.OK, stateBuffer);
          stateInterceptor.reply(httpStatusCodes.OK, stateBuffer);
          const getMapScope = getMapInterceptor.reply(httpStatusCodes.OK, mapBuffer2048x2048);
          getMapInterceptor.reply(httpStatusCodes.OK, mapBuffer2048x2048);
          getMapInterceptor.reply(httpStatusCodes.OK, mapBuffer2048x2048);

          const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
          const provider = container.resolve<PgBossJobQueueProvider>(JOB_QUEUE_PROVIDER);
          const queueName = container.resolve<string>(QUEUE_NAME);
          const request1 = { name: queueName, data: { z: 0, x: 0, y: 0, metatile: 8, parent: 'parent', force: true } };
          const request2 = { name: queueName, data: { z: 1, x: 0, y: 0, metatile: 8, parent: 'parent', force: false } };
          const request3 = { name: queueName, data: { z: 2, x: 0, y: 0, metatile: 8, parent: 'parent' } };

          const [jobId1, jobId2, jobId3] = await Promise.all([pgBoss.send(request1), pgBoss.send(request2), pgBoss.send(request3)]);

          const consumePromise = consumeAndProcessFactory(container)();

          const [job1, job2, job3] = await Promise.all([
            waitForJobToBeResolved(pgBoss, queueName, jobId1 as string),
            waitForJobToBeResolved(pgBoss, queueName, jobId2 as string),
            waitForJobToBeResolved(pgBoss, queueName, jobId3 as string),
          ]);

          await provider.stopQueue();

          await expect(consumePromise).resolves.not.toThrow();

          expect(job1).toHaveProperty('state', 'completed');
          expect(job1).toHaveProperty('data.force', true);
          expect(job2).toHaveProperty('state', 'completed');
          expect(job2).toHaveProperty('data.force', false);
          expect(job3).toHaveProperty('state', 'completed');
          expect(job3).not.toHaveProperty('data.force');

          getMapScope.done();
          detilerScope.done();
          stateScope.done();
        },
        LONG_RUNNING_TEST
      );

      it(
        'should complete some jobs even when one fails',
        async function () {
          detilerGetInterceptor.reply(httpStatusCodes.NOT_FOUND);
          detilerGetInterceptor.reply(httpStatusCodes.NOT_FOUND);
          detilerGetInterceptor.reply(httpStatusCodes.NOT_FOUND);
          detilerPutInterceptor.reply(httpStatusCodes.OK);
          detilerPutInterceptor.reply(httpStatusCodes.OK);
          const getMapScope = getMapInterceptor.reply(httpStatusCodes.OK, mapBuffer2048x2048);
          getMapInterceptor.reply(httpStatusCodes.OK, mapBuffer2048x2048);

          const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
          const queueName = container.resolve<string>(QUEUE_NAME);
          const provider = container.resolve<PgBossJobQueueProvider>(JOB_QUEUE_PROVIDER);
          const request1 = { name: queueName, data: { z: 0, x: 10, y: 10, metatile: 8, parent: 'parent' } };
          const request2 = { name: queueName, data: { z: 1, x: 0, y: 0, metatile: 8, parent: 'parent' } };
          const request3 = { name: queueName, data: { z: 2, x: 0, y: 0, metatile: 8, parent: 'parent' } };

          const [jobId1, jobId2, jobId3] = await Promise.all([pgBoss.send(request1), pgBoss.send(request2), pgBoss.send(request3)]);

          const consumePromise = consumeAndProcessFactory(container)();

          const [job1, job2, job3] = await Promise.all([
            waitForJobToBeResolved(pgBoss, queueName, jobId1 as string),
            waitForJobToBeResolved(pgBoss, queueName, jobId2 as string),
            waitForJobToBeResolved(pgBoss, queueName, jobId3 as string),
          ]);

          await provider.stopQueue();

          await expect(consumePromise).resolves.not.toThrow();

          expect(job1).toHaveProperty('state', 'failed');
          expect(job1).toHaveProperty('output.message', 'x index out of range of tile grid');
          expect(job2).toHaveProperty('state', 'completed');
          expect(job3).toHaveProperty('state', 'completed');

          getMapScope.done();
          detilerScope.done();
        },
        LONG_RUNNING_TEST
      );

      it(
        'should complete even if detiler get throws an error',
        async function () {
          const detilerGetScope = nock(detilerUrl).get(/.*/).replyWithError({ message: 'detiler get error' });
          const getMapScope = getMapInterceptor.reply(httpStatusCodes.OK, mapBuffer512x512);
          detilerPutInterceptor.reply(httpStatusCodes.OK);

          const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
          const provider = container.resolve<PgBossJobQueueProvider>(JOB_QUEUE_PROVIDER);
          const queueName = container.resolve<string>(QUEUE_NAME);
          const jobId = await pgBoss.send({ name: queueName, data: { z: 0, x: 0, y: 0, metatile: 8, parent: 'parent' } });

          const consumePromise = consumeAndProcessFactory(container)();

          const job = await waitForJobToBeResolved(pgBoss, queueName, jobId as string);

          await provider.stopQueue();

          await expect(consumePromise).resolves.not.toThrow();

          expect(job).toHaveProperty('state', 'completed');

          detilerGetScope.done();
          getMapScope.done();
        },
        LONG_RUNNING_TEST
      );

      it(
        'should completed even if getting state throws an error',
        async function () {
          detilerGetInterceptor.reply(httpStatusCodes.OK, { renderedAt: 0 });
          const stateScope = nock(stateUrl).get(/.*/).replyWithError({ message: 'state get error' });
          const getMapScope = getMapInterceptor.reply(httpStatusCodes.OK, mapBuffer512x512);
          detilerPutInterceptor.reply(httpStatusCodes.OK);

          const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
          const provider = container.resolve<PgBossJobQueueProvider>(JOB_QUEUE_PROVIDER);
          const queueName = container.resolve<string>(QUEUE_NAME);
          const jobId = await pgBoss.send({ name: queueName, data: { z: 0, x: 0, y: 0, metatile: 8, parent: 'parent' } });

          const consumePromise = consumeAndProcessFactory(container)();

          const job = await waitForJobToBeResolved(pgBoss, queueName, jobId as string);

          await provider.stopQueue();

          await expect(consumePromise).resolves.not.toThrow();

          expect(job).toHaveProperty('state', 'completed');

          detilerScope.done();
          getMapScope.done();
          stateScope.done();
        },
        LONG_RUNNING_TEST
      );

      it(
        'should complete even if detiler set throws an error',
        async function () {
          detilerGetInterceptor.reply(httpStatusCodes.NOT_FOUND);
          const detilerSetScope = nock(detilerUrl).put(/.*/).replyWithError({ message: 'detiler set error' });
          const getMapScope = getMapInterceptor.reply(httpStatusCodes.OK, mapBuffer512x512);

          const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
          const provider = container.resolve<PgBossJobQueueProvider>(JOB_QUEUE_PROVIDER);
          const queueName = container.resolve<string>(QUEUE_NAME);
          const jobId = await pgBoss.send({ name: queueName, data: { z: 0, x: 0, y: 0, metatile: 8, parent: 'parent' } });

          const consumePromise = consumeAndProcessFactory(container)();

          const job = await waitForJobToBeResolved(pgBoss, queueName, jobId as string);

          await provider.stopQueue();

          await expect(consumePromise).resolves.not.toThrow();

          expect(job).toHaveProperty('state', 'completed');

          detilerScope.done();
          getMapScope.done();
          detilerSetScope.done();
        },
        LONG_RUNNING_TEST
      );
    });

    describe('Bad Path', function () {
      it(
        'should fail the job if the tile is out of bounds',
        async function () {
          detilerGetInterceptor.reply(httpStatusCodes.NOT_FOUND);
          const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
          const provider = container.resolve<PgBossJobQueueProvider>(JOB_QUEUE_PROVIDER);
          const queueName = container.resolve<string>(QUEUE_NAME);
          const jobId = await pgBoss.send({ name: queueName, data: { z: 0, x: 10, y: 10, metatile: 8, parent: 'parent' } });

          const consumePromise = consumeAndProcessFactory(container)();

          const job = await waitForJobToBeResolved(pgBoss, queueName, jobId as string);

          await provider.stopQueue();

          await expect(consumePromise).resolves.not.toThrow();

          expect(job).toHaveProperty('state', 'failed');
          expect(job).toHaveProperty('output.message', 'x index out of range of tile grid');
          detilerScope.done();
        },
        LONG_RUNNING_TEST
      );

      it(
        'should fail the job if map fetching service returns an error',
        async function () {
          detilerGetInterceptor.reply(httpStatusCodes.NOT_FOUND);
          const mapUrl = container.resolve<string>(MAP_URL);
          const getMapScope = nock(mapUrl).get(/.*/).replyWithError({ message: 'fetching map error' });

          const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
          const provider = container.resolve<PgBossJobQueueProvider>(JOB_QUEUE_PROVIDER);
          const queueName = container.resolve<string>(QUEUE_NAME);
          const jobId = await pgBoss.send({ name: queueName, data: { z: 0, x: 0, y: 0, metatile: 8, parent: 'parent' } });

          const consumePromise = consumeAndProcessFactory(container)();

          const job = await waitForJobToBeResolved(pgBoss, queueName, jobId as string);

          await provider.stopQueue();

          await expect(consumePromise).resolves.not.toThrow();

          expect(job).toHaveProperty('state', 'failed');
          expect(job).toHaveProperty('output.message', 'fetching map error');

          getMapScope.done();
          detilerScope.done();
        },
        LONG_RUNNING_TEST
      );

      it(
        'should fail the job if map fetching service is unavailable',
        async function () {
          detilerGetInterceptor.reply(httpStatusCodes.NOT_FOUND);
          const getMapScope = getMapInterceptor.reply(httpStatusCodes.SERVICE_UNAVAILABLE);

          const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
          const provider = container.resolve<PgBossJobQueueProvider>(JOB_QUEUE_PROVIDER);
          const queueName = container.resolve<string>(QUEUE_NAME);
          const jobId = await pgBoss.send({ name: queueName, data: { z: 0, x: 0, y: 0, metatile: 8, parent: 'parent' } });

          const consumePromise = consumeAndProcessFactory(container)();

          const job = await waitForJobToBeResolved(pgBoss, queueName, jobId as string);

          await provider.stopQueue();

          await expect(consumePromise).resolves.not.toThrow();

          expect(job).toHaveProperty('state', 'failed');
          expect(job).toHaveProperty('output.message', 'Request failed with status code 503');

          getMapScope.done();
          detilerScope.done();
        },
        LONG_RUNNING_TEST
      );

      it(
        'should fail the job if tile storage provider storeTile had thrown an error',
        async function () {
          detilerGetInterceptor.reply(httpStatusCodes.NOT_FOUND);
          const getMapScope = getMapInterceptor.reply(httpStatusCodes.OK, mapBuffer2048x2048);

          const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
          const provider = container.resolve<PgBossJobQueueProvider>(JOB_QUEUE_PROVIDER);
          const queueName = container.resolve<string>(QUEUE_NAME);
          const jobId = await pgBoss.send({ name: queueName, data: { z: 0, x: 0, y: 0, metatile: 8, parent: 'parent' } });

          const error = new Error('storing error');

          const consumePromise = consumeAndProcessFactory(container)();

          const storageProviders = container.resolve<TilesStorageProvider[]>(TILES_STORAGE_PROVIDERS);
          jest.spyOn(storageProviders[0]!, 'storeTile').mockRejectedValue(error);

          const job = await waitForJobToBeResolved(pgBoss, queueName, jobId as string);

          await provider.stopQueue();

          await expect(consumePromise).resolves.not.toThrow();

          expect(job).toHaveProperty('state', 'failed');
          expect(job).toHaveProperty('output.message', error.message);

          getMapScope.done();
          detilerScope.done();
        },
        LONG_RUNNING_TEST
      );

      it(
        'should fail the job if s3 tile storage provider storeTile had thrown an error',
        async function () {
          detilerGetInterceptor.reply(httpStatusCodes.NOT_FOUND);
          const getMapScope = getMapInterceptor.reply(httpStatusCodes.OK, mapBuffer2048x2048);
          const errorMessage = 'send error';
          const error = new Error(errorMessage);
          s3SendMock.mockRejectedValueOnce(error);

          const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
          const provider = container.resolve<PgBossJobQueueProvider>(JOB_QUEUE_PROVIDER);
          const queueName = container.resolve<string>(QUEUE_NAME);
          const jobId = await pgBoss.send({ name: queueName, data: { z: 0, x: 0, y: 0, metatile: 8, parent: 'parent' } });

          const consumePromise = consumeAndProcessFactory(container)();

          const job = await waitForJobToBeResolved(pgBoss, queueName, jobId as string);

          await provider.stopQueue();

          await expect(consumePromise).resolves.not.toThrow();

          expect(job).toHaveProperty('state', 'failed');
          const jobOutput = job?.output as object as { [index: string]: string };
          expect(jobOutput['message']).toContain(error.message);

          getMapScope.done();
          detilerScope.done();
        },
        LONG_RUNNING_TEST
      );

      it(
        'should fail the job if fs tile storage provider storeTile had thrown an error',
        async function () {
          detilerGetInterceptor.reply(httpStatusCodes.NOT_FOUND);
          const getMapScope = getMapInterceptor.reply(httpStatusCodes.OK, mapBuffer2048x2048);
          const errorMessage = 'write error';
          const error = new Error(errorMessage);
          (fsPromises.writeFile as unknown as jest.Mock).mockRejectedValueOnce(error);

          const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
          const provider = container.resolve<PgBossJobQueueProvider>(JOB_QUEUE_PROVIDER);
          const queueName = container.resolve<string>(QUEUE_NAME);
          const jobId = await pgBoss.send({ name: queueName, data: { z: 0, x: 0, y: 0, metatile: 8, parent: 'parent' } });

          const consumePromise = consumeAndProcessFactory(container)();

          const job = await waitForJobToBeResolved(pgBoss, queueName, jobId as string);

          await provider.stopQueue();

          await expect(consumePromise).resolves.not.toThrow();

          expect(job).toHaveProperty('state', 'failed');
          const jobOutput = job?.output as object as { [index: string]: string };
          expect(jobOutput['message']).toContain(error.message);

          getMapScope.done();
          detilerScope.done();
        },
        LONG_RUNNING_TEST
      );
    });

    describe('Sad Path', function () {
      it('should throw an error if pgboss rejects fetching', async function () {
        const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);

        const fetchError = new Error('fetch error');
        jest.spyOn(pgBoss, 'fetch').mockRejectedValue(fetchError);

        const promise = consumeAndProcessFactory(container)();
        await expect(promise).rejects.toThrow(fetchError);
      });
    });
  });

  describe('wms', function () {
    let container: DependencyContainer;

    beforeEach(async () => {
      container = await registerExternalValues({
        override: [
          {
            token: SERVICES.CONFIG,
            provider: {
              useValue: {
                get: (key: string) => {
                  switch (key) {
                    case 'app.map.provider':
                      return 'wms';
                    case 'app.jobQueue.pgBoss.schema':
                      return 'public';
                    default:
                      return config.get(key);
                  }
                },
              },
            },
          },
          { token: SERVICES.LOGGER, provider: { useValue: jsLogger({ enabled: false }) } },
          { token: SERVICES.TRACER, provider: { useValue: trace.getTracer('testTracer') } },
          { token: METRICS_REGISTRY, provider: { useValue: new Registry() } },
          { token: TILES_STORAGE_LAYOUT, provider: { useValue: { format: '{z}/{x}/{y}.png', shouldFlipY: true } } },
        ],
        useChild: true,
      });

      const storageLayout = container.resolve<TileStoragLayout>(TILES_STORAGE_LAYOUT);

      determineKey = (tile: Required<Tile>): string => {
        if (storageLayout.shouldFlipY) {
          tile.y = getFlippedY(tile);
        }
        const key = format(storageLayout.format, tile);
        return key;
      };
    });

    afterEach(async () => {
      const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
      const queueName = container.resolve<string>(QUEUE_NAME);
      await cleanupQueue(pgBoss, queueName);
    });

    afterAll(async () => {
      const cleanupRegistry = container.resolve<CleanupRegistry>(SERVICES.CLEANUP_REGISTRY);
      await cleanupRegistry.trigger();
      container.reset();
    });

    describe('Happy path', function () {
      it(
        'should complete a single job',
        async function () {
          detilerGetInterceptor.reply(httpStatusCodes.NOT_FOUND);
          detilerPutInterceptor.reply(httpStatusCodes.OK);
          const getMapScope = getMapInterceptor.reply(httpStatusCodes.OK, mapBuffer512x512);

          const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
          const provider = container.resolve<PgBossJobQueueProvider>(JOB_QUEUE_PROVIDER);
          const queueName = container.resolve<string>(QUEUE_NAME);
          const jobId = await pgBoss.send({ name: queueName, data: { z: 1, x: 0, y: 0, metatile: 2, parent: 'parent' } });

          const consumePromise = consumeAndProcessFactory(container)();

          const storageProviders = container.resolve<TilesStorageProvider[]>(TILES_STORAGE_PROVIDERS);
          const storeTileSpies = storageProviders.map((provider) => jest.spyOn(provider, 'storeTile'));

          const job = await waitForJobToBeResolved(pgBoss, queueName, jobId as string);

          await provider.stopQueue();

          await expect(consumePromise).resolves.not.toThrow();

          expect(job).toHaveProperty('state', 'completed');

          storeTileSpies.forEach((spy) => expect(spy.mock.calls).toHaveLength(4));

          for (const storeTileSpy of storeTileSpies) {
            for (let i = 0; i < 4; i++) {
              const storeCall = storeTileSpy.mock.calls[i]![0];
              const key = determineKey({ x: storeCall.x, y: storeCall.y, z: storeCall.z, metatile: storeCall.metatile });
              const expectedBuffer = await fsPromises.readFile(`tests/integration/expected/${key}`);
              expect(expectedBuffer.compare(storeCall.buffer)).toBe(0);
            }
          }

          getMapScope.done();
          detilerScope.done();
        },
        LONG_RUNNING_TEST
      );
    });

    describe('Bad path', function () {
      it(
        'should fail the job if map fetching service returns an error',
        async function () {
          detilerGetInterceptor.reply(httpStatusCodes.NOT_FOUND);
          const getMapScope = nock(mapUrl).get(/.*/).replyWithError({ message: 'fetching map error' });

          const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
          const provider = container.resolve<PgBossJobQueueProvider>(JOB_QUEUE_PROVIDER);
          const queueName = container.resolve<string>(QUEUE_NAME);
          const jobId = await pgBoss.send({ name: queueName, data: { z: 0, x: 0, y: 0, metatile: 8, parent: 'parent' } });

          const consumePromise = consumeAndProcessFactory(container)();

          const job = await waitForJobToBeResolved(pgBoss, queueName, jobId as string);

          await provider.stopQueue();

          await expect(consumePromise).resolves.not.toThrow();

          expect(job).toHaveProperty('state', 'failed');
          expect(job).toHaveProperty('output.message', 'fetching map error');

          getMapScope.done();
          detilerScope.done();
        },
        LONG_RUNNING_TEST
      );

      it(
        'should fail the job if map fetching service returns an ok with xml content type',
        async function () {
          detilerGetInterceptor.reply(httpStatusCodes.NOT_FOUND);

          const getMapScope = getMapInterceptor.reply(200, '<xml></xml>', { 'Content-Type': 'text/xml' });

          const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
          const provider = container.resolve<PgBossJobQueueProvider>(JOB_QUEUE_PROVIDER);
          const queueName = container.resolve<string>(QUEUE_NAME);
          const jobId = await pgBoss.send({ name: queueName, data: { z: 0, x: 0, y: 0, metatile: 8, parent: 'parent' } });

          const consumePromise = consumeAndProcessFactory(container)();

          const job = await waitForJobToBeResolved(pgBoss, queueName, jobId as string);

          await provider.stopQueue();

          await expect(consumePromise).resolves.not.toThrow();

          expect(job).toHaveProperty('state', 'failed');
          expect(job).toHaveProperty('output.message', 'The response returned from the service was in xml format');

          getMapScope.done();
          detilerScope.done();
        },
        LONG_RUNNING_TEST
      );
    });
  });

  describe('disabled detiler', function () {
    let container: DependencyContainer;

    beforeEach(async () => {
      container = await registerExternalValues({
        override: [
          {
            token: SERVICES.CONFIG,
            provider: {
              useValue: {
                get: (key: string) => {
                  switch (key) {
                    case 'detiler.enabled':
                      return false;
                    default:
                      return config.get(key);
                  }
                },
              },
            },
          },
          { token: SERVICES.LOGGER, provider: { useValue: jsLogger({ enabled: false }) } },
          { token: SERVICES.TRACER, provider: { useValue: trace.getTracer('testTracer') } },
          { token: METRICS_REGISTRY, provider: { useValue: new Registry() } },
          { token: TILES_STORAGE_LAYOUT, provider: { useValue: { format: '{z}/{x}/{y}.png', shouldFlipY: true } } },
        ],
        useChild: true,
      });

      const storageLayout = container.resolve<TileStoragLayout>(TILES_STORAGE_LAYOUT);

      determineKey = (tile: Required<Tile>): string => {
        if (storageLayout.shouldFlipY) {
          tile.y = getFlippedY(tile);
        }
        const key = format(storageLayout.format, tile);
        return key;
      };
    });

    afterEach(async () => {
      const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
      const queueName = container.resolve<string>(QUEUE_NAME);
      await cleanupQueue(pgBoss, queueName);
    });

    afterAll(async () => {
      const cleanupRegistry = container.resolve<CleanupRegistry>(SERVICES.CLEANUP_REGISTRY);
      await cleanupRegistry.trigger();
      container.reset();
    });

    describe('Happy Path', function () {
      it(
        'should complete a single job',
        async function () {
          const getMapScope = getMapInterceptor.reply(httpStatusCodes.OK, mapBuffer512x512);

          const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
          const provider = container.resolve<PgBossJobQueueProvider>(JOB_QUEUE_PROVIDER);
          const queueName = container.resolve<string>(QUEUE_NAME);
          const jobId = await pgBoss.send({ name: queueName, data: { z: 1, x: 0, y: 0, metatile: 2, parent: 'parent' } });

          const consumePromise = consumeAndProcessFactory(container)();

          const storageProviders = container.resolve<TilesStorageProvider[]>(TILES_STORAGE_PROVIDERS);
          const storeTileSpies = storageProviders.map((provider) => jest.spyOn(provider, 'storeTile'));

          const job = await waitForJobToBeResolved(pgBoss, queueName, jobId as string);
          await provider.stopQueue();

          await expect(consumePromise).resolves.not.toThrow();

          expect(job).toHaveProperty('state', 'completed');

          storeTileSpies.forEach((spy) => expect(spy.mock.calls).toHaveLength(4));

          for (const storeTileSpy of storeTileSpies) {
            for (let i = 0; i < 4; i++) {
              const storeCall = storeTileSpy.mock.calls[i]![0];
              const key = determineKey({ x: storeCall.x, y: storeCall.y, z: storeCall.z, metatile: storeCall.metatile });
              const expectedBuffer = await fsPromises.readFile(`tests/integration/expected/${key}`);
              expect(expectedBuffer.compare(storeCall.buffer)).toBe(0);
            }
          }

          getMapScope.done();
        },
        LONG_RUNNING_TEST
      );

      it('should complete running jobs', async function () {
        const getMapScope = getMapInterceptor.reply(httpStatusCodes.OK, mapBuffer2048x2048).persist();

        const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
        const provider = container.resolve<PgBossJobQueueProvider>(JOB_QUEUE_PROVIDER);
        const queueName = container.resolve<string>(QUEUE_NAME);
        const request1 = { data: { z: 0, x: 0, y: 0, metatile: 8, parent: 'parent' } };
        const request2 = { data: { z: 1, x: 0, y: 0, metatile: 8, parent: 'parent' } };
        const request3 = { data: { z: 2, x: 0, y: 0, metatile: 8, parent: 'parent' } };
        const request4 = { data: { z: 3, x: 0, y: 0, metatile: 8, parent: 'parent' } };
        const request5 = { data: { z: 4, x: 0, y: 0, metatile: 8, parent: 'parent' } };

        await pgBoss.insert(queueName, [request1, request2, request3, request4, request5]);

        const consumePromise = consumeAndProcessFactory(container)();

        await setTimeoutPromise(5);
        await provider.stopQueue();

        await expect(consumePromise).resolves.not.toThrow();

        getMapScope.done();
      });
    });
  });

  describe('forced processing with no proceeding on failure', function () {
    let container: DependencyContainer;

    beforeEach(async () => {
      container = await registerExternalValues({
        override: [
          {
            token: SERVICES.CONFIG,
            provider: {
              useValue: {
                get: (key: string) => {
                  switch (key) {
                    case 'app.forceProcess':
                      return true;
                    case 'detiler.proceedOnFailure':
                      return false;
                    default:
                      return config.get(key);
                  }
                },
              },
            },
          },
          { token: SERVICES.LOGGER, provider: { useValue: jsLogger({ enabled: false }) } },
          { token: SERVICES.TRACER, provider: { useValue: trace.getTracer('testTracer') } },
          { token: METRICS_REGISTRY, provider: { useValue: new Registry() } },
          { token: TILES_STORAGE_LAYOUT, provider: { useValue: { format: '{z}/{x}/{y}.png', shouldFlipY: true } } },
        ],
        useChild: true,
      });

      const storageLayout = container.resolve<TileStoragLayout>(TILES_STORAGE_LAYOUT);

      determineKey = (tile: Required<Tile>): string => {
        if (storageLayout.shouldFlipY) {
          tile.y = getFlippedY(tile);
        }
        const key = format(storageLayout.format, tile);
        return key;
      };
    });

    afterEach(async () => {
      const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
      const queueName = container.resolve<string>(QUEUE_NAME);
      await cleanupQueue(pgBoss, queueName);
    });

    afterAll(async () => {
      const cleanupRegistry = container.resolve<CleanupRegistry>(SERVICES.CLEANUP_REGISTRY);
      await cleanupRegistry.trigger();
      container.reset();
    });

    describe('Happy Path', function () {
      it(
        'should complete a single job',
        async function () {
          detilerPutInterceptor.reply(httpStatusCodes.OK);
          const getMapScope = getMapInterceptor.reply(httpStatusCodes.OK, mapBuffer512x512);

          const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
          const provider = container.resolve<PgBossJobQueueProvider>(JOB_QUEUE_PROVIDER);
          const queueName = container.resolve<string>(QUEUE_NAME);
          const jobId = await pgBoss.send({ name: queueName, data: { z: 1, x: 0, y: 0, metatile: 2, parent: 'parent' } });

          const consumePromise = consumeAndProcessFactory(container)();

          const storageProviders = container.resolve<TilesStorageProvider[]>(TILES_STORAGE_PROVIDERS);
          const storeTileSpies = storageProviders.map((provider) => jest.spyOn(provider, 'storeTile'));

          expect(provider.activeQueueName).toBe(queueName);

          const job = await waitForJobToBeResolved(pgBoss, queueName, jobId as string);
          await provider.stopQueue();

          await expect(consumePromise).resolves.not.toThrow();

          expect(job).toHaveProperty('state', 'completed');

          storeTileSpies.forEach((spy) => expect(spy.mock.calls).toHaveLength(4));

          for (const storeTileSpy of storeTileSpies) {
            for (let i = 0; i < 4; i++) {
              const storeCall = storeTileSpy.mock.calls[i]![0];
              const key = determineKey({ x: storeCall.x, y: storeCall.y, z: storeCall.z, metatile: storeCall.metatile });
              const expectedBuffer = await fsPromises.readFile(`tests/integration/expected/${key}`);
              expect(expectedBuffer.compare(storeCall.buffer)).toBe(0);
            }
          }

          getMapScope.done();
          detilerScope.done();
        },
        LONG_RUNNING_TEST
      );
    });

    describe('Sad Path', function () {
      it(
        'should fail the job if detiler set has failed',
        async function () {
          const detilerSetScope = nock(detilerUrl).put(/.*/).replyWithError({ message: 'detiler set error' });
          const getMapScope = getMapInterceptor.reply(httpStatusCodes.OK, mapBuffer512x512);

          const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
          const provider = container.resolve<PgBossJobQueueProvider>(JOB_QUEUE_PROVIDER);
          const queueName = container.resolve<string>(QUEUE_NAME);
          const jobId = await pgBoss.send({ name: queueName, data: { z: 0, x: 0, y: 0, metatile: 8, parent: 'parent' } });

          const consumePromise = consumeAndProcessFactory(container)();

          const job = await waitForJobToBeResolved(pgBoss, queueName, jobId as string);

          await provider.stopQueue();

          await expect(consumePromise).resolves.not.toThrow();

          expect(job).toHaveProperty('state', 'failed');
          expect(job).toHaveProperty('output.message', 'detiler set error');

          detilerScope.done();
          getMapScope.done();
          detilerSetScope.done();
        },
        LONG_RUNNING_TEST
      );
    });
  });

  describe('filtered blank tiles', function () {
    let container: DependencyContainer;

    beforeEach(async () => {
      container = await registerExternalValues({
        override: [
          {
            token: SERVICES.CONFIG,
            provider: {
              useValue: {
                get: (key: string) => {
                  switch (key) {
                    case 'app.tilesStorage.shouldFilterBlankTiles':
                      return true;
                    default:
                      return config.get(key);
                  }
                },
              },
            },
          },
          { token: SERVICES.LOGGER, provider: { useValue: jsLogger({ enabled: false }) } },
          { token: SERVICES.TRACER, provider: { useValue: trace.getTracer('testTracer') } },
          { token: METRICS_REGISTRY, provider: { useValue: new Registry() } },
          { token: TILES_STORAGE_LAYOUT, provider: { useValue: { format: '{z}/{x}/{y}.png', shouldFlipY: true } } },
        ],
        useChild: true,
      });

      const storageLayout = container.resolve<TileStoragLayout>(TILES_STORAGE_LAYOUT);

      determineKey = (tile: Required<Tile>): string => {
        if (storageLayout.shouldFlipY) {
          tile.y = getFlippedY(tile);
        }
        const key = format(storageLayout.format, tile);
        return key;
      };
    });

    afterEach(async () => {
      const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
      const queueName = container.resolve<string>(QUEUE_NAME);
      await cleanupQueue(pgBoss, queueName);
    });

    afterAll(async () => {
      const cleanupRegistry = container.resolve<CleanupRegistry>(SERVICES.CLEANUP_REGISTRY);
      await cleanupRegistry.trigger();
      container.reset();
    });

    it(
      'should filter out fully blank tile',
      async function () {
        detilerPutInterceptor.reply(httpStatusCodes.OK);
        const buffer = await createBlankBuffer();
        const getMapScope = getMapInterceptor.reply(httpStatusCodes.OK, buffer);

        const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
        const provider = container.resolve<PgBossJobQueueProvider>(JOB_QUEUE_PROVIDER);
        const queueName = container.resolve<string>(QUEUE_NAME);
        const jobId = await pgBoss.send({ name: queueName, data: { z: 1, x: 0, y: 0, metatile: 2, parent: 'parent' } });

        const consumePromise = consumeAndProcessFactory(container)();

        const storageProviders = container.resolve<TilesStorageProvider[]>(TILES_STORAGE_PROVIDERS);
        const storeTileSpies = storageProviders.map((provider) => jest.spyOn(provider, 'storeTile'));
        const deleteTilesSpies = storageProviders.map((provider) => jest.spyOn(provider, 'deleteTiles').mockResolvedValueOnce(undefined));

        const job = await waitForJobToBeResolved(pgBoss, queueName, jobId as string);
        await provider.stopQueue();

        await expect(consumePromise).resolves.not.toThrow();

        expect(job).toHaveProperty('state', 'completed');

        storeTileSpies.forEach((spy) => expect(spy.mock.calls).toHaveLength(0));
        deleteTilesSpies.forEach((spy) => expect(spy.mock.calls).toHaveLength(1));

        getMapScope.done();
        detilerScope.done();
      },
      LONG_RUNNING_TEST
    );

    it(
      'should filter out blank subtiles',
      async function () {
        detilerPutInterceptor.reply(httpStatusCodes.OK);
        const buffer = await fsPromises.readFile('tests/blank-but-top-right.png');
        const getMapScope = getMapInterceptor.reply(httpStatusCodes.OK, buffer);

        const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
        const provider = container.resolve<PgBossJobQueueProvider>(JOB_QUEUE_PROVIDER);
        const queueName = container.resolve<string>(QUEUE_NAME);
        const jobId = await pgBoss.send({ name: queueName, data: { z: 1, x: 0, y: 0, metatile: 2, parent: 'parent' } });

        const consumePromise = consumeAndProcessFactory(container)();

        const storageProviders = container.resolve<TilesStorageProvider[]>(TILES_STORAGE_PROVIDERS);
        const storeTileSpies = storageProviders.map((provider) => jest.spyOn(provider, 'storeTile'));
        const deleteTilesSpies = storageProviders.map((provider) => jest.spyOn(provider, 'deleteTiles').mockResolvedValueOnce(undefined));

        const job = await waitForJobToBeResolved(pgBoss, queueName, jobId as string);
        await provider.stopQueue();

        await expect(consumePromise).resolves.not.toThrow();

        expect(job).toHaveProperty('state', 'completed');

        storeTileSpies.forEach((spy) => expect(spy.mock.calls).toHaveLength(1));
        deleteTilesSpies.forEach((spy) => expect(spy.mock.calls).toHaveLength(1));

        getMapScope.done();
        detilerScope.done();
      },
      LONG_RUNNING_TEST
    );

    it(
      'should fail the job if tile storage provider deleteTiles had thrown an error',
      async function () {
        detilerGetInterceptor.reply(httpStatusCodes.NOT_FOUND);
        const buffer = await createBlankBuffer();
        const getMapScope = getMapInterceptor.reply(httpStatusCodes.OK, buffer);

        const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
        const provider = container.resolve<PgBossJobQueueProvider>(JOB_QUEUE_PROVIDER);
        const queueName = container.resolve<string>(QUEUE_NAME);
        const jobId = await pgBoss.send({ name: queueName, data: { z: 0, x: 0, y: 0, metatile: 8, parent: 'parent' } });

        const error = new Error('storing error');

        const consumePromise = consumeAndProcessFactory(container)();

        const storageProviders = container.resolve<TilesStorageProvider[]>(TILES_STORAGE_PROVIDERS);
        jest.spyOn(storageProviders[0]!, 'deleteTiles').mockRejectedValue(error);

        const job = await waitForJobToBeResolved(pgBoss, queueName, jobId as string);

        await provider.stopQueue();

        await expect(consumePromise).resolves.not.toThrow();

        expect(job).toHaveProperty('state', 'failed');
        expect(job).toHaveProperty('output.message', error.message);

        getMapScope.done();
        detilerScope.done();
      },
      LONG_RUNNING_TEST
    );

    it(
      'should fail the job if s3 tile storage provider deleteTiles had thrown an error',
      async function () {
        detilerGetInterceptor.reply(httpStatusCodes.NOT_FOUND);
        const buffer = await createBlankBuffer();
        const getMapScope = getMapInterceptor.reply(httpStatusCodes.OK, buffer);
        const errorMessage = 'send error';
        const error = new Error(errorMessage);
        s3SendMock.mockRejectedValueOnce(error);

        const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
        const provider = container.resolve<PgBossJobQueueProvider>(JOB_QUEUE_PROVIDER);
        const queueName = container.resolve<string>(QUEUE_NAME);
        const jobId = await pgBoss.send({ name: queueName, data: { z: 0, x: 0, y: 0, metatile: 8, parent: 'parent' } });

        const consumePromise = consumeAndProcessFactory(container)();

        const job = await waitForJobToBeResolved(pgBoss, queueName, jobId as string);

        await provider.stopQueue();

        await expect(consumePromise).resolves.not.toThrow();

        expect(job).toHaveProperty('state', 'failed');
        const jobOutput = job?.output as object as { [index: string]: string };
        expect(jobOutput['message']).toContain(error.message);

        getMapScope.done();
        detilerScope.done();
      },
      LONG_RUNNING_TEST
    );

    it(
      'should fail the job if s3 tile storage provider deleteTiles has responded with error response',
      async function () {
        detilerGetInterceptor.reply(httpStatusCodes.NOT_FOUND);
        const buffer = await createBlankBuffer();
        const getMapScope = getMapInterceptor.reply(httpStatusCodes.OK, buffer);
        const error1 = { Message: 'err1', Key: 'key1' };
        const error2 = { Message: 'err2', Key: 'key2' };
        s3SendMock.mockResolvedValue({ Errors: [error1, error2] });

        const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
        const provider = container.resolve<PgBossJobQueueProvider>(JOB_QUEUE_PROVIDER);
        const queueName = container.resolve<string>(QUEUE_NAME);
        const jobId = await pgBoss.send({ name: queueName, data: { z: 0, x: 0, y: 0, metatile: 8, parent: 'parent' } });

        const consumePromise = consumeAndProcessFactory(container)();

        const job = await waitForJobToBeResolved(pgBoss, queueName, jobId as string);

        await provider.stopQueue();

        await expect(consumePromise).resolves.not.toThrow();

        expect(job).toHaveProperty('state', 'failed');
        const jobOutput = job?.output as object as { [index: string]: string };
        expect(jobOutput['message']).toContain('an error occurred during the delete of a batch of keys');

        getMapScope.done();
        detilerScope.done();
      },
      LONG_RUNNING_TEST
    );

    it(
      'should fail the job if fs unlink had thrown an error',
      async function () {
        detilerGetInterceptor.reply(httpStatusCodes.NOT_FOUND);
        const buffer = await createBlankBuffer();
        const getMapScope = getMapInterceptor.reply(httpStatusCodes.OK, buffer);
        const errorMessage = 'send error';
        const error = new Error(errorMessage);
        s3SendMock.mockResolvedValue({});
        (fsPromises.unlink as unknown as jest.Mock).mockRejectedValueOnce(error);

        const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
        const provider = container.resolve<PgBossJobQueueProvider>(JOB_QUEUE_PROVIDER);
        const queueName = container.resolve<string>(QUEUE_NAME);
        const jobId = await pgBoss.send({ name: queueName, data: { z: 0, x: 0, y: 0, metatile: 8, parent: 'parent' } });

        const consumePromise = consumeAndProcessFactory(container)();

        const job = await waitForJobToBeResolved(pgBoss, queueName, jobId as string);

        await provider.stopQueue();

        await expect(consumePromise).resolves.not.toThrow();

        expect(job).toHaveProperty('state', 'failed');
        const jobOutput = job?.output as object as { [index: string]: string };
        expect(jobOutput['message']).toContain(error.message);

        getMapScope.done();
        detilerScope.done();
      },
      LONG_RUNNING_TEST
    );

    it(
      'should delete blank tiles and not throw even if unlink throws not found error out blank subtiles',
      async function () {
        detilerPutInterceptor.reply(httpStatusCodes.OK);
        const buffer = await createBlankBuffer();
        const getMapScope = getMapInterceptor.reply(httpStatusCodes.OK, buffer);
        const errorMessage = 'request failure error';
        const error = new Error(errorMessage);
        const mockFsNotFoundError = error as NodeJS.ErrnoException;
        mockFsNotFoundError.code = FS_FILE_NOT_FOUND_ERROR_CODE;
        s3SendMock.mockResolvedValue({});
        (fsPromises.unlink as unknown as jest.Mock).mockRejectedValue(mockFsNotFoundError);

        const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
        const provider = container.resolve<PgBossJobQueueProvider>(JOB_QUEUE_PROVIDER);
        const queueName = container.resolve<string>(QUEUE_NAME);
        const jobId = await pgBoss.send({ name: queueName, data: { z: 1, x: 0, y: 0, metatile: 2, parent: 'parent' } });

        const consumePromise = consumeAndProcessFactory(container)();

        const job = await waitForJobToBeResolved(pgBoss, queueName, jobId as string);
        await provider.stopQueue();

        await expect(consumePromise).resolves.not.toThrow();

        expect(job).toHaveProperty('state', 'completed');

        getMapScope.done();
        detilerScope.done();
      },
      LONG_RUNNING_TEST
    );
  });
});
