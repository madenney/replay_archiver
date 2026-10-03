#!/usr/bin/env node
// Publish the archive one video at a time, verifying order after every single one.
//
// Flipping a video public writes a PERMANENT publishedAt and the channel sorts by
// it forever. Rather than scheduling all 656 and trusting YouTube's timing, this
// publishes strictly sequentially: flip one, read its publishedAt back, prove it
// is later than the previous one, and only then move on. Order is therefore a
// consequence of the sequence, not of timestamps we hope YouTube honours.
//
// It stops dead on the first anomaly, which keeps any damage to a single video.
//
// Designed to be watched. Every line shows the position, date range and title so
// the chronology is visible as it happens, and Ctrl+C is safe at any moment --
// progress is written continuously and --resume picks up exactly where it left off.
//
// Usage:
//   node scripts/publish_sequential.js --dry-run            # show what would happen
//   node scripts/publish_sequential.js --go                 # publish, verifying each
//   node scripts/publish_sequential.js --go --confirm-every 50
//   node scripts/publish_sequential.js --go --limit 5       # toe in the water
//   node scripts/publish_sequential.js --status
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { google } from 'googleapis';

const OUTPUT_DIR = process.env.OUTPUT_DIR;
const FINAL_DIR = process.env.FINAL_DIR || path.join(OUTPUT_DIR || '', 'final');
const STATE_FILE = path.resolve('reports/publish_sequential_state.json');
const LOG_FILE = path.resolve('reports/publish_sequential.log');

const SETTLE_MS = 2500;      // reads right after a write return stale data
const READ_RETRIES = 4;
const BETWEEN_MS = 400;      // gentle pacing between videos

function ytClient() {
  const o = new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET
  );
  o.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });
  return google.youtube({ version: 'v3', auth: o });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i === -1 ? dflt : process.argv[i + 1];
}

function log(line) {
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
  } catch { /* never let logging break the run */ }
}

// Rebuild chronological order from the manifests, proving it three ways.
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
      hi: games[games.length - 1].index,
      firstDate: dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null,
      lastDate: dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null,
    });
  }
  const byIdx = [...vids].sort((a, b) => a.lo - b.lo);
  const byDate = [...vids].sort((a, b) => String(a.firstDate).localeCompare(String(b.firstDate)));
  const byHi = [...vids].sort((a, b) => a.hi - b.hi);
  const key = (l) => l.map((v) => v.videoId).join(',');
  if (key(byIdx) !== key(byDate) || key(byIdx) !== key(byHi)) {
    throw new Error('ORDER AMBIGUOUS: index / first-date / last-index sorts disagree. Refusing to publish.');
  }
  if (new Set(byIdx.map((v) => v.videoId)).size !== byIdx.length) {
    throw new Error('Duplicate videoId across manifests. Refusing to publish.');
  }
  for (let i = 1; i < byIdx.length; i += 1) {
    if (byIdx[i].lo <= byIdx[i - 1].hi) throw new Error(`Overlapping ranges near idx ${byIdx[i].lo}`);
    if (byIdx[i - 1].lastDate && byIdx[i].firstDate && byIdx[i - 1].lastDate > byIdx[i].firstDate) {
      throw new Error(`Date order violation near idx ${byIdx[i].lo}`);
    }
  }
  return byIdx.map((v, i) => ({ position: i + 1, ...v }));
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { published: {}, lastPublishedAt: null, lastPosition: 0 }; }
}
function saveState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + '\n');
}

async function readVideo(yt, id) {
  for (let i = 0; i < READ_RETRIES; i += 1) {
    try {
      const r = await yt.videos.list({ part: ['status', 'snippet'], id: [id] });
      const v = r.data.items?.[0];
      if (v) return v;
    } catch { /* transient */ }
    await sleep(1500);
  }
  return null;
}

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim().toLowerCase()); }));
}

