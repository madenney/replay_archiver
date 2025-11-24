import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import os from 'os';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import lockfile from 'proper-lockfile';

import { asyncForEach, pad, convertIsoToMmDdYyyyHhMm } from './lib.js';
import {
  getStats,
  claimNextReplay,
  updateFlags,
  getReadyForStitch,
  getBlockers,
  initSchema,
} from './db.js';
import { config } from './config.js';
import { appendRunLog, appendUploadsLog, formatDuration, sanitizeFileName, escapeForFfmpegList, fileExists, readJsonFileSafe } from './util_log.js';
import { stitchStatePath, uploadsLogPath } from './paths.js';
import { runChildProcess, killDolphinOnEndFrame, spawnProcess } from './childProc.js';
import {
  configureDolphin,
  generateDolphinConfig,
  runDolphin,
  mergeVideo,
  addOverlay,
  deleteFiles,
  ensureVideoDurationStored,
  buildOverlayText,
} from './media.js';
const dbReady = initSchema();

const {
    gamesDir,
    finalDir,
    ssbmIsoPath,
    dolphinPath,
    quality,
    bitrateKbps,
    numWorkers,
    dolphinTimeoutMs,
    ffmpegTimeoutMs,
    overlayTimeoutMs,
    stitchMinTotalMinutes,
    archiveTitle,
    youtubeClientId,
    youtubeClientSecret,
    youtubeRefreshToken,
    youtubePrivacy,
    stitchTimeoutMs,
    claimTtlMs,
} = config;

async function printRunStats() {
    const stats = await getStats();
    const {
        total,
        uploaded,
        stitched,
        overlaid,
        recorded,
        skipped,
        pending,
        claimed,
    } = stats;
    console.log('=== Replay Status ===');
    console.log(`Total: ${total}`);
    console.log(`Uploaded: ${uploaded}`);
    console.log(`Stitched (not yet uploaded): ${Math.max(0, stitched - uploaded)}`);
    console.log(`Overlaid (not yet stitched/uploaded): ${Math.max(0, overlaid - stitched)}`);
    console.log(`Recorded (not yet overlaid/stitched/uploaded): ${Math.max(0, recorded - overlaid)}`);
    console.log(`Skipped: ${skipped}`);
    console.log(`Claimed (in-progress): ${claimed}`);
    console.log(`Pending (not uploaded): ${pending}`);
    console.log(`Progress: ${uploaded}/${total} uploaded`);
    console.log('=====================');
}

// Define __filename and __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Main function to process replays with a worker pool
export async function record(replays) {
    console.log('');
    await dbReady;
    await fsPromises.mkdir(gamesDir, { recursive: true });
    await fsPromises.mkdir(finalDir, { recursive: true });
    await printRunStats();
    // Configure Dolphin settings once before processing replays
    await configureDolphin();

    // Process replays using a worker pool
    await processReplaysWithWorkers(numWorkers);
}

