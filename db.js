import fs from 'fs'
import path from 'path'
import { Pool } from 'pg'
import os from 'os'
import { config } from './config.js'

const {
  PGHOST = 'localhost',
  PGPORT = '5432',
  PGUSER = 'postgres',
  PGPASSWORD,
  PGDATABASE = 'replay_archiver',
  PGSSL = 'false',
} = process.env

const pool = new Pool({
  host: PGHOST,
  port: Number(PGPORT),
  user: PGUSER,
  password: PGPASSWORD,
  database: PGDATABASE,
  ssl: PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30000,
})

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
])

function resolveReplayPath(filePath) {
  if (!filePath) return filePath
  const normalized = path.normalize(filePath)
  const replayDir = config.replayDirectory ? path.resolve(config.replayDirectory) : null
  const prefixToSwap =
    config.replayPathPrefix && config.replayPathPrefix.length
      ? path.resolve(config.replayPathPrefix)
      : null

  // If the path is valid as-is, keep it.
  if (fs.existsSync(normalized)) return normalized

  // If stored as relative, anchor it to this machine's replay directory.
  if (replayDir && !path.isAbsolute(normalized)) {
    const candidate = path.join(replayDir, normalized)
    if (fs.existsSync(candidate)) return candidate
  }

  // If a prefix was stored in the DB, swap it for this machine's base.
  if (replayDir && prefixToSwap && normalized.startsWith(prefixToSwap)) {
    const candidate = path.join(replayDir, path.relative(prefixToSwap, normalized))
    if (fs.existsSync(candidate)) return candidate
  }

  // Fallback: use the filename inside the configured replay directory.
  if (replayDir) {
    const candidate = path.join(replayDir, path.basename(normalized))
    if (fs.existsSync(candidate)) return candidate
    return candidate
  }

  // Fall back to the original value.
  return normalized
}

export async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS replays (
      ref_id TEXT UNIQUE NOT NULL,
      date TEXT,
      game_length_frames INTEGER,
      recorded INTEGER DEFAULT 0,
      overlaid INTEGER DEFAULT 0,
      stitch_pending INTEGER DEFAULT 0,
      stitched INTEGER DEFAULT 0,
      uploaded INTEGER DEFAULT 0,
      video_duration_seconds REAL,
      skip INTEGER DEFAULT 0,
      claimed_by TEXT,
      claimed_at TEXT,
      id SERIAL PRIMARY KEY,
      idx INTEGER UNIQUE NOT NULL,
      file_path TEXT NOT NULL,
      players TEXT,
      codes TEXT
    );
    CREATE INDEX IF NOT EXISTS replays_idx_idx ON replays(idx);
    CREATE INDEX IF NOT EXISTS replays_uploaded_idx ON replays(uploaded);
    CREATE INDEX IF NOT EXISTS replays_overlaid_idx ON replays(overlaid);
  `)
}

async function withClient(fn) {
  const client = await pool.connect()
  try {
    return await fn(client)
  } finally {
    client.release()
  }
}

function toRow(rec) {
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
  }
}

function rowToReplay(row) {
  if (!row) return null
  const resolvedPath = resolveReplayPath(row.file_path)
  return {
    db_id: row.id,
    index: row.idx,
    id: row.ref_id,
    file_path: resolvedPath,
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
  }
}

export async function clearReplays() {
  await pool.query('DELETE FROM replays')
}

export async function insertReplay(rec) {
  const row = toRow(rec)
  await pool.query(
    `INSERT INTO replays
    (idx, ref_id, file_path, date, players, codes, game_length_frames, stitch_pending, video_duration_seconds, recorded, overlaid, stitched, uploaded, skip, claimed_by, claimed_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      row.idx,
      row.ref_id,
      row.file_path,
      row.date,
      row.players,
      row.codes,
      row.game_length_frames,
      row.stitch_pending,
      row.video_duration_seconds,
      row.recorded,
      row.overlaid,
      row.stitched,
      row.uploaded,
      row.skip,
      row.claimed_by,
      row.claimed_at,
    ]
  )
}

