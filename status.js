import fs from 'fs/promises';
import path from 'path';

const replaysPath = path.join('replays.json');
const stitchStatePath = path.join('output', 'stitch_state.json');

async function main() {
  const replays = await readJsonSafe(replaysPath, []);
  if (!Array.isArray(replays) || replays.length === 0) {
    console.log('No replays loaded.');
    return;
  }

  const total = replays.length;
  const counts = {
    uploaded: 0,
    stitched: 0,
    overlaid: 0,
    recorded: 0,
    skipped: 0,
  };
  for (const r of replays) {
    if (r.uploaded) counts.uploaded++;
    if (r.stitched) counts.stitched++;
    if (r.overlaid) counts.overlaid++;
    if (r.recorded) counts.recorded++;
    if (r.skip) counts.skipped++;
  }
  const pending = replays.filter((r) => !r.uploaded && !r.skip).length;
  console.log('=== Replay Status ===');
  console.log(`Total:     ${total}`);
  console.log(`Uploaded:  ${counts.uploaded}`);
  console.log(`Stitched:  ${counts.stitched}`);
  console.log(`Overlaid:  ${counts.overlaid}`);
  console.log(`Recorded:  ${counts.recorded}`);
  console.log(`Skipped:   ${counts.skipped}`);
  console.log(`Pending:   ${pending}`);
  console.log(`Progress:  ${counts.uploaded}/${total} uploaded`);
  console.log('=====================');

  await reportStitchBlockers(replays);
}

async function reportStitchBlockers(replays) {
  let stitchState = await readJsonSafe(stitchStatePath, null);
  if (!stitchState) {
    console.log('No stitch_state.json found; stitching may not have run yet.');
    stitchState = { queue: [], uploads: [] };
  }

  const eligible = replays.filter((r) => r && !r.skip && !r.uploaded);
  const ready = eligible.filter((r) => r.overlaid);
  if (ready.length === 0) {
    console.log('Stitch: nothing ready yet (no overlaid, non-uploaded replays).');
    return;
  }

  const readyByIndex = [...ready].sort((a, b) => a.index - b.index);
  const maxReadyIndex = readyByIndex[readyByIndex.length - 1].index;
  const blockers = eligible.filter(
    (r) => r.index <= maxReadyIndex && !r.overlaid,
  );

  if (blockers.length === 0) {
    console.log('Stitch: ready to run (no blockers before highest ready index).');
  } else {
    const blockerIds = blockers.map((b) => b.index).join(', ');
    console.log(
      `Stitch: BLOCKED - ${blockers.length} unskipped replays <= ${maxReadyIndex} are not overlaid. Blockers: ${blockerIds}`,
    );
  }
}

async function readJsonSafe(p, fallback) {
  try {
    const data = await fs.readFile(p, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