// Worker pool function to process replays
async function processReplaysWithWorkers(numWorkers) {
    const stats = await getStats();
    const totalReplays = stats.total;
    let completed = stats.uploaded;
    const pendingCount = stats.pending;
    const alreadyUploaded = stats.uploaded;

    console.log(
        `Starting to process ${pendingCount} pending of ${totalReplays} total replays (${alreadyUploaded} already uploaded) with ${numWorkers} workers...`,
    );

    // Worker pool array and status tracking
    const workers = [];
    const workerPromises = [];
    const workerStatus = new Map(); // Map to track worker status and start time
    const workerTerminationFlags = new Map();
    let statusInterval;

    // Helper function to format elapsed time as mm:ss
    function formatElapsedTime(startTime) {
        const elapsedMs = Date.now() - startTime;
        const seconds = Math.floor(elapsedMs / 1000);
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
    }

    // Function to display worker statuses with timers
    function displayWorkerStatuses() {
        console.clear();
        console.log(`Processing ${totalReplays} replays with ${numWorkers} workers...`);
        console.log(`Completed: ${completed}/${totalReplays}`);
        console.log('\nWorker Statuses:');
        workerStatus.forEach((statusObj, workerId) => {
            const elapsedTime = formatElapsedTime(statusObj.startTime);
            console.log(`Worker ${workerId}: ${statusObj.message} [${elapsedTime}]`);
        });
        console.log('');
    }

    // Function to create a new worker
    function createWorker(workerId) {
        const worker = new Worker(__filename, { workerData: { workerId } });
        workerStatus.set(workerId, { message: 'Idle', startTime: Date.now() });
        workerTerminationFlags.set(workerId, { value: false });

        const workerPromise = new Promise((resolve, reject) => {
            worker.on('message', (msg) => {
                if (msg.status === 'update') {
                    // Update worker status and reset timer
                    workerStatus.set(workerId, { message: msg.message, startTime: Date.now() });
                    displayWorkerStatuses();
                } else if (msg.status === 'done') {
                    workerStatus.set(workerId, { message: 'Idle - requesting next', startTime: Date.now() });
                    completed++;
                    console.log(`Completed ${completed}/${totalReplays} replays`);
                    void fetchAndSendNext(workerId, worker, workerStatus, workerTerminationFlags, totalReplays, () => {
                        displayWorkerStatuses();
                    });
                } else if (msg.status === 'error') {
                    console.error(`Worker ${workerId} error: ${msg.error}`);
                    workerStatus.set(workerId, { message: 'Idle - retry after error', startTime: Date.now() });
                    completed++;
                    console.log(`Finished with error ${completed}/${totalReplays} replays`);
                    void fetchAndSendNext(workerId, worker, workerStatus, workerTerminationFlags, totalReplays, () => {
                        displayWorkerStatuses();
                    });
                }
            });
            worker.on('error', reject);
            worker.on('exit', (code) => {
                const terminated = workerTerminationFlags.get(workerId)?.value;
                if (code !== 0 && !terminated) {
                    reject(new Error(`Worker ${workerId} stopped with exit code ${code}`));
                } else {
                    workerStatus.delete(workerId);
                    resolve();
                }
            });
        });

        workers.push(worker);
        workerPromises.push(workerPromise);
        return worker;
    }

    // Start the worker pool
    const workersToStart = Math.min(numWorkers, pendingCount);
    if (workersToStart === 0) {
        console.log('No pending replays to process.');
        return;
    }
    for (let i = 0; i < workersToStart; i++) {
        const workerId = i + 1; // Assign a unique ID to each worker
        const worker = createWorker(workerId);
        void fetchAndSendNext(workerId, worker, workerStatus, workerTerminationFlags, totalReplays, () => {
            displayWorkerStatuses();
        });
    }

    // Keep status display ticking
    statusInterval = setInterval(displayWorkerStatuses, 1000);

    // Wait for all workers to complete
    await Promise.all(workerPromises);
    if (statusInterval) {
        clearInterval(statusInterval);
    }
    console.clear();
    console.log('All replays processed.');
}

