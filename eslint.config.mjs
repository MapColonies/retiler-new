import tsBaseConfig from '@map-colonies/eslint-config/ts-base';
import jestConfig from '@map-colonies/eslint-config/jest';
import { config } from '@map-colonies/eslint-config/helpers';

export default config(
  jestConfig,
  tsBaseConfig,
  {
    // The Turso feasibility harness under experiments/ is a standalone experiment,
    // not service code. It is dense with literal domain values (EPSG codes, the
    // WorldCRS84Quad bounding box, PRNG constants, percentiles, the writer-count
    // matrix) and it reads and writes GeoPackage columns, whose names are
    // snake_case by specification -- src/retiler/tilesStorageProvider/s3.ts
    // disables the same naming rule for the same reason.
    files: ['experiments/**/*.mts'],
    rules: {
      '@typescript-eslint/no-magic-numbers': 'off',
      '@typescript-eslint/naming-convention': 'off',
      'import-x/exports-last': 'off',
    },
  },
  {
    // The harness specs run on `node --test`, not Jest. Its `describe` and `it`
    // return promises that the runner itself awaits, so flagging them as floating
    // would mean prefixing every block with `void`.
    files: ['experiments/**/tests/**/*.mts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  }
);
