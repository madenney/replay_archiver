import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

const dbPath = process.env.REPLAYS_DB_PATH || path.join('replays.db');
let db;

const ALLOWED_UPDATE_FIELDS = new Set([
  'idx',
  'ref_id',
  'file_path',
  'date',
  'players',
  'codes',
  'game_length_frames',
  'stitch_pending',
  'video_duration_seconds',
  'recorded',
  'overlaid',
  'stitched',
  'uploaded',
  'skip',
  'claimed_by',
  'claimed_at',
]);

function getDb() {
  if (!db) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    initSchema();
  }
  return db;
}

function initSchema() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS replays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idx INTEGER UNIQUE NOT NULL,
      ref_id TEXT UNIQUE NOT NULL,
      file_path TEXT NOT NULL,
      date TEXT,
      players TEXT,
      codes TEXT,
      game_length_frames INTEGER,
      stitch_pending INTEGER DEFAULT 0,
      video_duration_seconds REAL,
      recorded INTEGER DEFAULT 0,
      overlaid INTEGER DEFAULT 0,
      stitched INTEGER DEFAULT 0,
      uploaded INTEGER DEFAULT 0,
      skip INTEGER DEFAULT 0,
      claimed_by TEXT,
      claimed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS replays_idx_idx ON replays(idx);
    CREATE INDEX IF NOT EXISTS replays_uploaded_idx ON replays(uploaded);
    CREATE INDEX IF NOT EXISTS replays_overlaid_idx ON replays(overlaid);
  `);
  try {
    db.prepare(`ALTER TABLE replays ADD COLUMN stitch_pending INTEGER DEFAULT 0;`).run();
  } catch (_) {
    // ignore if already exists
  }
  try {
    db.prepare(`ALTER TABLE replays ADD COLUMN video_duration_seconds REAL;`).run();
  } catch (_) {
    // ignore if already exists
  }
}

function clearReplays() {
  const db = getDb();
  db.prepare('DELETE FROM replays').run();
}

function toReplayParams(rec) {
  return {
    idx: rec.index,
    ref_id: rec.id,
    file_path: rec.file_path,
    date: rec.date || null,
    players: rec.players ? JSON.stringify(rec.players) : null,
    codes: rec.codes ? JSON.stringify(rec.codes) : null,
    game_length_frames: rec.game_length_frames ?? null,
    stitch_pending: rec.stitch_pending ? 1 : 0,
    video_duration_seconds: rec.video_duration_seconds ?? null,
    recorded: rec.recorded ? 1 : 0,
    overlaid: rec.overlaid ? 1 : 0,
    stitched: rec.stitched ? 1 : 0,
    uploaded: rec.uploaded ? 1 : 0,
    skip: rec.skip ? 1 : 0,
    claimed_by: rec.claimed_by || null,
    claimed_at: rec.claimed_at || null,
  };
}

function insertReplay(rec) {
  const db = getDb();
  db.prepare(
    `INSERT INTO replays
    (idx, ref_id, file_path, date, players, codes, game_length_frames, stitch_pending, video_duration_seconds, recorded, overlaid, stitched, uploaded, skip, claimed_by, claimed_at)
    VALUES (@idx, @ref_id, @file_path, @date, @players, @codes, @game_length_frames, @stitch_pending, @video_duration_seconds, @recorded, @overlaid, @stitched, @uploaded, @skip, @claimed_by, @claimed_at)`
  ).run(toReplayParams(rec));
}

function insertReplayBatch(records) {
  if (!records || records.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO replays
    (idx, ref_id, file_path, date, players, codes, game_length_frames, stitch_pending, video_duration_seconds, recorded, overlaid, stitched, uploaded, skip, claimed_by, claimed_at)
    VALUES (@idx, @ref_id, @file_path, @date, @players, @codes, @game_length_frames, @stitch_pending, @video_duration_seconds, @recorded, @overlaid, @stitched, @uploaded, @skip, @claimed_by, @claimed_at)`
  );
  const insertMany = db.transaction((rows) => {
    rows.forEach((rec) => {
      stmt.run(toReplayParams(rec));
    });
  });
  insertMany(records);
}

