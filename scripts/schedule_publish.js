#!/usr/bin/env node
// Schedule every archive video to go public on one day, in chronological order.
//
// Flipping a video public writes a PERMANENT publishedAt, and the channel lists
// by that value forever -- so there is exactly one attempt. This tool separates
// the irreversible act into three reviewable stages:
//
//   --plan <date>   build + write the full schedule. Touches nothing.
//   --execute       apply the plan (resumable; stops cleanly on quota limits).
//   --verify        read every video back and prove the schedule is correct.
//
// Ordering comes from the manifests: games are indexed chronologically, and the
// order is cross-checked three ways (first index, first date, last index) before
// any schedule is emitted. Measured behaviour: publishedAt lands 9-14s AFTER the
// scheduled time, so spacing must exceed worst-case drift by a wide margin.
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';

const PLAN_FILE = path.resolve('reports/publish_plan.json');
const STATE_FILE = path.resolve('reports/publish_state.json');
const OUTPUT_DIR = process.env.OUTPUT_DIR;
const FINAL_DIR = process.env.FINAL_DIR || path.join(OUTPUT_DIR || '', 'final');

const UPDATE_COST = 50; // quota units per videos.update
const MIN_SPACING_SECONDS = 60; // refuse anything tighter; drift was up to 14s

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

// ---------------------------------------------------------------- ordering
// Rebuild the chronological order from the manifests and prove it three ways.
function buildOrder() {
  const vids = [];
  for (const mf of fs.readdirSync(FINAL_DIR).filter((f) => f.endsWith('.manifest.json'))) {
    const m = JSON.parse(fs.readFileSync(path.join(FINAL_DIR, mf), 'utf8'));
    const games = [...m.games].sort((a, b) => a.index - b.index);
    const dates = games.map((g) => g.date).filter(Boolean);
    if (!m.videoId) throw new Error(`Manifest has no videoId: ${mf}`);
    vids.push({
      videoId: m.videoId,
      title: m.title,
      lo: games[0].index,
      hi: games[games.length - 1].index,
      firstDate: dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null,
      lastDate: dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null,
      games: games.length,
    });
  }

  const byIdx = [...vids].sort((a, b) => a.lo - b.lo);
  const byDate = [...vids].sort((a, b) => String(a.firstDate).localeCompare(String(b.firstDate)));
  const byHi = [...vids].sort((a, b) => a.hi - b.hi);
  const ids = (l) => l.map((v) => v.videoId).join(',');
  if (ids(byIdx) !== ids(byDate) || ids(byIdx) !== ids(byHi)) {
    throw new Error('ORDER AMBIGUOUS: sorting by index, first date and last index disagree. Refusing to continue.');
  }
  if (new Set(byIdx.map((v) => v.videoId)).size !== byIdx.length) {
    throw new Error('Duplicate videoId across manifests. Refusing to continue.');
  }
  // no overlapping index ranges
  for (let i = 1; i < byIdx.length; i += 1) {
    if (byIdx[i].lo <= byIdx[i - 1].hi) {
      throw new Error(`Overlapping index ranges: ${byIdx[i - 1].lo}-${byIdx[i - 1].hi} vs ${byIdx[i].lo}-${byIdx[i].hi}`);
    }
  }
  // dates must never go backwards between videos
  for (let i = 1; i < byIdx.length; i += 1) {
    if (byIdx[i - 1].lastDate && byIdx[i].firstDate && byIdx[i - 1].lastDate > byIdx[i].firstDate) {
      throw new Error(`Date order violation between ${byIdx[i - 1].lo} and ${byIdx[i].lo}`);
    }
  }
  return byIdx;
}

