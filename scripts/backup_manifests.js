import 'dotenv/config';
import { promises as fsPromises } from 'fs';
import path from 'path';

const FINAL_DIR = path.join(process.env.OUTPUT_DIR || '', 'final');
const BACKUP_DIR = path.resolve('manifest_backups');

async function main() {
  const entries = await fsPromises.readdir(FINAL_DIR, { withFileTypes: true });
  const manifests = entries
    .filter((e) => e.isFile() && e.name.endsWith('.manifest.json'))
    .map((e) => e.name)
    .sort();

  if (manifests.length === 0) {
    console.log('No manifests found.');
    return;
  }

  await fsPromises.mkdir(BACKUP_DIR, { recursive: true });

  let copied = 0;
  for (const name of manifests) {
    const src = path.join(FINAL_DIR, name);
    const dest = path.join(BACKUP_DIR, name);
    await fsPromises.copyFile(src, dest);
    copied++;
  }

  console.log(`Backed up ${copied} manifests to ${BACKUP_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
