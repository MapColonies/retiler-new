import type { Profile } from '../lib/types.mts';

export interface GateContext {
  repositoryRoot: string;
  /** Throwaway directory for databases and worker files produced by a run. */
  scratchDirectory: string;
  /** Where the run's report is written. */
  resultsDirectory: string;
  profile: Profile;
  /** Verdicts of the gates that already ran, so a gate can report itself blocked. */
  previous: Map<number, 'pass' | 'fail' | 'blocked' | 'not-run'>;
}
