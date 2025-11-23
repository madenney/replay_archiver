import { promises as fs } from 'fs';
import path from 'path';
import { SlippiGame } from '@slippi/slippi-js';

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: node analyze_slp.js <file-or-directory>');
    process.exit(1);
  }

  const slpFiles = await collectSlpFiles(path.resolve(target));
  if (slpFiles.length === 0) {
    console.error('No .slp files found.');
    return;
  }

  const infos = [];
  for (const file of slpFiles) {
    const info = await getReplayInfo(file);
    if (info) infos.push(info);
  }

  infos.sort((a, b) => a.sortTime - b.sortTime);

  for (const info of infos) {
    await printGameInfo(info.filePath, info.metadata);
  }
}

async function collectSlpFiles(targetPath) {
  try {
    const stat = await fs.lstat(targetPath);
    if (stat.isDirectory()) {
      const entries = await fs.readdir(targetPath, { withFileTypes: true });
      const results = await Promise.all(
        entries.map((entry) =>
          collectSlpFiles(path.join(targetPath, entry.name)),
        ),
      );
      return results.flat();
    }
    if (stat.isFile() && targetPath.toLowerCase().endsWith('.slp')) {
      return [targetPath];
    }
    return [];
  } catch (err) {
    console.error(`Failed to read ${targetPath}: ${err.message}`);
    return [];
  }
}

async function getReplayInfo(filePath) {
  try {
    const game = new SlippiGame(filePath);
    const metadata = game.getMetadata() || {};
    const dateVal = parseDate(metadata.startAt);
    const stat = await fs.lstat(filePath);
    const sortTime = !Number.isNaN(dateVal) ? dateVal : stat.mtimeMs;
    return { filePath, metadata, sortTime };
  } catch (err) {
    console.error(`Error parsing ${filePath}: ${err.message}`);
    return null;
  }
}

async function printGameInfo(filePath, metadata) {
  try {
    if (!metadata) {
      const game = new SlippiGame(filePath);
      metadata = game.getMetadata() || {};
    }
    const players = normalizePlayers(metadata.players);
    const p1 = formatPlayer(players[0], 'P1');
    const p2 = formatPlayer(players[1], 'P2');
    const date = formatDate(metadata.startAt);

    console.log('---------------');
    console.log(`File: ${filePath}`);
    console.log(`Date: ${date}`);
    console.log(`Players: ${p1} vs ${p2}`);
  } catch (err) {
    console.error(`Error parsing ${filePath}: ${err.message}`);
  }
}

function normalizePlayers(playersObj) {
  if (!playersObj) return [];
  if (Array.isArray(playersObj)) return playersObj;
  const entries = Object.entries(playersObj)
    .map(([k, v]) => {
      const num = Number(k);
      return { idx: Number.isNaN(num) ? k : num, data: v };
    })
    .sort((a, b) => {
      if (typeof a.idx === 'number' && typeof b.idx === 'number') {
        return a.idx - b.idx;
      }
      if (typeof a.idx === 'number') return -1;
      if (typeof b.idx === 'number') return 1;
      return String(a.idx).localeCompare(String(b.idx));
    });
  return entries.map((e) => e.data);
}

function formatPlayer(player, fallbackLabel) {
  console.log(player)
  if (!player) return fallbackLabel || 'Unknown';
  const names = player.names || {};
  return (
    names.netplay ||
    names.code ||
    names.nickname ||
    player.nametag ||
    fallbackLabel ||
    'Unknown'
  );
}

function formatDate(startAt) {
  if (!startAt) return 'Unknown';
  const ts = parseDate(startAt);
  if (Number.isNaN(ts)) return String(startAt);
  return new Date(ts).toISOString();
}

function parseDate(startAt) {
  const date = new Date(startAt);
  return date.getTime();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