export async function insertReplayBatch(records) {
  if (!records || records.length === 0) return
  await withClient(async (client) => {
    await client.query('BEGIN')
    try {
      const stmt = `INSERT INTO replays
        (idx, ref_id, file_path, date, players, codes, game_length_frames, stitch_pending, video_duration_seconds, recorded, overlaid, stitched, uploaded, skip, claimed_by, claimed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        ON CONFLICT (idx) DO NOTHING`
      for (const rec of records) {
        const row = toRow(rec)
        await client.query(stmt, [
          row.idx,
          row.ref_id,
          row.file_path,
          row.date,
          row.players,
          row.codes,
          row.game_length_frames,
          row.stitch_pending,
          row.video_duration_seconds,
          row.recorded,
          row.overlaid,
          row.stitched,
          row.uploaded,
          row.skip,
          row.claimed_by,
          row.claimed_at,
        ])
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    }
  })
}

export async function getStats() {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COALESCE(SUM(uploaded),0)::int AS uploaded,
      COALESCE(SUM(stitched),0)::int AS stitched,
      COALESCE(SUM(overlaid),0)::int AS overlaid,
      COALESCE(SUM(recorded),0)::int AS recorded,
      COALESCE(SUM(skip),0)::int AS skipped,
      COALESCE(SUM(CASE WHEN claimed_by IS NOT NULL THEN 1 ELSE 0 END),0)::int AS claimed
    FROM replays
  `)
  const row = rows[0] || {}
  const pendingRes = await pool.query(
    'SELECT COUNT(*)::int AS c FROM replays WHERE uploaded = 0 AND skip = 0'
  )
  const pending = pendingRes.rows[0]?.c || 0
  return {
    total: row.total || 0,
    uploaded: row.uploaded || 0,
    stitched: row.stitched || 0,
    overlaid: row.overlaid || 0,
    recorded: row.recorded || 0,
    skipped: row.skipped || 0,
    claimed: row.claimed || 0,
    pending,
  }
}

export async function claimNextReplay(claimTtlMs) {
  const hostname = os.hostname()
  const cutoff = new Date(Date.now() - claimTtlMs).toISOString()
  const stitchCutoff = new Date(
    Date.now() - Math.min(claimTtlMs, 60 * 1000)
  ).toISOString()
  const nowIso = new Date().toISOString()

  return withClient(async (client) => {
    await client.query('BEGIN')
    try {
      const res = await client.query(
        `SELECT * FROM replays
         WHERE uploaded = 0
           AND skip = 0
           AND (stitch_pending = 1 OR recorded = 0 OR overlaid = 0 OR stitched = 0)
           AND (
                (stitch_pending = 1 AND (claimed_at IS NULL OR claimed_at < $1))
                OR (stitch_pending != 1 AND (claimed_at IS NULL OR claimed_at < $2))
           )
         ORDER BY idx
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [stitchCutoff, cutoff]
      )
      const row = res.rows[0]
      if (!row) {
        await client.query('COMMIT')
        return null
      }
      await client.query(
        `UPDATE replays SET claimed_by = $1, claimed_at = $2 WHERE id = $3`,
        [hostname, nowIso, row.id]
      )
      await client.query('COMMIT')
      row.claimed_by = hostname
      row.claimed_at = nowIso
      return rowToReplay(row)
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    }
  })
}

export async function updateFlags(ids, fields) {
  if (!ids || ids.length === 0) return
  if (!fields || Object.keys(fields).length === 0) return
  const sets = []
  const params = []
  let idx = 1
  for (const [k, v] of Object.entries(fields)) {
    if (!ALLOWED_UPDATE_FIELDS.has(k)) {
      throw new Error(`Invalid field for update: ${k}`)
    }
    sets.push(`${k} = $${idx++}`)
    params.push(typeof v === 'boolean' ? (v ? 1 : 0) : Array.isArray(v) ? JSON.stringify(v) : v)
  }
  const placeholders = ids.map((_, i) => `$${idx + i}`).join(',')
  const sql = `UPDATE replays SET ${sets.join(', ')} WHERE idx IN (${placeholders})`
  params.push(...ids)
  await pool.query(sql, params)
}

export async function releaseClaim(idx) {
  await pool.query(`UPDATE replays SET claimed_by = NULL, claimed_at = NULL WHERE idx = $1`, [idx])
}

export async function getReadyForStitch() {
  const { rows } = await pool.query(
    `SELECT * FROM replays
     WHERE skip = 0 AND uploaded = 0 AND overlaid = 1
     ORDER BY idx`
  )
  return rows.map(rowToReplay)
}

export async function getBlockers(maxIdx) {
  const { rows } = await pool.query(
    `SELECT idx FROM replays
     WHERE skip = 0 AND uploaded = 0 AND idx <= $1 AND overlaid = 0
     ORDER BY idx`,
    [maxIdx]
  )
  return rows.map((r) => r.idx)
}

export async function rowToReplayAsync(idx) {
  const { rows } = await pool.query(`SELECT * FROM replays WHERE idx = $1`, [idx])
  return rowToReplay(rows[0])
}

export async function getVideoEntries() {
  const { rows } = await pool.query(`SELECT * FROM replays ORDER BY idx`)
  return rows.map(rowToReplay)
}

export async function endPool() {
  await pool.end()
}

export async function resetAllFlags() {
  const res = await pool.query(
    `UPDATE replays
     SET recorded = 0,
         overlaid = 0,
         stitched = 0,
         uploaded = 0,
         stitch_pending = 0,
         video_duration_seconds = NULL,
         claimed_by = NULL,
         claimed_at = NULL`
  )
  return res.rowCount || 0
}
