import 'dotenv/config';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import pkg from 'pg';
const { Pool } = pkg;

const execFileAsync = promisify(execFile);
const FINAL_DIR = '/path/to/output/hax_output/final';
const GAMES_DIR = '/path/to/output/hax_output/games';
const UPLOADS_PATH = '/path/to/output/hax_output/uploads.json';

const PROTECT_VIDEO_IDS = [
  'Yy2ZNlYRPjM',
  'dRixauTreFY', 'xBDZ2xwfvF0', 'b_xOLz2u2Qo', 'mX5VigUOxYU', '4_G2ODl4cr4',
  '8BRnNBwqP0k', 'vXkWv0dd5vo', '_1Z-u9H2QOQ', '5FXMSTGK5Ks',
  'LUOgSepTGRE', '3MdOf3mTDKI', 'GgI-YGnHpMw', 'Kuao3Wnir1M', 'rzHke85f1B8',
  'pjWN3dF8QeI', 'bSh42y8Qs20',
  'f6Vhojo4htA', 'O9LsLYcZLt0', '6i2DhBDE-kc', '2MCr4abzN9M', 'aKG9gEh1RSg',
  'KHBxumrbh2c',
];

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || 'replay_archiver',
});

const uploads = JSON.parse(await fs.readFile(UPLOADS_PATH, 'utf8'));

async function ffprobeOk(p) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', p,
    ], { timeout: 15000 });
    return Number.isFinite(parseFloat(stdout)) ? parseFloat(stdout) : null;
  } catch { return null; }
}

// Decorate uploads with their manifest's first idx so we can sort
const candidates = [];
for (const vid of PROTECT_VIDEO_IDS) {
  const u = uploads.find((x) => x.videoId === vid);
  if (!u) continue;
  const firstIdx = u.indices?.[0] || Infinity;
  candidates.push({ vid, upload: u, firstIdx });
}
candidates.sort((a, b) => a.firstIdx - b.firstIdx);

console.log(`Checking readiness of ${candidates.length} candidates in idx order…\n`);

const ready = [];
const notReady = [];

for (const c of candidates) {
  const manifestPath = path.join(FINAL_DIR, path.basename(c.upload.stitchedPath).replace(/\.mkv$/, '.manifest.json'));
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const games = manifest.games || [];
  const indices = games.map((g) => g.index);

  // Quick DB check
  const { rows } = await pool.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE overlaid=1)::int AS overlaid_ok
     FROM replays WHERE idx = ANY($1)`,
    [indices]
  );
  const overlaidOk = rows[0]?.overlaid_ok || 0;
  const total = rows[0]?.total || 0;

  let aviOk = 0, aviBad = 0;
  for (const g of games.slice(0, 5)) { // quick sample first
    const p = path.join(GAMES_DIR, path.basename(g.video_path));
    if (!existsSync(p)) { aviBad++; continue; }
    const d = await ffprobeOk(p);
    if (d == null) aviBad++; else aviOk++;
  }

  const isReady = overlaidOk === total && aviBad === 0;
  const summary = `${c.vid.padEnd(13)} ${c.upload.title.padEnd(40)} overlaid=${overlaidOk}/${total} sample_avis=${aviOk}/${aviOk + aviBad}`;
  if (isReady) { console.log(`  READY    ${summary}`); ready.push(c); }
  else        { console.log(`  WAITING  ${summary}`); notReady.push(c); }
}

console.log(`\nReady: ${ready.length}   Waiting: ${notReady.length}`);

if (process.argv.includes('--execute') && ready.length > 0) {
  console.log(`\n=== EXECUTING re-stitch on ${ready.length} ready manifests in idx order ===`);
  for (const c of ready) {
    console.log(`\n>>> ${c.vid} ${c.upload.title}`);
    await new Promise((resolve, reject) => {
      const child = spawn('node', ['scripts/restitch_manifest.js', c.vid], { stdio: 'inherit' });
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
      child.on('error', reject);
    }).catch((err) => console.error(`  ${c.vid} failed: ${err.message}`));
  }
}

await pool.end();
