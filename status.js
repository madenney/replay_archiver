import 'dotenv/config';
import { getStats, getBlockers, getReadyForStitch, initSchema } from './db.js';

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

  await reportStitchBlockers();
}

async function reportStitchBlockers() {
  const ready = await getReadyForStitch();
  if (ready.length === 0) {
    console.log('Stitch: nothing ready yet (no overlaid, non-uploaded replays).');
    return;
  }
  const readyByIndex = [...ready].sort((a, b) => a.index - b.index);
  const maxReadyIndex = readyByIndex[readyByIndex.length - 1].index;
  const blockers = await getBlockers(maxReadyIndex);
  if (blockers.length === 0) {
    console.log('Stitch: ready to run (no blockers before highest ready index).');
  } else {
    console.log(
      `Stitch: BLOCKED - ${blockers.length} unskipped replays <= ${maxReadyIndex} are not overlaid. Blockers: ${blockers.join(', ')}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
