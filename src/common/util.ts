import { MILLISECONDS_IN_SECOND, TIMESTAMP_REGEX } from './constants';

export const timerify = async <R, A extends unknown[]>(func: (...args: A) => Promise<R>, ...args: A): Promise<[R, number]> => {
  const startTime = performance.now();

  const funcResult = await func(...args);

  const endTime = performance.now();

  return [funcResult, endTime - startTime];
};

export const streamToString = async (stream: NodeJS.ReadStream): Promise<string> => {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
};

export const fetchTimestampValue = (content: string): string => {
  const matchResult = content.match(TIMESTAMP_REGEX);
  if (matchResult === null || matchResult.length === 0) {
    throw new Error();
  }

  const value = matchResult[0].split('=')[1];

  if (value === undefined) {
    throw new Error('invalid timestamp format');
  }

  return value.replace(/\\/g, '');
};

export const timestampToUnix = (timestamp: string): number => {
  return new Date(timestamp).getTime() / MILLISECONDS_IN_SECOND;
};
