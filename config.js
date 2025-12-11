import 'dotenv/config'
import path from 'path'

const requiredEnvVars = [
  'OUTPUT_DIR',
  'SSBM_ISO_PATH',
  'DOLPHIN_PATH',
  'QUALITY',
  'BITRATE_KBPS',
  'NUM_WORKERS',
  'DOLPHIN_TIMEOUT_MS',
  'FFMPEG_TIMEOUT_MS',
  'OVERLAY_TIMEOUT_MS',
  'STITCH_MIN_TOTAL_MINUTES',
  'ARCHIVE_TITLE',
  'YOUTUBE_CLIENT_ID',
  'YOUTUBE_CLIENT_SECRET',
  'YOUTUBE_REFRESH_TOKEN',
  'PGHOST',
  'PGPORT',
  'PGUSER',
  'PGPASSWORD',
  'PGDATABASE',
  'REPLAY_DIRECTORY',
]

const missing = requiredEnvVars.filter((key) => !process.env[key] || process.env[key] === '')
if (missing.length) {
  throw new Error(`Missing required env vars: ${missing.join(', ')}`)
}

function parseNumberEnv(key, defaultValue) {
  const raw = process.env[key]
  if ((raw === undefined || raw === null || raw === '') && defaultValue !== undefined) {
    return defaultValue
  }
  const cleaned = String(raw ?? '')
    .split('#')[0]
    .trim()
  const num = Number(cleaned)
  if (Number.isNaN(num)) {
    throw new Error(`Invalid number for ${key}: ${raw}`)
  }
  return num
}

export const config = {
  outputDir: process.env.OUTPUT_DIR,
  gamesDir: path.join(process.env.OUTPUT_DIR, 'games'),
  finalDir: path.join(process.env.OUTPUT_DIR, 'final'),
  keepTempFiles: process.env.KEEP_TEMP_FILES === 'true',
  ssbmIsoPath: process.env.SSBM_ISO_PATH,
  dolphinPath: process.env.DOLPHIN_PATH,
  quality: parseNumberEnv('QUALITY'),
  bitrateKbps: parseNumberEnv('BITRATE_KBPS'),
  numWorkers: parseNumberEnv('NUM_WORKERS'),
  dolphinTimeoutMs: parseNumberEnv('DOLPHIN_TIMEOUT_MS'),
  ffmpegTimeoutMs: parseNumberEnv('FFMPEG_TIMEOUT_MS'),
  overlayTimeoutMs: parseNumberEnv('OVERLAY_TIMEOUT_MS'),
  stitchMinTotalMinutes: parseNumberEnv('STITCH_MIN_TOTAL_MINUTES'),
  archiveTitle: process.env.ARCHIVE_TITLE,
  youtubeClientId: process.env.YOUTUBE_CLIENT_ID,
  youtubeClientSecret: process.env.YOUTUBE_CLIENT_SECRET,
  youtubeRefreshToken: process.env.YOUTUBE_REFRESH_TOKEN,
  youtubePrivacy: process.env.YOUTUBE_PRIVACY || 'unlisted',
  stitchTimeoutMs: parseNumberEnv('STITCH_TIMEOUT_MS', 4 * 60 * 60 * 1000),
  claimTtlMs: parseNumberEnv('CLAIM_TTL_MS', 24 * 60 * 60 * 1000),
  // Base directory for replay files (set per machine)
  replayDirectory: process.env.REPLAY_DIRECTORY,
  // Optional: prefix stored in DB file paths to swap with replayDirectory
  replayPathPrefix: process.env.REPLAY_PATH_PREFIX || null,
}
