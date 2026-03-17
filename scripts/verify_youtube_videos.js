import 'dotenv/config';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { google } from 'googleapis';

const UPLOADS_JSON = process.env.UPLOADS_JSON
  || path.join(process.env.OUTPUT_DIR || '', 'uploads.json');
const FINAL_DIR = path.join(process.env.OUTPUT_DIR || '', 'final');

const YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const YOUTUBE_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const YOUTUBE_REFRESH_TOKEN = process.env.YOUTUBE_REFRESH_TOKEN;

const BATCH_SIZE = 50;
const DELAY_MS = 500;

// ─── helpers ────────────────────────────────────────────────────────

function header(text) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${text}`);
  console.log('═'.repeat(60));
}

function ok(msg) { console.log(`  OK   ${msg}`); }
function warn(msg) { console.log(`  WARN ${msg}`); }
function fail(msg) { console.log(`  FAIL ${msg}`); }

// ─── data loading ───────────────────────────────────────────────────

async function loadUploads() {
  const raw = await fsPromises.readFile(UPLOADS_JSON, 'utf8');
  return JSON.parse(raw);
}

async function loadManifests() {
  const files = (await fsPromises.readdir(FINAL_DIR))
    .filter((f) => f.endsWith('.manifest.json'))
    .sort();
  const manifests = [];
  for (const f of files) {
    const data = JSON.parse(await fsPromises.readFile(path.join(FINAL_DIR, f), 'utf8'));
    data._filename = f;
    manifests.push(data);
  }
  return manifests;
}

async function loadDbReplays() {
  const pool = new Pool();
  try {
    const { rows } = await pool.query(
      `SELECT idx, skip, recorded, overlaid, stitched, uploaded FROM replays ORDER BY idx`
    );
    return rows;
  } finally {
    await pool.end();
  }
}

// ─── checks ─────────────────────────────────────────────────────────

function checkUploadsVsManifests(uploads, manifests) {
  header('Uploads vs Manifests');

  const uploadsByTitle = new Map(uploads.map((u) => [u.title, u]));
  const manifestsByTitle = new Map(manifests.map((m) => [m.title, m]));

  const uploadsWithoutManifest = uploads.filter((u) => !manifestsByTitle.has(u.title));
  const manifestsWithoutUpload = manifests.filter((m) => !uploadsByTitle.has(m.title));

  console.log(`  Uploads: ${uploads.length}  |  Manifests: ${manifests.length}`);

  if (uploadsWithoutManifest.length === 0) {
    ok('Every upload has a matching manifest.');
  } else {
    warn(`${uploadsWithoutManifest.length} upload(s) with no manifest:`);
    for (const u of uploadsWithoutManifest) {
      console.log(`         ${u.title}  [${u.videoId}]`);
    }
  }

  if (manifestsWithoutUpload.length === 0) {
    ok('Every manifest has a matching upload.');
  } else {
    warn(`${manifestsWithoutUpload.length} manifest(s) with no upload:`);
    for (const m of manifestsWithoutUpload) {
      console.log(`         ${m._filename}  "${m.title}"`);
    }
  }
}

function checkIndexCoverage(uploads, dbReplays) {
  header('Index Coverage (uploads vs database)');

  // Indices that appear in uploads
  const uploadedIndices = new Set();
  for (const u of uploads) {
    for (const i of u.indices) uploadedIndices.add(i);
  }
  const maxUploaded = Math.max(...uploadedIndices);

  // DB replays within the uploaded range
  const inRange = dbReplays.filter((r) => r.idx <= maxUploaded);
  const skippedInRange = inRange.filter((r) => r.skip === 1);
  const notSkippedInRange = inRange.filter((r) => r.skip === 0);

  console.log(`  Uploaded index range: 1 .. ${maxUploaded}`);
  console.log(`  Unique indices in uploads: ${uploadedIndices.size}`);
  console.log(`  DB replays in range: ${inRange.length}`);
  console.log(`  DB skipped in range: ${skippedInRange.length}`);

  // Indices in range that are not uploaded and not skipped
  const missingFromUploads = notSkippedInRange.filter((r) => !uploadedIndices.has(r.idx));
  // Skipped indices that somehow ended up in uploads anyway
  const skippedButUploaded = skippedInRange.filter((r) => uploadedIndices.has(r.idx));
  // Indices in uploads that don't exist in DB at all
  const dbIdxSet = new Set(dbReplays.map((r) => r.idx));
  const notInDb = [...uploadedIndices].filter((i) => !dbIdxSet.has(i));

  if (missingFromUploads.length === 0) {
    ok('All non-skipped replays in range are accounted for in uploads.');
  } else {
    fail(`${missingFromUploads.length} non-skipped replay(s) NOT in any upload:`);
    for (const r of missingFromUploads.slice(0, 20)) {
      console.log(`         idx=${r.idx}  recorded=${r.recorded} overlaid=${r.overlaid} stitched=${r.stitched}`);
    }
    if (missingFromUploads.length > 20) {
      console.log(`         ... and ${missingFromUploads.length - 20} more`);
    }
  }

  if (skippedButUploaded.length === 0) {
    ok('No skipped replays appear in uploads (as expected).');
  } else {
    warn(`${skippedButUploaded.length} skipped replay(s) found in uploads (unexpected):`);
    for (const r of skippedButUploaded) {
      console.log(`         idx=${r.idx}`);
    }
  }

  if (notInDb.length === 0) {
    ok('All uploaded indices exist in the database.');
  } else {
    warn(`${notInDb.length} uploaded index(es) not found in DB:`);
    for (const i of notInDb.slice(0, 20)) {
      console.log(`         idx=${i}`);
    }
  }

  // Verify the gaps line up with skipped replays
  const gaps = [];
  for (let i = 1; i <= maxUploaded; i++) {
    if (!uploadedIndices.has(i)) gaps.push(i);
  }
  const skippedIdxSet = new Set(skippedInRange.map((r) => r.idx));
  const gapSkipped = gaps.filter((i) => skippedIdxSet.has(i));
  const gapNotSkipped = gaps.filter((i) => !skippedIdxSet.has(i));

  console.log(`\n  Gaps in index range: ${gaps.length}`);
  console.log(`    Explained by skip=1: ${gapSkipped.length}`);

  if (gapNotSkipped.length === 0) {
    ok('All gaps accounted for by skipped replays.');
  } else {
    fail(`${gapNotSkipped.length} gap(s) NOT explained by skip=1:`);
    for (const i of gapNotSkipped) {
      const dbRow = dbReplays.find((r) => r.idx === i);
      if (dbRow) {
        console.log(`         idx=${i}  skip=${dbRow.skip} recorded=${dbRow.recorded} overlaid=${dbRow.overlaid}`);
      } else {
        console.log(`         idx=${i}  (not in DB)`);
      }
    }
  }
}

function checkPipelineStatus(dbReplays, uploads) {
  header('Pipeline Status (full database)');

  const uploadedIndices = new Set();
  for (const u of uploads) {
    for (const i of u.indices) uploadedIndices.add(i);
  }
  const maxUploaded = Math.max(...uploadedIndices);

  const total = dbReplays.length;
  const skipped = dbReplays.filter((r) => r.skip === 1).length;
  const notSkipped = total - skipped;
  const recorded = dbReplays.filter((r) => r.recorded === 1).length;
  const overlaid = dbReplays.filter((r) => r.overlaid === 1).length;
  const stitched = dbReplays.filter((r) => r.stitched === 1).length;

  // Remaining: not skipped, beyond uploaded range, not yet fully processed
  const remaining = dbReplays.filter((r) => r.skip === 0 && r.idx > maxUploaded);
  const remainingNotRecorded = remaining.filter((r) => r.recorded === 0);

  console.log(`  Total replays in DB:   ${total}`);
  console.log(`  Skipped:               ${skipped}`);
  console.log(`  Not skipped:           ${notSkipped}`);
  console.log(`  Recorded:              ${recorded}`);
  console.log(`  Overlaid:              ${overlaid}`);
  console.log(`  Stitched:              ${stitched}`);
  console.log(`  Uploaded (in range):   ${uploadedIndices.size}`);
  console.log(`\n  Beyond uploaded range (idx > ${maxUploaded}):`);
  console.log(`    Total remaining:     ${remaining.length}`);
  console.log(`    Not yet recorded:    ${remainingNotRecorded.length}`);
}

function parseYouTubeDuration(iso8601) {
  if (!iso8601) return 0;
  const match = iso8601.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return (parseInt(match[1] || 0) * 3600) + (parseInt(match[2] || 0) * 60) + parseInt(match[3] || 0);
}

async function checkYouTube(uploads) {
  header('YouTube Verification');

  if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET || !YOUTUBE_REFRESH_TOKEN) {
    warn('Missing YouTube credentials - skipping YouTube check.');
    return { missing: [], failed: [], processing: [], suspicious: [], checked: false };
  }

  const oauth2Client = new google.auth.OAuth2(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: YOUTUBE_REFRESH_TOKEN });
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

  const allIds = uploads.map((u) => u.videoId).filter(Boolean);
  const foundIds = new Set();
  const videoDetails = new Map();

  for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
    const batch = allIds.slice(i, i + BATCH_SIZE);
    const progress = Math.min(i + BATCH_SIZE, allIds.length);
    process.stdout.write(`  Checking ${progress}/${allIds.length}...\r`);
    const res = await youtube.videos.list({
      part: ['id', 'status', 'processingDetails', 'contentDetails'],
      id: batch,
    });
    for (const item of res.data.items || []) {
      foundIds.add(item.id);
      videoDetails.set(item.id, {
        uploadStatus: item.status?.uploadStatus,
        failureReason: item.status?.failureReason,
        rejectionReason: item.status?.rejectionReason,
        privacyStatus: item.status?.privacyStatus,
        processingStatus: item.processingDetails?.processingStatus,
        processingFailureReason: item.processingDetails?.processingFailureReason,
        processingProgress: item.processingDetails?.processingProgress,
        ytDuration: item.contentDetails?.duration,
        ytDurationSeconds: parseYouTubeDuration(item.contentDetails?.duration),
        definition: item.contentDetails?.definition,
      });
    }
    if (i + BATCH_SIZE < allIds.length) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }
  console.log('');

  const missing = uploads.filter((u) => !foundIds.has(u.videoId));
  const failed = [];
  const processing = [];
  const suspicious = [];

  for (const u of uploads) {
    const d = videoDetails.get(u.videoId);
    if (!d) continue;

    // Failed or rejected upload
    if (d.uploadStatus === 'failed' || d.uploadStatus === 'rejected') {
      failed.push({ ...u, _details: d });
      continue;
    }

    // Still processing
    if (d.uploadStatus !== 'processed' || (d.processingStatus && d.processingStatus !== 'succeeded' && d.processingStatus !== 'terminated')) {
      processing.push({ ...u, _details: d });
      continue;
    }

    // Processing failed even though upload "succeeded"
    if (d.processingStatus === 'terminated' || d.processingFailureReason) {
      failed.push({ ...u, _details: d });
      continue;
    }

    // Duration mismatch check — flag if YouTube duration differs by more than 2%
    const expectedSeconds = u.totalSeconds;
    const ytSeconds = d.ytDurationSeconds;
    if (expectedSeconds && ytSeconds) {
      const ratio = ytSeconds / expectedSeconds;
      if (ratio < 0.98 || ratio > 1.02) {
        suspicious.push({ ...u, _details: d, expectedSeconds, ytSeconds, ratio });
        continue;
      }
    }

    // Zero or very short duration on YouTube
    if (ytSeconds !== undefined && ytSeconds < 60 && expectedSeconds > 60) {
      suspicious.push({ ...u, _details: d, expectedSeconds, ytSeconds, ratio: ytSeconds / (expectedSeconds || 1) });
      continue;
    }

    // No duration reported at all
    if (!ytSeconds && expectedSeconds > 0) {
      suspicious.push({ ...u, _details: d, expectedSeconds, ytSeconds: 0, ratio: 0, issue: 'YouTube reports no duration' });
      continue;
    }

    // SD when we expect HD
    if (d.definition === 'sd' && expectedSeconds > 300) {
      suspicious.push({ ...u, _details: d, expectedSeconds, ytSeconds, issue: 'SD quality only' });
    }
  }

  // Report missing
  if (missing.length === 0) {
    ok(`All ${allIds.length} videos exist on YouTube.`);
  } else {
    fail(`${missing.length} video(s) NOT found on YouTube:`);
    for (const u of missing) {
      console.log(`         [${u.videoId}] ${u.title}`);
    }
  }

  // Report failed/rejected
  if (failed.length === 0) {
    ok('No videos have failed or been rejected.');
  } else {
    fail(`${failed.length} video(s) FAILED or REJECTED:`);
    for (const u of failed) {
      const d = u._details;
      const reason = d.processingFailureReason || d.failureReason || d.rejectionReason || 'unknown';
      console.log(`         [${u.videoId}] ${u.title}`);
      console.log(`           upload: ${d.uploadStatus}, processing: ${d.processingStatus || 'n/a'}, reason: ${reason}`);
    }
  }

  // Report still processing
  if (processing.length === 0) {
    ok('All found videos have finished processing.');
  } else {
    warn(`${processing.length} video(s) still processing or in unknown state:`);
    for (const u of processing) {
      const d = u._details;
      console.log(`         [${u.videoId}] ${u.title}`);
      console.log(`           upload: ${d.uploadStatus}, processing: ${d.processingStatus || 'n/a'}`);
    }
  }

  // Report suspicious (duration mismatch, SD-only, etc.)
  if (suspicious.length === 0) {
    ok('No duration mismatches or quality issues detected.');
  } else {
    warn(`${suspicious.length} video(s) with potential issues:`);
    for (const u of suspicious) {
      const d = u._details;
      const issue = u.issue || `duration: expected ${Math.round(u.expectedSeconds)}s, YouTube has ${u.ytSeconds}s (${Math.round((u.ratio || 0) * 100)}%)`;
      console.log(`         [${u.videoId}] ${u.title}`);
      console.log(`           ${issue}, quality: ${d.definition || 'n/a'}`);
    }
  }

  // Summary counts
  const healthy = allIds.length - missing.length - failed.length - processing.length - suspicious.length;
  console.log(`\n  Status breakdown:`);
  console.log(`    Healthy:      ${healthy}`);
  console.log(`    Suspicious:   ${suspicious.length}`);
  console.log(`    Failed:       ${failed.length}`);
  console.log(`    Processing:   ${processing.length}`);
  console.log(`    Missing:      ${missing.length}`);
  console.log(`  API quota used: ~${Math.ceil(allIds.length / BATCH_SIZE) * 3} units (id+status+contentDetails+processingDetails)`);

  return { missing, failed, processing, suspicious, checked: true };
}

function checkManifestVideoIds(manifests, uploads) {
  header('Manifest videoId Consistency');

  const uploadsById = new Map(uploads.map((u) => [u.videoId, u]));
  const manifestsMissingId = manifests.filter((m) => !m.videoId);
  const mismatch = [];

  for (const m of manifests) {
    if (m.videoId) {
      const upload = uploadsById.get(m.videoId);
      if (!upload) {
        mismatch.push({ manifest: m._filename, videoId: m.videoId, issue: 'videoId not in uploads.json' });
      }
    }
  }

  if (manifestsMissingId.length === 0) {
    ok('All manifests have a videoId.');
  } else {
    warn(`${manifestsMissingId.length} manifest(s) missing videoId:`);
    for (const m of manifestsMissingId) {
      console.log(`         ${m._filename}`);
    }
  }

  if (mismatch.length === 0) {
    ok('All manifest videoIds match an upload entry.');
  } else {
    warn(`${mismatch.length} manifest videoId mismatch(es):`);
    for (const m of mismatch) {
      console.log(`         ${m.manifest}: ${m.videoId} - ${m.issue}`);
    }
  }
}

// ─── summary ────────────────────────────────────────────────────────

function printSummary(problems) {
  header('SUMMARY');
  if (problems.length === 0) {
    console.log('  Everything looks good. Safe to delete local video files.');
  } else {
    console.log(`  ${problems.length} issue(s) found:\n`);
    for (const p of problems) {
      console.log(`  - ${p}`);
    }
    console.log('\n  Resolve the above before deleting local files.');
  }
  console.log('');
}

// ─── main ───────────────────────────────────────────────────────────

async function main() {
  console.log('Replay Archiver - Comprehensive Verification');
  console.log(`Date: ${new Date().toISOString()}`);

  const problems = [];

  // Load data
  const uploads = await loadUploads();
  console.log(`Loaded ${uploads.length} uploads from ${UPLOADS_JSON}`);

  const manifests = await loadManifests();
  console.log(`Loaded ${manifests.length} manifests from ${FINAL_DIR}`);

  let dbReplays;
  try {
    dbReplays = await loadDbReplays();
    console.log(`Loaded ${dbReplays.length} replays from database`);
  } catch (err) {
    console.log(`Could not connect to database: ${err.message}`);
    dbReplays = null;
  }

  // 1. Uploads vs Manifests
  checkUploadsVsManifests(uploads, manifests);
  const uploadsWithoutManifest = uploads.filter(
    (u) => !manifests.some((m) => m.title === u.title)
  );
  if (uploadsWithoutManifest.length > 0) {
    problems.push(`${uploadsWithoutManifest.length} upload(s) with no manifest`);
  }

  // 2. Manifest videoId consistency
  checkManifestVideoIds(manifests, uploads);
  const badManifests = manifests.filter((m) => !m.videoId);
  if (badManifests.length > 0) {
    problems.push(`${badManifests.length} manifest(s) missing videoId`);
  }

  // 3. Index coverage (requires DB)
  if (dbReplays) {
    checkIndexCoverage(uploads, dbReplays);

    const uploadedIndices = new Set();
    for (const u of uploads) for (const i of u.indices) uploadedIndices.add(i);
    const maxUploaded = Math.max(...uploadedIndices);

    const notSkippedMissing = dbReplays.filter(
      (r) => r.idx <= maxUploaded && r.skip === 0 && !uploadedIndices.has(r.idx)
    );
    if (notSkippedMissing.length > 0) {
      problems.push(`${notSkippedMissing.length} non-skipped replay(s) missing from uploads`);
    }

    // 4. Pipeline status
    checkPipelineStatus(dbReplays, uploads);
  } else {
    console.log('\n  (Skipping database checks - DB not available)');
  }

  // 5. YouTube verification
  const ytResult = await checkYouTube(uploads);
  if (ytResult.checked && ytResult.missing.length > 0) {
    problems.push(`${ytResult.missing.length} video(s) missing from YouTube`);
  }
  if (ytResult.checked && ytResult.failed.length > 0) {
    problems.push(`${ytResult.failed.length} video(s) FAILED processing on YouTube — DO NOT delete source files`);
  }
  if (ytResult.checked && ytResult.processing.length > 0) {
    problems.push(`${ytResult.processing.length} video(s) still processing on YouTube — wait before deleting`);
  }
  if (ytResult.checked && ytResult.suspicious?.length > 0) {
    problems.push(`${ytResult.suspicious.length} video(s) with duration/quality issues — investigate before deleting`);
  }

  // Summary
  printSummary(problems);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
