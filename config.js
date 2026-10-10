import 'dotenv/config'
import os from 'os'
import path from 'path'

const requiredEnvVars = [
  'OUTPUT_DIR',
  'SSBM_ISO_PATH',
  'DOLPHIN_PATH',
  'NUM_WORKERS',
  'DOLPHIN_TIMEOUT_MS',
  'FFMPEG_TIMEOUT_MS',
  'OVERLAY_TIMEOUT_MS',
  'STITCH_MIN_TOTAL_MINUTES',
  // EFBScale for the Dolphin dump. Required because leaving it unset makes a
  // recording inherit whatever resolution the operator last played at — one
  // such run produced a 25GB AVI at ~4fps for a 75-second game.
  'QUALITY',
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

function parseBooleanEnv(key, defaultValue) {
  const raw = process.env[key]
  if ((raw === undefined || raw === null || raw === '') && defaultValue !== undefined) {
    return defaultValue
  }
  const cleaned = String(raw ?? '')
    .split('#')[0]
    .trim()
    .toLowerCase()
  if (cleaned === 'true' || cleaned === '1') return true
  if (cleaned === 'false' || cleaned === '0') return false
  throw new Error(`Invalid boolean for ${key}: ${raw}`)
}

// When SCRATCH_DIR is set, all intermediate files (-unmerged, -merged,
// overlay png, dolphin .json) write to SCRATCH_DIR/games/ instead of
// OUTPUT_DIR/games/. The final overlaid NNNNNN.avi is then atomically
// published to OUTPUT_DIR/games/. Use on machines where OUTPUT_DIR is
// a network mount and intermediates would otherwise saturate the link.
const scratchDir = process.env.SCRATCH_DIR || null
const scratchGamesDir = scratchDir ? path.join(scratchDir, 'games') : null

// Dolphin encodes the frame dump on a single thread, and that thread is the
// recording speed limit. The codec is therefore the biggest lever on how long a
// bulk archive takes, and it is a quality/speed/disk trade-off only the operator
// can make — so it is configuration, not a constant.
//
//   unset     inherit the Dolphin profile's own setting (previous behaviour)
//   ffv1      lossless. 0.77x realtime at native, but only 0.10x at high EFB
//   utvideo   ~bit-exact and ~8x faster than ffv1 at high EFB (0.81x), but
//             writes ~12GB per 75s game and needs an even dump width, so it is
//             refused at QUALITY=2 (native is 939 wide)
//   mpeg4     lossy (about -6 dB), 3.0-3.6x realtime with EMULATION_SPEED=0
//   h264      refused by the runner — it drops the last ~50 frames at SIGTERM
const DUMP_CODECS = ['ffv1', 'utvideo', 'mpeg4']
function parseDumpCodec() {
  const raw = (process.env.DUMP_CODEC || '').split('#')[0].trim().toLowerCase()
  if (!raw) return null
  if (raw === 'h264') {
    throw new Error('DUMP_CODEC=h264 is refused: Dolphin drops the last ~50 frames of an h264 dump at SIGTERM')
  }
  if (!DUMP_CODECS.includes(raw)) {
    throw new Error(`Invalid DUMP_CODEC: ${raw}. Expected one of ${DUMP_CODECS.join(', ')}, or unset to inherit the profile.`)
  }
  return raw
}

export const config = {
  outputDir: process.env.OUTPUT_DIR,
  gamesDir: path.join(process.env.OUTPUT_DIR, 'games'),
  finalDir: path.join(process.env.OUTPUT_DIR, 'final'),
  scratchDir,
  scratchGamesDir,
  // Where per-replay intermediate files actually live. Equal to gamesDir
  // when SCRATCH_DIR is unset (legacy behavior, no functional change).
  workingGamesDir: scratchGamesDir || path.join(process.env.OUTPUT_DIR, 'games'),
  keepTempFiles: process.env.KEEP_TEMP_FILES === 'true',
  ssbmIsoPath: process.env.SSBM_ISO_PATH,
  dolphinPath: process.env.DOLPHIN_PATH,
  quality: parseNumberEnv('QUALITY', null),
  bitrateKbps: parseNumberEnv('BITRATE_KBPS', null),
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
  youtubeMadeForKids: parseBooleanEnv('YOUTUBE_MADE_FOR_KIDS', false),
  stitchTimeoutMs: parseNumberEnv('STITCH_TIMEOUT_MS', 4 * 60 * 60 * 1000),
  claimTtlMs: parseNumberEnv('CLAIM_TTL_MS', 24 * 60 * 60 * 1000),
  // After this many worker failures on the same replay, auto-set skip=1.
  // Prevents a single bad .slp (Dolphin hang, etc.) from blocking the stitcher
  // indefinitely.
  maxReplayErrors: parseNumberEnv('MAX_REPLAY_ERRORS', 3),
  slippiUpdate: parseNumberEnv('SLIPPI_UPDATE', 7950),
  // Dump codec: see DUMP_CODECS above. null = inherit the profile.
  dumpCodec: parseDumpCodec(),
  // [Core] EmulationSpeed. 0 = unlimited; only helps when the encoder is not
  // the bottleneck (i.e. with mpeg4, not with ffv1 at high EFB). Output is
  // bit-identical where it applies. null = inherit.
  emulationSpeed: parseNumberEnv('EMULATION_SPEED', null),
  // Where the per-worker throwaway Dolphin profiles are built. One per
  // concurrent Dolphin is mandatory: the dump path is a property of the user
  // dir, so two Dolphins sharing one silently overwrite each other's frames.
  // Keep it on local disk, never on a network mount.
  dolphinProfileDir: process.env.DOLPHIN_PROFILE_DIR || path.join(os.tmpdir(), 'replay_archiver_dolphin'),
  // The archive owner's own player, used to tell them apart from opponents in
  // overlays and index reports. Comma-separated; matched case-insensitively,
  // codes exactly and tags as substrings.
  archivePlayerCodes: (process.env.ARCHIVE_PLAYER_CODES || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
  archivePlayerTags: (process.env.ARCHIVE_PLAYER_TAGS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  youtubeChannelId: process.env.YOUTUBE_CHANNEL_ID || null,
  // Base directory for replay files (set per machine)
  replayDirectory: process.env.REPLAY_DIRECTORY,
  // Optional: prefix stored in DB file paths to swap with replayDirectory
  replayPathPrefix: process.env.REPLAY_PATH_PREFIX || null,
}
