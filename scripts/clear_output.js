import 'dotenv/config';
import path from 'path';
import { promises as fsPromises } from 'fs';
import { config } from '../config.js';

async function clearOutputDir() {
  const outputDir = config.outputDir;
  if (!outputDir || String(outputDir).trim() === '') {
    throw new Error('OUTPUT_DIR is not set.');
  }

  const resolved = path.resolve(outputDir);
  const root = path.parse(resolved).root;
  if (resolved === root) {
    throw new Error(`Refusing to clear root directory: ${resolved}`);
  }

  let entries;
  try {
    entries = await fsPromises.readdir(resolved, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log(`Output directory does not exist: ${resolved}`);
      return;
    }
    throw err;
  }

  if (entries.length === 0) {
    console.log(`Output directory is already empty: ${resolved}`);
    return;
  }

  await Promise.all(
    entries.map((entry) =>
      fsPromises.rm(path.join(resolved, entry.name), { recursive: true, force: true }),
    ),
  );

  console.log(
    `Cleared ${entries.length} item${entries.length === 1 ? '' : 's'} from ${resolved}`,
  );
}

async function main() {
  await clearOutputDir();
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .then(() => process.exit(0));
