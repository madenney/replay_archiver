#!/usr/bin/env node
// Independent audit of publish readiness: is every video present, and is the
// chronological order correct beyond doubt?
//
// Publish order is permanent, so this does not trust any single source. It
// derives the ordering from four independent places and requires them to agree:
//
//   A. manifest game indices        (how the pipeline grouped games)
//   B. Postgres replay dates        (metadata recorded at scan time)
//   C. .slp FILENAME timestamps     (what Slippi wrote, independent of the DB)
//   D. manifest startDate strings   (what is printed in the video titles)
//
// Plus completeness checks across manifests, uploads.json, Postgres and YouTube.
//
// Usage: node scripts/audit_publish_readiness.js
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { google } from 'googleapis';

const OUTPUT_DIR = process.env.OUTPUT_DIR;
const FINAL_DIR = process.env.FINAL_DIR || path.join(OUTPUT_DIR || '', 'final');
const UPLOADS_JSON = process.env.UPLOADS_JSON || path.join(OUTPUT_DIR || '', 'uploads.json');

let failures = 0;
function check(label, ok, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL';
  if (!ok) failures += 1;
  console.log(`  [${mark}] ${label}${detail ? ' — ' + detail : ''}`);
}

// Game_YYYYMMDDThhmmss.slp -> sortable string, straight from the filename.
function stampFromFilename(p) {
  const m = /Game_(\d{8}T\d{6})/i.exec(path.basename(p || ''));
  return m ? m[1] : null;
}

const pool = new pg.Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
});

const yt = (() => {
  const o = new google.auth.OAuth2(process.env.YOUTUBE_CLIENT_ID, process.env.YOUTUBE_CLIENT_SECRET);
  o.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });
  return google.youtube({ version: 'v3', auth: o });
})();

// ---------------------------------------------------------------- load data
const manifests = fs.readdirSync(FINAL_DIR).filter((f) => f.endsWith('.manifest.json'));
const videos = manifests.map((mf) => {
  const m = JSON.parse(fs.readFileSync(path.join(FINAL_DIR, mf), 'utf8'));
  const games = [...m.games].sort((a, b) => a.index - b.index);
  return {
    file: mf,
    videoId: m.videoId,
    title: m.title,
    startDate: m.startDate,
    lo: games[0].index,
    hi: games[games.length - 1].index,
    indices: games.map((g) => g.index),
    firstDate: games.map((g) => g.date).filter(Boolean).sort()[0] || null,
    lastDate: games.map((g) => g.date).filter(Boolean).sort().pop() || null,
  };
});

const uploads = JSON.parse(fs.readFileSync(UPLOADS_JSON, 'utf8'));

const dbRows = (await pool.query(
  'SELECT idx, date, file_path, uploaded, skip FROM replays ORDER BY idx'
)).rows;
const dbById = new Map(dbRows.map((r) => [r.idx, r]));

// live YouTube state
const ids = videos.map((v) => v.videoId);
const live = new Map();
for (let i = 0; i < ids.length; i += 50) {
  const r = await yt.videos.list({ part: ['status', 'snippet'], id: ids.slice(i, i + 50), maxResults: 50 });
  for (const v of r.data.items || []) live.set(v.id, v);
}

console.log(`\n=== 1. COMPLETENESS ===`);
check('manifest count == uploads.json count', videos.length === uploads.length,
  `${videos.length} vs ${uploads.length}`);
check('every manifest has a videoId', videos.every((v) => !!v.videoId));
check('all videoIds unique', new Set(ids).size === ids.length);
check('every video exists on YouTube', live.size === videos.length, `${live.size}/${videos.length}`);

const manifestGames = new Set();
let dupes = 0;
for (const v of videos) for (const i of v.indices) { if (manifestGames.has(i)) dupes += 1; manifestGames.add(i); }
check('no game appears in two videos', dupes === 0, `${dupes} duplicates`);

const dbUploaded = new Set(dbRows.filter((r) => r.uploaded === 1).map((r) => r.idx));
check('manifest games == DB uploaded games',
  manifestGames.size === dbUploaded.size && [...manifestGames].every((i) => dbUploaded.has(i)),
  `${manifestGames.size} vs ${dbUploaded.size}`);

const uploadGames = new Set();
for (const u of uploads) for (const i of u.indices) uploadGames.add(i);
check('manifest games == uploads.json games',
  manifestGames.size === uploadGames.size && [...manifestGames].every((i) => uploadGames.has(i)));

const totalDb = dbRows.length;
const skipped = dbRows.filter((r) => r.skip === 1).length;
check('every replay accounted for (uploaded + skipped == total)',
  dbUploaded.size + skipped === totalDb, `${dbUploaded.size} + ${skipped} = ${dbUploaded.size + skipped} of ${totalDb}`);

console.log(`\n=== 2. FOUR INDEPENDENT ORDERINGS ===`);
const A = [...videos].sort((a, b) => a.lo - b.lo);

// B: order by the DB date of each video's first game
const B = [...videos].sort((a, b) => {
  const da = dbById.get(a.lo)?.date || '';
  const db_ = dbById.get(b.lo)?.date || '';
  return String(da).localeCompare(String(db_));
});

