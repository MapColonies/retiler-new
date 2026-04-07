/* eslint-disable @typescript-eslint/naming-convention */ // s3-client object commands arguments
import crypto from 'crypto';
import { DeleteObjectsCommand, ObjectIdentifier, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { EndpointV2 } from '@smithy/types';
import { type Logger } from '@map-colonies/js-logger';
import { Tile } from '@map-colonies/tile-calc';
import Format from 'string-format';
import { inject, injectable } from 'tsyringe';
import { S3_BUCKET, SERVICES, TILES_STORAGE_LAYOUT } from '../../common/constants';
import { timerify } from '../../common/util';
import { TilesStorageProvider } from '../interfaces';
import { TileWithBuffer, TileWithMetadata } from '../types';
import { getFlippedY } from '../util';
import { type TileStoragLayout } from './interfaces';
import { S3_BATCH_DELETE_MAX_SIZE } from './constants';

@injectable()
export class S3TilesStorage implements TilesStorageProvider {
  private endpoint?: EndpointV2;

  public constructor(
    @inject(SERVICES.S3) private readonly s3Client: S3Client,
    @inject(SERVICES.LOGGER) private readonly logger: Logger,
    @inject(S3_BUCKET) private readonly bucket: string,
    @inject(TILES_STORAGE_LAYOUT) private readonly storageLayout: TileStoragLayout
  ) {
    this.logger.info({ msg: 'initializing S3 tile storage', bucketName: bucket, storageLayout });
  }

  public async storeTile(tileWithBuffer: TileWithBuffer): Promise<void> {
    const { buffer, parent, ...baseTile } = tileWithBuffer;

    const key = this.determineKey(baseTile);

    const md5Hash = crypto.createHash('md5').update(buffer).digest('base64');

    const command = new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: buffer, ContentLength: buffer.byteLength, ContentMD5: md5Hash });

    try {
      await this.s3Client.send(command);
      this.logger.debug({
        msg: 'successfully stored tile in bucket',
        tile: baseTile,
        parent,
        endpoint: this.endpoint,
        bucketName: this.bucket,
        key,
        contentLength: buffer.byteLength,
        contentMD5: md5Hash,
      });
    } catch (error) {
      const s3Error = error as Error;
      this.logger.error({
        msg: 'an error occurred during tile storing',
        err: s3Error,
        tile: baseTile,
        parent,
        endpoint: this.endpoint,
        bucketName: this.bucket,
        key,
      });
      throw new Error(`an error occurred during the put of key ${key} on bucket ${this.bucket}, ${s3Error.message}`);
    }
  }

  public async storeTiles(tiles: TileWithBuffer[]): Promise<void> {
    if (tiles.length === 0) {
      return;
    }

    const parent = tiles[0]?.parent;

    if (this.endpoint === undefined) {
      const region = await this.s3Client.config.region();
      this.endpoint = this.s3Client.config.endpointProvider({ Region: region });
    }

    this.logger.debug({ msg: 'storing batch of tiles in bucket', parent, count: tiles.length, endpoint: this.endpoint, bucketName: this.bucket });

    const [, duration] = await timerify(async () => Promise.all(tiles.map(async (tile) => this.storeTile(tile))));

    this.logger.debug({
      msg: 'finished storing batch of tiles',
      duration,
      parent,
      count: tiles.length,
      endpoint: this.endpoint,
      bucketName: this.bucket,
    });
  }

  public async deleteTiles(tiles: TileWithMetadata[]): Promise<void> {
    if (tiles.length === 0) {
      return;
    }

    const parent = tiles[0]?.parent;

    this.logger.info({
      msg: 'executing batch deletion of tiles from bucket',
      parent,
      count: tiles.length,
      endpoint: this.endpoint,
      bucketName: this.bucket,
      maxBatchSize: S3_BATCH_DELETE_MAX_SIZE,
    });

    const keysToDelete: ObjectIdentifier[] = tiles.map((tile) => ({ Key: this.determineKey(tile) }));

    const batches: ObjectIdentifier[][] = [];

    for (let i = 0; i < keysToDelete.length; i += S3_BATCH_DELETE_MAX_SIZE) {
      batches.push(keysToDelete.slice(i, i + S3_BATCH_DELETE_MAX_SIZE));
    }

    const deletePromises = batches.map(async (batch, index) => {
      const command = new DeleteObjectsCommand({
        Bucket: this.bucket,
        Delete: { Objects: batch, Quiet: true },
      });

      try {
        const response = await this.s3Client.send(command);

        if (response.Errors && response.Errors.length > 0) {
          response.Errors.forEach((error) => {
            this.logger.error({
              msg: 'an error occurred during tile deletion for a key',
              err: error.Message,
              key: error.Key,
              parent,
              endpoint: this.endpoint,
              bucketName: this.bucket,
            });
          });

          throw new Error(`batch deleteion ${index} partially failed with at least one out of ${batch.length} object deletion failure`);
        }

        this.logger.debug({
          msg: `finished the deletion of batch ${index + 1}/${batches.length} of tiles`,
          count: batch.length,
          parent,
          endpoint: this.endpoint,
          bucketName: this.bucket,
        });
      } catch (error) {
        const s3Error = error as Error;
        this.logger.error({
          msg: `an error occurred during batch tile deletion (batch ${index + 1}/${batches.length})`,
          err: s3Error,
          count: batch.length,
          parent,
          endpoint: this.endpoint,
          bucketName: this.bucket,
        });
        throw new Error(`an error occurred during the delete of a batch of keys on bucket ${this.bucket}, ${s3Error.message}`);
      }
    });

    const [, duration] = await timerify(async () => Promise.all(deletePromises));

    this.logger.debug({
      msg: 'finished batch deletion of tiles',
      duration,
      parent,
      count: tiles.length,
      endpoint: this.endpoint,
      bucketName: this.bucket,
      deletedKeys: keysToDelete.map((k) => k.Key),
    });
  }

  private determineKey(tile: Required<Tile>): string {
    if (this.storageLayout.shouldFlipY) {
      tile.y = getFlippedY(tile);
    }
    const key = Format(this.storageLayout.format, tile);
    return key;
  }
}
