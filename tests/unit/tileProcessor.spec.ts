import { readFile } from 'fs/promises';
import { IDetilerClient } from '@map-colonies/detiler-client';
import jsLogger from '@map-colonies/js-logger';
import { AxiosInstance } from 'axios';
import { Registry } from 'prom-client';
import { ConfigType } from '../../src/common/config';
import { MapProvider, MapSplitterProvider, TilesStorageProvider } from '../../src/retiler/interfaces';
import { TileProcessor } from '../../src/retiler/tileProcessor';
import { timestampToUnix } from '../../src/common/util';
import { MILLISECONDS_IN_SECOND } from '../../src/common/constants';
import { MapSplitResult } from '../../src/retiler/types';
import { createBlankBuffer } from '../integration/helpers';
import { Tracer } from '@opentelemetry/api';

const REMOTE_STATE_TIMESTAMP = '2024-01-15T21:20:36Z';

describe('TileProcessor', () => {
  let processor: TileProcessor;
  let processorWithMultiStores: TileProcessor;
  let tracerMock: { startActiveSpan: jest.Mock };
  let mapProv: MapProvider;
  let mapSplitterProv: MapSplitterProvider;
  let tilesStorageProv: TilesStorageProvider;
  let anotherTilesStorageProv: TilesStorageProvider;
  let mockedClient: jest.Mocked<AxiosInstance>;
  let mockedDetiler: IDetilerClient;

  describe('#processTile', () => {
    const getMap = jest.fn();
    const splitMap = jest.fn();
    const storeTile = jest.fn();
    const storeTiles = jest.fn();
    const deleteTiles = jest.fn();
    const getTileDetails = jest.fn();
    const setTileDetails = jest.fn();
    const queryCooldownsAsyncGenerator = jest.fn();

    const configMock = {
      get: jest.fn().mockImplementation((key: string) => {
        switch (key) {
          case 'app.project':
            return {
              name: 'testKit',
              stateUrl: 'stateUrlTest',
            };
          case 'detiler.proceedOnFailure':
            return true;
          default:
            return;
        }
      }),
      has: jest.fn(),
    } as unknown as ConfigType;

    beforeEach(function () {
      mapProv = {
        getMap,
      };
      tracerMock = {
        startActiveSpan: jest.fn().mockImplementation((_name: string, _options: unknown, fn: (span: unknown) => unknown) =>
          fn({
            setStatus: jest.fn(),
            recordException: jest.fn(),
            end: jest.fn(),
            setAttribute: jest.fn(),
            setAttributes: jest.fn(),
            addEvent: jest.fn(),
          })
        ),
      };
      mapSplitterProv = {
        splitMap,
      };

      tilesStorageProv = {
        storeTile,
        storeTiles,
        deleteTiles,
      };

      anotherTilesStorageProv = {
        storeTile,
        storeTiles,
        deleteTiles,
      };

      mockedClient = { get: jest.fn() } as unknown as jest.Mocked<AxiosInstance>;
      mockedDetiler = {
        getTileDetails,
        setTileDetails,
        getKits: jest.fn(),
        queryTilesDetails: jest.fn(),
        queryTilesDetailsAsyncGenerator: jest.fn(),
        queryCooldownsAsyncGenerator,
        getTilesDetails: jest.fn(),
      };

      processor = new TileProcessor(
        jsLogger({ enabled: false }),
        tracerMock,
        mapProv,
        mapSplitterProv,
        [tilesStorageProv],
        mockedClient,
        configMock,
        mockedDetiler,
        new Registry(),
        []
      );

      processorWithMultiStores = new TileProcessor(
        jsLogger({ enabled: false }),
        tracerMock as unknown as Tracer,
        mapProv,
        mapSplitterProv,
        [tilesStorageProv, anotherTilesStorageProv],
        mockedClient,
        configMock,
        mockedDetiler,
        new Registry(),
        []
      );
    });

    afterEach(function () {
      jest.clearAllMocks();
    });

    it('should call all the processing functions in a row and resolve without errors', async () => {
      const tile = { x: 0, y: 0, z: 0, metatile: 8, state: 2 };

      jest.spyOn(Date, 'now').mockImplementation(() => 1705487516000);
      getTileDetails.mockResolvedValue({ kit: 'testKit', updatedAt: 10, state: 1, createdAt: 10, updateCount: 1, location: '31.1,32.3' });
      const remoteStateResponse = await readFile('tests/state.txt');
      mockedClient.get.mockResolvedValue({ data: remoteStateResponse });

      const getMapResponse = Buffer.from('test');
      getMap.mockResolvedValue(getMapResponse);
      const splitResultMock: MapSplitResult = {
        splittedTiles: [
          { z: 0, x: 0, y: 0, metatile: 1, buffer: Buffer.from([]) },
          { z: 0, x: 1, y: 0, metatile: 1, buffer: Buffer.from([]) },
        ],
        blankTiles: [],
        outOfBoundsCount: 0,
        isMetatileBlank: false,
      };
      splitMap.mockResolvedValue(splitResultMock);

      await expect(processor.processTile(tile)).resolves.not.toThrow();

      expect(mockedDetiler.getTileDetails).toHaveBeenCalledWith({ kit: 'testKit', x: 0, y: 0, z: 0 });
      expect(mockedClient.get.mock.calls).toHaveLength(1);
      expect(mockedDetiler.queryCooldownsAsyncGenerator).toHaveBeenCalledWith({
        area: [-180, -90, 180, 90],
        enabled: true,
        kits: ['testKit'],
        minZoom: tile.z,
        maxZoom: tile.z,
      });
      expect(mapProv.getMap).toHaveBeenCalled();
      expect(mapSplitterProv.splitMap).toHaveBeenCalled();
      expect(tilesStorageProv.storeTiles).toHaveBeenCalled();
      expect(mockedDetiler.setTileDetails).toHaveBeenCalledWith(
        { kit: 'testKit', x: 0, y: 0, z: 0 },
        { status: 'rendered', state: 2, timestamp: 1705487516 }
      );
    });

    it('should call all the processing functions in a row, get one cooldown which duration is too low and resolve without errors', async () => {
      const tile = { x: 0, y: 0, z: 0, metatile: 8, state: 2 };

      jest.spyOn(Date, 'now').mockImplementation(() => 1705487516000);
      getTileDetails.mockResolvedValue({
        kit: 'testKit',
        updatedAt: 10,
        renderedAt: 1705353635,
        state: 1,
        createdAt: 10,
        updateCount: 1,
        location: '31.1,32.3',
      });
      const remoteStateResponse = await readFile('tests/state.txt');
      mockedClient.get.mockResolvedValue({ data: remoteStateResponse });

      queryCooldownsAsyncGenerator.mockImplementation(function* () {
        yield [{ duration: 10 }];
      });

      const getMapResponse = Buffer.from('test');
      getMap.mockResolvedValue(getMapResponse);
      const splitResultMock: MapSplitResult = {
        splittedTiles: [
          { z: 0, x: 0, y: 0, metatile: 1, buffer: Buffer.from([]) },
          { z: 0, x: 1, y: 0, metatile: 1, buffer: Buffer.from([]) },
        ],
        blankTiles: [],
        outOfBoundsCount: 0,
        isMetatileBlank: false,
      };
      splitMap.mockResolvedValue(splitResultMock);

      await expect(processor.processTile(tile)).resolves.not.toThrow();

      expect(mockedDetiler.getTileDetails).toHaveBeenCalledWith({ kit: 'testKit', x: 0, y: 0, z: 0 });
      expect(mockedClient.get.mock.calls).toHaveLength(1);
      expect(mockedDetiler.queryCooldownsAsyncGenerator).toHaveBeenCalledWith({
        area: [-180, -90, 180, 90],
        enabled: true,
        kits: ['testKit'],
        minZoom: tile.z,
        maxZoom: tile.z,
      });
      expect(mapProv.getMap).toHaveBeenCalled();
      expect(mapSplitterProv.splitMap).toHaveBeenCalled();
      expect(tilesStorageProv.storeTiles).toHaveBeenCalled();
      expect(mockedDetiler.setTileDetails).toHaveBeenCalledWith(
        { kit: 'testKit', x: 0, y: 0, z: 0 },
        { status: 'rendered', state: 2, timestamp: 1705487516 }
      );
    });

    it('should call all the processing functions in a row, get cooldown which causes the tile processing to be skipped', async () => {
      const tile = { x: 0, y: 0, z: 0, metatile: 8, state: 2 };

      jest.spyOn(Date, 'now').mockImplementation(() => 1705487516000);
      getTileDetails.mockResolvedValue({
        kit: 'testKit',
        updatedAt: 10,
        renderedAt: 1705353635,
        state: 1,
        createdAt: 10,
        updateCount: 1,
        location: '31.1,32.3',
      });
      const remoteStateResponse = await readFile('tests/state.txt');
      mockedClient.get.mockResolvedValue({ data: remoteStateResponse });

      queryCooldownsAsyncGenerator.mockImplementation(function* () {
        yield [{ duration: 999999 }];
      });

      await expect(processor.processTile(tile)).resolves.not.toThrow();

      expect(mockedDetiler.getTileDetails).toHaveBeenCalledWith({ kit: 'testKit', x: 0, y: 0, z: 0 });
      expect(mockedClient.get.mock.calls).toHaveLength(1);
      expect(mockedDetiler.queryCooldownsAsyncGenerator).toHaveBeenCalledWith({
        area: [-180, -90, 180, 90],
        enabled: true,
        kits: ['testKit'],
        minZoom: tile.z,
        maxZoom: tile.z,
      });
      expect(mapProv.getMap).not.toHaveBeenCalled();
      expect(mapSplitterProv.splitMap).not.toHaveBeenCalled();
      expect(tilesStorageProv.storeTiles).not.toHaveBeenCalled();
      expect(mockedDetiler.setTileDetails).toHaveBeenCalledTimes(1);
      expect(mockedDetiler.setTileDetails).toHaveBeenCalledWith(
        { kit: 'testKit', x: 0, y: 0, z: 0 },
        { status: 'cooled', state: 2, timestamp: 1705487516 }
      );
    });

    it('should call all the processing functions in a row and resolve without errors if detiler is not configured', async () => {
      const processor = new TileProcessor(
        jsLogger({ enabled: false }),
        tracerMock as unknown as Tracer,
        mapProv,
        mapSplitterProv,
        [tilesStorageProv],
        mockedClient,
        configMock,
        undefined,
        new Registry(),
        []
      );

      const tile = { x: 0, y: 0, z: 0, metatile: 8, state: 2 };

      const getMapResponse = Buffer.from('test');
      getMap.mockResolvedValue(getMapResponse);
      const splitResultMock: MapSplitResult = {
        splittedTiles: [
          { z: 0, x: 0, y: 0, metatile: 1, buffer: Buffer.from([]) },
          { z: 0, x: 1, y: 0, metatile: 1, buffer: Buffer.from([]) },
        ],
        blankTiles: [],
        outOfBoundsCount: 0,
        isMetatileBlank: false,
      };
      splitMap.mockResolvedValue(splitResultMock);

      await expect(processor.processTile(tile)).resolves.not.toThrow();

      expect(mockedDetiler.getTileDetails).not.toHaveBeenCalled();
      expect(mockedClient.get.mock.calls).toHaveLength(0);
      expect(mockedDetiler.queryCooldownsAsyncGenerator).not.toHaveBeenCalled();
      expect(mapProv.getMap).toHaveBeenCalled();
      expect(mapSplitterProv.splitMap).toHaveBeenCalled();
      expect(tilesStorageProv.storeTiles).toHaveBeenCalled();
      expect(mockedDetiler.setTileDetails).not.toHaveBeenCalled();
    });

    it('should skip processing due to detiler detail response having greater updated time', async () => {
      const tile = { x: 0, y: 0, z: 0, metatile: 8 };

      jest.spyOn(Date, 'now').mockImplementation(() => 1705487516000);
      const updatedAtUnix = timestampToUnix(REMOTE_STATE_TIMESTAMP) + 1000000;
      getTileDetails.mockResolvedValue({
        kit: 'testKit',
        updatedAt: updatedAtUnix,
        renderedAt: updatedAtUnix,
        state: 1,
        createdAt: 0,
        updateCount: 1,
        renderCount: 1,
        location: '31.1,32.3',
      });
      const remoteStateResponse = await readFile('tests/state.txt');
      mockedClient.get.mockResolvedValue({ data: remoteStateResponse });

      await expect(processor.processTile(tile)).resolves.not.toThrow();

      expect(mockedDetiler.getTileDetails).toHaveBeenCalledWith({ kit: 'testKit', x: 0, y: 0, z: 0 });
      expect(mockedClient.get.mock.calls).toHaveLength(1);
      expect(mockedDetiler.queryCooldownsAsyncGenerator).not.toHaveBeenCalled();
      expect(mapProv.getMap).not.toHaveBeenCalled();
      expect(mapSplitterProv.splitMap).not.toHaveBeenCalled();
      expect(tilesStorageProv.storeTiles).not.toHaveBeenCalled();
      expect(mockedDetiler.setTileDetails).toHaveBeenCalledTimes(1);
      expect(mockedDetiler.setTileDetails).toHaveBeenCalledWith({ kit: 'testKit', x: 0, y: 0, z: 0 }, { status: 'skipped', timestamp: 1705487516 });
    });

    it('should call all the processing functions in a row with the exception of detiler if tile is attributed with force', async () => {
      const tile = { x: 0, y: 0, z: 0, metatile: 8, force: true };

      const newUpdatedAt = timestampToUnix(REMOTE_STATE_TIMESTAMP);
      jest.spyOn(Date, 'now').mockImplementation(() => newUpdatedAt * MILLISECONDS_IN_SECOND);

      const getMapResponse = Buffer.from('test');
      getMap.mockResolvedValue(getMapResponse);
      const splitResultMock: MapSplitResult = {
        splittedTiles: [
          { z: 0, x: 0, y: 0, metatile: 1, buffer: Buffer.from([]) },
          { z: 0, x: 1, y: 0, metatile: 1, buffer: Buffer.from([]) },
        ],
        blankTiles: [],
        outOfBoundsCount: 0,
        isMetatileBlank: false,
      };
      splitMap.mockResolvedValue(splitResultMock);

      await expect(processor.processTile(tile)).resolves.not.toThrow();

      expect(mockedDetiler.getTileDetails).not.toHaveBeenCalled();
      expect(mockedClient.get.mock.calls).toHaveLength(0);
      expect(mockedDetiler.queryCooldownsAsyncGenerator).not.toHaveBeenCalled();
      expect(mapProv.getMap).toHaveBeenCalled();
      expect(mapSplitterProv.splitMap).toHaveBeenCalled();
      expect(tilesStorageProv.storeTiles).toHaveBeenCalled();
      expect(mockedDetiler.setTileDetails).toHaveBeenCalledWith(
        { kit: 'testKit', x: 0, y: 0, z: 0 },
        { status: 'rendered', state: undefined, timestamp: newUpdatedAt }
      );
    });

    it('should call all the processing functions in a row with the exception of detiler if application is force processing', async () => {
      const configMock = {
        get: jest.fn().mockImplementation((key: string) => {
          switch (key) {
            case 'app.project':
              return {
                name: 'testKit',
                stateUrl: 'stateUrlTest',
              };
            case 'app.forceProcess':
              return true;
          }
        }),
        has: jest.fn(),
      } as unknown as ConfigType;

      const tileProcessorWithForce = new TileProcessor(
        jsLogger({ enabled: false }),
        tracerMock as unknown as Tracer,
        mapProv,
        mapSplitterProv,
        [tilesStorageProv, anotherTilesStorageProv],
        mockedClient,
        configMock,
        mockedDetiler,
        new Registry(),
        []
      );

      const tile = { x: 0, y: 0, z: 0, metatile: 8 };

      const newUpdatedAt = timestampToUnix(REMOTE_STATE_TIMESTAMP);
      jest.spyOn(Date, 'now').mockImplementation(() => newUpdatedAt * MILLISECONDS_IN_SECOND);

      const getMapResponse = Buffer.from('test');
      getMap.mockResolvedValue(getMapResponse);
      const splitResultMock: MapSplitResult = {
        splittedTiles: [
          { z: 0, x: 0, y: 0, metatile: 1, buffer: Buffer.from([]) },
          { z: 0, x: 1, y: 0, metatile: 1, buffer: Buffer.from([]) },
        ],
        blankTiles: [],
        outOfBoundsCount: 0,
        isMetatileBlank: false,
      };
      splitMap.mockResolvedValue(splitResultMock);

      await expect(tileProcessorWithForce.processTile(tile)).resolves.not.toThrow();

      expect(mockedDetiler.getTileDetails).not.toHaveBeenCalled();
      expect(mockedClient.get.mock.calls).toHaveLength(0);
      expect(mockedDetiler.queryCooldownsAsyncGenerator).not.toHaveBeenCalled();
      expect(mapProv.getMap).toHaveBeenCalled();
      expect(mapSplitterProv.splitMap).toHaveBeenCalled();
      expect(tilesStorageProv.storeTiles).toHaveBeenCalled();
      expect(mockedDetiler.setTileDetails).toHaveBeenCalledWith(
        { kit: 'testKit', x: 0, y: 0, z: 0 },
        { status: 'rendered', state: undefined, timestamp: newUpdatedAt }
      );
    });

    it('should call all the processing functions in a row and resolve without errors for multi stores processor', async () => {
      const tile = { x: 0, y: 0, z: 0, metatile: 8 };

      jest.spyOn(Date, 'now').mockImplementation(() => 1705487516000);
      getTileDetails.mockResolvedValue({ kit: 'testKit', updatedAt: 10, state: 1, createdAt: 10, updateCount: 1, location: '31.1,32.3' });
      const remoteStateResponse = await readFile('tests/state.txt');
      mockedClient.get.mockResolvedValue({ data: remoteStateResponse });

      const getMapResponse = Buffer.from('test');
      getMap.mockResolvedValue(getMapResponse);
      const splitResultMock: MapSplitResult = {
        splittedTiles: [
          { z: 0, x: 0, y: 0, metatile: 1, buffer: Buffer.from([]) },
          { z: 0, x: 1, y: 0, metatile: 1, buffer: Buffer.from([]) },
        ],
        blankTiles: [],
        outOfBoundsCount: 0,
        isMetatileBlank: false,
      };
      splitMap.mockResolvedValue(splitResultMock);

      await expect(processorWithMultiStores.processTile(tile)).resolves.not.toThrow();

      expect(mockedDetiler.getTileDetails).toHaveBeenCalledWith({ kit: 'testKit', x: 0, y: 0, z: 0 });
      expect(mockedClient.get.mock.calls).toHaveLength(1);
      expect(mockedDetiler.queryCooldownsAsyncGenerator).toHaveBeenCalledWith({
        area: [-180, -90, 180, 90],
        enabled: true,
        kits: ['testKit'],
        minZoom: tile.z,
        maxZoom: tile.z,
      });
      expect(mapProv.getMap).toHaveBeenCalled();
      expect(mapSplitterProv.splitMap).toHaveBeenCalled();
      expect(tilesStorageProv.storeTiles).toHaveBeenCalled();
      expect(anotherTilesStorageProv.storeTiles).toHaveBeenCalled();
      expect(mockedDetiler.setTileDetails).toHaveBeenCalledWith(
        { kit: 'testKit', x: 0, y: 0, z: 0 },
        { status: 'rendered', state: undefined, timestamp: 1705487516 }
      );
    });

    it('should call all the processing functions in a row and resolve without errors if pre processing fails by getTileDetails', async () => {
      const tile = { x: 0, y: 0, z: 0, metatile: 8 };
      getTileDetails.mockRejectedValue(new Error());
      const getMapResponse = Buffer.from('test');
      getMap.mockResolvedValue(getMapResponse);
      const splitResultMock: MapSplitResult = {
        splittedTiles: [
          { z: 0, x: 0, y: 0, metatile: 1, buffer: Buffer.from([]) },
          { z: 0, x: 1, y: 0, metatile: 1, buffer: Buffer.from([]) },
        ],
        blankTiles: [],
        outOfBoundsCount: 0,
        isMetatileBlank: false,
      };
      splitMap.mockResolvedValue(splitResultMock);

      await expect(processor.processTile(tile)).resolves.not.toThrow();

      expect(mockedDetiler.getTileDetails).toHaveBeenCalledWith({ kit: 'testKit', x: 0, y: 0, z: 0 });
      expect(mockedClient.get.mock.calls).toHaveLength(0);
      expect(mockedDetiler.queryCooldownsAsyncGenerator).not.toHaveBeenCalled();
      expect(mapProv.getMap).toHaveBeenCalled();
      expect(mapSplitterProv.splitMap).toHaveBeenCalled();
      expect(tilesStorageProv.storeTiles).toHaveBeenCalled();
      expect(mockedDetiler.setTileDetails).toHaveBeenCalled();
    });

    it('should call all the processing functions in a row and resolve without errors if pre processing fails by getting state', async () => {
      const tile = { x: 0, y: 0, z: 0, metatile: 8 };
      getTileDetails.mockReturnValue({ updatedAt: 1 });
      mockedClient.get.mockRejectedValue(new Error());
      const getMapResponse = Buffer.from('test');
      getMap.mockResolvedValue(getMapResponse);
      const splitResultMock: MapSplitResult = {
        splittedTiles: [
          { z: 0, x: 0, y: 0, metatile: 1, buffer: Buffer.from([]) },
          { z: 0, x: 1, y: 0, metatile: 1, buffer: Buffer.from([]) },
        ],
        blankTiles: [],
        outOfBoundsCount: 0,
        isMetatileBlank: false,
      };
      splitMap.mockResolvedValue(splitResultMock);

      await expect(processor.processTile(tile)).resolves.not.toThrow();

      expect(mockedDetiler.getTileDetails).toHaveBeenCalledWith({ kit: 'testKit', x: 0, y: 0, z: 0 });
      expect(mockedClient.get.mock.calls).toHaveLength(1);
      expect(mockedDetiler.queryCooldownsAsyncGenerator).not.toHaveBeenCalled();
      expect(mapProv.getMap).toHaveBeenCalled();
      expect(mapSplitterProv.splitMap).toHaveBeenCalled();
      expect(tilesStorageProv.storeTiles).toHaveBeenCalled();
      expect(mockedDetiler.setTileDetails).toHaveBeenCalled();
    });

    it('should call all the processing functions in a row and resolve without errors even if post processing fails by setTileDetails', async () => {
      const tile = { x: 0, y: 0, z: 0, metatile: 8 };
      getTileDetails.mockResolvedValue(null);
      const getMapResponse = Buffer.from('test');
      getMap.mockResolvedValue(getMapResponse);
      const splitResultMock: MapSplitResult = {
        splittedTiles: [
          { z: 0, x: 0, y: 0, metatile: 1, buffer: Buffer.from([]) },
          { z: 0, x: 1, y: 0, metatile: 1, buffer: Buffer.from([]) },
        ],
        blankTiles: [],
        outOfBoundsCount: 0,
        isMetatileBlank: false,
      };
      splitMap.mockResolvedValue(splitResultMock);
      setTileDetails.mockRejectedValue(new Error());

      await expect(processor.processTile(tile)).resolves.not.toThrow();

      expect(mockedDetiler.getTileDetails).toHaveBeenCalledWith({ kit: 'testKit', x: 0, y: 0, z: 0 });
      expect(mockedClient.get.mock.calls).toHaveLength(0);
      expect(mockedDetiler.queryCooldownsAsyncGenerator).not.toHaveBeenCalled();
      expect(mapProv.getMap).toHaveBeenCalled();
      expect(mapSplitterProv.splitMap).toHaveBeenCalled();
      expect(tilesStorageProv.storeTiles).toHaveBeenCalled();
      expect(mockedDetiler.setTileDetails).toHaveBeenCalled();
    });

    it('should not store any blank sub tiles for a blank tile and resolve without errors', async () => {
      const tile = { x: 0, y: 0, z: 0, metatile: 8 };
      const blankTiles = [
        { z: 0, x: 0, y: 0, metatile: 1 },
        { z: 0, x: 1, y: 0, metatile: 1 },
        { z: 0, x: 0, y: 1, metatile: 1 },
        { z: 0, x: 1, y: 1, metatile: 1 },
      ];
      getTileDetails.mockResolvedValue(null);
      const getMapResponse = createBlankBuffer();
      getMap.mockResolvedValue(getMapResponse);
      const splitResultMock: MapSplitResult = {
        splittedTiles: [],
        blankTiles,
        outOfBoundsCount: 0,
        isMetatileBlank: true,
      };
      splitMap.mockResolvedValue(splitResultMock);

      await expect(processor.processTile(tile)).resolves.not.toThrow();

      expect(mockedDetiler.getTileDetails).toHaveBeenCalledWith({ kit: 'testKit', x: 0, y: 0, z: 0 });
      expect(mockedClient.get.mock.calls).toHaveLength(0);
      expect(mockedDetiler.queryCooldownsAsyncGenerator).not.toHaveBeenCalled();
      expect(mapProv.getMap).toHaveBeenCalled();
      expect(mapSplitterProv.splitMap).toHaveBeenCalled();
      expect(tilesStorageProv.storeTiles).toHaveBeenCalledTimes(0);
      expect(tilesStorageProv.deleteTiles).toHaveBeenCalledTimes(1);
      expect(tilesStorageProv.deleteTiles).toHaveBeenCalledWith(blankTiles);
    });

    it('should store splitted tiles and delete blank tiles and resolve without errors', async () => {
      const tile = { x: 0, y: 0, z: 0, metatile: 8 };
      const splittedTiles = [
        { z: 0, x: 0, y: 0, metatile: 1, buffer: Buffer.from([]) },
        { z: 0, x: 1, y: 0, metatile: 1, buffer: Buffer.from([]) },
      ];
      const expectedSplittedTiles = splittedTiles.map((subTile) => ({
        ...subTile,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        buffer: expect.any(Uint8Array),
      }));
      const blankTiles = [
        { z: 0, x: 0, y: 0, metatile: 1 },
        { z: 0, x: 1, y: 0, metatile: 1 },
        { z: 0, x: 0, y: 1, metatile: 1 },
        { z: 0, x: 1, y: 1, metatile: 1 },
      ];
      getTileDetails.mockResolvedValue(null);
      const getMapResponse = createBlankBuffer();
      getMap.mockResolvedValue(getMapResponse);
      const splitResultMock: MapSplitResult = {
        splittedTiles,
        blankTiles,
        outOfBoundsCount: 0,
        isMetatileBlank: true,
      };
      splitMap.mockResolvedValue(splitResultMock);

      await expect(processor.processTile(tile)).resolves.not.toThrow();

      expect(mockedDetiler.getTileDetails).toHaveBeenCalledWith({ kit: 'testKit', x: 0, y: 0, z: 0 });
      expect(mockedClient.get.mock.calls).toHaveLength(0);
      expect(mockedDetiler.queryCooldownsAsyncGenerator).not.toHaveBeenCalled();
      expect(mapProv.getMap).toHaveBeenCalled();
      expect(mapSplitterProv.splitMap).toHaveBeenCalled();
      expect(tilesStorageProv.storeTiles).toHaveBeenCalledTimes(1);
      expect(tilesStorageProv.storeTiles).toHaveBeenCalledWith(expectedSplittedTiles);
      expect(tilesStorageProv.deleteTiles).toHaveBeenCalledTimes(1);
      expect(tilesStorageProv.deleteTiles).toHaveBeenCalledWith(blankTiles);
    });

    it('should fail if setTileDetails fails and configured to not proceed on detiler failure', async () => {
      const configMock = {
        get: jest.fn().mockImplementation((key: string) => {
          switch (key) {
            case 'app.project':
              return {
                name: 'testKit',
                stateUrl: 'stateUrlTest',
              };
            case 'detiler.proceedOnFailure':
              return false;
          }
        }),
        has: jest.fn(),
      } as unknown as ConfigType;

      const tileProcessorWithNoProceeding = new TileProcessor(
        jsLogger({ enabled: false }),
        tracerMock as unknown as Tracer,
        mapProv,
        mapSplitterProv,
        [tilesStorageProv, anotherTilesStorageProv],
        mockedClient,
        configMock,
        mockedDetiler,
        new Registry(),
        []
      );

      const tile = { x: 0, y: 0, z: 0, metatile: 8 };
      getTileDetails.mockResolvedValue(null);
      const getMapResponse = Buffer.from('test');
      getMap.mockResolvedValue(getMapResponse);
      const splitResultMock: MapSplitResult = {
        splittedTiles: [
          { z: 0, x: 0, y: 0, metatile: 1, buffer: Buffer.from([]) },
          { z: 0, x: 1, y: 0, metatile: 1, buffer: Buffer.from([]) },
        ],
        blankTiles: [],
        outOfBoundsCount: 0,
        isMetatileBlank: false,
      };
      splitMap.mockResolvedValue(splitResultMock);
      const error = new Error('detiler set error');
      setTileDetails.mockRejectedValue(error);

      await expect(tileProcessorWithNoProceeding.processTile(tile)).rejects.toThrow(error);

      expect(mockedDetiler.getTileDetails).toHaveBeenCalledWith({ kit: 'testKit', x: 0, y: 0, z: 0 });
      expect(mockedClient.get.mock.calls).toHaveLength(0);
      expect(mockedDetiler.queryCooldownsAsyncGenerator).not.toHaveBeenCalled();
      expect(mapProv.getMap).toHaveBeenCalled();
      expect(mapSplitterProv.splitMap).toHaveBeenCalled();
      expect(tilesStorageProv.storeTiles).toHaveBeenCalled();
      expect(mockedDetiler.setTileDetails).toHaveBeenCalled();
    });

    it('should throw error if getting map has failed', async () => {
      const tile = { x: 0, y: 0, z: 0, metatile: 8 };
      getTileDetails.mockResolvedValue(null);
      const getMapError = new Error('getting map error');
      getMap.mockRejectedValue(getMapError);

      await expect(processor.processTile(tile)).rejects.toThrow(getMapError);

      expect(mockedDetiler.getTileDetails).toHaveBeenCalledWith({ kit: 'testKit', x: 0, y: 0, z: 0 });
      expect(mockedClient.get.mock.calls).toHaveLength(0);
      expect(mockedDetiler.queryCooldownsAsyncGenerator).not.toHaveBeenCalled();
      expect(mapProv.getMap).toHaveBeenCalled();
      expect(mapSplitterProv.splitMap).not.toHaveBeenCalled();
      expect(tilesStorageProv.storeTiles).not.toHaveBeenCalled();
      expect(mockedDetiler.setTileDetails).not.toHaveBeenCalled();
    });

    it('should throw error if splitting map has failed', async () => {
      const tile = { x: 0, y: 0, z: 0, metatile: 8 };
      getTileDetails.mockResolvedValue(null);
      const getMapResponse = Buffer.from('test');
      getMap.mockResolvedValue(getMapResponse);
      const splitMapError = new Error('splitting map error');
      splitMap.mockRejectedValue(splitMapError);

      await expect(processor.processTile(tile)).rejects.toThrow(splitMapError);

      expect(mockedDetiler.getTileDetails).toHaveBeenCalledWith({ kit: 'testKit', x: 0, y: 0, z: 0 });
      expect(mockedClient.get.mock.calls).toHaveLength(0);
      expect(mockedDetiler.queryCooldownsAsyncGenerator).not.toHaveBeenCalled();
      expect(mapProv.getMap).toHaveBeenCalled();
      expect(mapSplitterProv.splitMap).toHaveBeenCalled();
      expect(tilesStorageProv.storeTiles).not.toHaveBeenCalled();
      expect(mockedDetiler.setTileDetails).not.toHaveBeenCalled();
    });

    it('should throw error if storing tiles had failed', async () => {
      const tile = { x: 0, y: 0, z: 0, metatile: 8 };
      getTileDetails.mockResolvedValue(null);
      const getMapResponse = Buffer.from('test');
      getMap.mockResolvedValue(getMapResponse);
      const splitResultMock: MapSplitResult = {
        splittedTiles: [
          { z: 0, x: 0, y: 0, metatile: 1, buffer: Buffer.from([]) },
          { z: 0, x: 1, y: 0, metatile: 1, buffer: Buffer.from([]) },
        ],
        blankTiles: [],
        outOfBoundsCount: 0,
        isMetatileBlank: false,
      };
      splitMap.mockResolvedValue(splitResultMock);
      const storeTileError = new Error('store tile error');
      storeTiles.mockRejectedValue(storeTileError);

      await expect(processor.processTile(tile)).rejects.toThrow(storeTileError);

      expect(mockedDetiler.getTileDetails).toHaveBeenCalledWith({ kit: 'testKit', x: 0, y: 0, z: 0 });
      expect(mockedClient.get.mock.calls).toHaveLength(0);
      expect(mockedDetiler.queryCooldownsAsyncGenerator).not.toHaveBeenCalled();
      expect(mapProv.getMap).toHaveBeenCalled();
      expect(mapSplitterProv.splitMap).toHaveBeenCalled();
      expect(tilesStorageProv.storeTiles).toHaveBeenCalled();
      expect(mockedDetiler.setTileDetails).not.toHaveBeenCalled();
    });

    it('should throw error if storing tiles had failed on at least one of the multi storage processor', async () => {
      const tile = { x: 0, y: 0, z: 0, metatile: 8 };
      getTileDetails.mockResolvedValue(null);
      const getMapResponse = Buffer.from('test');
      getMap.mockResolvedValue(getMapResponse);
      const splitResultMock: MapSplitResult = {
        splittedTiles: [
          { z: 0, x: 0, y: 0, metatile: 1, buffer: Buffer.from([]) },
          { z: 0, x: 1, y: 0, metatile: 1, buffer: Buffer.from([]) },
        ],
        blankTiles: [],
        outOfBoundsCount: 0,
        isMetatileBlank: false,
      };
      splitMap.mockResolvedValue(splitResultMock);
      const storeTileError = new Error('store tile error');
      storeTiles.mockResolvedValueOnce(undefined).mockRejectedValue(storeTileError);

      await expect(processorWithMultiStores.processTile(tile)).rejects.toThrow(storeTileError);

      expect(mockedDetiler.getTileDetails).toHaveBeenCalledWith({ kit: 'testKit', x: 0, y: 0, z: 0 });
      expect(mockedClient.get.mock.calls).toHaveLength(0);
      expect(mockedDetiler.queryCooldownsAsyncGenerator).not.toHaveBeenCalled();
      expect(mapProv.getMap).toHaveBeenCalled();
      expect(mapSplitterProv.splitMap).toHaveBeenCalled();
      expect(tilesStorageProv.storeTiles).toHaveBeenCalled();
      expect(anotherTilesStorageProv.storeTiles).toHaveBeenCalled();
      expect(mockedDetiler.setTileDetails).not.toHaveBeenCalled();
    });
  });
});