function rowToReplay(row) {
  if (!row) return null;
  return {
    db_id: row.id,
    index: row.idx,
    id: row.ref_id,
    file_path: row.file_path,
    date: row.date,
    players: row.players ? JSON.parse(row.players) : [],
    codes: row.codes ? JSON.parse(row.codes) : [],
    game_length_frames: row.game_length_frames,
    stitch_pending: row.stitch_pending,
    video_duration_seconds: row.video_duration_seconds,
    recorded: !!row.recorded,
    overlaid: !!row.overlaid,
    stitched: !!row.stitched,
    uploaded: !!row.uploaded,
    skip: !!row.skip,
    claimed_by: row.claimed_by,
    claimed_at: row.claimed_at,
  };
}

function getStats() {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(uploaded) AS uploaded,
      SUM(stitched) AS stitched,
      SUM(overlaid) AS overlaid,
      SUM(recorded) AS recorded,
      SUM(skip) AS skipped,
      SUM(CASE WHEN claimed_by IS NOT NULL THEN 1 ELSE 0 END) AS claimed
    FROM replays
  `).get();
  const pending = db
    .prepare('SELECT COUNT(*) AS c FROM replays WHERE uploaded = 0 AND skip = 0')
    .get().c;
  return {
    total: row.total || 0,
    uploaded: row.uploaded || 0,
    stitched: row.stitched || 0,
    overlaid: row.overlaid || 0,
    recorded: row.recorded || 0,
    skipped: row.skipped || 0,
    claimed: row.claimed || 0,
    pending,
  };
}

function claimNextReplay(claimTtlMs) {
  const db = getDb();
  const hostname = os.hostname();
  const cutoff = new Date(Date.now() - claimTtlMs).toISOString();
  const nowIso = new Date().toISOString();
  const tx = db.transaction(() => {
        const row = db
          .prepare(
            `SELECT * FROM replays
             WHERE uploaded = 0
               AND skip = 0
               AND (stitch_pending = 1 OR recorded = 0 OR overlaid = 0 OR stitched = 0)
               AND (claimed_at IS NULL OR claimed_at < @cutoff)
             ORDER BY idx
             LIMIT 1`
          )
          .get({ cutoff });
    if (!row) return null;
    db.prepare(
      `UPDATE replays SET claimed_by = @host, claimed_at = @now WHERE id = @id`
    ).run({ host: hostname, now: nowIso, id: row.id });
    row.claimed_by = hostname;
    row.claimed_at = nowIso;
    return rowToReplay(row);
  });
  return tx();
}

function updateFlags(ids, fields) {
  if (!ids || ids.length === 0) return;
  if (!fields || Object.keys(fields).length === 0) return;
  const db = getDb();
  const sets = [];
  const params = {};
  Object.entries(fields).forEach(([k, v]) => {
    if (!ALLOWED_UPDATE_FIELDS.has(k)) {
      throw new Error(`Invalid field for update: ${k}`);
    }
    sets.push(`${k} = @${k}`);
    params[k] =
      typeof v === 'boolean' ? (v ? 1 : 0) : Array.isArray(v) ? JSON.stringify(v) : v;
  });
  const sql = `UPDATE replays SET ${sets.join(', ')} WHERE idx IN (${ids
    .map((_, i) => `@id${i}`)
    .join(',')})`;
  const paramObj = { ...params };
  ids.forEach((id, i) => {
    paramObj[`id${i}`] = id;
  });
  db.prepare(sql).run(paramObj);
}

function releaseClaim(idx) {
  const db = getDb();
  db.prepare(
    `UPDATE replays SET claimed_by = NULL, claimed_at = NULL WHERE idx = ?`
  ).run(idx);
}

function getReadyForStitch() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM replays
       WHERE skip = 0 AND uploaded = 0 AND overlaid = 1
       ORDER BY idx`
    )
    .all();
  return rows.map(rowToReplay);
}

function getBlockers(maxIdx) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT idx FROM replays
       WHERE skip = 0 AND uploaded = 0 AND idx <= ? AND overlaid = 0
       ORDER BY idx`
    )
    .all(maxIdx);
  return rows.map((r) => r.idx);
}

export {
  getDb,
  initSchema,
  clearReplays,
  insertReplay,
  insertReplayBatch,
  getStats,
  claimNextReplay,
  updateFlags,
  releaseClaim,
  getReadyForStitch,
  getBlockers,
  rowToReplay,
};
