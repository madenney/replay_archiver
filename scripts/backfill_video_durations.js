import 'dotenv/config';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { probeDurationSeconds } from '../ffprobe.js';
import { pad } from '../lib.js';

const MANIFEST_SUFFIX = '.manifest.json';
const args = new Set(process.argv.slice(2));
const skipKnown = !args.has('--reprobe');

function resolveVideoPath(game, outputGamesDir) {
  const rawVideoPath = game?.video_path || game?.videoPath || null;
  if (outputGamesDir) {
    const fileName = rawVideoPath
      ? path.basename(rawVideoPath)
      : Number.isFinite(game?.index)
        ? `${pad(game.index, 6)}.avi`
        : null;
    if (fileName) {
      return path.join(outputGamesDir, fileName);
    }
  }
  return rawVideoPath;
}

function renderProgress(done, total) {
  if (process.stdout.isTTY) {
    process.stdout.write(`\r${done}/${total}`);
  } else {
    process.stdout.write(`${done}/${total}\n`);
  }
}

async function collectManifests(finalDir) {
  const entries = await fsPromises.readdir(finalDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(MANIFEST_SUFFIX))
    .map((entry) => path.join(finalDir, entry.name))
    .sort();
}

async function countGames(manifestPaths) {
  const skipped = new Set();
  let total = 0;
  for (const manifestPath of manifestPaths) {
    try {
      const raw = await fsPromises.readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(raw);
      const games = Array.isArray(manifest.games) ? manifest.games : [];
      total += games.length;
    } catch (err) {
      console.error(`Skipping ${manifestPath}: ${err.message}`);
      skipped.add(manifestPath);
    }
  }
  return { total, skipped };
}

async function main() {
  const outputDir = process.env.OUTPUT_DIR;
  if (!outputDir) {
    throw new Error('Missing OUTPUT_DIR in environment.');
  }

  const finalDir = path.join(outputDir, 'final');
  const outputGamesDir = path.join(outputDir, 'games');
  const manifestPaths = await collectManifests(finalDir);

  if (manifestPaths.length === 0) {
    console.log(`No manifest files found in ${finalDir}`);
    return;
  }

  const { total, skipped } = await countGames(manifestPaths);
  if (total === 0) {
    console.log('No games found in manifests.');
    return;
  }

  let processed = 0;
  let updatedGames = 0;
  let missingPaths = 0;
  let missingFiles = 0;
  let probeFailures = 0;
  let skippedKnown = 0;

  renderProgress(processed, total);

  for (const manifestPath of manifestPaths) {
    if (skipped.has(manifestPath)) {
      continue;
    }

    let manifest;
    try {
      const raw = await fsPromises.readFile(manifestPath, 'utf8');
      manifest = JSON.parse(raw);
    } catch (err) {
      console.error(`Skipping ${manifestPath}: ${err.message}`);
      continue;
    }

    const games = Array.isArray(manifest.games) ? manifest.games : [];
    let manifestUpdated = false;
    let manifestMissing = 0;
    let manifestProbeFailures = 0;
    let manifestMissingPaths = 0;
    let manifestSkippedKnown = 0;

    for (const game of games) {
      const existing = Number.isFinite(game?.video_duration_seconds)
        ? game.video_duration_seconds
        : Number.isFinite(game?.videoDurationSeconds)
          ? game.videoDurationSeconds
          : null;

      if (skipKnown && existing != null) {
        skippedKnown += 1;
        manifestSkippedKnown += 1;
        processed += 1;
        renderProgress(processed, total);
        continue;
      }

      const videoPath = resolveVideoPath(game, outputGamesDir);
      let duration = null;

      if (!videoPath) {
        missingPaths += 1;
        manifestMissingPaths += 1;
      } else {
        try {
          duration = await probeDurationSeconds(videoPath);
        } catch (err) {
          if (err && err.code === 'ENOENT') {
            throw new Error('ffprobe not found in PATH.');
          }
          const stderr = err?.stderr ? String(err.stderr) : '';
          if (stderr.includes('No such file') || stderr.includes('No such file or directory')) {
            missingFiles += 1;
            manifestMissing += 1;
          } else {
            probeFailures += 1;
            manifestProbeFailures += 1;
          }
        }
      }

      if (duration != null) {
        if (existing == null || Math.abs(existing - duration) > 0.001) {
          game.video_duration_seconds = duration;
          manifestUpdated = true;
          updatedGames += 1;
        }
      }

      processed += 1;
      renderProgress(processed, total);
    }

    if (manifestUpdated) {
      await fsPromises.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    }

    if (
      manifestMissingPaths ||
      manifestMissing ||
      manifestProbeFailures ||
      manifestSkippedKnown
    ) {
      console.log(
        `\n${path.basename(manifestPath)}: missing paths=${manifestMissingPaths}, missing files=${manifestMissing}, probe failures=${manifestProbeFailures}, skipped known=${manifestSkippedKnown}`,
      );
    }
  }

  process.stdout.write('\n');
  console.log(
    `Done. Updated ${updatedGames} games. Skipped known=${skippedKnown}. Missing paths=${missingPaths}, missing files=${missingFiles}, probe failures=${probeFailures}.`,
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
