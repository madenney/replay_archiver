import 'dotenv/config';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { google } from 'googleapis';
import { buildYouTubeDescription, extractArchiveTitle } from '../youtube_description.js';

const UPLOADS_JSON = process.env.UPLOADS_JSON
  || path.join(process.env.OUTPUT_DIR || '', 'uploads.json');
const FINAL_DIR = process.env.FINAL_DIR
  || path.join(process.env.OUTPUT_DIR || '', 'final');
const BACKUP_DIR = path.resolve('manifest_backups');

const YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const YOUTUBE_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const YOUTUBE_REFRESH_TOKEN = process.env.YOUTUBE_REFRESH_TOKEN;

// The two videos missing from YouTube
const MISSING_VIDEO_IDS = ['DLNHHo2SPuY', 'Ti8Dhbz7s7U'];

function getManifestPath(upload) {
  const sp = upload.stitchedPath || '';
  const base = path.basename(sp, path.extname(sp));
  return path.join(FINAL_DIR, `${base}.manifest.json`);
}

function getLocalVideoPath(upload) {
  const base = path.basename(upload.stitchedPath);
  return path.join(FINAL_DIR, base);
}

function buildDescriptionFromManifest(manifest) {
  const archiveTitle =
    manifest.archiveTitle ||
    extractArchiveTitle(manifest.title) ||
    'Archive';

  const games = Array.isArray(manifest.games) ? manifest.games : [];
  const indices =
    Array.isArray(manifest.indices) && manifest.indices.length
      ? manifest.indices
      : games
          .map((g) => g?.index)
          .filter((idx) => typeof idx === 'number');

  const durationsSeconds = games.map((g) => {
    const d = g?.video_duration_seconds ?? g?.videoDurationSeconds;
    return Number.isFinite(d) ? d : 0;
  });

  return buildYouTubeDescription({
    archiveTitle,
    startDate: manifest.startDate,
    endDate: manifest.endDate,
    indices,
    durationsSeconds,
    totalSeconds: manifest.totalSeconds,
  });
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

async function uploadToYouTube(youtube, { filePath, title, description }) {
  const totalBytes = (await fsPromises.stat(filePath)).size;
  console.log(`  File size: ${formatBytes(totalBytes)}`);
  console.log(`  Uploading to YouTube...`);

  let lastPercent = -1;
  const startTime = Date.now();

  const res = await youtube.videos.insert(
    {
      part: ['snippet', 'status'],
      requestBody: {
        snippet: { title, description },
        status: {
          privacyStatus: process.env.YOUTUBE_PRIVACY || 'unlisted',
          selfDeclaredMadeForKids: false,
        },
      },
      media: {
        body: fs.createReadStream(filePath),
      },
    },
    {
      onUploadProgress: (event) => {
        if (!event || typeof event.bytesRead !== 'number') return;
        const percent = Math.min(100, Math.floor((event.bytesRead / totalBytes) * 100));
        if (percent <= lastPercent) return;
        lastPercent = percent;

        const elapsed = Date.now() - startTime;
        const bytesPerMs = event.bytesRead / elapsed;
        const remaining = (totalBytes - event.bytesRead) / bytesPerMs;
        const eta = Number.isFinite(remaining) ? formatDuration(remaining) : '---';
        const speed = `${(bytesPerMs * 1000 / 1024 / 1024).toFixed(1)} MB/s`;

        process.stdout.write(
          `\r  Uploading to YouTube (${percent}%) - ${formatBytes(event.bytesRead)}/${formatBytes(totalBytes)} - ${speed} - ETA: ${eta}   `
        );
      },
    }
  );

  const elapsed = formatDuration(Date.now() - startTime);
  console.log(`\n  Upload complete in ${elapsed}`);
  return res?.data;
}

async function main() {
  if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET || !YOUTUBE_REFRESH_TOKEN) {
    console.error('Missing YouTube credentials in env.');
    process.exit(1);
  }

  const raw = await fsPromises.readFile(UPLOADS_JSON, 'utf8');
  const uploads = JSON.parse(raw);

  const oauth2Client = new google.auth.OAuth2(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: YOUTUBE_REFRESH_TOKEN });
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

  const toReupload = uploads.filter((u) => MISSING_VIDEO_IDS.includes(u.videoId));
  console.log(`Found ${toReupload.length} uploads to re-upload.\n`);

  for (const upload of toReupload) {
    const oldVideoId = upload.videoId;
    console.log(`--- ${upload.title} ---`);
    console.log(`  Old videoId: ${oldVideoId}`);

    // Find local video file
    const videoPath = getLocalVideoPath(upload);
    if (!fs.existsSync(videoPath)) {
      console.error(`  SKIP: Video file not found at ${videoPath}`);
      continue;
    }
    console.log(`  Video file: ${videoPath}`);

    // Load manifest and build description
    const manifestPath = getManifestPath(upload);
    if (!fs.existsSync(manifestPath)) {
      console.error(`  SKIP: Manifest not found at ${manifestPath}`);
      continue;
    }
    const manifest = JSON.parse(await fsPromises.readFile(manifestPath, 'utf8'));
    const description = buildDescriptionFromManifest(manifest);

    // Upload to YouTube
    const result = await uploadToYouTube(youtube, {
      filePath: videoPath,
      title: upload.title,
      description,
    });

    const newVideoId = result.id;
    console.log(`  New videoId: ${newVideoId}`);

    // Update uploads.json
    upload.videoId = newVideoId;
    upload.uploadedAt = new Date().toISOString();
    upload.stitchedPath = videoPath; // fix the old path while we're at it

    // Update manifest
    manifest.videoId = newVideoId;
    await fsPromises.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`  Updated manifest: ${path.basename(manifestPath)}`);

    // Update backup manifest
    const backupPath = path.join(BACKUP_DIR, path.basename(manifestPath));
    await fsPromises.writeFile(backupPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`  Updated backup:   ${path.basename(manifestPath)}`);

    console.log('');
  }

  // Write updated uploads.json
  await fsPromises.writeFile(UPLOADS_JSON, JSON.stringify(uploads, null, 2) + '\n');
  console.log(`Updated ${UPLOADS_JSON}`);

  console.log('\nDone!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
