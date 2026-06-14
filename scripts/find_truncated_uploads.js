import 'dotenv/config';
import { promises as fs } from 'fs';
import path from 'path';
import { google } from 'googleapis';

const FINAL_DIR = path.join(process.env.OUTPUT_DIR || '', 'final');
const UPLOADS_JSON = path.join(process.env.OUTPUT_DIR || '', 'uploads.json');
const TOLERANCE_SECONDS = 30;

function parseIsoDuration(iso) {
  if (!iso) return null;
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (!m) return null;
  return (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
}

function fmtHms(s) {
  if (s == null) return '?';
  s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

const uploads = JSON.parse(await fs.readFile(UPLOADS_JSON, 'utf8'));
console.log(`Loaded ${uploads.length} uploads\n`);

const oauth2Client = new google.auth.OAuth2(
  process.env.YOUTUBE_CLIENT_ID,
  process.env.YOUTUBE_CLIENT_SECRET,
);
oauth2Client.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });
const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

const ids = uploads.map(u => u.videoId).filter(Boolean);
const ytDuration = new Map();
for (let i = 0; i < ids.length; i += 50) {
  const batch = ids.slice(i, i + 50);
  process.stderr.write(`  Checking ${Math.min(i + 50, ids.length)}/${ids.length}...\r`);
  const res = await youtube.videos.list({ part: ['id', 'contentDetails'], id: batch });
  for (const item of res.data.items || []) {
    ytDuration.set(item.id, parseIsoDuration(item.contentDetails?.duration));
  }
  if (i + 50 < ids.length) await new Promise(r => setTimeout(r, 400));
}
process.stderr.write('\n\n');

const truncated = [];
const missing = [];
for (const u of uploads) {
  if (!ytDuration.has(u.videoId)) { missing.push(u); continue; }
  const ytSec = ytDuration.get(u.videoId);

  let expected = null;
  let source = '';
  const manifestPath = path.join(FINAL_DIR, path.basename(u.stitchedPath).replace(/\.mkv$/, '.manifest.json'));
  try {
    const m = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    if (typeof m.totalSeconds === 'number') { expected = m.totalSeconds; source = 'manifest.totalSeconds'; }
    else if (Array.isArray(m.games)) {
      expected = m.games.reduce((a, g) => a + (g.video_duration_seconds || 0), 0);
      source = 'sum(games.video_duration_seconds)';
    }
  } catch { /* missing manifest */ }
  if (expected == null && typeof u.totalSeconds === 'number') { expected = u.totalSeconds; source = 'uploads.totalSeconds'; }
  if (expected == null) continue;

  const diff = expected - ytSec;
  if (diff > TOLERANCE_SECONDS) {
    truncated.push({ u, ytSec, expected, diff, source, manifestPath });
  }
}

truncated.sort((a, b) => (a.u.indices?.[0] || 0) - (b.u.indices?.[0] || 0));

console.log(`=== TRUNCATED UPLOADS: ${truncated.length} ===\n`);
for (const t of truncated) {
  const firstIdx = t.u.indices?.[0] ?? '?';
  const lastIdx = t.u.indices?.[t.u.indices.length - 1] ?? '?';
  console.log(`  ${t.u.title}`);
  console.log(`    videoId:   ${t.u.videoId}`);
  console.log(`    indices:   ${firstIdx} - ${lastIdx} (${t.u.indices?.length || 0} games)`);
  console.log(`    expected:  ${fmtHms(t.expected)}  (${t.source})`);
  console.log(`    on YT:     ${fmtHms(t.ytSec)}`);
  console.log(`    missing:   ${fmtHms(t.diff)}  (${Math.round(t.diff / t.expected * 100)}% of expected)`);
  console.log(`    mkv:       ${path.basename(t.u.stitchedPath)}`);
  console.log('');
}

console.log(`=== SUMMARY ===`);
console.log(`  Total uploads:        ${uploads.length}`);
console.log(`  Missing from YT:      ${missing.length}`);
console.log(`  Truncated (>${TOLERANCE_SECONDS}s short): ${truncated.length}`);
const totalShort = truncated.reduce((a, t) => a + t.diff, 0);
console.log(`  Total missing time:   ${fmtHms(totalShort)}`);

await fs.writeFile(
  path.join(path.dirname(UPLOADS_JSON), 'truncated_uploads.json'),
  JSON.stringify(truncated.map(t => ({ ...t.u, _ytSec: t.ytSec, _expectedSec: t.expected, _diffSec: t.diff })), null, 2)
).catch(() => console.log('(could not write report — likely disk full)'));
