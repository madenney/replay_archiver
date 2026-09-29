#!/usr/bin/env node
// Measure, on throwaway videos, exactly how YouTube assigns `publishedAt`.
//
// Flipping a video to public writes a permanent publishedAt, and the channel
// lists by that value forever. With 656 archive videos that must appear in
// strict chronological order, we get exactly one attempt -- so the behaviour is
// measured here on disposable clips rather than discovered on real content.
//
// Questions this answers:
//   1. Can publishAt be set on a video that is currently unlisted
//      (via privacyStatus=private + publishAt)?
//   2. Does the resulting publishedAt equal the scheduled time EXACTLY, or the
//      moment YouTube got around to it? (Determines required spacing.)
//   3. Does unlisted -> public rewrite publishedAt to the flip moment?
//   4. Do two videos scheduled N seconds apart come out in that order?
//
// Usage:
//   node scripts/publish_behavior_test.js --upload           # make + upload 3 clips
//   node scripts/publish_behavior_test.js --schedule 600     # arm the experiment
//   node scripts/publish_behavior_test.js --check            # read results
//   node scripts/publish_behavior_test.js --cleanup          # delete the clips
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { google } from 'googleapis';

const execFileAsync = promisify(execFile);
const STATE = path.resolve('reports/publish_behavior_test.json');
const SPACING_SECONDS = 60; // gap between the two scheduled clips

function ytClient() {
  const o = new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET
  );
  o.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });
  return google.youtube({ version: 'v3', auth: o });
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    return null;
  }
}

function saveState(s) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n');
}

