# Turso GeoPackage feasibility harness

Executable version of the gates in `planning/geopackage-turso-feasibility.md`.

The question it answers: **can multiple Retiler pods write concurrently to one
standards-compliant GeoPackage on a shared volume, using only published Turso
artifacts?** It produces evidence, not an opinion — every verdict is backed by a
recorded observation.

This is an experiment. It is deliberately self-contained: it does not touch
`src/`, the service's `tsconfig`, its Jest configuration, or its build. What it
does change outside this directory:

- `package.json` — the pinned `@tursodatabase/database` devDependency and the
  `experiment:turso*` scripts
- `eslint.config.mjs` — two `experiments/**`-scoped rule overrides
- `.gitignore`, `.prettierignore`, `.dockerignore` — keep generated run output
  out of git and prettier, and the whole directory out of the production image

## Running it

```bash
npm run experiment:turso              # all six gates, quick profile
npm run experiment:turso -- --profile full
npm run experiment:turso -- --gates 3,6 --keep-scratch
npm run experiment:turso:test         # unit tests for the pure logic
npm run experiment:turso:typecheck
```

Reports land in `results/`: `latest.md` plus a timestamped `.md` and `.json` per
run. The `.json` holds the full measurements — per-scenario throughput, latency
percentiles, conflict and retry counts, file footprints, crash outcomes.

Requires Node 24 (the harness runs `.mts` directly via type stripping) and, for
the interoperability checks, `gdalinfo` on `PATH`. Ordinary SQLite comes from
Node's built-in `node:sqlite`, so no separate SQLite install is needed.

## Layout

| Path | What it is |
| --- | --- |
| `run.mts` | Orchestrator: runs the gates, writes the report |
| `gates/` | One module per gate, each returning a `GateResult` |
| `lib/` | Coordinates, retry policy, workload planning, GeoPackage fixture, validation, metrics |
| `workers/` | The separate OS processes the gates spawn |
| `tests/` | `node --test` specs for the pure logic |

The pure, decision-carrying logic — coordinate conversion, error
classification, backoff, workload planning, metric aggregation, the GeoPackage
fixture — is unit tested. The gates themselves are the experiment and are
verified by running them.

## Design notes worth knowing

**Writers are real processes.** Concurrency inside one process would prove
nothing about separate pods, so every writer is a spawned OS process with its
own connection.

**Correctness is checked by replaying the database's own commit log.** Each
mutation transaction also writes a row to `_experiment_commit_log`, so the
commit order is recorded by the same transaction that wrote the tiles. Replaying
it gives the exact expected winner for every contended coordinate, which makes
"latest wins" checkable rather than a guess about timing. Finalization drops
that table before validating.

`commit_seq` is a global autoincrement. That is a sound commit order *only
because writers serialize* — see gate 2. It would need revisiting if Turso ever
allowed genuinely concurrent commits.

**Turso never builds the GeoPackage.** The fixture is written by ordinary SQLite
from the OGC schema, so any deviation afterwards is attributable to Turso.

**Both engines get the same lock wait.** Turso gets `DatabaseOpts.timeout` and
the SQLite control gets `PRAGMA busy_timeout`, both `DEFAULT_BUSY_TIMEOUT_MS`.
Without this the comparison is meaningless: an untimed Turso writer fails a
contended write in about a millisecond and can be starved out of the file
entirely.

**Every gate runs even after an earlier one fails.** The plan says to stop at the
first blocker, but a blocker in one gate rarely answers what the later gates ask,
and the point is to produce the whole evidence set in one pass.

**Throughput is measured repeatedly, and may still be inconclusive.** Across
three early full runs the same comparison produced ratios from 0.53x to 1.84x
purely from machine noise, so a single sample cannot support a verdict. Each
writer count now runs `THROUGHPUT_REPEATS` times per engine; the verdict uses the
median, and if the repetitions land on both sides of parity the check reports
`not-run` rather than picking a side. Every sample is in the JSON report.

**The throughput comparison has a known asymmetry.** The control prepares its
three statements once and reuses them; the Turso path re-prepares on every
`tx.run`, because a statement prepared from a `Transaction` handle dies with that
transaction, and one prepared from the `Database` deadlocks if awaited inside a
transaction callback. That is what the published API forces an adapter to do, so
the comparison does reflect real usage — but some of the gap is preparation
overhead rather than commit throughput. The control is also synchronous
(`node:sqlite`) against Turso's async native binding. Treat the ratio as
directional, not precise.

