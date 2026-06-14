import { promises as fs } from 'fs';
import { existsSync, statSync } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const OUTPUT_DIR = process.env.OUTPUT_DIR;
if (!OUTPUT_DIR) { console.error('OUTPUT_DIR env var not set'); process.exit(1); }
const FINAL_DIR = process.env.FINAL_DIR || path.join(OUTPUT_DIR, 'final');
const GAMES_DIR = process.env.GAMES_DIR || path.join(OUTPUT_DIR, 'games');
const UPLOADS_PATH = process.env.UPLOADS_JSON || path.join(OUTPUT_DIR, 'uploads.json');
const REPORT_PATH = path.resolve('reports/broken_avis.json');

const PROTECT_VIDEO_IDS = [
  'Yy2ZNlYRPjM',
  'dRixauTreFY', 'xBDZ2xwfvF0', 'b_xOLz2u2Qo', 'mX5VigUOxYU', '4_G2ODl4cr4',
  '8BRnNBwqP0k', 'vXkWv0dd5vo', '_1Z-u9H2QOQ', '5FXMSTGK5Ks',
  'LUOgSepTGRE', '3MdOf3mTDKI', 'GgI-YGnHpMw', 'Kuao3Wnir1M', 'rzHke85f1B8',
  'pjWN3dF8QeI', 'bSh42y8Qs20',
  'f6Vhojo4htA', 'O9LsLYcZLt0', '6i2DhBDE-kc', '2MCr4abzN9M', 'aKG9gEh1RSg',
  'KHBxumrbh2c',
];

async function ffprobeDuration(p) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', p,
    ], { timeout: 15000 });
    const d = parseFloat(String(stdout).trim());
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch {
    return null;
  }
}

const uploads = JSON.parse(await fs.readFile(UPLOADS_PATH, 'utf8'));

const report = {};
let totalGames = 0;
let totalBroken = 0;
let totalMissing = 0;
let totalUnprobeable = 0;
let totalShort = 0;

for (const videoId of PROTECT_VIDEO_IDS) {
  const upload = uploads.find((u) => u.videoId === videoId);
  if (!upload) {
    console.error(`  videoId ${videoId} not found in uploads.json`);
    continue;
  }
  const manifestBase = path.basename(upload.stitchedPath).replace(/\.mkv$/, '.manifest.json');
  const manifestPath = path.join(FINAL_DIR, manifestBase);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const games = manifest.games || [];
  const entry = { videoId, title: upload.title, indices: [upload.indices?.[0], upload.indices?.[upload.indices.length - 1]], totalGames: games.length, broken: [] };

  for (let i = 0; i < games.length; i++) {
    const g = games[i];
    totalGames++;
    const aviPath = path.join(GAMES_DIR, path.basename(g.video_path || `${String(g.index).padStart(6, '0')}.avi`));
    const manifestSec = g.video_duration_seconds || 0;

    if (!existsSync(aviPath)) {
      entry.broken.push({ idx: g.index, reason: 'missing', aviPath, manifestSec });
      totalBroken++; totalMissing++;
      continue;
    }
    let size = 0;
    try { size = statSync(aviPath).size; } catch {}
    const ffSec = await ffprobeDuration(aviPath);
    if (ffSec == null) {
      entry.broken.push({ idx: g.index, reason: 'unprobeable', aviPath, manifestSec, size });
      totalBroken++; totalUnprobeable++;
      continue;
    }
    if (manifestSec > 0 && ffSec < manifestSec * 0.95) {
      entry.broken.push({ idx: g.index, reason: 'short', aviPath, manifestSec, ffprobeSec: ffSec, size });
      totalBroken++; totalShort++;
      continue;
    }
  }

  report[videoId] = entry;
  process.stderr.write(`  ${videoId} ${upload.title}: ${entry.broken.length}/${games.length} broken                                    \n`);
}

await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2));

console.log(`\n=== SUMMARY ===`);
console.log(`  Manifests scanned: ${PROTECT_VIDEO_IDS.length}`);
console.log(`  Total games:       ${totalGames}`);
console.log(`  Broken total:      ${totalBroken}`);
console.log(`    missing:         ${totalMissing}`);
console.log(`    unprobeable:     ${totalUnprobeable}`);
console.log(`    short (<95%):    ${totalShort}`);
console.log(`\nReport: ${REPORT_PATH}`);

// Print per-manifest summary table
console.log(`\n=== PER-MANIFEST BREAKDOWN ===`);
console.log('videoId       broken/total  title');
for (const [vid, e] of Object.entries(report)) {
  console.log(`${vid.padEnd(13)} ${String(e.broken.length).padStart(4)}/${String(e.totalGames).padEnd(5)} ${e.title}`);
}
