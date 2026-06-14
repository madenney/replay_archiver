import 'dotenv/config';
import { promises as fs } from 'fs';
import { existsSync, statSync } from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { google } from 'googleapis';

const FINAL_DIR = path.join(process.env.OUTPUT_DIR || '', 'final');
const GAMES_DIR = path.join(process.env.OUTPUT_DIR || '', 'games');
const UPLOADS_JSON = path.join(process.env.OUTPUT_DIR || '', 'uploads.json');
const TOLERANCE_SECONDS = 30;

function parseIsoDuration(iso) {
  if (!iso) return null;
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  return m ? (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0) : null;
}
function fmtHms(s) {
  if (s == null) return '?';
  s = Math.round(s);
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
}

function ffprobeDuration(p) {
  try {
    const out = execFileSync('ffprobe', ['-v','error','-show_entries','format=duration','-of','csv=p=0', p], { encoding: 'utf8' });
    return Number(out.trim()) || null;
  } catch { return null; }
}

const uploads = JSON.parse(await fs.readFile(UPLOADS_JSON, 'utf8'));

const oauth2Client = new google.auth.OAuth2(process.env.YOUTUBE_CLIENT_ID, process.env.YOUTUBE_CLIENT_SECRET);
oauth2Client.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });
const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

const ids = uploads.map(u => u.videoId).filter(Boolean);
const ytDuration = new Map();
for (let i = 0; i < ids.length; i += 50) {
  const batch = ids.slice(i, i + 50);
  process.stderr.write(`  YT ${Math.min(i + 50, ids.length)}/${ids.length}...\r`);
  const res = await youtube.videos.list({ part: ['id', 'contentDetails'], id: batch });
  for (const item of res.data.items || []) ytDuration.set(item.id, parseIsoDuration(item.contentDetails?.duration));
  if (i + 50 < ids.length) await new Promise(r => setTimeout(r, 400));
}
process.stderr.write('\n');

const truncated = [];
for (const u of uploads) {
  if (!ytDuration.has(u.videoId)) continue;
  const ytSec = ytDuration.get(u.videoId);
  const manifestPath = path.join(FINAL_DIR, path.basename(u.stitchedPath).replace(/\.mkv$/, '.manifest.json'));
  let m; try { m = JSON.parse(await fs.readFile(manifestPath, 'utf8')); } catch { continue; }
  const expected = m.totalSeconds;
  if (typeof expected !== 'number') continue;
  const diff = expected - ytSec;
  if (diff > TOLERANCE_SECONDS) truncated.push({ u, m, ytSec, expected, diff, manifestPath });
}
truncated.sort((a,b) => (a.u.indices?.[0]||0) - (b.u.indices?.[0]||0));

const LEAD_IN = 123 / 60; // 2.05s per game (matches stitcher.js)

// Tier by missing percent
function tier(t) {
  const p = t.diff / t.expected;
  if (p >= 0.50) return 'CATASTROPHIC';
  if (p >= 0.10) return 'SIGNIFICANT';
  return 'MINOR';
}

const results = [];
for (const t of truncated) {
  const games = t.m.games || [];
  // walk: cumulative duration as ffmpeg concat would produce
  let acc = 0;
  let cutIdx = -1;        // index in games array where the cut falls
  let lastGoodIdx = -1;   // last fully-included game
  for (let i = 0; i < games.length; i++) {
    const d = (games[i].video_duration_seconds ?? ((games[i].game_length_frames || 0) / 60));
    if (acc + d <= t.ytSec + 1) {
      acc += d;
      lastGoodIdx = i;
    } else {
      cutIdx = i;
      break;
    }
  }

  const cutGame = cutIdx >= 0 ? games[cutIdx] : null;
  const lastGood = lastGoodIdx >= 0 ? games[lastGoodIdx] : null;
  const dropped = games.length - (lastGoodIdx + 1);

  // ffprobe the suspect AVI (the one at the cut point) and the last-good one
  function probe(g) {
    if (!g) return null;
    const p = path.join(GAMES_DIR, path.basename(g.video_path || ''));
    if (!existsSync(p)) return { path: p, exists: false };
    const sz = statSync(p).size;
    const dur = ffprobeDuration(p);
    return { path: p, exists: true, size: sz, ffprobeSeconds: dur, manifestSeconds: g.video_duration_seconds };
  }
  const cutProbe = probe(cutGame);
  const lastGoodProbe = probe(lastGood);

  results.push({ t, lastGood, lastGoodIdx, cutGame, cutIdx, dropped, lastGoodProbe, cutProbe });
}

// Output
for (const r of results) {
  const t = r.t;
  console.log(`\n=== [${tier(t)}] ${t.u.title} ===`);
  console.log(`  videoId: ${t.u.videoId}   indices: ${t.u.indices?.[0]}-${t.u.indices?.[t.u.indices.length-1]} (${t.u.indices?.length} games)`);
  console.log(`  expected ${fmtHms(t.expected)}  on YT ${fmtHms(t.ytSec)}  missing ${fmtHms(t.diff)}`);
  console.log(`  last fully-included game: idx=${r.lastGood?.index ?? '?'} (${r.lastGoodIdx+1}/${t.m.games.length}, slot in concat)`);
  if (r.lastGoodProbe) {
    console.log(`    lastGood file: ${r.lastGoodProbe.exists ? `size=${Math.round((r.lastGoodProbe.size||0)/1e6)}MB ffprobe=${r.lastGoodProbe.ffprobeSeconds?.toFixed(2)}s manifest=${r.lastGoodProbe.manifestSeconds?.toFixed(2)}s` : 'MISSING ON DISK'}`);
  }
  console.log(`  cut-point game: idx=${r.cutGame?.index ?? '?'} (slot ${r.cutIdx+1}/${t.m.games.length}) — players=${(r.cutGame?.players||[]).join(' vs ')}`);
  if (r.cutProbe) {
    if (!r.cutProbe.exists) {
      console.log(`    cut-point file: MISSING ON DISK at ${r.cutProbe.path}`);
    } else {
      const manSec = r.cutProbe.manifestSeconds;
      const ffSec = r.cutProbe.ffprobeSeconds;
      const ratio = (ffSec && manSec) ? (ffSec / manSec) : null;
      const flag = ratio != null && ratio < 0.95 ? '  ⚠ SHORT ON DISK' : '';
      console.log(`    cut-point file: size=${Math.round(r.cutProbe.size/1e6)}MB ffprobe=${ffSec?.toFixed(2)}s manifest=${manSec?.toFixed(2)}s${flag}`);
    }
  }
  console.log(`  games dropped after cut: ${r.dropped}`);
}

// summary
const byTier = { CATASTROPHIC: 0, SIGNIFICANT: 0, MINOR: 0 };
const cutProbeIssues = { shortOnDisk: 0, missingOnDisk: 0, matches: 0, noFile: 0 };
for (const r of results) {
  byTier[tier(r.t)]++;
  if (!r.cutProbe) cutProbeIssues.noFile++;
  else if (!r.cutProbe.exists) cutProbeIssues.missingOnDisk++;
  else if (r.cutProbe.ffprobeSeconds && r.cutProbe.manifestSeconds && r.cutProbe.ffprobeSeconds / r.cutProbe.manifestSeconds < 0.95) cutProbeIssues.shortOnDisk++;
  else cutProbeIssues.matches++;
}
console.log(`\n=== SUMMARY ===`);
console.log(`Tiers: ${JSON.stringify(byTier)}`);
console.log(`Cut-point AVI status:`, JSON.stringify(cutProbeIssues));
