#!/usr/bin/env node
// Verify recent publishes WITHOUT spending API quota.
//
// The Data API costs quota we need for publishing, and once it is exhausted the
// normal verifier cannot run at all. The channel's RSS feed is not part of that
// quota and exposes the 15 most recently published videos with their publish
// timestamps -- enough to confirm, while publishing by hand, that the last
// stretch went out in the right order.
//
// Run it every ~10 videos during a manual run. It catches an inversion within
// the recent window instead of hours later.
//
// Usage: node scripts/verify_recent_rss.js
import 'dotenv/config';
import fs from 'fs';
import path from 'path';

const OUTPUT_DIR = process.env.OUTPUT_DIR;
const FINAL_DIR = process.env.FINAL_DIR || path.join(OUTPUT_DIR || '', 'final');
const CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID || 'UChC8uLOg9AaQUxSWVRNAyUA';

function buildOrder() {
  const vids = [];
  for (const mf of fs.readdirSync(FINAL_DIR).filter((f) => f.endsWith('.manifest.json'))) {
    const m = JSON.parse(fs.readFileSync(path.join(FINAL_DIR, mf), 'utf8'));
    const games = [...m.games].sort((a, b) => a.index - b.index);
    vids.push({ videoId: m.videoId, title: m.title, lo: games[0].index });
  }
  return vids.sort((a, b) => a.lo - b.lo).map((v, i) => ({ position: i + 1, ...v }));
}

const order = buildOrder();
const byId = new Map(order.map((v) => [v.videoId, v]));

const xml = await (await fetch(
  `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`
)).text();

const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => {
  const e = m[1];
  const id = /<yt:videoId>(.*?)<\/yt:videoId>/.exec(e)?.[1];
  const title = /<title>([\s\S]*?)<\/title>/.exec(e)?.[1];
  const published = /<published>(.*?)<\/published>/.exec(e)?.[1];
  return { id, title, published };
});

if (!entries.length) {
  console.log('No entries in feed — nothing published yet, or the feed is cached.');
  process.exit(0);
}

// Feed is newest-first; flip so it reads in publish order.
const inPublishOrder = [...entries].reverse();

console.log(`feed returned ${entries.length} most recent published videos\n`);
console.log('publish order (oldest of the window first):');
let unknown = 0;
for (const e of inPublishOrder) {
  const v = byId.get(e.id);
  if (!v) unknown += 1;
  console.log(
    `  ${e.published}  ${v ? '#' + String(v.position).padStart(3) : ' ???'}  ${String(e.title).slice(0, 46)}`
  );
}

// Within the window, chronological position must increase with publish time.
const known = inPublishOrder.filter((e) => byId.has(e.id)).map((e) => ({ ...e, ...byId.get(e.id) }));
const problems = [];
for (let i = 1; i < known.length; i += 1) {
  const a = known[i - 1], b = known[i];
  if (b.position <= a.position) {
    problems.push(`#${b.position} published AFTER #${a.position} — out of chronological order`);
  }
  if (new Date(b.published) <= new Date(a.published)) {
    problems.push(`#${b.position} publish timestamp is not after #${a.position}`);
  }
}

console.log('');
if (unknown) console.log(`note: ${unknown} feed entries are not archive videos (ignored)`);
if (problems.length) {
  console.log(`PROBLEMS (${problems.length}) — STOP PUBLISHING:`);
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}
console.log(`OK — the last ${known.length} archive videos published in correct order.`);
if (known.length) {
  const last = known[known.length - 1];
  console.log(`most recent: #${last.position} of ${order.length}  (${order.length - last.position} still to publish)`);
}
