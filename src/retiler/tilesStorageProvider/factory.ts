import { createHash } from 'crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { Logger } from '@map-colonies/js-logger';
import { FactoryFunction } from 'tsyringe';
import { CleanupRegistry } from '@map-colonies/cleanup-registry';
import { HttpRequest } from '@smithy/types';
import { ConfigType } from '@src/common/config';
import { validate } from '../../common/validation';
import { SERVICES } from '../../common/constants';
import { TilesStorageProvider } from '../interfaces';
import { StorageProviderConfig } from './interfaces';
import { S3TilesStorage } from './s3';
import { FsTilesStorage } from './fs';
import { TILES_STORAGE_PROVIDERS_SCHEMA } from './validation';

interface Args {
  request: HttpRequest;
}

export const tilesStorageProvidersFactory: FactoryFunction<TilesStorageProvider[]> = (container) => {
  const config = container.resolve<ConfigType>(SERVICES.CONFIG);
  const logger = container.resolve<Logger>(SERVICES.LOGGER);
  const cleanupRegistry = container.resolve<CleanupRegistry>(SERVICES.CLEANUP_REGISTRY);
  const storageProvidersConfig = config.get('app.tilesStorage.providers');
  const tilesStorageLayout = config.get('app.tilesStorage.layout');

  const { isValid, errors } = validate<StorageProviderConfig[]>(storageProvidersConfig, TILES_STORAGE_PROVIDERS_SCHEMA);
  if (!isValid) {
    throw new Error(`invalid tiles storage providers configuration: ${JSON.stringify(errors)}`);
  }

  const s3ClientsMap = new Map<string, S3Client>();

  return storageProvidersConfig.map((providerConfig) => {
    if (providerConfig.kind === 's3') {
      const { kind, bucketName, ...clientConfig } = providerConfig;
      let s3Client = s3ClientsMap.get(clientConfig.endpoint);

      if (!s3Client) {
        // Create S3Client
        s3Client = new S3Client({
          ...clientConfig,
          credentials: {
            accessKeyId: clientConfig.credentials.accessKeyId,
            secretAccessKey: clientConfig.credentials.secretAccessKey,
          },
        });

        // Add MD5 fallback middleware (Content-MD5 header)
        // https://github.com/aws/aws-sdk-js-v3/blob/d1501040077b937ef23e591238cda4bbe729c721/supplemental-docs/MD5_FALLBACK.md
        s3Client.middlewareStack.add(
          /* istanbul ignore next */
          (next, context) => async (args) => {
            const typedArgs = args as Args;

            // Check if this is a DeleteObjects command
            const isDeleteObjects = context.commandName === 'DeleteObjectsCommand';
            if (!isDeleteObjects) {
              return next(args);
            }

            const headers = typedArgs.request.headers;

            // Remove any checksum headers
            Object.keys(headers).forEach((header) => {
              if (header.toLowerCase().startsWith('x-amz-checksum-') || header.toLowerCase().startsWith('x-amz-sdk-checksum-')) {
                delete headers[header];
              }
            });

            // Add MD5
            if (typedArgs.request.body) {
              const bodyContent = Buffer.from(typedArgs.request.body);
              // Create a new hash instance for each request
              headers['Content-MD5'] = createHash('md5').update(bodyContent).digest('base64');
            }

            return next(args);
          },
          {
            step: 'build',
          }
        );

        s3ClientsMap.set(clientConfig.endpoint, s3Client);

        // Register for cleanup
        cleanupRegistry.register({
          func: async () => {
            return new Promise((resolve) => {
              (s3Client as S3Client).destroy();
              return resolve(undefined);
            });
          },
          id: `s3-${clientConfig.endpoint}`,
        });
      }

      return new S3TilesStorage(s3Client, logger, bucketName, tilesStorageLayout);
    }

    // FS Storage
    const { basePath } = providerConfig;
    return new FsTilesStorage(logger, basePath, tilesStorageLayout);
  });
};
