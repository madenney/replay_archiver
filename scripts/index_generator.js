import 'dotenv/config';
import { promises as fsPromises } from 'fs';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { getDurationsSecondsFromFfprobe } from '../ffprobe.js';
import { pad } from '../lib.js';

const LEAD_IN_FRAMES = 123;
const MANIFEST_SUFFIX = '.manifest.json';
const TIMESTAMP_BUFFER_SECONDS = 0.5;

function formatYouTubeTimestamp(totalSeconds) {
  const safeSeconds = Math.max(0, Math.ceil((totalSeconds || 0) + TIMESTAMP_BUFFER_SECONDS));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

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

function getBaseNameFromPath(filePath) {
  if (!filePath) return null;
  return path.basename(filePath, path.extname(filePath));
}

function getManifestBaseName(manifest, manifestPath) {
  return (
    getBaseNameFromPath(manifest?.stitchedPath) ||
    getBaseNameFromPath(manifestPath)
  );
}

async function loadUploadsIndex(uploadsPath) {
  try {
    const raw = await fsPromises.readFile(uploadsPath, 'utf8');
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) return { byBaseName: {}, byTitle: {} };
    const byBaseName = {};
    const byTitle = {};
    entries.forEach((entry) => {
      if (!entry || !entry.videoId) return;
      const baseName = getBaseNameFromPath(entry.stitchedPath);
      if (baseName && !byBaseName[baseName]) {
        byBaseName[baseName] = entry.videoId;
      }
      if (entry.title && !byTitle[entry.title]) {
        byTitle[entry.title] = entry.videoId;
      }
    });
    return { byBaseName, byTitle };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { byBaseName: {}, byTitle: {} };
    }
    throw err;
  }
}

async function writeLine(stream, line) {
  if (!stream.write(`${line}\n`)) {
    await new Promise((resolve) => stream.once('drain', resolve));
  }
}

async function runPandoc(inputPath, outputPath) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      'pandoc',
      ['--pdf-engine=lualatex', inputPath, '-o', outputPath],
      { stdio: 'inherit' },
    );
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pandoc exited with code ${code}`));
    });
  });
}

async function main() {
  const outputDir = process.env.OUTPUT_DIR;
  if (!outputDir) {
    throw new Error('Missing OUTPUT_DIR in environment.');
  }

  const finalDir = path.join(outputDir, 'final');
  const outputGamesDir = path.join(outputDir, 'games');
  const uploadsPath = path.join(outputDir, 'uploads.json');
  const { byBaseName, byTitle } = await loadUploadsIndex(uploadsPath);

  const entries = await fsPromises.readdir(finalDir, { withFileTypes: true });
  const manifests = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(MANIFEST_SUFFIX))
    .map((entry) => path.join(finalDir, entry.name))
    .sort();

  if (manifests.length === 0) {
    console.log(`No manifest files found in ${finalDir}`);
    return;
  }

  const tmpDir = path.resolve('tmp');
  const markdownPath = path.join(tmpDir, 'index.md');
  const pdfPath = path.resolve('index.pdf');

  await fsPromises.mkdir(tmpDir, { recursive: true });
  const stream = fs.createWriteStream(markdownPath, { encoding: 'utf8' });

  await writeLine(stream, '# Replay Index');
  await writeLine(stream, '');

  for (let i = 0; i < manifests.length; i += 1) {
    const manifestPath = manifests[i];
    try {
      const raw = await fsPromises.readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(raw);
      const baseName = getManifestBaseName(manifest, manifestPath);
      const videoId =
        manifest.videoId ||
        (baseName ? byBaseName[baseName] : null) ||
        (manifest.title ? byTitle[manifest.title] : null) ||
        null;
      const videoUrl = videoId ? `https://youtu.be/${videoId}` : null;
      const heading = manifest.title || baseName || path.basename(manifestPath);

      await writeLine(stream, `## ${heading}`);
      if (videoUrl) {
        await writeLine(stream, `Video: ${videoUrl}`);
      } else {
        await writeLine(stream, 'Video: (missing videoId)');
      }
      await writeLine(stream, '');

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
        { label: 'index-generator' },
      );

      let elapsedSeconds = 0;
      for (let idx = 0; idx < durationsSeconds.length; idx += 1) {
        const label = indices[idx];
        const labelText =
          (typeof label === 'number' && Number.isFinite(label)) ||
          (typeof label === 'string' && label.trim())
            ? label
            : idx + 1;
        const timestampSeconds = Math.max(
          0,
          Math.ceil((elapsedSeconds || 0) + TIMESTAMP_BUFFER_SECONDS),
        );
        const formattedTimestamp = formatYouTubeTimestamp(elapsedSeconds);
        if (videoUrl) {
          const link = `${videoUrl}?t=${timestampSeconds}`;
          await writeLine(stream, `- ${labelText}: [${formattedTimestamp}](${link})`);
        } else {
          await writeLine(stream, `- ${labelText}: ${formattedTimestamp}`);
        }
        elapsedSeconds += durationsSeconds[idx];
      }

      await writeLine(stream, '');
      console.log(`Processed ${i + 1}/${manifests.length}: ${manifestPath}`);
    } catch (err) {
      console.error(`Failed to process ${manifestPath}: ${err.message}`);
    }
  }

  await new Promise((resolve, reject) => {
    stream.end(resolve);
    stream.on('error', reject);
  });

  await runPandoc(markdownPath, pdfPath);
  console.log(`Wrote ${pdfPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
