import { DatabaseSync } from 'node:sqlite';
import { sha256, tilePayloadHash } from './payload.mts';
import { COMMIT_LOG_TABLE } from './turso.mts';
import type { MutationOp, WriterReport } from './types.mts';

export interface CommitLogEntry {
  commitSeq: number;
  batchId: string;
  writerId: number;
  batchIndex: number;
  ops: MutationOp[];
}

export interface Verification {
  /** Batches the writers were told had committed. */
  acknowledgedBatches: number;
  /** Batches the database itself records as committed. */
  loggedBatches: number;
  /** Acknowledged batches with no commit-log row: a lost acknowledged mutation. */
  lostAcknowledged: string[];
  /** Committed batches the writer never got an acknowledgement for. */
  unacknowledgedCommits: string[];
  /** Coordinates whose stored bytes are not what the commit order implies. */
  staleTiles: string[];
  /** Coordinates that should have been deleted but are still present. */
  undeletedTiles: string[];
  /** Coordinates that should be present but are missing. */
  missingTiles: string[];
  /** Tiles present with no commit that explains them. */
  orphanTiles: string[];
  finalTileCount: number;
  expectedTileCount: number;
  lastWinsHolds: boolean;
  atomicityHolds: boolean;
}

const coordinateKey = (op: { z: number; x: number; y: number }): string => `${op.z}/${op.x}/${op.y}`;

/**
 * The commit log, or an empty list when the table was never created -- which
 * means no writer ever got as far as its first statement. That is a result the
 * gate should report, not an exception that aborts the whole run.
 */
export const readCommitLog = (databasePath: string): CommitLogEntry[] => {
  const db = new DatabaseSync(databasePath, { readOnly: true });

  try {
    const exists = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(COMMIT_LOG_TABLE) as {
      n: number;
    };

    if (exists.n === 0) {
      return [];
    }

    return (
      db.prepare(`SELECT commit_seq, batch_id, writer_id, batch_index, ops_json FROM ${COMMIT_LOG_TABLE} ORDER BY commit_seq`).all() as {
        commit_seq: number;
        batch_id: string;
        writer_id: number;
        batch_index: number;
        ops_json: string;
      }[]
    ).map((row) => ({
      commitSeq: row.commit_seq,
      batchId: row.batch_id,
      writerId: row.writer_id,
      batchIndex: row.batch_index,
      ops: JSON.parse(row.ops_json) as MutationOp[],
    }));
  } finally {
    db.close();
  }
};

/**
 * Rebuilds the GeoPackage projection the commit order implies, then compares it
 * to what is actually stored.
 *
 * Replaying the database's own commit log -- written inside each mutation
 * transaction -- is what makes "latest wins" checkable even when writers
 * collide: the log fixes the order, so the expected winner of every contended
 * coordinate is unambiguous rather than a guess about timing.
 */
export const verifyDatabase = async (databasePath: string, tileTable: string, reports: WriterReport[]): Promise<Verification> => {
  const log = readCommitLog(databasePath);

  /** coordinate -> the commit that last wrote it, or null if last deleted. */
  const projection = new Map<string, { writerId: number; batchIndex: number } | null>();

  for (const entry of log) {
    for (const op of entry.ops) {
      projection.set(coordinateKey(op), op.kind === 'put' ? { writerId: entry.writerId, batchIndex: entry.batchIndex } : null);
    }
  }

  const db = new DatabaseSync(databasePath, { readOnly: true });
  const stored = new Map<string, string>();

  try {
    const rows = db.prepare(`SELECT zoom_level, tile_column, tile_row, tile_data FROM "${tileTable}"`).all() as {
      zoom_level: number;
      tile_column: number;
      tile_row: number;
      tile_data: Uint8Array;
    }[];

    for (const row of rows) {
      stored.set(`${row.zoom_level}/${row.tile_column}/${row.tile_row}`, sha256(row.tile_data));
    }
  } finally {
    db.close();
  }

  const staleTiles: string[] = [];
  const undeletedTiles: string[] = [];
  const missingTiles: string[] = [];
  let expectedTileCount = 0;

  for (const [key, winner] of projection) {
    const actualHash = stored.get(key);

    if (winner === null) {
      if (actualHash !== undefined) {
        undeletedTiles.push(key);
      }
      continue;
    }

    expectedTileCount++;

    if (actualHash === undefined) {
      missingTiles.push(key);
    } else if (actualHash !== (await tilePayloadHash(winner))) {
      staleTiles.push(key);
    }
  }

  const orphanTiles = [...stored.keys()].filter((key) => !projection.has(key));

  const loggedIds = new Set(log.map((entry) => entry.batchId));
  const acknowledgedIds = new Set(reports.flatMap((report) => report.acknowledged ?? []).map((batch) => batch.batchId));

  const lostAcknowledged = [...acknowledgedIds].filter((id) => !loggedIds.has(id));
  const unacknowledgedCommits = [...loggedIds].filter((id) => !acknowledgedIds.has(id));

  return {
    acknowledgedBatches: acknowledgedIds.size,
    loggedBatches: loggedIds.size,
    lostAcknowledged,
    unacknowledgedCommits,
    staleTiles,
    undeletedTiles,
    missingTiles,
    orphanTiles,
    finalTileCount: stored.size,
    expectedTileCount,
    lastWinsHolds: staleTiles.length === 0 && undeletedTiles.length === 0 && missingTiles.length === 0,
    atomicityHolds: lostAcknowledged.length === 0 && orphanTiles.length === 0 && missingTiles.length === 0,
  };
};
