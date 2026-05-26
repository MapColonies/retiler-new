import { AxiosError, AxiosInstance } from 'axios';
import jsLogger from '@map-colonies/js-logger';
import { ArcgisMapProvider } from '../../../src/retiler/mapProvider/arcgis/arcgisMapProvider';

jest.mock('axios');

describe('arcgisMapProvider', () => {
  describe('#getMap', () => {
    let arcgisProv: ArcgisMapProvider;
    let mockedClient: jest.Mocked<AxiosInstance>;

    beforeEach(function () {
      mockedClient = { get: jest.fn() } as unknown as jest.Mocked<AxiosInstance>;
      arcgisProv = new ArcgisMapProvider(mockedClient, jsLogger({ enabled: false }), 'http://url.com', 'png32');
    });

    afterEach(function () {
      jest.clearAllMocks();
    });

    it('should resolve into a buffer if the request has completed', async function () {
      const response = { data: Buffer.from('test') };
      mockedClient.get.mockResolvedValue(response);

      const tile = { z: 0, x: 0, y: 0, metatile: 1 };

      const buffer = await arcgisProv.getMap(tile);

      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.toString()).toBe('test');
    });

    it('should throw an error if the request has failed', async function () {
      const error = new Error('some error') as AxiosError;
      error.toJSON = jest.fn();
      mockedClient.get.mockRejectedValue(error);

      const tile = { z: 0, x: 0, y: 0, metatile: 1 };

      const promise = arcgisProv.getMap(tile);

      await expect(promise).rejects.toThrow(error);
    });
  });
});
