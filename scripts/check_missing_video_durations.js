import 'dotenv/config';
import path from 'path';
import { promises as fs } from 'fs';

const MANIFEST_SUFFIX = '.manifest.json';
const args = new Set(process.argv.slice(2));
const listMissing = args.has('--list');

function getDurationSeconds(game) {
  if (Number.isFinite(game?.video_duration_seconds)) {
    return game.video_duration_seconds;
  }
  if (Number.isFinite(game?.videoDurationSeconds)) {
    return game.videoDurationSeconds;
  }
  return null;
}

function describeGame(game) {
  if (Number.isFinite(game?.index)) {
    return `index=${game.index}`;
  }
  if (game?.video_path) {
    return `path=${game.video_path}`;
  }
  if (game?.videoPath) {
    return `path=${game.videoPath}`;
  }
  return 'unknown';
}

async function collectManifests(finalDir) {
  const entries = await fs.readdir(finalDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(MANIFEST_SUFFIX))
    .map((entry) => path.join(finalDir, entry.name))
    .sort();
}

async function main() {
  const outputDir = process.env.OUTPUT_DIR;
  if (!outputDir || String(outputDir).trim() === '') {
    throw new Error('OUTPUT_DIR is not set.');
  }

  const finalDir = path.join(outputDir, 'final');
  let manifestPaths;
  try {
    manifestPaths = await collectManifests(finalDir);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log(`Final directory does not exist: ${finalDir}`);
      return;
    }
    throw err;
  }

  if (manifestPaths.length === 0) {
    console.log(`No manifest files found in ${finalDir}`);
    return;
  }

  let totalGames = 0;
  let totalMissing = 0;
  let skipped = 0;

  for (const manifestPath of manifestPaths) {
    let manifest;
    try {
      const raw = await fs.readFile(manifestPath, 'utf8');
      manifest = JSON.parse(raw);
    } catch (err) {
      console.error(`Skipping ${manifestPath}: ${err.message}`);
      skipped += 1;
      continue;
    }

    const games = Array.isArray(manifest.games) ? manifest.games : [];
    totalGames += games.length;

    const missing = [];
    for (const game of games) {
      if (getDurationSeconds(game) == null) {
        missing.push(game);
      }
    }

    if (missing.length > 0) {
      totalMissing += missing.length;
      console.log(
        `${path.basename(manifestPath)}: missing durations=${missing.length}/${games.length}`,
      );
      if (listMissing) {
        for (const game of missing) {
          console.log(`  - ${describeGame(game)}`);
        }
      }
    }
  }

  if (totalGames === 0) {
    console.log('No games found in manifests.');
    return;
  }

  if (totalMissing === 0) {
    console.log(`All durations present across ${totalGames} games.`);
    return;
  }

  console.log(
    `Done. Missing durations=${totalMissing} across ${totalGames} games. Skipped manifests=${skipped}.`,
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
