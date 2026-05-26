import { AxiosError, AxiosInstance } from 'axios';
import jsLogger from '@map-colonies/js-logger';
import { WmsMapProvider } from '../../../src/retiler/mapProvider/wms/wmsMapProvider';
import { WmsConfig, WmsRequestParams } from '../../../src/retiler/mapProvider/wms/requestParams';

jest.mock('axios');

describe('wmsMapProvider', () => {
  describe('#getMap', () => {
    let mockedClient: jest.Mocked<AxiosInstance>;

    beforeEach(function () {
      mockedClient = { get: jest.fn() } as unknown as jest.Mocked<AxiosInstance>;
    });

    afterEach(function () {
      jest.clearAllMocks();
    });

    it('should resolve into a buffer if the request has completed with wms version 1.1.1', async function () {
      const wmsConfig: WmsConfig = { version: '1.1.1', layers: 'someLayer', styles: 'someStyle' };
      const wmsProv = new WmsMapProvider(mockedClient, jsLogger({ enabled: false }), 'http://url.com', 'image/png', wmsConfig);

      const response = { data: Buffer.from('test'), headers: { 'content-type': 'image/png' } };
      mockedClient.get.mockResolvedValue(response);

      const tile = { z: 0, x: 0, y: 0, metatile: 1 };

      const buffer = await wmsProv.getMap(tile);

      const wmsReqParams = mockedClient.get.mock.calls[0]![1]?.params as WmsRequestParams;

      expect(mockedClient.get.mock.calls).toHaveLength(1);
      expect(wmsReqParams).not.toHaveProperty('crs');
      expect(wmsReqParams).toMatchObject({
        ...wmsConfig,
        srs: 'EPSG:4326',
        format: 'image/png',
        bbox: '-180,-90,0,90',
      });

      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.toString()).toBe('test');
    });

    it('should resolve into a buffer if the request has completed with wms version 1.3.0', async function () {
      const wmsConfig: WmsConfig = { version: '1.3.0', layers: 'someLayer', styles: 'someStyle' };

      const wmsProv = new WmsMapProvider(mockedClient, jsLogger({ enabled: false }), 'http://url.com', 'image/png', wmsConfig);

      const response = { data: Buffer.from('test'), headers: { 'content-type': 'image/png' } };
      mockedClient.get.mockResolvedValue(response);

      const tile = { z: 0, x: 0, y: 0, metatile: 1 };

      const buffer = await wmsProv.getMap(tile);

      const wmsReqParams = mockedClient.get.mock.calls[0]![1]?.params as WmsRequestParams;

      expect(mockedClient.get.mock.calls).toHaveLength(1);
      expect(wmsReqParams).not.toHaveProperty('srs');
      expect(wmsReqParams).toMatchObject({
        ...wmsConfig,
        crs: 'EPSG:4326',
        format: 'image/png',
        bbox: '-90,-180,90,0',
      });

      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.toString()).toBe('test');
    });

    it('should throw an error if the request has failed', async function () {
      const wmsProv = new WmsMapProvider(mockedClient, jsLogger({ enabled: false }), 'http://url.com', 'image/png', {
        version: '1.1.1',
        layers: '',
        styles: '',
      });

      const error = new Error('some error') as AxiosError;
      error.toJSON = jest.fn();
      mockedClient.get.mockRejectedValue(error);

      const tile = { z: 0, x: 0, y: 0, metatile: 1 };

      const promise = wmsProv.getMap(tile);

      await expect(promise).rejects.toThrow(error);
    });
  });
});
