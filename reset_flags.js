import 'dotenv/config';
import { getDb } from './db.js';

async function main() {
  const db = getDb();
    const res = db
      .prepare(
        `UPDATE replays
         SET recorded = 0,
             overlaid = 0,
             stitched = 0,
             uploaded = 0,
             stitch_pending = 0,
             video_duration_seconds = NULL,
             claimed_by = NULL,
             claimed_at = NULL`
      )
      .run();
  console.log(`Reset flags for ${res.changes} replays`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
