import { promises as fs } from 'fs';
import path from 'path';

async function main() {
  const [source, dest, countArg] = process.argv.slice(2);
  if (!source || !dest) {
    console.error('Usage: node copy_random_games.js <source_dir> <dest_dir> [count=100]');
    process.exit(1);
  }

  const count = Number.isNaN(Number(countArg)) ? 100 : Number(countArg);
  const sourceDir = path.resolve(source);
  const destDir = path.resolve(dest);

  const allMatches = await collectGameFiles(sourceDir);
  if (allMatches.length === 0) {
    console.error('No files found starting with "Game_2020"');
    return;
  }

  const selected = sampleRandom(allMatches, Math.min(count, allMatches.length));
  await fs.mkdir(destDir, { recursive: true });

  for (const filePath of selected) {
    const filename = path.basename(filePath);
    const destPath = path.join(destDir, filename);
    await fs.copyFile(filePath, destPath);
    console.log(`Copied: ${filePath} -> ${destPath}`);
  }

  console.log(`Done. Copied ${selected.length} files to ${destDir}`);
}

async function collectGameFiles(dir) {
  const results = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await collectGameFiles(fullPath);
      results.push(...sub);
    } else if (entry.isFile() && entry.name.startsWith('Game_2024')) {
      results.push(fullPath);
    }
  }
  return results;
}

function sampleRandom(arr, n) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
