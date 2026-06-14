import 'dotenv/config';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import pkg from 'pg';
const { Pool } = pkg;
import { maybeStitchAndUpload } from '../stitcher.js';

const execFileAsync = promisify(execFile);

const OUTPUT_DIR = process.env.OUTPUT_DIR;
if (!OUTPUT_DIR) { console.error('OUTPUT_DIR env var not set'); process.exit(1); }
const FINAL_DIR = process.env.FINAL_DIR || path.join(OUTPUT_DIR, 'final');
const GAMES_DIR = process.env.GAMES_DIR || path.join(OUTPUT_DIR, 'games');
const UPLOADS_PATH = process.env.UPLOADS_JSON || path.join(OUTPUT_DIR, 'uploads.json');
const RESTITCH_LOG = path.resolve('reports/restitch_log.json');

const manifestArg = process.argv[2];
if (!manifestArg) {
  console.error('Usage: node scripts/restitch_manifest.js <manifest-path-or-videoId>');
  process.exit(1);
}

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || 'replay_archiver',
});

// Resolve manifest path: accept either a file path or a videoId
const uploads = JSON.parse(await fs.readFile(UPLOADS_PATH, 'utf8'));
let manifestPath = manifestArg;
let upload;
if (!manifestArg.endsWith('.manifest.json')) {
  upload = uploads.find((u) => u.videoId === manifestArg);
  if (!upload) { console.error(`No upload found for videoId=${manifestArg}`); process.exit(1); }
  manifestPath = path.join(FINAL_DIR, path.basename(upload.stitchedPath).replace(/\.mkv$/, '.manifest.json'));
} else {
  const base = path.basename(manifestPath).replace(/\.manifest\.json$/, '');
  upload = uploads.find((u) => path.basename(u.stitchedPath, '.mkv') === base);
}

console.log(`Manifest: ${manifestPath}`);
console.log(`Old videoId: ${upload?.videoId || '(none)'}`);

const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const indices = (manifest.games || []).map((g) => g.index);
console.log(`Indices: ${indices[0]}-${indices[indices.length - 1]} (${indices.length} games)`);

// Verify all AVIs are healthy
async function ffprobeOk(p) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', p,
    ], { timeout: 15000 });
    const d = parseFloat(String(stdout).trim());
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch { return null; }
}

console.log('Verifying all AVIs are healthy…');
const notReady = [];
for (const g of manifest.games || []) {
  const aviPath = path.join(GAMES_DIR, path.basename(g.video_path || `${String(g.index).padStart(6, '0')}.avi`));
  if (!existsSync(aviPath)) { notReady.push({ idx: g.index, reason: 'missing' }); continue; }
  const dur = await ffprobeOk(aviPath);
  if (dur == null) { notReady.push({ idx: g.index, reason: 'unprobeable' }); continue; }
  if (g.video_duration_seconds && dur < g.video_duration_seconds * 0.95) {
    notReady.push({ idx: g.index, reason: 'short', ffSec: dur, manifestSec: g.video_duration_seconds });
  }
}

// Verify DB shows overlaid=1 for all
const { rows: dbRows } = await pool.query(
  `SELECT idx, recorded, overlaid, uploaded, skip FROM replays WHERE idx = ANY($1) ORDER BY idx`,
  [indices]
);
const notOverlaid = dbRows.filter((r) => r.overlaid !== 1 && r.skip !== 1);

if (notReady.length || notOverlaid.length) {
  console.error(`\nNOT READY — cannot re-stitch yet:`);
  if (notReady.length) {
    console.error(`  Bad AVIs: ${notReady.length} (sample: ${JSON.stringify(notReady.slice(0, 5))})`);
  }
  if (notOverlaid.length) {
    console.error(`  Not overlaid in DB: ${notOverlaid.length} (sample idx: ${notOverlaid.slice(0, 5).map((r) => r.idx).join(', ')})`);
  }
  console.error(`\nWait for the recorder/overlayer to heal these, then re-run.`);
  await pool.end();
  process.exit(2);
}

// Reset DB so stitcher picks them up
console.log(`Resetting uploaded/stitched flags for ${indices.length} indices…`);
await pool.query(
  `UPDATE replays SET uploaded=0, stitched=0, stitch_pending=0
   WHERE idx = ANY($1)`,
  [indices]
);

// Call stitcher
console.log(`Calling maybeStitchAndUpload({ onlyIndices: ${indices.length} indices })…`);
let stitchResult;
try {
  stitchResult = await maybeStitchAndUpload(null, (s) => process.stderr.write(`  status: ${s}\r`), { onlyIndices: indices });
} catch (err) {
  console.error(`\nStitcher threw: ${err.message}`);
  console.error('(post-stitch duration check likely caught a still-corrupt AVI — investigate which idx is bad)');
  await pool.end();
  process.exit(3);
}
process.stderr.write('\n');

console.log(`Stitcher returned: ${stitchResult}`);

// Find the new videoId from the just-written manifest (it should now have videoId set)
const newManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const newVideoId = newManifest.videoId;
console.log(`New videoId: ${newVideoId}`);

// Append to restitch log
let log = [];
try { log = JSON.parse(await fs.readFile(RESTITCH_LOG, 'utf8')); } catch {}
log.push({
  manifestPath,
  oldVideoId: upload?.videoId || null,
  newVideoId,
  oldStitchedPath: upload?.stitchedPath || null,
  newStitchedPath: newManifest.stitchedPath,
  restitchedAt: new Date().toISOString(),
});
await fs.mkdir(path.dirname(RESTITCH_LOG), { recursive: true });
await fs.writeFile(RESTITCH_LOG, JSON.stringify(log, null, 2));
console.log(`Logged to ${RESTITCH_LOG}`);

await pool.end();
