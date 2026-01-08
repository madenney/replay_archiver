import 'dotenv/config';
import path from 'path';
import { promises as fs } from 'fs';

const INDEX_RE = /^(\d+)/;

function chunkList(items, size) {
  const lines = [];
  for (let i = 0; i < items.length; i += size) {
    lines.push(items.slice(i, i + size).join(', '));
  }
  return lines.join('\n');
}

async function main() {
  const outputDir = process.env.OUTPUT_DIR;
  if (!outputDir || String(outputDir).trim() === '') {
    throw new Error('OUTPUT_DIR is not set.');
  }

  const gamesDir = path.resolve(outputDir, 'games');
  let entries;
  try {
    entries = await fs.readdir(gamesDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log(`Games directory does not exist: ${gamesDir}`);
      return;
    }
    throw err;
  }

  const present = new Set();
  let maxIndex = null;
  let maxWidth = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(INDEX_RE);
    if (!match) continue;
    const digits = match[1];
    const index = Number(digits);
    if (!Number.isFinite(index)) continue;
    present.add(index);
    if (digits.length > maxWidth) maxWidth = digits.length;
    if (maxIndex === null || index > maxIndex) maxIndex = index;
  }

  if (maxIndex === null) {
    console.log(`No indexed files found in ${gamesDir}`);
    return;
  }

  const missing = [];
  for (let i = 0; i <= maxIndex; i += 1) {
    if (!present.has(i)) missing.push(i);
  }

  const width = Math.max(maxWidth, String(maxIndex).length);
  if (missing.length === 0) {
    console.log(`No missing indices in ${gamesDir} (0..${String(maxIndex).padStart(width, '0')}).`);
    return;
  }

  const formattedMissing = missing.map((idx) => String(idx).padStart(width, '0'));
  console.log(
    `Missing indices (${missing.length}) between 0 and ${String(maxIndex).padStart(width, '0')}:`,
  );
  console.log(chunkList(formattedMissing, 20));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
