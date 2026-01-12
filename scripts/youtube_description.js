import 'dotenv/config';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { buildYouTubeDescription, extractArchiveTitle } from '../youtube_description.js';
import { getDurationsSecondsFromFfprobe } from '../ffprobe.js';

const LEAD_IN_FRAMES = 123;

function usage() {
  console.log('Usage: node scripts/youtube_description.js <manifest.json> <output.txt>');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    usage();
    process.exit(1);
  }

  const manifestPath = args[0];
  const outputPath = args[1];

  const raw = await fsPromises.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);
  const archiveTitle =
    manifest.archiveTitle ||
    extractArchiveTitle(manifest.title) ||
    'Archive';

  const indices =
    Array.isArray(manifest.indices) && manifest.indices.length
      ? manifest.indices
      : Array.isArray(manifest.games)
        ? manifest.games
            .map((game) => game?.index)
            .filter((idx) => typeof idx === 'number')
        : [];

  const games = Array.isArray(manifest.games) ? manifest.games : [];
  const outputDir = process.env.OUTPUT_DIR;
  const outputGamesDir = outputDir ? path.join(outputDir, 'games') : null;
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

    const rawVideoPath = game?.video_path || game?.videoPath || null;
    if (outputGamesDir) {
      const fileName = rawVideoPath
        ? path.basename(rawVideoPath)
        : Number.isFinite(game?.index)
          ? `${String(game.index).padStart(6, '0')}.avi`
          : null;
      if (fileName) {
        videoPaths.push(path.join(outputGamesDir, fileName));
        return;
      }
    }
    videoPaths.push(rawVideoPath);
  });
  const durationsSeconds = await getDurationsSecondsFromFfprobe(
    videoPaths,
    fallbackDurationsSeconds,
    { label: 'youtube-description' },
  );

  const description = buildYouTubeDescription({
    archiveTitle,
    startDate: manifest.startDate,
    endDate: manifest.endDate,
    indices,
    durationsSeconds,
    totalSeconds: manifest.totalSeconds,
  });

  await fsPromises.mkdir(path.dirname(outputPath), { recursive: true });
  await fsPromises.writeFile(outputPath, description);
  console.log(`Wrote description to ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