// Worker thread logic
if (!isMainThread) {
    const { workerId } = workerData;

    function validateReplay(replay) {
        if (!replay) {
            throw new Error(`Worker ${workerId}: Received empty replay payload`);
        }
        if (typeof replay.index !== 'number') {
            throw new Error(`Worker ${workerId}: Missing or invalid replay.index`);
        }
        if (typeof replay.file_path !== 'string' || replay.file_path.length === 0) {
            throw new Error(`Worker ${workerId}: Missing replay.file_path for index ${replay.index}`);
        }
        if (typeof replay.game_length_frames !== 'number') {
            throw new Error(`Worker ${workerId}: Missing or invalid game_length_frames for index ${replay.index}`);
        }
        if (!replay.date) {
            throw new Error(`Worker ${workerId}: Missing date for index ${replay.index}`);
        }
    }

    // Helper function to send status updates to the main thread
    function sendStatus(message) {
        parentPort.postMessage({ status: 'update', message: `Replay #${replayIndex} - ${message}` });
    }

    async function finishReplay(replay, reason, { clearStitchPending = false } = {}) {
        const updates = {};
        if (clearStitchPending) {
            updates.stitch_pending = 0;
            updates.claimed_by = null;
            updates.claimed_at = null;
        } else {
            updates.claimed_by = os.hostname();
            updates.claimed_at = new Date().toISOString();
        }
        await markReplaysField([replay], updates);
        await appendRunLog(
            `Worker ${workerId} finished replay #${replay.index} (${reason}) (recorded=${replay.recorded}, overlaid=${replay.overlaid}, stitched=${replay.stitched}, uploaded=${replay.uploaded}, skip=${replay.skip})`,
            `worker-${workerId}`,
            [],
        );
        parentPort.postMessage({ status: 'done' });
    }

    let replayIndex = 0; // Track the current replay index for status updates

    parentPort.on('message', async (replay) => {
        try {
            await dbReady;
            await appendRunLog(
                `Worker ${workerId} started replay #${replay.index} (recorded=${replay.recorded}, overlaid=${replay.overlaid}, stitched=${replay.stitched}, uploaded=${replay.uploaded}, skip=${replay.skip}, claimed_by=${replay.claimed_by}, claimed_at=${replay.claimed_at})`,
                `worker-${workerId}`,
                [],
            );
            validateReplay(replay);
            replayIndex = replay.index;
            if (replay.overlaid && !replay.stitched && !replay.stitch_pending) {
                await markReplaysField([replay], { stitch_pending: 1 });
                replay.stitch_pending = 1;
            }
            if (replay.skip || replay.uploaded) {
                await finishReplay(replay, 'skip/uploaded fast-path');
                return;
            }

            // Fast paths based on existing flags
            if (replay.stitched && !replay.uploaded) {
                sendStatus('Stitched already; uploading');
                await markReplaysField([replay], { stitched: true, claimed_by: null, claimed_at: null });
                const stitchedNow = await maybeStitchAndUpload(replay, sendStatus);
                await finishReplay(replay, 'stitched fast-path', { clearStitchPending: stitchedNow });
                return;
            }

            if (replay.overlaid && !replay.stitched) {
                const overlaidPath = path.resolve(gamesDir, `${pad(replay.index, 6)}.avi`);
                if (!(await fileExists(overlaidPath))) {
                    sendStatus('Overlay missing; resetting flags');
                    await markReplaysField([replay], {
                        recorded: 0,
                        overlaid: 0,
                        stitch_pending: 0,
                        claimed_by: null,
                        claimed_at: null,
                    });
                    await finishReplay(replay, 'overlay missing - flags reset');
                    return;
                }
                await ensureVideoDurationStored(replay, markReplaysField, fileExists, getVideoDuration);
                sendStatus('Already overlaid; stitching/uploading');
                await markReplaysField([replay], { stitch_pending: 1 });
                const stitchedNow = await maybeStitchAndUpload(replay, sendStatus);
                await finishReplay(replay, 'overlaid fast-path', { clearStitchPending: stitchedNow });
                return;
            }

            if (replay.recorded && !replay.overlaid) {
                sendStatus('Already recorded; adding overlay');
                await addOverlay(replay, buildOverlayText);
                await markReplaysField([replay], { overlaid: true, stitch_pending: 1 });
                sendStatus('Deleting Files');
                await deleteFiles(replay);
                sendStatus('Queueing for Stitch/Upload');
                const stitchedNow = await maybeStitchAndUpload(replay, sendStatus);
                await finishReplay(replay, 'recorded fast-path', { clearStitchPending: stitchedNow });
                return;
            }

            sendStatus('Starting');

            sendStatus('Generating Config');
            await generateDolphinConfig(replay);

            sendStatus('Running Dolphin');
            await runDolphin(replay);

            sendStatus('Merging Video');
            await mergeVideo(replay);
            await markReplaysField([replay], { recorded: true });

            sendStatus('Adding Overlay');
            await addOverlay(replay, buildOverlayText);
            await markReplaysField([replay], { overlaid: true, stitch_pending: 1 });
            sendStatus('Overlay complete');
            await ensureVideoDurationStored(replay, markReplaysField, fileExists, getVideoDuration);

            sendStatus('Deleting Files');
            await deleteFiles(replay);

            sendStatus('Queueing for Stitch/Upload');
            const stitchedNow = await maybeStitchAndUpload(replay, sendStatus);

            await finishReplay(replay, 'full pipeline', {
                clearStitchPending: stitchedNow,
                clearClaim: stitchedNow,
            });
        } catch (error) {
            try {
                await deleteFiles(replay);
            } catch (cleanupError) {
                console.error(
                    `Worker ${workerId} cleanup error for replay #${replayIndex}: ${cleanupError.message}`,
                );
            }
            try {
                await markReplaysField([replay], { claimed_by: null, claimed_at: null });
            } catch (_) {
                // ignore
            }
            parentPort.postMessage({ status: 'error', error: error.message });
        }
    });
}

