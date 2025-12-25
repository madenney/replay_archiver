import 'dotenv/config';
import path from 'path';
import { initSchema, getStats, getReadyForStitch, getBlockers, endPool } from '../db.js';
import { config } from '../config.js';
import { pad, convertIsoToMmDdYyyyHhMm } from '../lib.js';
import { fileExists, formatDuration } from '../util_log.js';

const FPS = 60;

function getDateRange(videoEntries) {
  if (!videoEntries.length) {
    return { startDate: '', endDate: '' };
  }
  const dates = videoEntries
    .map((v) => v.date)
    .filter(Boolean)
    .map((d) => new Date(d).getTime())
    .filter((n) => !Number.isNaN(n));
  if (!dates.length) {
    return { startDate: '', endDate: '' };
  }
  const min = Math.min(...dates);
  const max = Math.max(...dates);
  return {
    startDate: convertIsoToMmDdYyyyHhMm(new Date(min).toISOString()),
    endDate: convertIsoToMmDdYyyyHhMm(new Date(max).toISOString()),
  };
}

async function main() {
  await initSchema();
  const stats = await getStats();
  if (stats.total === 0) {
    console.log('No replays loaded.');
    return;
  }

  console.log('=== Replay Status ===');
  console.log(`Total:     ${stats.total}`);
  console.log(`Uploaded:  ${stats.uploaded}`);
  console.log(`Stitched:  ${stats.stitched}`);
  console.log(`Overlaid:  ${stats.overlaid}`);
  console.log(`Recorded:  ${stats.recorded}`);
  console.log(`Skipped:   ${stats.skipped}`);
  console.log(`Claimed:   ${stats.claimed}`);
  console.log(`Pending:   ${stats.pending}`);
  console.log(`Progress:  ${stats.uploaded}/${stats.total} uploaded`);
  console.log('=====================');

  const thresholdMinutes = config.stitchMinTotalMinutes;
  if (!Number.isFinite(thresholdMinutes) || thresholdMinutes <= 0) {
    console.log(`Stitching is disabled (STITCH_MIN_TOTAL_MINUTES=${thresholdMinutes}).`);
    return;
  }

  const thresholdSeconds = thresholdMinutes * 60;
  const ready = await getReadyForStitch();
  if (!ready.length) {
    console.log('Stitch: nothing ready yet (no overlaid, non-uploaded replays).');
    return;
  }

  const readyByIndex = [...ready].sort((a, b) => a.index - b.index);
  console.log(`Ready for stitch: ${readyByIndex.length} replays`);
  console.log(`Stitch threshold: ${thresholdMinutes} minutes (${thresholdSeconds}s)`);

  const videoEntries = [];
  const missingFiles = [];
  const invalidFrames = [];
  let totalSeconds = 0;
  let maxReadyIndex = null;

  for (const r of readyByIndex) {
    const videoPath = path.resolve(config.gamesDir, `${pad(r.index, 6)}.avi`);
    if (!(await fileExists(videoPath))) {
      missingFiles.push({ index: r.index, path: videoPath });
      break;
    }
    const frames = typeof r.game_length_frames === 'number' ? r.game_length_frames : null;
    if (!frames || Number.isNaN(frames) || frames <= 0) {
      invalidFrames.push({ index: r.index, frames });
      break;
    }
    const duration = frames / FPS;
    videoEntries.push({
      index: r.index,
      path: videoPath,
      duration,
      date: r.date,
      frames,
    });
    totalSeconds += duration;
    maxReadyIndex = r.index;
    if (totalSeconds >= thresholdSeconds) {
      break;
    }
  }

  if (missingFiles.length > 0 || invalidFrames.length > 0) {
    const missingIdx = missingFiles.map((m) => m.index).join(', ');
    const badFrameIdx = invalidFrames.map((m) => m.index).join(', ');
    console.log(
      `Stitch paused: missing files (${missingFiles.length}) [${missingIdx || 'none'}] ` +
        `or invalid frame counts (${invalidFrames.length}) [${badFrameIdx || 'none'}].`,
    );
    if (missingFiles.length > 0) {
      console.log(`First missing file: ${missingFiles[0].path}`);
    }
  }

  if (!videoEntries.length) {
    console.log('No valid replays available for the next stitch pass.');
    return;
  }

  const tallyDuration = formatDuration(totalSeconds);
  const minutes = (totalSeconds / 60).toFixed(2);
  const { startDate, endDate } = getDateRange(videoEntries);
  console.log('--- Next Stitch Tally ---');
  console.log(`Count:   ${videoEntries.length}`);
  console.log(`Frames:  ${videoEntries.reduce((sum, v) => sum + v.frames, 0)}`);
  console.log(`Time:    ${tallyDuration} (${minutes} mins)`);
  if (startDate && endDate) {
    console.log(`Range:   ${startDate} -> ${endDate}`);
  }
  console.log(`Indices: ${videoEntries.map((v) => v.index).join(', ')}`);

  if (totalSeconds < thresholdSeconds) {
    const remaining = thresholdSeconds - totalSeconds;
    console.log(
      `Below threshold: need ${formatDuration(remaining)} (${(remaining / 60).toFixed(2)} mins) more.`,
    );
  }

  if (maxReadyIndex !== null) {
    const blockers = await getBlockers(maxReadyIndex);
    if (blockers.length === 0) {
      console.log('Stitch readiness: OK (no blockers before highest ready index).');
    } else {
      console.log(
        `Stitch readiness: BLOCKED - ${blockers.length} unskipped replays <= ${maxReadyIndex} are not overlaid.`,
      );
      console.log(`Blockers: ${blockers.join(', ')}`);
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .then(async () => {
    await endPool().catch(() => {});
    process.exit(0);
  });
