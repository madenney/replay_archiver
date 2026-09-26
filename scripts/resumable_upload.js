#!/usr/bin/env node
// Resumable YouTube upload that survives connection drops.
//
// scripts/reupload_missing.js streams the whole file through
// youtube.videos.insert in one shot. For a 70+ GB archive video that is a
// multi-hour transfer, and a single ECONNRESET throws the entire thing away --
// there is no retry and no resume, so each failure costs hours.
//
// This uses YouTube's resumable upload protocol directly: open a session, PUT
// the file in chunks, and on any network failure ask the server how many bytes
// it actually has and continue from there. An interruption costs one chunk,
// not the whole upload.
//
// Usage:
//   node scripts/resumable_upload.js <videoId-in-uploads.json> [--dry-run]
import 'dotenv/config';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { google } from 'googleapis';
import { buildYouTubeDescription, extractArchiveTitle } from '../youtube_description.js';

const UPLOADS_JSON =
  process.env.UPLOADS_JSON || path.join(process.env.OUTPUT_DIR || '', 'uploads.json');
const FINAL_DIR = process.env.FINAL_DIR || path.join(process.env.OUTPUT_DIR || '', 'final');
const BACKUP_DIR = path.resolve('manifest_backups');

const CHUNK_SIZE = 64 * 1024 * 1024; // must be a multiple of 256 KiB
const MAX_ATTEMPTS_PER_CHUNK = 8;
const RETRY_BASE_MS = 5000;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const targetVideoId = args.find((a) => !a.startsWith('-'));

