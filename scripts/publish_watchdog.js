#!/usr/bin/env node
// Watch the scheduled rollout and halt it the moment anything goes wrong.
//
// Once videos are scheduled, YouTube publishes them on its own. If one fails to
// publish on time while later ones succeed, the stuck video ends up with a LATER
// permanent publishedAt than its successors -- the archive is then out of order
// forever, with no way to fix it.
//
// This watchdog cannot make a stuck video publish. What it can do is stop every
// video that has not fired yet, which keeps the damage to one video and leaves
// the rest still fixable. Halting works by pushing publishAt far into the future;
// the videos stay private and can be re-scheduled once the problem is understood.
//
// Checks performed per video, at its scheduled moment:
//   1. did it actually go public within the tolerance window?
//   2. is its publishedAt strictly AFTER the previously published video?
// Either failure triggers an immediate halt of the next N videos.
//
// Usage:
//   node scripts/publish_watchdog.js --watch [--tolerance 60] [--halt-batch 40]
//   node scripts/publish_watchdog.js --halt-now [--halt-batch 100]   (manual panic button)
//   node scripts/publish_watchdog.js --status
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';

const PLAN_FILE = path.resolve('reports/publish_plan.json');
const LOG_FILE = path.resolve('reports/publish_watchdog.log');
const HALT_FAR_FUTURE = '2036-01-01T00:00:00.000Z';

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
  const stamp = `[${new Date().toISOString()}] ${line}`;
  console.log(stamp);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, stamp + '\n');
  } catch {
    /* logging must never break the watchdog */
  }
}

// Push the next `count` unpublished videos far into the future so they cannot
// fire. Returns how many were successfully stopped.
async function halt(yt, plan, fromPosition, count, reason) {
  log(`!! HALT TRIGGERED: ${reason}`);
  log(`!! stopping up to ${count} videos from position ${fromPosition}`);
  const targets = plan.items.filter((it) => it.position >= fromPosition).slice(0, count);
  let stopped = 0;
  for (const it of targets) {
    try {
      const cur = await yt.videos.list({ part: ['status'], id: [it.videoId] });
      const s = cur.data.items?.[0]?.status;
      if (!s) {
        log(`   #${it.position} ${it.videoId}: not found`);
        continue;
      }
      if (s.privacyStatus === 'public') {
        log(`   #${it.position} ${it.videoId}: ALREADY PUBLIC - too late to stop`);
        continue;
      }
      await yt.videos.update({
        part: ['status'],
        requestBody: {
          id: it.videoId,
          status: {
            privacyStatus: 'private',
            publishAt: HALT_FAR_FUTURE,
            license: s.license ?? 'youtube',
            embeddable: s.embeddable ?? true,
            publicStatsViewable: s.publicStatsViewable ?? true,
            selfDeclaredMadeForKids: s.selfDeclaredMadeForKids ?? false,
          },
        },
      });
      stopped += 1;
      if (stopped % 10 === 0) log(`   halted ${stopped}/${targets.length}...`);
      await sleep(100);
    } catch (err) {
      log(`   #${it.position} ${it.videoId}: halt FAILED - ${err.message}`);
    }
  }
  log(`!! halted ${stopped} videos. Rollout stopped from position ${fromPosition}.`);
  log(`!! Re-schedule with schedule_publish.js once the cause is understood.`);
  return stopped;
}

