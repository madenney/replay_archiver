import { promises as fs } from 'fs';
import path from 'path';
import * as SlippiPkg from '@slippi/slippi-js';
const SlippiGame =
  SlippiPkg.SlippiGame ||
  (SlippiPkg.default && SlippiPkg.default.SlippiGame);
if (!SlippiGame) {
  throw new Error('Unable to load SlippiGame from @slippi/slippi-js');
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: node count_tags.js <dir>');
    process.exit(1);
  }

  const slpFiles = await collectSlpFiles(path.resolve(target));
  if (slpFiles.length === 0) {
    console.error('No .slp files found.');
    return;
  }

  const counts = new Map();

  for (const file of slpFiles) {
    try {
      const game = new SlippiGame(file);
      const metadata = game.getMetadata() || {};
      const players = normalizePlayers(metadata.players);
      const names = players.map((p, idx) => formatPlayerName(p, `P${idx + 1}`));
      names.forEach((name) => {
        const key = name.toLowerCase();
        const entry = counts.get(key) || { name, count: 0 };
        entry.count += 1;
        counts.set(key, entry);
      });
    } catch (err) {
      console.error(`Failed to parse ${file}: ${err.message}`);
    }
  }

  const sorted = Array.from(counts.values())
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 50);

  sorted.forEach((entry) => {
    console.log(`${entry.count}\t${entry.name}`);
  });
}

async function collectSlpFiles(dir) {
  const results = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await collectSlpFiles(fullPath);
      results.push(...sub);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.slp')) {
      results.push(fullPath);
    }
  }
  return results;
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

function formatPlayerName(player, fallback) {
  if (!player) return fallback || 'Unknown';
  const names = player.names || {};
  return (
    names.netplay ||
    names.code ||
    names.displayName ||
    names.nickname ||
    names.tag ||
    names.name ||
    player.nametag ||
    fallback ||
    'Unknown'
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
