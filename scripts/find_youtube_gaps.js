import 'dotenv/config';
import { promises as fs } from 'fs';
import path from 'path';
import { google } from 'googleapis';

const UPLOADS_JSON = process.env.UPLOADS_JSON
  || path.join(process.env.OUTPUT_DIR || '', 'uploads.json');

const BATCH_SIZE = 50;
const DELAY_MS = 500;

async function main() {
  const uploads = JSON.parse(await fs.readFile(UPLOADS_JSON, 'utf8'));
  console.log(`Loaded ${uploads.length} uploads from ${UPLOADS_JSON}\n`);

  const oauth2Client = new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET,
  );
  oauth2Client.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

  const allIds = uploads.map(u => u.videoId).filter(Boolean);
  const foundIds = new Set();
  const videoInfo = new Map();

  for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
    const batch = allIds.slice(i, i + BATCH_SIZE);
    const progress = Math.min(i + BATCH_SIZE, allIds.length);
    process.stderr.write(`  Checking ${progress}/${allIds.length}...\r`);
    const res = await youtube.videos.list({
      part: ['id', 'contentDetails'],
      id: batch,
    });
    for (const item of res.data.items || []) {
      foundIds.add(item.id);
      videoInfo.set(item.id, {
        ytDuration: item.contentDetails?.duration,
      });
    }
    if (i + BATCH_SIZE < allIds.length) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }
  process.stderr.write('\n\n');

  // Find missing (deleted) videos
  const missing = uploads.filter(u => !foundIds.has(u.videoId));

  // Sort by first index so they're in chronological replay order
  missing.sort((a, b) => (a.indices?.[0] || 0) - (b.indices?.[0] || 0));

  if (missing.length === 0) {
    console.log('All videos accounted for on YouTube. No gaps found.');
    return;
  }

  console.log(`=== ${missing.length} DELETED/MISSING VIDEOS ===\n`);

  let totalGames = 0;
  let totalSeconds = 0;

  for (const u of missing) {
    const firstIdx = u.indices?.[0] || '?';
    const lastIdx = u.indices?.[u.indices.length - 1] || '?';
    const gameCount = u.indices?.length || 0;
    totalGames += gameCount;
    totalSeconds += u.totalSeconds || 0;

    console.log(`  ${u.title}`);
    console.log(`    videoId:      ${u.videoId}`);
    console.log(`    indices:      ${firstIdx} - ${lastIdx} (${gameCount} games)`);
    console.log(`    duration:     ${Math.round((u.totalSeconds || 0) / 3600 * 10) / 10} hours`);
    console.log(`    stitchedPath: ${u.stitchedPath}`);
    console.log('');
  }

  console.log(`=== SUMMARY ===`);
  console.log(`  Missing videos:  ${missing.length}`);
  console.log(`  Total games:     ${totalGames}`);
  console.log(`  Total duration:  ${Math.round(totalSeconds / 3600 * 10) / 10} hours`);
  console.log(`  Still on YT:     ${allIds.length - missing.length}`);

  // Check if the .mkv files still exist on disk for re-upload
  console.log(`\n=== MKV FILE CHECK ===\n`);
  const FINAL_DIR = path.join(process.env.OUTPUT_DIR || '', 'final');
  let mkvFound = 0;
  let mkvMissing = 0;
  for (const u of missing) {
    // Try both the recorded stitchedPath and the final dir
    const basename = path.basename(u.stitchedPath || '');
    const localPath = path.join(FINAL_DIR, basename);
    let exists = false;
    try {
      await fs.access(localPath);
      exists = true;
    } catch {
      // Also try the original stitchedPath
      try {
        await fs.access(u.stitchedPath);
        exists = true;
      } catch {}
    }
    if (exists) {
      mkvFound++;
    } else {
      mkvMissing++;
      console.log(`  MISSING MKV: ${basename}`);
    }
  }
  console.log(`\n  MKVs found on disk: ${mkvFound}/${missing.length}`);
  if (mkvMissing > 0) {
    console.log(`  MKVs NOT found:     ${mkvMissing} (will need re-stitching)`);
  } else {
    console.log(`  All MKVs available for re-upload!`);
  }

  // Save the list for use by a re-upload script
  await fs.writeFile(
    path.join(path.dirname(UPLOADS_JSON), 'reupload_needed.json'),
    JSON.stringify(missing, null, 2),
  );
  console.log(`\nSaved missing list to reupload_needed.json`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
