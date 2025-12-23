import 'dotenv/config';
import { initSchema, resetAllFlags, endPool } from '../db.js';

async function main() {
  await initSchema();
  const changed = await resetAllFlags();
  console.log(`Reset flags for ${changed} replays`);
  await endPool();
}

main().catch((err) => {
  console.error(err);
  void endPool().catch(() => {});
  process.exit(1);
}).then(() => process.exit(0));
