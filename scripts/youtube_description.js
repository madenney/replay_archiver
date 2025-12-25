import { promises as fsPromises } from 'fs';
import path from 'path';
import { buildYouTubeDescription, extractArchiveTitle } from '../youtube_description.js';

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

  const durationsSeconds = Array.isArray(manifest.games)
    ? manifest.games.map((game) => {
        const frames = game?.game_length_frames;
        return typeof frames === 'number' && Number.isFinite(frames)
          ? (frames + LEAD_IN_FRAMES) / 60
          : 0;
      })
    : [];

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
