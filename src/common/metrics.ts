import { Histogram } from 'prom-client';

export const enum ProcessKind {
  FETCH = 'fetch',
  SPLIT = 'split',
  STORE = 'store',
  DELETE = 'delete',
  PRE_PROCESS = 'pre_process',
  POST_PROCESS = 'post_process',
}

export const enum ProcessReason {
  PROJECT_UPDATED = 'project_updated',
  FORCE = 'force',
  NO_DETILER = 'no_detiler',
  ERROR_OCCURRED = 'error_occurred',
}

export const enum ProcessSkipReason {
  TILE_UP_TO_DATE = 'tile_up_to_date',
  COOLDOWN = 'cooldown',
}

export const enum MetatileStatus {
  COMPLETED = 'completed',
  SKIPPED = 'skipped',
  BLANK = 'blank',
  FAILED = 'failed',
}

export const enum SubTileStatus {
  STORED = 'stored',
  BLANK = 'blank',
  OUT_OF_BOUNDS = 'out_of_bounds',
}

export const endMetricTimer = (timer?: ReturnType<Histogram['startTimer']>): void => {
  if (timer) {
    timer();
  }
};
