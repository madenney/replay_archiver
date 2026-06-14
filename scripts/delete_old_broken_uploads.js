import 'dotenv/config';
import { promises as fs } from 'fs';
import path from 'path';
import { google } from 'googleapis';

const OUTPUT_DIR = process.env.OUTPUT_DIR;
if (!OUTPUT_DIR) { console.error('OUTPUT_DIR env var not set'); process.exit(1); }
const FINAL_DIR = process.env.FINAL_DIR || path.join(OUTPUT_DIR, 'final');
const UPLOADS_PATH = process.env.UPLOADS_JSON || path.join(OUTPUT_DIR, 'uploads.json');
const REPLACED_DIR = path.resolve('manifest_backups/replaced');
const RESTITCH_LOG = path.resolve('reports/restitch_log.json');
const EXECUTE = process.argv.includes('--execute');

const oauth2Client = new google.auth.OAuth2(
  process.env.YOUTUBE_CLIENT_ID,
  process.env.YOUTUBE_CLIENT_SECRET,
);
oauth2Client.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });
const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

const log = JSON.parse(await fs.readFile(RESTITCH_LOG, 'utf8'));
const uploads = JSON.parse(await fs.readFile(UPLOADS_PATH, 'utf8'));

console.log(`Processing ${log.length} restitch log entries…\n`);

let deletedYt = 0, removedEntries = 0, archivedManifests = 0;

for (const entry of log) {
  const { oldVideoId, newVideoId, oldStitchedPath } = entry;
  if (!oldVideoId || !newVideoId) {
    console.log(`  SKIP missing ids: ${JSON.stringify(entry)}`);
    continue;
  }

  // Verify new videoId is live on YouTube
  const { data } = await youtube.videos.list({ part: ['id'], id: [newVideoId] });
  const live = data.items && data.items.length > 0;
  if (!live) {
    console.log(`  SKIP ${oldVideoId} — new videoId ${newVideoId} not yet live on YT`);
    continue;
  }

  // Find and prepare to remove the old uploads.json entry
  const oldIdx = uploads.findIndex((u) => u.videoId === oldVideoId);
  if (oldIdx === -1) {
    console.log(`  ${oldVideoId} already removed from uploads.json`);
  }

  if (!EXECUTE) {
    console.log(`  DRY-RUN would delete YT video ${oldVideoId} + remove uploads.json entry + archive old manifest`);
    continue;
  }

  // Delete the old YT video
  try {
    await youtube.videos.delete({ id: oldVideoId });
    console.log(`  Deleted YT video ${oldVideoId}`);
    deletedYt++;
  } catch (err) {
    if (err.code === 404) console.log(`  YT video ${oldVideoId} already gone`);
    else { console.error(`  FAIL delete ${oldVideoId}: ${err.message}`); continue; }
  }

  // Remove old entry from uploads.json (in place, will rewrite at end)
  if (oldIdx >= 0) {
    uploads.splice(oldIdx, 1);
    removedEntries++;
  }

  // Archive the old manifest if it exists (matches old stitchedPath)
  if (oldStitchedPath) {
    const oldManifestBase = path.basename(oldStitchedPath).replace(/\.mkv$/, '.manifest.json');
    const oldManifestPath = path.join(FINAL_DIR, oldManifestBase);
    // Note: the new manifest may overwrite this on disk if same filename was reused.
    // We keep it via copy to manifest_backups/replaced/.
    try {
      await fs.mkdir(REPLACED_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const archivePath = path.join(REPLACED_DIR, `${oldManifestBase}.${oldVideoId}.${stamp}.json`);
      await fs.copyFile(oldManifestPath, archivePath).catch(() => null);
      archivedManifests++;
    } catch (err) {
      console.warn(`  could not archive ${oldManifestPath}: ${err.message}`);
    }
  }
}

if (EXECUTE) {
  await fs.writeFile(UPLOADS_PATH, JSON.stringify(uploads, null, 2) + '\n');
  console.log(`\nuploads.json rewritten (${removedEntries} old entries removed).`);
}

console.log(`\n=== SUMMARY ===`);
console.log(`  YT videos deleted: ${deletedYt}`);
console.log(`  uploads.json entries removed: ${removedEntries}`);
console.log(`  Manifests archived: ${archivedManifests}`);
if (!EXECUTE) console.log('\n(Dry run. Pass --execute to actually delete.)');
