/* eslint-disable @typescript-eslint/naming-convention */ // s3-client object commands arguments
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { getConfig, initConfig } from '../../../src/common/config';
import { pgBossFactory } from '../../../src/retiler/jobQueueProvider/pgbossFactory';

process.env.ALLOW_CONFIG_MUTATIONS = 'true'; // @aws-sdk/client-s3 attempts to modify config on tests

export default async (): Promise<void> => {
  await initConfig(true);
  const config = getConfig();
  const pgBossConfig = config.get('app.jobQueue.pgBoss');
  const projectName = config.get('app.project.name');
  const queueName = config.get('app.queueName');
  const pgBoss = pgBossFactory({ ...pgBossConfig, projectName, migrate: true, createSchema: true, supervise: false, schedule: false });
  const storageProvidersConfig = config.get('app.tilesStorage.providers');

  const promises = storageProvidersConfig.map(async (provider) => {
    if (provider.kind !== 's3') {
      return Promise.resolve();
    }

    const { kind, bucketName, ...clientConfig } = provider;
    const s3Client = new S3Client({ ...clientConfig, credentials: { ...clientConfig.credentials } });

    try {
      await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
    } catch (error) {
      const s3Error = error as Error;
      if (s3Error.name !== 'NotFound') {
        throw s3Error;
      }
      await s3Client.send(new CreateBucketCommand({ Bucket: bucketName }));
    }
  });

  await Promise.all(promises);

  await pgBoss.start();
  const queue = await pgBoss.getQueue(queueName);
  if (queue === null) {
    await pgBoss.createQueue(queueName, { retryLimit: 0 });
  } else {
    await pgBoss.updateQueue(queueName, { retryLimit: 0 });
  }
  await pgBoss.stop({ graceful: false });
};