async function main() {
  const order = buildOrder();
  const dry = process.argv.includes('--dry-run');
  const go = process.argv.includes('--go');
  const status = process.argv.includes('--status');
  const limit = Number(arg('--limit', String(order.length)));
  const confirmEvery = Number(arg('--confirm-every', '0'));
  const state = loadState();

  if (status || (!dry && !go)) {
    const done = Object.keys(state.published).length;
    log(`order verified 3 ways: ${order.length} videos`);
    log(`published so far     : ${done}`);
    log(`next up              : #${done + 1} ${order[done]?.title ?? '(none)'}`);
    if (!status) log(`\nUsage: --dry-run | --go [--limit N] [--confirm-every N] | --status`);
    return;
  }

  const pending = order.filter((v) => !state.published[v.videoId]);
  log(`total ${order.length}, already public ${order.length - pending.length}, pending ${pending.length}`);
  const batch = pending.slice(0, limit);

  if (dry) {
    log(`\nwould publish ${batch.length} videos, in this order:`);
    for (const v of batch.slice(0, 10)) {
      log(`  #${String(v.position).padStart(3)}  ${v.firstDate?.slice(0, 10)}  idx ${String(v.lo).padStart(6)}  ${v.title}`);
    }
    if (batch.length > 10) log(`  ... and ${batch.length - 10} more, ending with:`);
    if (batch.length > 10) {
      const last = batch[batch.length - 1];
      log(`  #${String(last.position).padStart(3)}  ${last.firstDate?.slice(0, 10)}  idx ${String(last.lo).padStart(6)}  ${last.title}`);
    }
    log('\n--dry-run: nothing was changed.');
    return;
  }

  const yt = ytClient();
  let prevAt = state.lastPublishedAt ? new Date(state.lastPublishedAt) : null;
  let count = 0;

  for (const v of batch) {
    // Flip to public, preserving every other status field.
    let before;
    try {
      // Videos we published ourselves were verified at the time and their
      // publishedAt is recorded. Re-reading them costs a quota unit each and
      // grows with every run, so trust the record and only verify order.
      const known = state.published[v.videoId];
      if (known?.publishedAt) {
        const knownAt = new Date(known.publishedAt);
        if (prevAt && knownAt <= prevAt) {
          log(`\nSTOPPED — ORDER VIOLATION at #${v.position} ${v.videoId} (from recorded state)`);
          log(`  this publishedAt : ${knownAt.toISOString()}`);
          log(`  previous         : ${prevAt.toISOString()}`);
          saveState(state);
          process.exit(3);
        }
        prevAt = knownAt;
        continue;
      }
      before = await readVideo(yt, v.videoId);
      if (!before) throw new Error('could not read video before publishing');
      if (before.status.privacyStatus === 'public') {
        // Already public -- published manually, or by an earlier run. Its order
        // still has to hold: accepting it blindly would let an out-of-order
        // video through silently, which is the one failure we cannot undo.
        const alreadyAt = new Date(before.snippet.publishedAt);
        if (prevAt && alreadyAt <= prevAt) {
          log(`\nSTOPPED — ORDER VIOLATION at #${v.position} ${v.videoId} (was already public)`);
          log(`  this publishedAt : ${alreadyAt.toISOString()}`);
          log(`  previous         : ${prevAt.toISOString()}`);
          log('  This video was published out of order before this run.');
          log('  Everything after it is untouched. Investigate before resuming.');
          saveState(state);
          process.exit(3);
        }
        log(`  · #${String(v.position).padStart(3)}/${order.length} already public, in order — recording`);
        state.published[v.videoId] = { publishedAt: before.snippet.publishedAt, position: v.position };
        state.lastPublishedAt = before.snippet.publishedAt;
        state.lastPosition = v.position;
        saveState(state);
        prevAt = alreadyAt;
        continue;
      }
      const s = before.status;
      await yt.videos.update({
        part: ['status'],
        requestBody: {
          id: v.videoId,
          status: {
            privacyStatus: 'public',
            license: s.license ?? 'youtube',
            embeddable: s.embeddable ?? true,
            publicStatsViewable: s.publicStatsViewable ?? true,
            selfDeclaredMadeForKids: s.selfDeclaredMadeForKids ?? false,
          },
        },
      });
    } catch (err) {
      log(`\nSTOPPED at #${v.position} ${v.videoId}: ${err.message}`);
      log('Nothing after this was touched. Fix, then re-run to resume.');
      saveState(state);
      process.exit(1);
    }

    // Reads immediately after a write return stale values — let it settle.
    await sleep(SETTLE_MS);
    const after = await readVideo(yt, v.videoId);
    if (!after) {
      log(`\nSTOPPED at #${v.position}: published but could not verify. Check manually before resuming.`);
      saveState(state);
      process.exit(2);
    }
    if (after.status.privacyStatus !== 'public') {
      log(`\nSTOPPED at #${v.position}: privacy is ${after.status.privacyStatus}, expected public.`);
      saveState(state);
      process.exit(2);
    }

    // THE check that matters: strictly later than the previous video.
    const at = new Date(after.snippet.publishedAt);
    if (prevAt && at <= prevAt) {
      log(`\nSTOPPED — ORDER VIOLATION at #${v.position} ${v.videoId}`);
      log(`  this publishedAt : ${at.toISOString()}`);
      log(`  previous         : ${prevAt.toISOString()}`);
      log('  Everything after this is untouched. Investigate before resuming.');
      saveState(state);
      process.exit(3);
    }

    state.published[v.videoId] = { publishedAt: at.toISOString(), position: v.position };
    state.lastPublishedAt = at.toISOString();
    state.lastPosition = v.position;
    saveState(state);
    prevAt = at;
    count += 1;

    log(`  ✓ #${String(v.position).padStart(3)}/${order.length}  ${v.firstDate?.slice(0, 10)}  idx ${String(v.lo).padStart(6)}  ${at.toISOString().slice(11, 19)}  ${v.title}`);

    if (confirmEvery && count % confirmEvery === 0 && count < batch.length) {
      const a = await ask(`\n  ${count} published, all in order. Continue? [y/N] `);
      if (a !== 'y' && a !== 'yes') { log('  paused by you. Re-run to resume.'); return; }
    }
    await sleep(BETWEEN_MS);
  }

  log(`\ndone: ${count} published this run, ${Object.keys(state.published).length}/${order.length} total, all verified in order.`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