// ------------------------------------------------------------------- plan
function cmdPlan() {
  const startIso = arg('--plan'); // e.g. 2026-10-10T09:00:00Z
  const spacing = Number(arg('--spacing', '120'));
  if (!startIso) throw new Error('Usage: --plan <ISO start time> [--spacing seconds]');
  if (!Number.isFinite(spacing) || spacing < MIN_SPACING_SECONDS) {
    throw new Error(`--spacing must be >= ${MIN_SPACING_SECONDS}s (measured publish drift was up to 14s)`);
  }
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) throw new Error(`Unparseable start time: ${startIso}`);
  start.setMilliseconds(0);

  const order = buildOrder();
  const items = order.map((v, i) => ({
    position: i + 1,
    videoId: v.videoId,
    title: v.title,
    lo: v.lo,
    hi: v.hi,
    games: v.games,
    firstDate: v.firstDate,
    publishAt: new Date(start.getTime() + i * spacing * 1000).toISOString(),
  }));

  const last = new Date(items[items.length - 1].publishAt);
  const spanHours = (last - start) / 3600000;
  const sameDay = start.toISOString().slice(0, 10) === last.toISOString().slice(0, 10);

  // strictly increasing timestamps
  for (let i = 1; i < items.length; i += 1) {
    if (new Date(items[i].publishAt) <= new Date(items[i - 1].publishAt)) {
      throw new Error(`Non-increasing publishAt at position ${i + 1}`);
    }
  }

  const plan = {
    createdAt: new Date().toISOString(),
    startIso: start.toISOString(),
    spacingSeconds: spacing,
    count: items.length,
    spanHours: Number(spanHours.toFixed(2)),
    endsSameUtcDay: sameDay,
    quotaUnits: items.length * UPDATE_COST,
    items,
  };
  fs.mkdirSync(path.dirname(PLAN_FILE), { recursive: true });
  fs.writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2) + '\n');

  console.log(`videos            : ${plan.count}`);
  console.log(`spacing           : ${spacing}s`);
  console.log(`first publishAt   : ${items[0].publishAt}  (idx ${items[0].lo}, ${items[0].firstDate?.slice(0, 10)})`);
  console.log(`last  publishAt   : ${items[items.length - 1].publishAt}  (idx ${items[items.length - 1].lo}, ${items[items.length - 1].firstDate?.slice(0, 10)})`);
  console.log(`span              : ${plan.spanHours} h`);
  console.log(`ends same UTC day : ${sameDay}${sameDay ? '' : '   <-- WARNING: rollout crosses midnight UTC'}`);
  console.log(`quota needed      : ${plan.quotaUnits.toLocaleString()} units (${UPDATE_COST}/video)`);
  console.log(`\nplan written to ${PLAN_FILE}`);
  console.log('Review it, then: --execute');
}

// ---------------------------------------------------------------- execute
async function cmdExecute() {
  const plan = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));
  const limit = Number(arg('--limit', String(plan.items.length)));
  const dry = process.argv.includes('--dry-run');
  let state = { done: {}, startedAt: new Date().toISOString() };
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    /* first run */
  }

  const pending = plan.items.filter((it) => !state.done[it.videoId]);
  console.log(`total ${plan.items.length}, already scheduled ${plan.items.length - pending.length}, pending ${pending.length}`);
  if (!pending.length) {
    console.log('Nothing to do. Next: --verify');
    return;
  }
  const batch = pending.slice(0, limit);
  console.log(`this run: ${batch.length} videos = ${batch.length * UPDATE_COST} quota units`);
  if (dry) {
    for (const it of batch.slice(0, 5)) console.log(`  #${it.position} ${it.videoId} -> ${it.publishAt}`);
    console.log('  --dry-run: nothing sent.');
    return;
  }

  const yt = ytClient();
  let ok = 0;
  for (const it of batch) {
    try {
      // Fetch current status so update() does not reset fields it omits.
      const cur = await yt.videos.list({ part: ['status'], id: [it.videoId] });
      const s = cur.data.items?.[0]?.status;
      if (!s) throw new Error('video not found');
      await yt.videos.update({
        part: ['status'],
        requestBody: {
          id: it.videoId,
          status: {
            privacyStatus: 'private',
            publishAt: it.publishAt,
            license: s.license ?? 'youtube',
            embeddable: s.embeddable ?? true,
            publicStatsViewable: s.publicStatsViewable ?? true,
            selfDeclaredMadeForKids: s.selfDeclaredMadeForKids ?? false,
          },
        },
      });
      state.done[it.videoId] = { publishAt: it.publishAt, at: new Date().toISOString() };
      ok += 1;
      if (ok % 25 === 0) {
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
        console.log(`  ${ok}/${batch.length} scheduled...`);
      }
      await sleep(120); // stay clear of per-second rate limits
    } catch (err) {
      const reason = err?.errors?.[0]?.reason || err?.message || '';
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
      if (/quota/i.test(reason)) {
        console.error(`\nQUOTA EXHAUSTED after ${ok} this run. Progress saved.`);
        console.error('Re-run --execute tomorrow; it resumes where it stopped.');
        return;
      }
      console.error(`\nFAILED on #${it.position} ${it.videoId}: ${reason}`);
      console.error('Progress saved. Fix, then re-run --execute to resume.');
      return;
    }
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
  console.log(`\nscheduled ${ok} this run. Total ${Object.keys(state.done).length}/${plan.items.length}`);
  console.log('When all are scheduled: --verify');
}

