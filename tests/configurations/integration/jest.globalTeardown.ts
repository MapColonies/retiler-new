import { rimraf } from 'rimraf';
import { getConfig, initConfig } from '../../../src/common/config';
import { pgBossFactory } from '../../../src/retiler/jobQueueProvider/pgbossFactory';

export default async function (): Promise<void> {
  await initConfig(true);
  const config = getConfig();
  const pgBossConfig = config.get('app.jobQueue.pgBoss');
  const projectName = config.get('app.project.name');
  const queueName = config.get('app.queueName');
  const pgBoss = pgBossFactory({ ...pgBossConfig, projectName, migrate: false, supervise: false, schedule: false });
  const tileProviders = config.get('app.tilesStorage.providers');

  for (const provider of tileProviders) {
    if (provider.kind === 's3') {
      continue;
    }
    await rimraf(provider.basePath);
  }

  await pgBoss.start();
  const queue = await pgBoss.getQueue(queueName);
  if (queue !== null) {
    await pgBoss.deleteAllJobs(queueName);
    await pgBoss.deleteQueue(queueName);
  }
  await pgBoss.stop({ graceful: false });
}
