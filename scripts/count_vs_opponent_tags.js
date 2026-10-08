import 'dotenv/config';
import path from 'path';
import { promises as fs } from 'fs';

// The archive owner's own player, so reports can name the opponent instead.
const OWN_CODES = (process.env.ARCHIVE_PLAYER_CODES || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
const OWN_TAGS = (process.env.ARCHIVE_PLAYER_TAGS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

const MANIFEST_SUFFIX = '.manifest.json';

function isArchivePlayer(tag, code) {
  const codeValue = String(code || '');
  if (OWN_CODES.includes(codeValue.toUpperCase())) return true;
  const tagValue = String(tag || '').toLowerCase();
  return OWN_TAGS.some((t) => tagValue.includes(t));
}

function getOpponentEntry(game) {
  const players = Array.isArray(game?.players) ? game.players : [];
  const codes = Array.isArray(game?.codes) ? game.codes : [];
  const total = Math.max(players.length, codes.length);
  if (!total) return { opponent: null, hasArchivePlayer: false };

  const entries = [];
  for (let i = 0; i < total; i += 1) {
    entries.push({ tag: players[i] || '', code: codes[i] || '' });
  }

  const ownIndices = entries
    .map((entry, idx) => (isArchivePlayer(entry.tag, entry.code) ? idx : -1))
    .filter((idx) => idx >= 0);

  if (ownIndices.length === 0) {
    return { opponent: null, hasArchivePlayer: false };
  }

  if (ownIndices.length === 1) {
    const opponent = entries.find((_, idx) => idx !== ownIndices[0]) || null;
    return { opponent, hasArchivePlayer: true };
  }

  const opponent = entries.find((entry) => !isArchivePlayer(entry.tag, entry.code)) || null;
  return { opponent, hasArchivePlayer: true };
}

function formatName(entry) {
  if (!entry) return 'Unknown';
  const tag = String(entry.tag || '').trim();
  if (tag) return tag;
  const code = String(entry.code || '').trim();
  if (code) return code;
  return 'Unknown';
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

  const counts = new Map();
  let skippedManifests = 0;
  let skippedNoArchivePlayer = 0;
  let skippedNoOpponent = 0;

  for (const manifestPath of manifestPaths) {
    let manifest;
    try {
      const raw = await fs.readFile(manifestPath, 'utf8');
      manifest = JSON.parse(raw);
    } catch (err) {
      console.error(`Skipping ${manifestPath}: ${err.message}`);
      skippedManifests += 1;
      continue;
    }

    const games = Array.isArray(manifest.games) ? manifest.games : [];
    for (const game of games) {
      const { opponent, hasArchivePlayer } = getOpponentEntry(game);
      if (!hasArchivePlayer) {
        skippedNoArchivePlayer += 1;
        continue;
      }
      if (!opponent) {
        skippedNoOpponent += 1;
        continue;
      }

      const name = formatName(opponent);
      const key = name.toLowerCase();
      const entry = counts.get(key) || { name, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
  }

  if (counts.size === 0) {
    console.log('No opponent tags found.');
    return;
  }

  const sorted = Array.from(counts.values()).sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name),
  );

  sorted.forEach((entry) => {
    console.log(`${entry.count}\t${entry.name}`);
  });

  if (skippedManifests || skippedNoArchivePlayer || skippedNoOpponent) {
    console.error(
      `Skipped manifests=${skippedManifests}, games without archive player=${skippedNoArchivePlayer}, games without opponent=${skippedNoOpponent}.`,
    );
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
