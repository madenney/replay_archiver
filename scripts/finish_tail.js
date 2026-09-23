#!/usr/bin/env node
// Flush the final, short batch of replays into one last video.
//
// The stitcher accumulates games until it crosses STITCH_MIN_TOTAL_MINUTES,
// so whatever is left over at the very end is by definition shorter than the
// threshold and will never stitch on its own ("Stitch paused: totalSeconds <
// threshold"). No pre-set threshold fixes this — lowering it early just makes
// every remaining video shorter and leaves a new short tail behind.
//
// This script waits until the leftover is all that remains, then re-runs the
// normal stitch/upload path with the threshold set just below the leftover's
// real duration, so everything still pending lands in exactly one final video.
//
// Usage:
//   node scripts/finish_tail.js --dry-run   # show what it would do
//   node scripts/finish_tail.js             # stitch + upload the tail
//   node scripts/finish_tail.js --force     # tail-flush even if a full-length
//                                           # video could still be made
import 'dotenv/config';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { initSchema, getReadyForStitch, getBlockers, endPool } from '../db.js';
import { config } from '../config.js';
import { formatDuration } from '../util_log.js';

const LEAD_IN_FRAMES = 123; // matches stitcher.js / media.js
const FPS = 60;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run') || args.includes('-n');
const force = args.includes('--force');

async function main() {
  await initSchema();
  const ready = await getReadyForStitch();

  if (ready.length === 0) {
    console.log('Nothing ready to stitch — everything is uploaded or skipped. Done!');
    return;
  }

  const withFrames = ready.filter(
    (r) => typeof r.game_length_frames === 'number' && r.game_length_frames > 0
  );
  if (withFrames.length !== ready.length) {
    const bad = ready
      .filter((r) => !(typeof r.game_length_frames === 'number' && r.game_length_frames > 0))
      .map((r) => r.index);
    console.error(
      `Refusing to run: ${bad.length} ready replay(s) have no usable game_length_frames: ${bad.join(', ')}`
    );
    console.error('The stitcher would stop at the first one. Fix or skip them, then re-run.');
    process.exitCode = 1;
    return;
  }

  const totalSeconds = ready.reduce(
    (sum, r) => sum + (r.game_length_frames + LEAD_IN_FRAMES) / FPS,
    0
  );
  const thresholdSeconds = config.stitchMinTotalMinutes * 60;
  const firstIdx = ready[0].index;
  const lastIdx = ready[ready.length - 1].index;

  console.log(`Remaining ready: ${ready.length} games, ${formatDuration(totalSeconds)} (idx ${firstIdx}–${lastIdx})`);
  console.log(`Current threshold: ${config.stitchMinTotalMinutes} min (${formatDuration(thresholdSeconds)})`);

  if (totalSeconds >= thresholdSeconds && !force) {
    const fullVideos = Math.floor(totalSeconds / thresholdSeconds);
    console.log(
      `\nNot the tail yet — enough is left for ~${fullVideos} more full-length video(s).\n` +
        'Let the normal pipeline keep running and re-run this when it reports\n' +
        '"Stitch paused: totalSeconds < threshold". (Use --force to flush anyway.)'
    );
    return;
  }

  // A blocker below the tail would make the stitcher bail regardless.
  const blockers = await getBlockers(lastIdx);
  if (blockers.length > 0) {
    console.error(
      `Refusing to run: ${blockers.length} unskipped replay(s) <= ${lastIdx} are not overlaid: ${blockers.join(', ')}`
    );
    console.error('Record them or set skip=1, then re-run.');
    process.exitCode = 1;
    return;
  }

  // Set the threshold just below the real total so the stitcher's accumulator
  // only crosses it on the very last game — one video, not one video per game.
  // (A low threshold like 1 minute would close a batch after the first game.)
  const tailThresholdMinutes = (totalSeconds - 1) / 60;

  console.log(
    `\nTail flush: one final video of ${ready.length} games, ~${formatDuration(totalSeconds)}\n` +
      `Running with STITCH_MIN_TOTAL_MINUTES=${tailThresholdMinutes.toFixed(4)}`
  );

  if (dryRun) {
    console.log('\n--dry-run: not stitching. Command that would run:');
    console.log(`  STITCH_MIN_TOTAL_MINUTES=${tailThresholdMinutes.toFixed(4)} node index.js -s`);
    return;
  }

  await endPool().catch(() => {});

  const child = spawn(process.execPath, ['index.js', '-s'], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: { ...process.env, STITCH_MIN_TOTAL_MINUTES: tailThresholdMinutes.toFixed(4) },
  });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  process.exitCode = code ?? 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void endPool().catch(() => {});
  });
