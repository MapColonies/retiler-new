import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { TILE_SIZE_PIXELS } from './geopackage.mts';

/**
 * Identifies which writer and which batch produced a tile's bytes. The payload
 * is derived from it deterministically, so a verifier can recompute the exact
 * bytes it expects to find at a coordinate from the commit log alone.
 */
export interface PayloadMarker {
  writerId: number;
  batchIndex: number;
}

const CHANNELS = 3;

const cache = new Map<string, Buffer>();

const markerKey = (marker: PayloadMarker): string => `${marker.writerId}:${marker.batchIndex}`;

/**
 * A real 256x256 PNG produced by Sharp, exactly as the splitter would emit.
 * The marker is written into the first pixels so two markers can never
 * collide, and the rest is a flat colour so the file stays small.
 *
 * Payloads are memoised per marker: a batch writes the same bytes to every one
 * of its coordinates, which keeps generation cheap without weakening
 * verification -- the marker still identifies the exact commit that won.
 */
export const tilePayload = async (marker: PayloadMarker): Promise<Buffer> => {
  const key = markerKey(marker);
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }

  const raw = Buffer.alloc(TILE_SIZE_PIXELS * TILE_SIZE_PIXELS * CHANNELS, (marker.writerId * 31) % 256);
  raw.writeUInt8(marker.writerId & 0xff, 0);
  raw.writeUInt8((marker.batchIndex >> 8) & 0xff, 1);
  raw.writeUInt8(marker.batchIndex & 0xff, 2);

  const png = await sharp(raw, { raw: { width: TILE_SIZE_PIXELS, height: TILE_SIZE_PIXELS, channels: CHANNELS } })
    .png({ compressionLevel: 6 })
    .toBuffer();

  cache.set(key, png);
  return png;
};

export const sha256 = (buffer: Buffer | Uint8Array): string => createHash('sha256').update(buffer).digest('hex');

export const tilePayloadHash = async (marker: PayloadMarker): Promise<string> => sha256(await tilePayload(marker));
