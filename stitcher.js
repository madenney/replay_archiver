import path from 'path';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import lockfile from 'proper-lockfile';
import { google } from 'googleapis';

import { config } from './config.js';
import { appendRunLog, appendUploadsLog, formatDuration, sanitizeFileName, escapeForFfmpegList, fileExists } from './util_log.js';
import { stitchStatePath } from './paths.js';
import { spawnProcess, runChildProcess } from './childProc.js';
import { getReadyForStitch, getBlockers, updateFlags } from './db.js';
import { pad, convertIsoToMmDdYyyyHhMm } from './lib.js';

const {
  gamesDir,
  finalDir,
  bitrateKbps,
  stitchMinTotalMinutes,
  archiveTitle,
  youtubeClientId,
  youtubeClientSecret,
  youtubeRefreshToken,
  youtubePrivacy,
  stitchTimeoutMs,
} = config;

export async function markReplaysField(videoEntries, fieldsToSet) {
  const indices = videoEntries.map((v) => v.index);
  await updateFlags(indices, fieldsToSet);
}

export async function maybeStitchAndUpload(replay, sendStatus, { onlyIndices = null } = {}) {
  if (Number.isNaN(stitchMinTotalMinutes) || stitchMinTotalMinutes <= 0) {
    await appendRunLog(
      `Stitch check skipped (stitchMinTotalMinutes=${stitchMinTotalMinutes})`,
      'stitch-skip'
    );
    return false;
  }

  await ensureStitchStateFile();
  const release = await lockfile.lock(stitchStatePath, { retries: 5 });
  try {
    const ready = await getReadyForStitch({ onlyIndices });

    await appendRunLog(
      `Stitch check: ${ready.length} ready replays`,
      'stitch-ready'
    );

    if (ready.length === 0) {
      return false;
    }

    const readyByIndex = [...ready].sort((a, b) => a.index - b.index);
    const videoEntries = [];
    const thresholdSeconds = stitchMinTotalMinutes * 60;
    const missingFiles = [];
    const invalidFrameCounts = [];
    let maxReadyIndex = null;
    let totalSeconds = 0;

    for (const r of readyByIndex) {
      const videoPath = path.resolve(gamesDir, `${pad(r.index, 6)}.avi`);
      if (!(await fileExists(videoPath))) {
        missingFiles.push({ index: r.index, path: videoPath });
        break;
      }
      const frames = typeof r.game_length_frames === 'number' ? r.game_length_frames : null;
      if (!frames || Number.isNaN(frames) || frames <= 0) {
        invalidFrameCounts.push({ index: r.index, frames });
        break;
      }
      const duration = frames / 60; // Slippi frames are 60fps
      videoEntries.push({
        index: r.index,
        path: videoPath,
        duration,
        date: r.date,
        frames,
      });
      totalSeconds += duration;
      maxReadyIndex = r.index;
      if (totalSeconds >= thresholdSeconds) {
        break;
      }
    }

    if (missingFiles.length > 0 || invalidFrameCounts.length > 0) {
      const missingIdx = missingFiles.map((m) => m.index).join(', ');
      const badFrameIdx = invalidFrameCounts
        .map((m) => m.index)
        .join(', ');
      console.warn(
        `Stitch paused: missing files (${missingFiles.length}) [${missingIdx}] or invalid frame counts (${invalidFrameCounts.length}) [${badFrameIdx}]. Mark skip or regenerate.`,
      );
      await appendRunLog(
        `Stitch paused (missing files ${missingIdx || 'none'}, invalid frame counts ${badFrameIdx || 'none'})`,
        'stitch-missing'
      );
      return false;
    }

    if (!videoEntries.length || totalSeconds < thresholdSeconds) {
      await appendRunLog(
        `Stitch paused: totalSeconds=${totalSeconds}s < threshold=${thresholdSeconds}s`,
        'stitch-under-threshold'
      );
      return false;
    }

    const blockers = await getBlockers(maxReadyIndex);
    if (blockers.length > 0) {
      const blockerIds = blockers.join(', ');
      console.warn(
        `Stitch paused: ${blockers.length} unskipped replays <= ${maxReadyIndex} are not overlaid. Mark skip or process them. Blockers: ${blockerIds}`,
      );
      await appendRunLog(
        `Stitch paused: blockers <= ${maxReadyIndex}: ${blockerIds}`,
        'stitch-blockers'
      );
      return false;
    }

    const { startDate, endDate } = getDateRange(videoEntries);
    const safeStart = startDate.replace(/[\/:]/g, '-');
    const safeEnd = endDate.replace(/[\/:]/g, '-');
    const archiveTitleSafe = archiveTitle || 'Archive';
    const finalTitle = `${archiveTitleSafe}: ${startDate} - ${endDate}`;
    const stitchedFileName = `${sanitizeFileName(archiveTitleSafe)}_${safeStart}_${safeEnd}.avi`;
    const stitchedPath = path.join(finalDir, stitchedFileName);
    const concatListPath = path.join(finalDir, `concat_${Date.now()}.txt`);
    const description = buildYouTubeDescription({
      archiveTitle: archiveTitleSafe,
      startDate,
      endDate,
      videoEntries,
      totalSeconds,
    });

    sendStatus?.('Stitching Videos');
    await stitchVideos(videoEntries, stitchedPath, concatListPath);
    await markReplaysField(videoEntries, {
      stitched: true,
      stitch_pending: 1,
    });

    const manifest = {
      title: finalTitle,
      stitchedPath,
      startDate,
      endDate,
      indices: videoEntries.map((v) => v.index),
      totalSeconds,
      videoId: null,
    };
    const manifestPath = path.join(
      finalDir,
      `${path.basename(stitchedPath, path.extname(stitchedPath))}.manifest.json`
    );

    sendStatus?.('Uploading to YouTube');
    let uploadData;
    try {
      uploadData = await uploadToYouTube({
        filePath: stitchedPath,
        title: finalTitle,
        description,
      });
    } catch (err) {
      console.error(`YouTube upload failed: ${err.message}`);
      await appendRunLog(
        `YouTube upload failed for ${stitchedPath}: ${err.message}`,
        'youtube-upload-error',
        []
      );
      await fsPromises.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
      await appendRunLog(
        `Wrote manifest for ${stitchedPath} -> ${manifestPath}`,
        'manifest',
        [manifestPath]
      );
      return false;
    }

    const videoId = uploadData?.id || null;
    manifest.videoId = videoId;

    await markReplaysField(videoEntries, {
      uploaded: true,
      stitch_pending: 0,
    });
    await appendRunLog(
      `Uploaded to YouTube${videoId ? ` (${videoId})` : ''}: ${stitchedPath}`,
      'youtube-upload',
      [stitchedPath]
    );
    await appendUploadsLog({
      title: finalTitle,
      stitchedPath,
      uploadedAt: new Date().toISOString(),
      videoId,
      indices: videoEntries.map((v) => v.index),
      totalSeconds,
      manual: false,
    });
    await fsPromises.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    await appendRunLog(
      `Wrote manifest for ${stitchedPath} -> ${manifestPath}`,
      'manifest',
      [manifestPath]
    );
    return true;

  } finally {
    await release();
  }
}

