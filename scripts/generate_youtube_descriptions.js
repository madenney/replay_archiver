import 'dotenv/config';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { buildYouTubeDescription, extractArchiveTitle } from '../youtube_description.js';
import { getDurationsSecondsFromFfprobe } from '../ffprobe.js';
import { pad } from '../lib.js';

const LEAD_IN_FRAMES = 123;
const MANIFEST_SUFFIX = '.manifest.json';

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

function getOutputBaseName(manifest, manifestPath) {
  const stitchedPath = manifest?.stitchedPath;
  if (stitchedPath) {
    return path.basename(stitchedPath, path.extname(stitchedPath));
  }
  const fileName = path.basename(manifestPath);
  if (fileName.endsWith(MANIFEST_SUFFIX)) {
    return fileName.slice(0, -MANIFEST_SUFFIX.length);
  }
  return path.parse(fileName).name;
}

async function main() {
  const outputDir = process.env.OUTPUT_DIR;
  if (!outputDir) {
    throw new Error('Missing OUTPUT_DIR in environment.');
  }

  const finalDir = path.join(outputDir, 'final');
  const outputGamesDir = path.join(outputDir, 'games');
  const descriptionsDir = path.resolve('yt_descriptions');

  const entries = await fsPromises.readdir(finalDir, { withFileTypes: true });
  const manifests = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(MANIFEST_SUFFIX))
    .map((entry) => path.join(finalDir, entry.name))
    .sort();

  if (manifests.length === 0) {
    console.log(`No manifest files found in ${finalDir}`);
    return;
  }

  await fsPromises.mkdir(descriptionsDir, { recursive: true });

  for (const manifestPath of manifests) {
    try {
      const raw = await fsPromises.readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(raw);
      const archiveTitle =
        manifest.archiveTitle ||
        extractArchiveTitle(manifest.title) ||
        'Archive';

      const games = Array.isArray(manifest.games) ? manifest.games : [];
      const indices =
        Array.isArray(manifest.indices) && manifest.indices.length
          ? manifest.indices
          : games
              .map((game) => game?.index)
              .filter((idx) => typeof idx === 'number');

      const videoPaths = [];
      const fallbackDurationsSeconds = [];
      games.forEach((game) => {
        const storedDurationSeconds = Number.isFinite(game?.video_duration_seconds)
          ? game.video_duration_seconds
          : Number.isFinite(game?.videoDurationSeconds)
            ? game.videoDurationSeconds
            : null;
        if (storedDurationSeconds != null) {
          fallbackDurationsSeconds.push(storedDurationSeconds);
          videoPaths.push(null);
          return;
        }

        const frames = game?.game_length_frames;
        fallbackDurationsSeconds.push(
          typeof frames === 'number' && Number.isFinite(frames)
            ? (frames + LEAD_IN_FRAMES) / 60
            : 0,
        );
        videoPaths.push(resolveVideoPath(game, outputGamesDir));
      });

      const durationsSeconds = await getDurationsSecondsFromFfprobe(
        videoPaths,
        fallbackDurationsSeconds,
        { label: 'yt-descriptions' },
      );

      const description = buildYouTubeDescription({
        archiveTitle,
        startDate: manifest.startDate,
        endDate: manifest.endDate,
        indices,
        durationsSeconds,
        totalSeconds: manifest.totalSeconds,
      });

      const baseName = getOutputBaseName(manifest, manifestPath);
      const outputPath = path.join(descriptionsDir, `${baseName}.txt`);
      await fsPromises.writeFile(outputPath, description);
      console.log(`Wrote ${outputPath}`);
    } catch (err) {
      console.error(`Failed to process ${manifestPath}: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
