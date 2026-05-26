/* eslint-disable @typescript-eslint/naming-convention */ // due to client-s3
import { S3Client } from '@aws-sdk/client-s3';
import jsLogger from '@map-colonies/js-logger';
import { S3TilesStorage } from '../../../src/retiler/tilesStorageProvider/s3';

// eslint-disable-next-line @typescript-eslint/no-unsafe-return
jest.mock('@aws-sdk/client-s3', () => ({
  ...jest.requireActual('@aws-sdk/client-s3'),

  S3Client: jest.fn().mockImplementation(() => ({
    send: jest.fn(),
    config: {
      region: jest.fn().mockReturnValue('test-region'),
      endpointProvider: jest.fn().mockReturnValue('test-endpoint'),
    },
  })),
}));

describe('S3TilesStorage', () => {
  let storage: S3TilesStorage;
  let mockedS3Client: jest.Mocked<S3Client>;

  beforeEach(function () {
    mockedS3Client = new S3Client({}) as jest.Mocked<S3Client>;
    storage = new S3TilesStorage(mockedS3Client, jsLogger({ enabled: false }), 'test-bucket', { format: 'test/{z}/{x}/{y}.png', shouldFlipY: true });
  });

  afterEach(function () {
    jest.clearAllMocks();
  });

  describe('#storeTile', () => {
    it('should resolve without an error if client send resolved', async function () {
      const buffer = Buffer.from('test');
      mockedS3Client.send.mockResolvedValue(undefined as never);

      const promise = storage.storeTile({
        buffer,
        x: 1,
        y: 2,
        z: 3,
        metatile: 1,
      });

      await expect(promise).resolves.not.toThrow();
      expect(mockedS3Client.send.mock.calls).toHaveLength(1);
    });

    it('should throw an error if the request failed', async function () {
      const errorMessage = 'request failure error';
      const error = new Error(errorMessage);
      mockedS3Client.send.mockRejectedValue(error as never);

      const promise = storage.storeTile({
        buffer: Buffer.from('test'),
        x: 1,
        y: 2,
        z: 3,
        metatile: 1,
      });

      await expect(promise).rejects.toThrow(errorMessage);
      expect(mockedS3Client.send.mock.calls).toHaveLength(1);
    });
  });

  describe('#storeTiles', () => {
    it('should resolve without an error if payload is an empty array', async function () {
      mockedS3Client.send.mockResolvedValue(undefined as never);

      const promise = storage.storeTiles([]);

      await expect(promise).resolves.not.toThrow();

      expect(mockedS3Client.send.mock.calls).toHaveLength(0);
    });

    it('should resolve without an error if client send resolved', async function () {
      mockedS3Client.send.mockResolvedValue(undefined as never);

      const tile = { x: 1, y: 2, z: 3, metatile: 1 };
      const buffer = Buffer.from('test');

      const promise = storage.storeTiles([
        { ...tile, buffer },
        { ...tile, buffer },
      ]);

      await expect(promise).resolves.not.toThrow();
      expect(mockedS3Client.send.mock.calls).toHaveLength(2);
    });

    it('should throw an error if one of the requests had failed', async function () {
      const errorMessage = 'request failure error';
      const error = new Error(errorMessage);
      mockedS3Client.send.mockRejectedValueOnce(error as never);

      const buffer = Buffer.from('test');
      const tile = { x: 1, y: 2, z: 3, metatile: 1 };

      const promise = storage.storeTiles([
        { ...tile, buffer },
        { ...tile, buffer },
      ]);

      await expect(promise).rejects.toThrow(errorMessage);
      expect(mockedS3Client.send.mock.calls).toHaveLength(2);
    });
  });

  describe('#deleteTiles', () => {
    it('should resolve without an error if payload is an empty array', async function () {
      mockedS3Client.send.mockResolvedValue(undefined as never);

      const promise = storage.deleteTiles([]);

      await expect(promise).resolves.not.toThrow();

      expect(mockedS3Client.send.mock.calls).toHaveLength(0);
    });

    it('should resolve without an error if client send resolved', async function () {
      mockedS3Client.send.mockResolvedValue({} as never);

      const tile1 = { x: 1, y: 2, z: 3, metatile: 1 };
      const tile2 = { x: 2, y: 2, z: 3, metatile: 1 };

      const promise = storage.deleteTiles([tile1, tile2]);

      await expect(promise).resolves.not.toThrow();
      expect(mockedS3Client.send.mock.calls).toHaveLength(1);
      expect(mockedS3Client.send.mock.calls[0]![0]).toHaveProperty('input.Delete.Objects', [{ Key: 'test/3/1/5.png' }, { Key: 'test/3/2/5.png' }]);
    });

    it('should throw an error if one of the requests had failed', async function () {
      const errorMessage = 'request failure error';
      const error = new Error(errorMessage);
      mockedS3Client.send.mockRejectedValueOnce(error as never);

      const tile = { x: 1, y: 2, z: 3, metatile: 1 };

      const promise = storage.deleteTiles([tile]);

      await expect(promise).rejects.toThrow(errorMessage);
      expect(mockedS3Client.send.mock.calls).toHaveLength(1);
    });

    it('should throw a proper error if one of the requests had failed with errors array', async function () {
      const errorMessage = 'an error occurred during the delete of a batch of keys on bucket test-bucket';
      const error1 = { Message: 'err1', Key: 'key1' };
      const error2 = { Message: 'err2', Key: 'key2' };
      mockedS3Client.send.mockResolvedValueOnce({ Errors: [error1, error2] } as never);

      const tile = { x: 1, y: 2, z: 3, metatile: 1 };

      const promise = storage.deleteTiles([tile]);

      await expect(promise).rejects.toThrow(errorMessage);
      expect(mockedS3Client.send.mock.calls).toHaveLength(1);
    });
  });
});