async function stitchVideos(videoEntries, stitchedPath, concatListPath) {
  const stitchBitrate = Number.isFinite(bitrateKbps) ? bitrateKbps : 15000;
  const listContent = videoEntries
    .map((v) => `file '${escapeForFfmpegList(v.path)}'`)
    .join('\n');
  await fsPromises.writeFile(concatListPath, listContent);
  const exists = await fileExists(concatListPath);
  if (!exists) {
    throw new Error(`concat list missing at ${concatListPath}`);
  }

  const args = [
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concatListPath,
    '-c:v',
    'copy',
    '-b:v',
    `${stitchBitrate}k`,
    '-af',
    'aresample=async=1:first_pts=0',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-fflags',
    '+genpts',
    stitchedPath,
  ];

  await appendRunLog(
    `ffmpeg stitch (${videoEntries.length} videos, total ~${Math.round(
      videoEntries.reduce((a, v) => a + v.duration, 0) / 60,
    )} min)`,
    'ffmpeg',
    args,
  );
  const child = spawnProcess('ffmpeg', args);
  try {
    await runChildProcess(child, {
      name: 'ffmpeg (stitch)',
      replayIndex: 'stitch',
      timeoutMs: stitchTimeoutMs,
    });
    // only remove the concat file on success to help with debugging failures
    try {
      await fsPromises.unlink(concatListPath);
    } catch (_) {
      // ignore
    }
  } catch (err) {
    // bubble up stitch errors
    throw err;
  }
}

function getDateRange(videoEntries) {
  if (!videoEntries.length) {
    return { startDate: '', endDate: '' };
  }
  const dates = videoEntries
    .map((v) => v.date)
    .filter(Boolean)
    .map((d) => new Date(d).getTime())
    .filter((n) => !Number.isNaN(n));
  const min = Math.min(...dates);
  const max = Math.max(...dates);
  return {
    startDate: convertIsoToMmDdYyyyHhMm(new Date(min).toISOString()),
    endDate: convertIsoToMmDdYyyyHhMm(new Date(max).toISOString()),
  };
}

function buildYouTubeDescription({
  archiveTitle,
  startDate,
  endDate,
  videoEntries,
  totalSeconds,
}) {
  const lines = [
    `${archiveTitle}: ${startDate} - ${endDate}`,
    `Games: ${videoEntries.length}`,
    `Total duration: ${formatDuration(totalSeconds)}`,
    `Range: ${startDate} to ${endDate}`,
    '',
    'Games in this archive (indices):',
    videoEntries.map((v) => v.index).join(', '),
  ];
  return lines.join('\n');
}

async function uploadToYouTube({ filePath, title, description }) {
  const oauth2Client = new google.auth.OAuth2(
    youtubeClientId,
    youtubeClientSecret,
  );
  oauth2Client.setCredentials({
    refresh_token: youtubeRefreshToken,
  });
  const youtube = google.youtube({
    version: 'v3',
    auth: oauth2Client,
  });
  const res = await youtube.videos.insert(
    {
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title,
          description,
        },
        status: {
          privacyStatus: youtubePrivacy,
        },
      },
      media: {
        body: fs.createReadStream(filePath),
      },
    },
    {
      onUploadProgress: () => {
        // optional: could log progress
      },
      onUploadError: (err) => {
        throw err;
      },
    }
  );

  return res?.data;
}

async function ensureStitchStateFile() {
  try {
    await fsPromises.access(stitchStatePath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      await fsPromises.writeFile(
        stitchStatePath,
        JSON.stringify({ queue: [], uploads: [] }, null, 2),
      );
    } else {
      throw err;
    }
  }
}