async function maybeStitchAndUpload(replay, sendStatus) {
    if (
        Number.isNaN(stitchMinTotalMinutes) ||
        stitchMinTotalMinutes <= 0 ||
        !archiveTitle
    ) {
        return false;
    }

    await ensureStitchStateFile();
    const release = await lockfile.lock(stitchStatePath, { retries: 5 });
    try {
        const ready = await getReadyForStitch();

        if (ready.length === 0) {
            return false;
        }

        const readyByIndex = [...ready].sort((a, b) => a.index - b.index);
        const maxReadyIndex = readyByIndex[readyByIndex.length - 1].index;
    const videoEntries = [];
    const missingFiles = [];
    const missingDurations = [];
    for (const r of readyByIndex) {
        const videoPath = path.resolve(gamesDir, `${pad(r.index, 6)}.avi`);
        if (!(await fileExists(videoPath))) {
            missingFiles.push({ index: r.index, path: videoPath });
            continue;
        }
        let duration =
            typeof r.video_duration_seconds === 'number' && !Number.isNaN(r.video_duration_seconds)
                ? r.video_duration_seconds
                : null;
        if (!duration) {
            duration = await getVideoDuration(videoPath);
            if (duration != null) {
                await markReplaysField([r], { video_duration_seconds: duration });
            }
        }
        if (!duration || Number.isNaN(duration)) {
            missingDurations.push({ index: r.index, path: videoPath });
            continue;
        }
        videoEntries.push({
                index: r.index,
                path: videoPath,
                duration,
                date: r.date,
            });
        }

        if (missingFiles.length > 0 || missingDurations.length > 0) {
            const missingIdx = missingFiles.map((m) => m.index).join(', ');
            const missingDurIdx = missingDurations
                .map((m) => m.index)
                .join(', ');
            console.warn(
                `Stitch paused: missing files (${missingFiles.length}) [${missingIdx}] or durations (${missingDurations.length}) [${missingDurIdx}]. Mark skip or regenerate.`,
            );
            return false;
        }

        const totalSeconds = videoEntries.reduce(
            (acc, v) => acc + v.duration,
            0,
        );

        if (totalSeconds < stitchMinTotalMinutes * 60) {
            return false;
        }

        const blockers = await getBlockers(maxReadyIndex);
        if (blockers.length > 0) {
            const blockerIds = blockers.join(', ');
            console.warn(
                `Stitch paused: ${blockers.length} unskipped replays <= ${maxReadyIndex} are not overlaid. Mark skip or process them. Blockers: ${blockerIds}`,
            );
            return false;
        }

        const { startDate, endDate } = getDateRange(videoEntries);
        const safeStart = startDate.replace(/[\/:]/g, '-');
        const safeEnd = endDate.replace(/[\/:]/g, '-');
        const finalTitle = `${archiveTitle}: ${startDate} - ${endDate}`;
        const stitchedFileName = `${sanitizeFileName(archiveTitle)}_${safeStart}_${safeEnd}.avi`;
        const stitchedPath = path.join(finalDir, stitchedFileName);
        const concatListPath = path.join(finalDir, `concat_${Date.now()}.txt`);
        const description = buildYouTubeDescription({
            archiveTitle,
            startDate,
            endDate,
            videoEntries,
            totalSeconds,
        });

        sendStatus?.('Stitching Videos');
        await stitchVideos(videoEntries, stitchedPath, concatListPath);
        await markReplaysField(videoEntries, {
            stitched: true,
            stitch_pending: 0,
        });

        await appendRunLog(
            `Stitch complete; manual upload required: ${stitchedPath}`,
            'youtube-upload-skipped',
            [stitchedPath]
        );
        await markReplaysField(videoEntries, {
            uploaded: true,
            stitch_pending: 0,
        });
        await appendUploadsLog({
            title: finalTitle,
            stitchedPath,
            uploadedAt: new Date().toISOString(),
            videoId: null,
            indices: videoEntries.map((v) => v.index),
            totalSeconds,
            manual: true,
        });
        const manifest = {
            title: finalTitle,
            stitchedPath,
            startDate,
            endDate,
            indices: videoEntries.map((v) => v.index),
            totalSeconds,
        };
        const manifestPath = path.join(
            finalDir,
            `${path.basename(stitchedPath, path.extname(stitchedPath))}.manifest.json`
        );
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
        `${bitrateKbps}k`,
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

async function getVideoDuration(videoPath) {
    return new Promise((resolve) => {
        const args = [
            '-v',
            'error',
            '-show_entries',
            'format=duration',
            '-of',
            'default=noprint_wrappers=1:nokey=1',
            videoPath,
        ];
        appendRunLog(`ffprobe duration check for ${videoPath}`, 'ffprobe', args);
        const child = spawnProcess('ffprobe', args);
        let output = '';
        child.stdout?.on('data', (data) => {
            output += data.toString();
        });
        child.on('error', () => resolve(null));
        child.on('exit', (code) => {
            if (code !== 0) {
                resolve(null);
            } else {
                const seconds = parseFloat(output.trim());
                resolve(Number.isNaN(seconds) ? null : seconds);
            }
        });
    });
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
            onUploadProgress: (evt) => {
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

async function fetchAndSendNext(workerId, worker, workerStatus, workerTerminationFlags, totalReplays, onStatus) {
    try {
        const replay = await claimNextReplay(claimTtlMs);
        if (replay) {
            workerStatus.set(workerId, { message: `Replay #${replay.index} - queued`, startTime: Date.now() });
            onStatus?.();
            await appendRunLog(
                `Worker ${workerId} assigned replay #${replay.index} (recorded=${replay.recorded}, overlaid=${replay.overlaid}, stitched=${replay.stitched}, uploaded=${replay.uploaded}, skip=${replay.skip}, claimed_by=${replay.claimed_by}, claimed_at=${replay.claimed_at})`,
                'worker-assign',
                [],
            );
            worker.postMessage(replay);
            return;
        }
        const stats = await getStats();
        if (stats.pending > 0) {
            workerStatus.set(workerId, { message: 'Idle - waiting for next eligible replay', startTime: Date.now() });
            onStatus?.();
            setTimeout(() => {
                fetchAndSendNext(workerId, worker, workerStatus, workerTerminationFlags, totalReplays, onStatus);
            }, 2000);
        } else {
            workerStatus.set(workerId, { message: 'Idle - no pending replays (will retry)', startTime: Date.now() });
            onStatus?.();
            setTimeout(() => {
                fetchAndSendNext(workerId, worker, workerStatus, workerTerminationFlags, totalReplays, onStatus);
            }, 5000);
        }
    } catch (err) {
        console.error(`Worker ${workerId} failed to claim next replay: ${err.message}`);
        workerStatus.set(workerId, { message: 'Finished', startTime: Date.now() });
        onStatus?.();
        const flag = workerTerminationFlags.get(workerId);
        if (flag) flag.value = true;
        setTimeout(() => {
            fetchAndSendNext(workerId, worker, workerStatus, workerTerminationFlags, totalReplays, onStatus);
        }, 5000);
    }
}


async function markReplaysField(videoEntries, fieldsToSet) {
    const indices = videoEntries.map((v) => v.index);
    await updateFlags(indices, fieldsToSet);
}