async function makeClip(file, label) {
  await execFileAsync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc=size=320x240:rate=30:duration=2`,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-metadata', `title=${label}`,
    file,
  ]);
  return file;
}

async function cmdUpload() {
  const yt = ytClient();
  const dir = '/tmp/claude-1000/publish-test';
  fs.mkdirSync(dir, { recursive: true });
  const clips = [];
  for (const n of [1, 2, 3]) {
    const file = path.join(dir, `clip${n}.mp4`);
    await makeClip(file, `publish-order test clip ${n}`);
    // Uploaded PRIVATE so nothing is ever publicly visible by accident.
    const res = await yt.videos.insert(
      {
        part: ['snippet', 'status'],
        requestBody: {
          snippet: {
            title: `ZZ DELETE ME - publish order test ${n}`,
            description: 'Throwaway clip measuring publishedAt behaviour. Safe to delete.',
          },
          status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
        },
        media: { body: fs.createReadStream(file) },
      }
    );
    console.log(`  clip ${n}: ${res.data.id}`);
    clips.push({ n, videoId: res.data.id });
  }
  saveState({ clips, uploadedAt: new Date().toISOString() });
  console.log(`\nUploaded 3 private clips (4800 quota units). State -> ${STATE}`);
  console.log('Next: node scripts/publish_behavior_test.js --schedule 600');
}

async function cmdSchedule(leadSeconds) {
  const yt = ytClient();
  const st = loadState();
  if (!st) throw new Error('No state; run --upload first');

  const base = new Date(Date.now() + leadSeconds * 1000);
  // round to whole second so comparison is unambiguous
  base.setMilliseconds(0);
  const t1 = new Date(base.getTime());
  const t2 = new Date(base.getTime() + SPACING_SECONDS * 1000);

  // Clip 1 and 2: currently private -> scheduled. Clip 2 is scheduled LATER but
  // updated FIRST, so if ordering ever followed API-call order rather than the
  // timestamps, the result would come out reversed and we would see it.
  const plan = [
    { n: 2, at: t2 },
    { n: 1, at: t1 },
  ];
  for (const p of plan) {
    const clip = st.clips.find((c) => c.n === p.n);
    await yt.videos.update({
      part: ['status'],
      requestBody: {
        id: clip.videoId,
        status: {
          privacyStatus: 'private',
          publishAt: p.at.toISOString(),
          selfDeclaredMadeForKids: false,
          license: 'youtube',
          embeddable: true,
          publicStatsViewable: true,
        },
      },
    });
    clip.scheduledFor = p.at.toISOString();
    console.log(`  clip ${p.n} (${clip.videoId}) scheduled for ${p.at.toISOString()}`);
  }

  // Clip 3: the control. Make it unlisted now; --check flips it to public so we
  // can observe what publishedAt becomes on a plain unlisted->public switch.
  const c3 = st.clips.find((c) => c.n === 3);
  await yt.videos.update({
    part: ['status'],
    requestBody: {
      id: c3.videoId,
      status: {
        privacyStatus: 'unlisted',
        selfDeclaredMadeForKids: false,
        license: 'youtube',
        embeddable: true,
        publicStatsViewable: true,
      },
    },
  });
  console.log(`  clip 3 (${c3.videoId}) set unlisted (control for the flip test)`);

  st.scheduledAt = new Date().toISOString();
  saveState(st);
  console.log(`\nScheduled. Check back after ${t2.toISOString()}:`);
  console.log('  node scripts/publish_behavior_test.js --check');
}

async function cmdFlipControl() {
  const yt = ytClient();
  const st = loadState();
  const c3 = st.clips.find((c) => c.n === 3);
  const before = await yt.videos.list({ part: ['snippet', 'status'], id: [c3.videoId] });
  const beforePub = before.data.items?.[0]?.snippet?.publishedAt;
  const flipAt = new Date().toISOString();
  await yt.videos.update({
    part: ['status'],
    requestBody: {
      id: c3.videoId,
      status: {
        privacyStatus: 'public',
        selfDeclaredMadeForKids: false,
        license: 'youtube',
        embeddable: true,
        publicStatsViewable: true,
      },
    },
  });
  c3.publishedAtBeforeFlip = beforePub;
  c3.flippedAt = flipAt;
  saveState(st);
  console.log(`  clip 3 flipped unlisted -> public at ${flipAt}`);
  console.log(`  publishedAt BEFORE flip: ${beforePub}`);
  console.log('  re-run --check in a minute to see publishedAt AFTER the flip');
}

async function cmdCheck() {
  const yt = ytClient();
  const st = loadState();
  if (!st) throw new Error('No state; run --upload first');
  const ids = st.clips.map((c) => c.videoId);
  const r = await yt.videos.list({ part: ['snippet', 'status'], id: ids });
  const found = new Map((r.data.items || []).map((v) => [v.id, v]));

  console.log('clip | videoId     | privacy  | scheduled publishAt      | actual publishedAt       | delta');
  for (const c of st.clips) {
    const v = found.get(c.videoId);
    if (!v) {
      console.log(`  ${c.n}  | ${c.videoId} | (not found / deleted)`);
      continue;
    }
    const sched = c.scheduledFor || v.status.publishAt || '-';
    const actual = v.snippet.publishedAt;
    let delta = '-';
    if (c.scheduledFor && actual) {
      delta = `${((new Date(actual) - new Date(c.scheduledFor)) / 1000).toFixed(0)}s`;
    }
    console.log(
      `  ${c.n}  | ${c.videoId} | ${String(v.status.privacyStatus).padEnd(8)} | ${String(sched).padEnd(24)} | ${String(actual).padEnd(24)} | ${delta}`
    );
    c.observedPublishedAt = actual;
    c.observedPrivacy = v.status.privacyStatus;
  }
  saveState(st);

  const c1 = st.clips.find((c) => c.n === 1);
  const c2 = st.clips.find((c) => c.n === 2);
  if (c1?.observedPublishedAt && c2?.observedPublishedAt) {
    const ordered = new Date(c1.observedPublishedAt) < new Date(c2.observedPublishedAt);
    console.log(`\nVERDICT`);
    console.log(`  clip1 scheduled before clip2, and publishedAt order matches: ${ordered}`);
    const exact1 = c1.scheduledFor === c1.observedPublishedAt;
    const exact2 = c2.scheduledFor === c2.observedPublishedAt;
    console.log(`  publishedAt == scheduled publishAt EXACTLY: clip1=${exact1} clip2=${exact2}`);
    console.log(
      exact1 && exact2
        ? '  => timestamps are ours to choose; ordering is guaranteed by the values.'
        : '  => YouTube stamps its own time; spacing must exceed the observed drift.'
    );
  }
  const c3 = st.clips.find((c) => c.n === 3);
  if (c3?.publishedAtBeforeFlip) {
    console.log(
      `\n  control clip3: publishedAt before flip = ${c3.publishedAtBeforeFlip}, after = ${c3.observedPublishedAt}`
    );
    console.log(
      `  unlisted->public rewrote publishedAt: ${c3.publishedAtBeforeFlip !== c3.observedPublishedAt}`
    );
  }
}

async function cmdCleanup() {
  const yt = ytClient();
  const st = loadState();
  if (!st) throw new Error('No state');
  for (const c of st.clips) {
    try {
      await yt.videos.delete({ id: c.videoId });
      console.log(`  deleted ${c.videoId}`);
    } catch (e) {
      console.log(`  ${c.videoId}: ${e.message}`);
    }
  }
  console.log('Cleanup done.');
}

const args = process.argv.slice(2);
const main = async () => {
  if (args.includes('--upload')) return cmdUpload();
  if (args.includes('--schedule')) {
    const i = args.indexOf('--schedule');
    return cmdSchedule(Number(args[i + 1] || 600));
  }
  if (args.includes('--flip-control')) return cmdFlipControl();
  if (args.includes('--check')) return cmdCheck();
  if (args.includes('--cleanup')) return cmdCleanup();
  console.log('Usage: --upload | --schedule <leadSeconds> | --flip-control | --check | --cleanup');
};
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