if (!targetVideoId) {
  console.error('Usage: node scripts/resumable_upload.js <videoId> [--dry-run]');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRetriable(err, status) {
  if (typeof status === 'number') {
    return status === 408 || status === 429 || (status >= 500 && status < 600);
  }
  const s = String(err?.code || err?.message || '');
  return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|socket hang up|network|aborted/i.test(s);
}

function fmtBytes(b) {
  return b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${(b / 1024 ** 2).toFixed(0)} MB`;
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

async function getAccessToken(oauth2Client) {
  const { token } = await oauth2Client.getAccessToken();
  if (!token) throw new Error('Could not obtain access token');
  return token;
}

// Open a resumable session and return its upload URI.
async function startSession(accessToken, { title, description, privacyStatus, madeForKids }) {
  const res = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({
        snippet: { title, description },
        status: { privacyStatus, selfDeclaredMadeForKids: madeForKids },
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`Failed to start upload session: ${res.status} ${await res.text()}`);
  }
  const uri = res.headers.get('location');
  if (!uri) throw new Error('Upload session started but no Location header returned');
  return uri;
}

// Ask the server how many bytes it already has, so we resume instead of restart.
// Returns the next byte offset, or a finished video resource if it completed.
async function queryOffset(sessionUri, accessToken, totalBytes) {
  const res = await fetch(sessionUri, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Range': `bytes */${totalBytes}`,
    },
  });
  if (res.status === 200 || res.status === 201) {
    return { done: true, video: await res.json().catch(() => null) };
  }
  if (res.status === 308) {
    const range = res.headers.get('range');
    if (!range) return { done: false, offset: 0 };
    const end = Number(range.split('-')[1]);
    return { done: false, offset: Number.isFinite(end) ? end + 1 : 0 };
  }
  throw new Error(`Unexpected status querying upload offset: ${res.status}`);
}

function readChunk(filePath, start, end) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    fs.createReadStream(filePath, { start, end })
      .on('data', (c) => chunks.push(c))
      .on('end', () => resolve(Buffer.concat(chunks)))
      .on('error', reject);
  });
}

async function uploadResumable(filePath, sessionUri, oauth2Client) {
  const totalBytes = (await fsPromises.stat(filePath)).size;
  let accessToken = await getAccessToken(oauth2Client);
  let offset = 0;
  const startedAt = Date.now();
  let tokenRefreshedAt = Date.now();

  console.log(`  Total size: ${fmtBytes(totalBytes)}  chunk: ${fmtBytes(CHUNK_SIZE)}`);

  while (offset < totalBytes) {
    // Access tokens last ~1h; a big upload outlives them.
    if (Date.now() - tokenRefreshedAt > 30 * 60 * 1000) {
      accessToken = await getAccessToken(oauth2Client);
      tokenRefreshedAt = Date.now();
    }

    const end = Math.min(offset + CHUNK_SIZE, totalBytes) - 1;
    const body = await readChunk(filePath, offset, end);

    let sent = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_CHUNK && !sent; attempt += 1) {
      try {
        const res = await fetch(sessionUri, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Length': String(body.length),
            'Content-Range': `bytes ${offset}-${end}/${totalBytes}`,
          },
          body,
        });

        if (res.status === 200 || res.status === 201) {
          const video = await res.json().catch(() => null);
          const elapsed = fmtDuration(Date.now() - startedAt);
          console.log(`\n  Upload complete in ${elapsed}`);
          return video;
        }
        if (res.status === 308) {
          const range = res.headers.get('range');
          offset = range ? Number(range.split('-')[1]) + 1 : end + 1;
          sent = true;
          break;
        }
        if (isRetriable(null, res.status)) {
          throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
        }
        throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
      } catch (err) {
        const status = err?.status;
        if (!isRetriable(err, status) || attempt === MAX_ATTEMPTS_PER_CHUNK) throw err;
        const delay = RETRY_BASE_MS * 2 ** (attempt - 1);
        process.stdout.write(
          `\n  chunk at ${fmtBytes(offset)} failed (${err.message}); retrying in ${Math.round(delay / 1000)}s [${attempt}/${MAX_ATTEMPTS_PER_CHUNK}]\n`
        );
        await sleep(delay);
        // Re-sync with the server: it may have kept part of the failed chunk.
        accessToken = await getAccessToken(oauth2Client);
        tokenRefreshedAt = Date.now();
        const q = await queryOffset(sessionUri, accessToken, totalBytes);
        if (q.done) {
          console.log(`\n  Upload completed during recovery`);
          return q.video;
        }
        offset = q.offset;
        sent = true; // chunk boundaries recomputed from the server's offset
      }
    }

    const pct = ((offset / totalBytes) * 100).toFixed(1);
    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = offset / elapsed / 1024 / 1024;
    const eta = rate > 0 ? fmtDuration(((totalBytes - offset) / (rate * 1024 * 1024)) * 1000) : '?';
    process.stdout.write(
      `\r  ${pct}% - ${fmtBytes(offset)}/${fmtBytes(totalBytes)} - ${rate.toFixed(1)} MB/s - ETA: ${eta}   `
    );
  }

  // Fully sent but no terminal response yet: confirm with the server.
  const q = await queryOffset(sessionUri, await getAccessToken(oauth2Client), totalBytes);
  if (q.done) return q.video;
  throw new Error('Upload finished sending but server did not confirm completion');
}

function buildDescriptionFromManifest(manifest) {
  const archiveTitle = manifest.archiveTitle || extractArchiveTitle(manifest.title) || 'Archive';
  const games = Array.isArray(manifest.games) ? manifest.games : [];
  const indices = games.map((g) => g?.index).filter((i) => typeof i === 'number');
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

async function main() {
  const uploads = JSON.parse(await fsPromises.readFile(UPLOADS_JSON, 'utf8'));
  const upload = uploads.find((u) => u.videoId === targetVideoId);
  if (!upload) {
    console.error(`No uploads.json entry with videoId=${targetVideoId}`);
    process.exit(1);
  }

  const videoPath = path.join(FINAL_DIR, path.basename(upload.stitchedPath));
  if (!fs.existsSync(videoPath)) {
    console.error(`Video file not found: ${videoPath}`);
    process.exit(1);
  }

  const manifestPath = path.join(
    FINAL_DIR,
    path.basename(upload.stitchedPath).replace(/\.mkv$/, '.manifest.json')
  );
  const manifest = JSON.parse(await fsPromises.readFile(manifestPath, 'utf8'));
  const description = buildDescriptionFromManifest(manifest);

  console.log(`--- ${upload.title} ---`);
  console.log(`  Old videoId: ${upload.videoId}`);
  console.log(`  File: ${videoPath}`);

  if (dryRun) {
    console.log('  --dry-run: not uploading.');
    return;
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });

  const accessToken = await getAccessToken(oauth2Client);
  const sessionUri = await startSession(accessToken, {
    title: upload.title,
    description,
    privacyStatus: process.env.YOUTUBE_PRIVACY || 'unlisted',
    madeForKids: String(process.env.YOUTUBE_MADE_FOR_KIDS || 'false') === 'true',
  });
  console.log('  Resumable session opened');

  const video = await uploadResumable(videoPath, sessionUri, oauth2Client);
  const newVideoId = video?.id;
  if (!newVideoId) throw new Error('Upload finished but no video id was returned');
  console.log(`  New videoId: ${newVideoId}`);

  upload.videoId = newVideoId;
  upload.uploadedAt = new Date().toISOString();
  await fsPromises.writeFile(UPLOADS_JSON, JSON.stringify(uploads, null, 2) + '\n');

  manifest.videoId = newVideoId;
  await fsPromises.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  try {
    await fsPromises.writeFile(
      path.join(BACKUP_DIR, path.basename(manifestPath)),
      JSON.stringify(manifest, null, 2) + '\n'
    );
  } catch (_) {
    /* backup dir may not exist on every machine */
  }
  console.log('  Updated uploads.json + manifest');
  console.log('Done!');
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