## Two hazards in attaching to a shared file

Both are intermittent and load-dependent: they show up far more often when the
machine is already busy, which in a full run means gates 4 and 5 — gate 5 passes
five times out of five in isolation but can lose a writer immediately after gate
4's fleet work. When either hazard costs a writer, the affected gate reports a
failure and records the exact error, so a `FAIL` on "every writer process ran to
completion" or "a surviving process keeps writing" should be read as one of
these, not as harness flakiness.

**Simultaneous opens can be refused.** Gate 2 starts N processes at the same
instant, repeatedly, and counts the refusals: `Locking error: ... Database is
already open without experimental multiprocess WAL in another process`. Observed
at roughly 3-5 per 100 opens with 8 concurrent openers, and once with only 2.
`DatabaseOpts.timeout` does not cover the open path, so an adapter has to retry
the open itself — `openTursoWithRetry` does.

**A startup race is reported as corruption.** A writer that loses the race to
initialise the shared WAL coordination file dies with:

```
Corrupt database: shared WAL coordination file is smaller than the
coordination header: got 0, minimum 4096
```

The condition is transient, but the message is indistinguishable from real
corruption. The harness deliberately does **not** classify it as retryable:
blindly retrying anything calling itself corrupt is how a genuinely damaged
GeoPackage gets hammered instead of quarantined. So the process dies — and in a
cluster the pod would crash-loop. Distinguishing the two cases needs Turso to
report them differently.

## Two findings that shaped the code

**`shouldFlipY` must not be reused, and no flip is needed.** In
`@map-colonies/tile-calc`'s WorldCRS84Quad grid, `y = 0` is the *north* row —
`tileToBoundingBox({ z: 1, x: 0, y: 0 })` returns `north: 90`. That is already
GeoPackage's top-left `tile_row` origin, so Retiler's `y` maps straight to
`tile_row`. The global `app.tilesStorage.layout.shouldFlipY` flips y for the S3
and filesystem *key layout*; applying it here would write every tile into the
vertically mirrored row. `lib/coordinates.mts` owns this and ignores the flag.

**GeoPackage 1.3, not 1.4.** GDAL 3.4.1 warns that `user_version` 10400 "may
only be partially supported", which would make every validation run ambiguous.
Both are ratified OGC versions.

## Recovery procedure the experiment establishes

The plan requires every accepted recoverable failure to have a documented,
tested procedure. Gate 5 exercises these; this is what it found is needed.

| Failure | Operator steps | Basis |
| --- | --- | --- |
| A pod is killed mid-transaction | None. The next process to open the file recovers it; the killed batch is wholly absent and `integrity_check` returns ok. | Gate 5, five injection points |
| A pod is killed after commit but before pg-boss is told | None. Let pg-boss retry the render job: reapplying the same batch is idempotent and leaves the file valid. | Gate 5, lost-acknowledgement replay |
| A pod is killed during checkpoint | None. The file reopens clean and the surviving writers keep committing. | Gate 5, `during-checkpoint` |
| A pod is refused at open | None, provided the adapter retries the open. Gate 2 shows simultaneous opens are sometimes rejected outright, and `DatabaseOpts.timeout` does not cover the open path. | Gate 2, open race |

No case required rebuilding the file from S3. That option stays open as the
fallback the plan describes, but nothing observed here made it necessary --
which is a statement about a local filesystem, not about RWX.

## What this environment could not exercise

These are reported as `not-run`, never as passes:

- **The OpenShift RWX StorageClass.** Everything ran on a local filesystem. The
  plan requires the real StorageClass, and POSIX locking over a shared network
  volume is exactly where an embedded engine is most likely to differ. Gate 4
  and gate 5 results should be treated as an upper bound.
- **Pod eviction and PVC unmount/remount.** `SIGKILL` is the closest local
  approximation and was exercised instead.
- **`gdal driver gpkg validate`.** That check needs the unified `gdal` CLI from
  GDAL 3.11+; this host has 3.4.1, so `gdalinfo` and `ogrinfo` were used.
- **QGIS.** Needs a human at a desktop session.