async function cmdWatch() {
  const plan = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));
  const toleranceSec = Number(arg('--tolerance', '60'));
  const haltBatch = Number(arg('--halt-batch', '40'));
  const yt = ytClient();

  if (toleranceSec >= plan.spacingSeconds) {
    throw new Error(
      `--tolerance (${toleranceSec}s) must be less than spacing (${plan.spacingSeconds}s), or a halt would come too late to stop the next video`
    );
  }

  log(`watchdog starting: ${plan.items.length} videos, spacing ${plan.spacingSeconds}s, tolerance ${toleranceSec}s, halt batch ${haltBatch}`);
  log(`first publish ${plan.items[0].publishAt}, last ${plan.items[plan.items.length - 1].publishAt}`);

  let prevPublishedAt = null;
  let prevPosition = null;

  for (const it of plan.items) {
    const due = new Date(it.publishAt).getTime();
    const deadline = due + toleranceSec * 1000;

    // wait until the tolerance window closes for this video
    while (Date.now() < deadline) {
      await sleep(Math.min(5000, deadline - Date.now()));
    }

    let v = null;
    for (let attempt = 0; attempt < 3 && !v; attempt += 1) {
      try {
        const r = await yt.videos.list({ part: ['status', 'snippet'], id: [it.videoId] });
        v = r.data.items?.[0] ?? null;
      } catch (err) {
        log(`  #${it.position} lookup error (${err.message}), retrying`);
        await sleep(3000);
      }
    }

    if (!v) {
      await halt(yt, plan, it.position + 1, haltBatch, `#${it.position} ${it.videoId} could not be read`);
      process.exit(2);
    }

    // CHECK 1: did it publish?
    if (v.status.privacyStatus !== 'public') {
      await halt(
        yt, plan, it.position + 1, haltBatch,
        `#${it.position} ${it.videoId} still ${v.status.privacyStatus} ${toleranceSec}s after its slot`
      );
      process.exit(2);
    }

    // CHECK 2: is it strictly after the previous one?
    const pub = new Date(v.snippet.publishedAt);
    if (prevPublishedAt && pub <= prevPublishedAt) {
      await halt(
        yt, plan, it.position + 1, haltBatch,
        `ORDER VIOLATION: #${it.position} publishedAt ${pub.toISOString()} is not after #${prevPosition} (${prevPublishedAt.toISOString()})`
      );
      process.exit(2);
    }

    const drift = ((pub.getTime() - due) / 1000).toFixed(0);
    if (it.position % 25 === 0 || it.position <= 3) {
      log(`  ok #${it.position}/${plan.items.length} ${it.videoId} drift ${drift}s (idx ${it.lo})`);
    }
    prevPublishedAt = pub;
    prevPosition = it.position;
  }

  log(`ALL ${plan.items.length} PUBLISHED IN ORDER. Rollout complete.`);
}

async function cmdHaltNow() {
  const plan = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));
  const yt = ytClient();
  const count = Number(arg('--halt-batch', '100'));
  // find the first not-yet-public video
  let from = plan.items.length + 1;
  for (const it of plan.items) {
    const r = await yt.videos.list({ part: ['status'], id: [it.videoId] });
    const s = r.data.items?.[0]?.status;
    if (s && s.privacyStatus !== 'public') { from = it.position; break; }
  }
  if (from > plan.items.length) { log('everything already public; nothing to halt'); return; }
  await halt(yt, plan, from, count, 'manual --halt-now');
}

async function cmdStatus() {
  const plan = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));
  const yt = ytClient();
  const ids = plan.items.map((i) => i.videoId);
  const got = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const r = await yt.videos.list({ part: ['status', 'snippet'], id: ids.slice(i, i + 50), maxResults: 50 });
    for (const v of r.data.items || []) got.set(v.id, v);
  }
  let pub = 0, priv = 0, other = 0, outOfOrder = 0;
  let prev = null;
  for (const it of plan.items) {
    const v = got.get(it.videoId);
    if (!v) { other += 1; continue; }
    if (v.status.privacyStatus === 'public') {
      pub += 1;
      const t = new Date(v.snippet.publishedAt);
      if (prev && t <= prev) outOfOrder += 1;
      prev = t;
    } else if (v.status.privacyStatus === 'private') priv += 1;
    else other += 1;
  }
  console.log(`public          : ${pub}/${plan.items.length}`);
  console.log(`private/pending : ${priv}`);
  console.log(`other/missing   : ${other}`);
  console.log(`OUT OF ORDER    : ${outOfOrder}   <-- must be 0`);
}

const main = async () => {
  if (process.argv.includes('--watch')) return cmdWatch();
  if (process.argv.includes('--halt-now')) return cmdHaltNow();
  if (process.argv.includes('--status')) return cmdStatus();
  console.log(`Usage:
  --watch [--tolerance 60] [--halt-batch 40]   monitor rollout, halt on any fault
  --halt-now [--halt-batch 100]                manual panic button
  --status                                     current published/pending counts`);
};
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
