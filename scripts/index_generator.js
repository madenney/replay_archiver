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

function parseDateToMillis(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return parsed.getTime();
  const match = text.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/,
  );
  if (!match) return null;
  const [, month, day, year, hour = '0', minute = '0'] = match;
  const parsedFallback = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  );
  return Number.isNaN(parsedFallback.getTime()) ? null : parsedFallback.getTime();
}

function getManifestSortKey(manifest) {
  const games = Array.isArray(manifest?.games) ? manifest.games : [];
  const dates = games
    .map((game) => parseDateToMillis(game?.date))
    .filter((ts) => Number.isFinite(ts));
  if (dates.length) {
    return { missing: false, ts: Math.min(...dates) };
  }
  const startTs = parseDateToMillis(manifest?.startDate);
  if (Number.isFinite(startTs)) return { missing: false, ts: startTs };
  const endTs = parseDateToMillis(manifest?.endDate);
  if (Number.isFinite(endTs)) return { missing: false, ts: endTs };
  return { missing: true, ts: 0 };
}

function formatDateOnly(timestampMs) {
  const date = new Date(timestampMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${month}/${day}/${year}`;
}

function formatDateOnlyFromValue(value) {
  if (!value) return '';
  const parsed = parseDateToMillis(value);
  if (Number.isFinite(parsed)) return formatDateOnly(parsed);
  const text = String(value).trim();
  if (!text) return '';
  if (text.includes(' ')) return text.split(' ')[0];
  if (text.includes('T')) return text.split('T')[0];
  return text;
}

function getManifestDateRangeText(manifest) {
  const start = manifest?.startDate;
  const end = manifest?.endDate;
  const startText = start ? formatDateOnlyFromValue(start) : '';
  const endText = end ? formatDateOnlyFromValue(end) : '';
  if (startText && endText) return startText === endText ? startText : `${startText} - ${endText}`;
  if (startText) return startText;
  if (endText) return endText;

  const games = Array.isArray(manifest?.games) ? manifest.games : [];
  const dates = games
    .map((game) => parseDateToMillis(game?.date))
    .filter((ts) => Number.isFinite(ts));
  if (!dates.length) return '';
  const min = Math.min(...dates);
  const max = Math.max(...dates);
  const startRange = formatDateOnly(min);
  const endRange = formatDateOnly(max);
  return startRange === endRange ? startRange : `${startRange} - ${endRange}`;
}

function isHaxPlayer(tag, code) {
  const codeValue = String(code || '');
  if (codeValue === 'XX#02' || codeValue === 'HAX#472') return true;
  const tagValue = String(tag || '').toLowerCase();
  return tagValue.includes('hax') || tagValue.includes('b0xx');
}

function getNonHaxPlayer(game) {
  const players = Array.isArray(game?.players) ? game.players : [];
  const codes = Array.isArray(game?.codes) ? game.codes : [];
  const total = Math.max(players.length, codes.length);
  if (!total) return null;
  const entries = [];
  for (let i = 0; i < total; i += 1) {
    entries.push({ tag: players[i] || '', code: codes[i] || '' });
  }
  const haxIndices = entries
    .map((entry, idx) => (isHaxPlayer(entry.tag, entry.code) ? idx : -1))
    .filter((idx) => idx >= 0);
  if (haxIndices.length === 1) {
    return entries.find((_, idx) => idx !== haxIndices[0]) || entries[0];
  }
  const nonHax = entries.find((entry) => !isHaxPlayer(entry.tag, entry.code));
  return nonHax || entries[0];
}

function formatPlayerLabel(entry) {
  if (!entry) return 'Unknown';
  const tag = String(entry.tag || '').trim();
  const code = String(entry.code || '').trim();
  if (tag && code) return `${tag} (${code})`;
  if (tag) return tag;
  if (code) return code;
  return 'Unknown';
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

  const manifestEntries = [];
  let skipped = 0;
  for (const manifestPath of manifests) {
    try {
      const raw = await fsPromises.readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(raw);
      const { missing, ts } = getManifestSortKey(manifest);
      manifestEntries.push({
        manifestPath,
        manifest,
        sortMissing: missing,
        sortTs: ts,
      });
    } catch (err) {
      console.error(`Skipping ${manifestPath}: ${err.message}`);
      skipped += 1;
    }
  }

  if (manifestEntries.length === 0) {
    console.log(`No readable manifest files found in ${finalDir}`);
    return;
  }

  manifestEntries.sort((a, b) => {
    if (a.sortMissing !== b.sortMissing) {
      return a.sortMissing ? 1 : -1;
    }
    if (a.sortTs !== b.sortTs) {
      return a.sortTs - b.sortTs;
    }
    return a.manifestPath.localeCompare(b.manifestPath);
  });

  const tmpDir = path.resolve('tmp');
  const markdownPath = path.join(tmpDir, 'index.md');
  const pdfPath = path.resolve('index.pdf');

  await fsPromises.mkdir(tmpDir, { recursive: true });
  const stream = fs.createWriteStream(markdownPath, { encoding: 'utf8' });

  await writeLine(stream, '# Hax Archive Index');
  await writeLine(stream, '');

  for (let i = 0; i < manifestEntries.length; i += 1) {
    const { manifestPath, manifest } = manifestEntries[i];
    try {
      const baseName = getManifestBaseName(manifest, manifestPath);
      const videoId =
        manifest.videoId ||
        (baseName ? byBaseName[baseName] : null) ||
        (manifest.title ? byTitle[manifest.title] : null) ||
        null;
      const videoUrl = videoId ? `https://youtu.be/${videoId}` : null;
      const dateRange = getManifestDateRangeText(manifest);
      const heading = dateRange || 'Unknown date';

      await writeLine(stream, `## ${heading}`);
      if (videoUrl) {
        await writeLine(stream, `Video link: [${videoUrl}](${videoUrl})`);
      } else {
        await writeLine(stream, 'Video link: (missing videoId)');
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

      await writeLine(stream, '| Game | Opponent | Video Timestamp |');
      await writeLine(stream, '| --- | --- | --- |');

      let elapsedSeconds = 0;
      for (let idx = 0; idx < durationsSeconds.length; idx += 1) {
        const game = games[idx] && typeof games[idx] === 'object' ? games[idx] : {};
        const playerLabel = formatPlayerLabel(getNonHaxPlayer(game));
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
          const mdTime = `[${formattedTimestamp}](${link})`;
          await writeLine(stream, `| ${labelText} | ${playerLabel} | ${mdTime} |`);
        } else {
          await writeLine(stream, `| ${labelText} | ${playerLabel} | ${formattedTimestamp} |`);
        }
        elapsedSeconds += durationsSeconds[idx];
      }

      await writeLine(stream, '');
      console.log(`Processed ${i + 1}/${manifestEntries.length}: ${manifestPath}`);
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

  if (skipped) {
    console.log(`Skipped ${skipped} unreadable manifest(s).`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
