#!/usr/bin/env node
// Prove the channel's listing order matches true chronological order.
//
// Works regardless of how videos were published -- by the sequential script, by
// hand through Studio, or a mix. It compares YouTube's live publishedAt values
// against the chronological order derived from the manifests, and reports any
// video that would appear out of place.
//
// Run it mid-way to check progress, and at the end as the final proof.
//
// Usage: node scripts/verify_publish_order.js
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';

const OUTPUT_DIR = process.env.OUTPUT_DIR;
const FINAL_DIR = process.env.FINAL_DIR || path.join(OUTPUT_DIR || '', 'final');

function buildOrder() {
  const vids = [];
  for (const mf of fs.readdirSync(FINAL_DIR).filter((f) => f.endsWith('.manifest.json'))) {
    const m = JSON.parse(fs.readFileSync(path.join(FINAL_DIR, mf), 'utf8'));
    if (!m.videoId) throw new Error(`Manifest has no videoId: ${mf}`);
    const games = [...m.games].sort((a, b) => a.index - b.index);
    const dates = games.map((g) => g.date).filter(Boolean);
    vids.push({
      videoId: m.videoId,
      title: m.title,
      lo: games[0].index,
      firstDate: dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null,
    });
  }
  return vids.sort((a, b) => a.lo - b.lo).map((v, i) => ({ position: i + 1, ...v }));
}

const yt = (() => {
  const o = new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET
  );
  o.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });
  return google.youtube({ version: 'v3', auth: o });
})();

const order = buildOrder();
const ids = order.map((v) => v.videoId);
const live = new Map();
for (let i = 0; i < ids.length; i += 50) {
  const r = await yt.videos.list({ part: ['status', 'snippet'], id: ids.slice(i, i + 50), maxResults: 50 });
  for (const v of r.data.items || []) live.set(v.id, v);
}

let pub = 0, unlisted = 0, priv = 0, missing = 0;
const published = [];
for (const v of order) {
  const l = live.get(v.videoId);
  if (!l) { missing += 1; continue; }
  const p = l.status.privacyStatus;
  if (p === 'public') { pub += 1; published.push({ ...v, publishedAt: l.snippet.publishedAt }); }
  else if (p === 'unlisted') unlisted += 1;
  else priv += 1;
}

console.log(`total videos    : ${order.length}`);
console.log(`public          : ${pub}`);
console.log(`unlisted        : ${unlisted}`);
console.log(`private         : ${priv}`);
console.log(`missing         : ${missing}`);

// Among the published ones, does publish order match chronological order?
const violations = [];
for (let i = 1; i < published.length; i += 1) {
  const a = published[i - 1], b = published[i];
  if (new Date(b.publishedAt) <= new Date(a.publishedAt)) {
    violations.push(
      `#${b.position} (${b.firstDate?.slice(0, 10)}) publishedAt ${b.publishedAt} is NOT after #${a.position} (${a.publishedAt})`
    );
  }
}

console.log(`\nchecked ${published.length} published videos for ordering`);
console.log(`ORDER VIOLATIONS : ${violations.length}   <-- must be 0`);
for (const v of violations.slice(0, 20)) console.log('  ' + v);
if (violations.length > 20) console.log(`  ... and ${violations.length - 20} more`);

if (!violations.length && published.length) {
  console.log('\nEvery published video appears in correct chronological order.');
  if (pub === order.length) console.log('ALL 656 PUBLISHED AND CORRECTLY ORDERED.');
  else console.log(`${order.length - pub} still to publish — keep going in order.`);
}
