import { JSONSchemaType } from 'ajv';
import { StorageProviderConfig } from './interfaces';

export const TILES_STORAGE_PROVIDERS_SCHEMA: JSONSchemaType<StorageProviderConfig[]> = {
  type: 'array',
  minItems: 1,
  items: {
    type: 'object',
    required: ['kind'],
    oneOf: [
      {
        type: 'object',
        required: ['kind', 'basePath'],
        additionalProperties: false,
        properties: {
          kind: { const: 'fs' },
          basePath: { type: 'string' },
        },
      },
      {
        type: 'object',
        required: ['kind', 'endpoint', 'bucketName'],
        additionalProperties: true,
        properties: {
          kind: { const: 's3' },
          endpoint: { type: 'string' },
          bucketName: { type: 'string' },
        },
      },
    ],
  },
};