// C: order by the .slp FILENAME timestamp of each video's first game
const cMissing = videos.filter((v) => !stampFromFilename(dbById.get(v.lo)?.file_path)).length;
const C = [...videos].sort((a, b) => {
  const sa = stampFromFilename(dbById.get(a.lo)?.file_path) || '';
  const sb = stampFromFilename(dbById.get(b.lo)?.file_path) || '';
  return sa.localeCompare(sb);
});

// D: order by the manifest's own startDate string (MM/DD/YYYY HH:MM)
const toSortable = (s) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/.exec(String(s || ''));
  return m ? `${m[3]}${m[1]}${m[2]}${m[4]}${m[5]}` : '';
};
const dMissing = videos.filter((v) => !toSortable(v.startDate)).length;
const D = [...videos].sort((a, b) => toSortable(a.startDate).localeCompare(toSortable(b.startDate)));

const key = (l) => l.map((v) => v.videoId).join(',');
check('A manifest index order', true, `${A.length} videos`);
check('B == A  (Postgres date order)', key(B) === key(A));
check('C == A  (.slp filename timestamp order)', key(C) === key(A),
  cMissing ? `${cMissing} filenames unparseable` : '');
check('D == A  (manifest startDate order)', key(D) === key(A),
  dMissing ? `${dMissing} startDates unparseable` : '');

// show first divergence if any
for (const [name, L] of [['B', B], ['C', C], ['D', D]]) {
  if (key(L) !== key(A)) {
    for (let i = 0; i < A.length; i += 1) {
      if (A[i].videoId !== L[i].videoId) {
        console.log(`     first divergence at position ${i + 1}: A=${A[i].lo} (${A[i].title}) vs ${name}=${L[i].lo} (${L[i].title})`);
        break;
      }
    }
  }
}

console.log(`\n=== 3. STRUCTURAL ORDER PROPERTIES ===`);
let overlaps = 0, backwards = 0, gapsOk = true, gapList = [];
for (let i = 1; i < A.length; i += 1) {
  if (A[i].lo <= A[i - 1].hi) overlaps += 1;
  if (A[i - 1].lastDate && A[i].firstDate && A[i - 1].lastDate > A[i].firstDate) backwards += 1;
  if (A[i].lo !== A[i - 1].hi + 1) {
    const missing = [];
    for (let g = A[i - 1].hi + 1; g < A[i].lo; g += 1) missing.push(g);
    gapList.push({ after: A[i - 1].hi, missing });
    if (!missing.every((g) => dbById.get(g)?.skip === 1)) gapsOk = false;
  }
}
check('no overlapping index ranges between videos', overlaps === 0, `${overlaps}`);
check('dates never go backwards between videos', backwards === 0, `${backwards}`);
check('every gap between videos is a skipped replay', gapsOk,
  `${gapList.length} gap(s): ${gapList.map((g) => g.missing.join(',')).join(' | ')}`);
// spread would overflow the stack on 125k elements
const minUploaded = [...dbUploaded].reduce((a, b) => (b < a ? b : a), Infinity);
const maxUploaded = [...dbUploaded].reduce((a, b) => (b > a ? b : a), -Infinity);
check('first video starts at the earliest uploaded game', A[0].lo === minUploaded,
  `video starts ${A[0].lo}, earliest game ${minUploaded}`);
check('last video ends at the final uploaded game', A[A.length - 1].hi === maxUploaded,
  `video ends ${A[A.length - 1].hi}, last game ${maxUploaded}`);

console.log(`\n=== 4. CURRENT YOUTUBE STATE ===`);
const privacies = {};
for (const v of videos) {
  const p = live.get(v.videoId)?.status?.privacyStatus || 'MISSING';
  privacies[p] = (privacies[p] || 0) + 1;
}
console.log(`  privacy: ${JSON.stringify(privacies)}`);
const pub = videos.filter((v) => live.get(v.videoId)?.status?.privacyStatus === 'public');
check('no videos published yet, or published ones are in order', (() => {
  const inOrder = A.filter((v) => live.get(v.videoId)?.status?.privacyStatus === 'public');
  for (let i = 1; i < inOrder.length; i += 1) {
    const a = new Date(live.get(inOrder[i - 1].videoId).snippet.publishedAt);
    const b = new Date(live.get(inOrder[i].videoId).snippet.publishedAt);
    if (b <= a) return false;
  }
  return true;
})(), `${pub.length} public`);

console.log(`\n=== RESULT ===`);
console.log(failures === 0
  ? `  ALL CHECKS PASSED — ${videos.length} videos, complete and unambiguously ordered.`
  : `  ${failures} CHECK(S) FAILED — do not publish until resolved.`);
console.log(`  first: #1   ${A[0].title}  (${A[0].firstDate?.slice(0, 10)})`);
console.log(`  last : #${A.length} ${A[A.length - 1].title}  (${A[A.length - 1].firstDate?.slice(0, 10)})`);

await pool.end();
process.exit(failures === 0 ? 0 : 1);
