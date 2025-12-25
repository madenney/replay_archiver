import 'dotenv/config';
import { initSchema, getVideoEntries, endPool } from '../db.js';
import { formatDuration } from '../util_log.js';

const FPS = 60;

function getFlagValue(args, flag) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === flag) return args[i + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return null;
}

function parseLimit(args) {
  const raw = getFlagValue(args, '-n');
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid -n value: ${raw}. Expected a positive integer.`);
  }
  return value;
}

function formatTimeSummary(totalSeconds) {
  const totalMinutes = totalSeconds / 60;
  const totalHours = totalSeconds / 3600;
  const totalDays = totalHours / 24;
  return {
    duration: formatDuration(totalSeconds),
    minutes: totalMinutes,
    hours: totalHours,
    days: totalDays,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const limit = parseLimit(args);

  await initSchema();
  const replays = await getVideoEntries();
  const selected = limit ? replays.slice(0, limit) : replays;
  if (!selected.length) {
    console.log('No replays found.');
    return;
  }

  let totalFrames = 0;
  let skipped = 0;

  for (const replay of selected) {
    const framesRaw = replay.game_length_frames;
    const frames =
      typeof framesRaw === 'number' && Number.isFinite(framesRaw) && framesRaw > 0
        ? Math.floor(framesRaw)
        : 0;
    if (frames === 0) {
      skipped++;
    }
    totalFrames += frames;
    const totalSeconds = totalFrames / FPS;
    const summary = formatTimeSummary(totalSeconds);
    const idx = typeof replay.index === 'number' ? replay.index : '?';
    console.log(
      `${String(idx).padStart(6, '0')} | +${frames} frames | total ${totalFrames} frames | ` +
        `${summary.duration} | ${summary.hours.toFixed(2)} hrs (${summary.minutes.toFixed(2)} mins, ${summary.days.toFixed(2)} days)`,
    );
  }

  const finalSeconds = totalFrames / FPS;
  const finalSummary = formatTimeSummary(finalSeconds);
  console.log(
    `Total: ${totalFrames} frames | ${finalSummary.duration} | ${finalSummary.hours.toFixed(2)} hrs (${finalSummary.days.toFixed(2)} days)`,
  );
  if (skipped > 0) {
    console.log(`Note: ${skipped} replay${skipped === 1 ? '' : 's'} had missing/invalid frame counts.`);
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
