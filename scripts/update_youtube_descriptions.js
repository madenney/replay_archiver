import 'dotenv/config';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { google } from 'googleapis';
import { buildYouTubeDescription, extractArchiveTitle } from '../youtube_description.js';

const UPLOADS_JSON = process.env.UPLOADS_JSON
  || path.join(process.env.OUTPUT_DIR || '', 'uploads.json');
const FINAL_DIR = process.env.FINAL_DIR
  || path.join(process.env.OUTPUT_DIR || '', 'final');

const YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const YOUTUBE_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const YOUTUBE_REFRESH_TOKEN = process.env.YOUTUBE_REFRESH_TOKEN;

// YouTube API quota: default 10,000 units/day, videos.update costs 50 units each
const DELAY_MS = 1000;

function usage() {
  console.log(`Usage: node scripts/update_youtube_descriptions.js [--start N] [--end N] [--dry-run]

Options:
  --start N    Start at upload index N (0-based, inclusive) [default: 0]
  --end N      End at upload index N (0-based, exclusive) [default: all]
  --dry-run    Print descriptions without calling YouTube API
  --video-id X Only update the upload with this YouTube video ID
`);
}

function parseArgs(argv) {
  const args = { start: 0, end: null, dryRun: false, videoId: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--start') args.start = parseInt(argv[++i], 10);
    else if (argv[i] === '--end') args.end = parseInt(argv[++i], 10);
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--video-id') args.videoId = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') { usage(); process.exit(0); }
  }
  return args;
}

function getManifestPath(upload) {
  const sp = upload.stitchedPath || '';
  const base = path.basename(sp, path.extname(sp));
  return path.join(FINAL_DIR, `${base}.manifest.json`);
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

async function updateVideoDescription(youtube, videoId, description) {
  // First fetch the current snippet so we preserve title/tags/etc
  const current = await youtube.videos.list({
    part: ['snippet'],
    id: [videoId],
  });

  const video = current.data.items?.[0];
  if (!video) {
    throw new Error(`Video ${videoId} not found (maybe private/deleted?)`);
  }

  const snippet = video.snippet;
  snippet.description = description;

  await youtube.videos.update({
    part: ['snippet'],
    requestBody: {
      id: videoId,
      snippet,
    },
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET || !YOUTUBE_REFRESH_TOKEN) {
    console.error('Missing YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, or YOUTUBE_REFRESH_TOKEN in env.');
    process.exit(1);
  }

  const raw = await fsPromises.readFile(UPLOADS_JSON, 'utf8');
  const uploads = JSON.parse(raw);
  console.log(`Loaded ${uploads.length} uploads from ${UPLOADS_JSON}`);

  let selected = uploads;
  if (args.videoId) {
    selected = uploads.filter((u) => u.videoId === args.videoId);
    if (selected.length === 0) {
      console.error(`No upload found with videoId=${args.videoId}`);
      process.exit(1);
    }
  } else {
    const end = args.end ?? uploads.length;
    selected = uploads.slice(args.start, end);
  }

  console.log(`Processing ${selected.length} uploads (${args.dryRun ? 'DRY RUN' : 'LIVE'})...`);

  let youtube = null;
  if (!args.dryRun) {
    const oauth2Client = new google.auth.OAuth2(
      YOUTUBE_CLIENT_ID,
      YOUTUBE_CLIENT_SECRET,
    );
    oauth2Client.setCredentials({ refresh_token: YOUTUBE_REFRESH_TOKEN });
    youtube = google.youtube({ version: 'v3', auth: oauth2Client });
  }

  let updated = 0;
  let failed = 0;

  for (const upload of selected) {
    const { videoId, title } = upload;
    const manifestPath = getManifestPath(upload);

    try {
      const manifestRaw = await fsPromises.readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(manifestRaw);
      const description = buildDescriptionFromManifest(manifest);

      if (args.dryRun) {
        console.log(`\n--- [${videoId}] ${title} ---`);
        console.log(description);
        updated++;
        continue;
      }

      await updateVideoDescription(youtube, videoId, description);
      updated++;
      console.log(`Updated [${videoId}] ${title}`);

      // Rate limit
      if (selected.indexOf(upload) < selected.length - 1) {
        await new Promise((r) => setTimeout(r, DELAY_MS));
      }
    } catch (err) {
      failed++;
      console.error(`Failed [${videoId}] ${title}: ${err.message}`);
    }
  }

  console.log(`\nDone. Updated: ${updated}, Failed: ${failed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