// ----------------------------------------------------------------- verify
async function cmdVerify() {
  const plan = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));
  const yt = ytClient();
  const want = new Map(plan.items.map((it) => [it.videoId, it]));
  const ids = plan.items.map((it) => it.videoId);
  const got = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const r = await yt.videos.list({ part: ['status', 'snippet'], id: ids.slice(i, i + 50), maxResults: 50 });
    for (const v of r.data.items || []) got.set(v.id, v);
  }

  let missing = 0, wrongPrivacy = 0, wrongTime = 0, notScheduled = 0;
  const problems = [];
  for (const it of plan.items) {
    const v = got.get(it.videoId);
    if (!v) { missing += 1; problems.push(`#${it.position} ${it.videoId} NOT FOUND`); continue; }
    if (v.status.privacyStatus !== 'private') {
      wrongPrivacy += 1;
      problems.push(`#${it.position} ${it.videoId} privacy=${v.status.privacyStatus} (want private)`);
    }
    if (!v.status.publishAt) {
      notScheduled += 1;
      problems.push(`#${it.position} ${it.videoId} has NO publishAt`);
    } else if (new Date(v.status.publishAt).toISOString() !== new Date(it.publishAt).toISOString()) {
      wrongTime += 1;
      problems.push(`#${it.position} ${it.videoId} publishAt=${v.status.publishAt} want ${it.publishAt}`);
    }
  }

  // the decisive check: scheduled times strictly increasing in chronological order
  let nonMonotonic = 0;
  let prev = null;
  for (const it of plan.items) {
    const v = got.get(it.videoId);
    const t = v?.status?.publishAt ? new Date(v.status.publishAt) : null;
    if (t && prev && t <= prev) {
      nonMonotonic += 1;
      problems.push(`#${it.position} ${it.videoId} publishAt not after previous`);
    }
    if (t) prev = t;
  }

  console.log(`checked            : ${plan.items.length}`);
  console.log(`not found          : ${missing}`);
  console.log(`wrong privacy      : ${wrongPrivacy}`);
  console.log(`missing publishAt  : ${notScheduled}`);
  console.log(`wrong publishAt    : ${wrongTime}`);
  console.log(`NON-MONOTONIC      : ${nonMonotonic}   <-- must be 0`);
  const clean = !missing && !wrongPrivacy && !wrongTime && !notScheduled && !nonMonotonic;
  console.log(clean ? '\nALL CORRECT — schedule is chronological and complete.' : `\nPROBLEMS (${problems.length}):`);
  for (const p of problems.slice(0, 20)) console.log('  ' + p);
  if (problems.length > 20) console.log(`  ... and ${problems.length - 20} more`);
}

const main = async () => {
  if (process.argv.includes('--plan')) return cmdPlan();
  if (process.argv.includes('--execute')) return cmdExecute();
  if (process.argv.includes('--verify')) return cmdVerify();
  console.log(`Usage:
  --plan <ISO start> [--spacing 120]   build and write the schedule (touches nothing)
  --execute [--limit N] [--dry-run]    apply it (resumable, quota-aware)
  --verify                             read back every video and prove ordering`);
};
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
