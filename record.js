import 'dotenv/config';
import path from 'path';
import readline from 'readline';
import crypto from 'crypto';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import os from 'os';
import { spawn } from 'child_process';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { fileURLToPath } from 'url';
import lockfile from 'proper-lockfile';
import { google } from 'googleapis';

import { asyncForEach, pad, convertIsoToMmDdYyyyHhMm } from './lib.js';

const requiredEnvVars = [
  'OUTPUT_DIR',
  'SSBM_ISO_PATH',
  'DOLPHIN_PATH',
  'QUALITY',
  'BITRATE_KBPS',
  'NUM_WORKERS',
  'DOLPHIN_TIMEOUT_MS',
  'FFMPEG_TIMEOUT_MS',
  'OVERLAY_TIMEOUT_MS',
  'STITCH_MIN_TOTAL_MINUTES',
  'ARCHIVE_TITLE',
  'YOUTUBE_CLIENT_ID',
  'YOUTUBE_CLIENT_SECRET',
  'YOUTUBE_REFRESH_TOKEN',
];

const missingEnvVars = requiredEnvVars.filter(
  (name) => process.env[name] === undefined || process.env[name] === '',
);

if (missingEnvVars.length > 0) {
  throw new Error(
    `Missing required env vars: ${missingEnvVars.join(
      ', ',
    )}. Check your .env file.`,
  );
}

const outputDir = process.env.OUTPUT_DIR;
const ssbmIsoPath = process.env.SSBM_ISO_PATH;
const dolphinPath = process.env.DOLPHIN_PATH;
const quality = Number(process.env.QUALITY);
const bitrateKbps = Number(process.env.BITRATE_KBPS);
const numWorkers = Number(process.env.NUM_WORKERS);
const dolphinTimeoutMs = Number(process.env.DOLPHIN_TIMEOUT_MS);
const ffmpegTimeoutMs = Number(process.env.FFMPEG_TIMEOUT_MS);
const overlayTimeoutMs = Number(process.env.OVERLAY_TIMEOUT_MS);
const stitchMinTotalMinutes = Number(process.env.STITCH_MIN_TOTAL_MINUTES);
const archiveTitle = process.env.ARCHIVE_TITLE;
const youtubeClientId = process.env.YOUTUBE_CLIENT_ID;
const youtubeClientSecret = process.env.YOUTUBE_CLIENT_SECRET;
const youtubeRefreshToken = process.env.YOUTUBE_REFRESH_TOKEN;
const youtubePrivacy = process.env.YOUTUBE_PRIVACY || 'unlisted';
const stitchTimeoutMs = Number(
  process.env.STITCH_TIMEOUT_MS !== undefined
    ? process.env.STITCH_TIMEOUT_MS
    : 4 * 60 * 60 * 1000,
);
const replaysJsonPath = path.join('replays.json');
const stitchStatePath = path.join(outputDir, 'stitch_state.json');
const runLogPath = path.join(outputDir, 'run.log');

// Define __filename and __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Main function to process replays with a worker pool
export async function record(replays) {
    // Configure Dolphin settings once before processing replays
    await configureDolphin();

    // Process replays using a worker pool
    await processReplaysWithWorkers(replays, numWorkers);
}

// Worker pool function to process replays
async function processReplaysWithWorkers(replays, numWorkers) {
    const totalReplays = replays.length;
    const alreadyDone = replays.filter((r) => r.done).length;
    let completed = alreadyDone;
    const pendingCount = replays.filter((r) => !r.done).length;

    console.log(
        `Starting to process ${totalReplays} replays (${alreadyDone} already done) with ${numWorkers} workers...`,
    );

    // Create a queue of replays
    const replayQueue = [...replays];

    // Worker pool array and status tracking
    const workers = [];
    const workerPromises = [];
    const workerStatus = new Map(); // Map to track worker status and start time

    // Helper function to get the next non-done replay
    function getNextNonDoneReplay() {
        while (replayQueue.length > 0) {
            const replay = replayQueue.shift();
            if (!replay.done) {
                return replay;
            }
            console.log(
                `Skipping #${replay.index} - already marked done (${completed}/${totalReplays} replays complete)`,
            );
        }
        return null; // Queue is empty or all remaining replays are done
    }

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
        console.clear(); // Clear the terminal for a cleaner display
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

        const workerPromise = new Promise((resolve, reject) => {
            worker.on('message', (msg) => {
                if (msg.status === 'update') {
                    // Update worker status and reset timer
                    workerStatus.set(workerId, { message: msg.message, startTime: Date.now() });
                    displayWorkerStatuses();
                } else if (msg.status === 'done') {
                    completed++;
                    console.log(`Completed ${completed}/${totalReplays} replays`);
                    // Process the next non-done replay if available
                    const nextReplay = getNextNonDoneReplay();
                    if (nextReplay) {
                        worker.postMessage(nextReplay);
                    } else {
                        workerStatus.set(workerId, { message: 'Finished', startTime: Date.now() });
                        displayWorkerStatuses();
                        worker.terminate();
                    }
                } else if (msg.status === 'error') {
                    console.error(`Worker ${workerId} error: ${msg.error}`);
                    completed++;
                    console.log(`Finished with error ${completed}/${totalReplays} replays`);
                    const nextReplay = getNextNonDoneReplay();
                    if (nextReplay) {
                        worker.postMessage(nextReplay);
                    } else {
                        workerStatus.set(workerId, { message: 'Finished', startTime: Date.now() });
                        displayWorkerStatuses();
                        worker.terminate();
                    }
                }
            });
            worker.on('error', reject);
            worker.on('exit', (code) => {
                if (code !== 0) {
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
        const replay = getNextNonDoneReplay();
        if (replay) {
            worker.postMessage(replay);
        } else {
            worker.terminate();
        }
    }

    // Wait for all workers to complete
    await Promise.all(workerPromises);
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

    let replayIndex = 0; // Track the current replay index for status updates

    parentPort.on('message', async (replay) => {
        try {
            validateReplay(replay);
            replayIndex = replay.index;
            sendStatus('Starting');

            sendStatus('Generating Config');
            await generateDolphinConfig(replay);

            sendStatus('Running Dolphin');
            await run_dolphin(replay);

            sendStatus('Merging Video');
            await merge_video(replay);

            sendStatus('Adding Overlay');
            await add_overlay(replay);

            sendStatus('Deleting Files');
            await delete_files(replay);

            sendStatus('Marking Done');
            await markReplayDone(replaysJsonPath, replay.index);

            sendStatus('Queueing for Stitch/Upload');
            await maybeStitchAndUpload(replay, sendStatus);

            parentPort.postMessage({ status: 'done' });
        } catch (error) {
            try {
                await delete_files(replay);
            } catch (cleanupError) {
                console.error(
                    `Worker ${workerId} cleanup error for replay #${replayIndex}: ${cleanupError.message}`,
                );
            }
            parentPort.postMessage({ status: 'error', error: error.message });
        }
    });
}

// Video Processing Functions
async function generateDolphinConfig(replay) {
    const dolphinConfig = {
        mode: 'normal',
        replay: replay.file_path,
        startFrame: -123,
        endFrame: replay.game_length_frames - 124,
        isRealTimeMode: false,
        commandId: `${crypto.randomBytes(12).toString('hex')}`,
    };
    return fsPromises.writeFile(
        path.join(outputDir, `${pad(replay.index, 6)}.json`),
        JSON.stringify(dolphinConfig)
    );
}

async function run_dolphin(replay) {
    const fileBasename = pad(replay.index, 6);
    const dolphinArgs = [
        '-i',
        path.resolve(outputDir, `${fileBasename}.json`),
        '-o',
        `${fileBasename}-unmerged`,
        `--output-directory=${outputDir}`,
        '-b',
        '-e',
        ssbmIsoPath,
        '--cout',
    ];

    await appendRunLog(
        `Dolphin playback for replay #${replay.index}`,
        dolphinPath,
        dolphinArgs,
    );
    const child = spawn(dolphinPath, dolphinArgs);
    killDolphinOnEndFrame(child);
    await runChildProcess(child, {
        name: 'Dolphin',
        replayIndex: replay.index,
        timeoutMs: dolphinTimeoutMs,
    });
}

async function merge_video(replay) {
    const fileBasename = pad(replay.index, 6);
    const ffmpegMergeArgs = [
        '-i',
        path.resolve(outputDir, `${fileBasename}-unmerged.avi`),
        '-i',
        path.resolve(outputDir, `${fileBasename}-unmerged.wav`),
        '-b:v',
        `${bitrateKbps}k`,
        path.resolve(outputDir, `${fileBasename}-merged.avi`),
    ];

    await appendRunLog(
        `ffmpeg merge for replay #${replay.index}`,
        'ffmpeg',
        ffmpegMergeArgs,
    );
    const child = spawn('ffmpeg', ffmpegMergeArgs);
    await runChildProcess(child, {
        name: 'ffmpeg (merge)',
        replayIndex: replay.index,
        timeoutMs: ffmpegTimeoutMs,
    });
}

async function add_overlay(replay) {
    const fileBasename = pad(replay.index, 6);
    const overlayArgs = [
        path.resolve('./overlay.py'),
        path.resolve(outputDir, `${fileBasename}-merged.avi`),
        path.resolve(outputDir, `${fileBasename}.avi`),
        convertIsoToMmDdYyyyHhMm(replay.date),
        path.resolve(outputDir, `${fileBasename}-overlay.png`),
    ];

    await appendRunLog(
        `overlay.py for replay #${replay.index}`,
        'python3',
        overlayArgs,
    );
    const child = spawn('python3', overlayArgs);
    await runChildProcess(child, {
        name: 'overlay.py',
        replayIndex: replay.index,
        timeoutMs: overlayTimeoutMs,
    });
}

async function delete_files(replay) {
    const fileBasename = pad(replay.index, 6);
    const filesToDelete = [
        `${fileBasename}-unmerged.avi`,
        `${fileBasename}-unmerged.wav`,
        `${fileBasename}-merged.avi`,
        `${fileBasename}-overlay.png`,
        `${fileBasename}.json`,
    ];

    for (const file of filesToDelete) {
        const filePath = path.resolve(outputDir, file);
        try {
            await fsPromises.unlink(filePath);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error(`Failed to delete ${filePath}: ${error.message}`);
            }
        }
    }
}

// Dolphin Configuration Functions
async function configureDolphin() {
    const dolphinDirname = path.resolve('/home/user/.config/SlippiPlayback');
    const gameSettingsPath = path.join(dolphinDirname, 'GameSettings', 'GALE01.ini');
    const graphicsSettingsPath = path.join(dolphinDirname, 'Config', 'GFX.ini');
    const dolphinSettingsPath = path.join(dolphinDirname, 'Config', 'Dolphin.ini');

    // Ensure directories exist and create game settings file if missing
    await fsPromises.mkdir(path.dirname(gameSettingsPath), { recursive: true });
    if (!fs.existsSync(gameSettingsPath)) {
        const fd = await fsPromises.open(gameSettingsPath, 'a');
        await fd.close();
    }

    if (!fs.existsSync(gameSettingsPath)) {
        throw new Error('Error: could not find game settings file');
    }

    // Game settings
    let newSettings = ['[Gecko]', '[Gecko_Enabled]', '$Optional: Game Music OFF', '$Optional: Widescreen 16:9', '[Gecko_Disabled]'];
    await fsPromises.writeFile(gameSettingsPath, newSettings.join('\n'));

    // Ensure graphics settings file exists
    await fsPromises.mkdir(path.dirname(graphicsSettingsPath), { recursive: true });
    if (!fs.existsSync(graphicsSettingsPath)) {
        await fsPromises.writeFile(graphicsSettingsPath, '');
    }

    // Graphics settings
    let rl = readline.createInterface({
        input: fs.createReadStream(graphicsSettingsPath),
        crlfDelay: Infinity,
    });
    newSettings = [];
    const aspectRatioSetting = 6;
    for await (const line of rl) {
        if (line.startsWith('AspectRatio')) {
            newSettings.push(`AspectRatio = ${aspectRatioSetting}`);
        } else if (line.startsWith('InternalResolutionFrameDumps')) {
            newSettings.push(`InternalResolutionFrameDumps = True`);
        } else if (line.startsWith('BitrateKbps')) {
            newSettings.push(`BitrateKbps = ${bitrateKbps}`);
        } else if (line.startsWith('EFBScale')) {
            newSettings.push(`EFBScale = ${quality}`);
        } else {
            newSettings.push(line);
        }
    }
    await fsPromises.writeFile(graphicsSettingsPath, newSettings.join('\n'));

    // Ensure Dolphin settings file exists
    await fsPromises.mkdir(path.dirname(dolphinSettingsPath), { recursive: true });
    if (!fs.existsSync(dolphinSettingsPath)) {
        await fsPromises.writeFile(dolphinSettingsPath, '');
    }

    // Dolphin settings
    rl = readline.createInterface({
        input: fs.createReadStream(dolphinSettingsPath),
        crlfDelay: Infinity,
    });
    newSettings = [];
    for await (const line of rl) {
        if (line.startsWith('DumpFrames ')) {
            newSettings.push(`DumpFrames = True`);
        } else if (line.startsWith('DumpFramesSilent ')) {
            newSettings.push(`DumpFramesSilent = True`);
        } else if (line.startsWith('DumpAudio ')) {
            newSettings.push(`DumpAudio = True`);
        } else if (line.startsWith('DumpAudioSilent ')) {
            newSettings.push(`DumpAudioSilent = True`);
        } else {
            newSettings.push(line);
        }
    }
    await fsPromises.writeFile(dolphinSettingsPath, newSettings.join('\n'));
}

// Utility Functions
const runChildProcess = (child, { name, replayIndex, timeoutMs }) =>
    new Promise((resolve, reject) => {
        let finished = false;
        const logBuffer = [];
        const pushLog = (prefix, chunk) => {
            const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
            lines.forEach((line) => {
                const entry = `[${prefix}] ${line}`;
                logBuffer.push(entry);
                if (logBuffer.length > 50) {
                    logBuffer.shift();
                }
            });
        };

        if (child.stdout) {
            child.stdout.on('data', (data) =>
                pushLog(`${name}#${replayIndex} stdout`, data),
            );
        }
        if (child.stderr) {
            child.stderr.on('data', (data) =>
                pushLog(`${name}#${replayIndex} stderr`, data),
            );
        }

        const done = (err) => {
            if (finished) return;
            finished = true;
            if (timeout) clearTimeout(timeout);
            if (err) {
                console.error(
                    `${name} failed for replay #${replayIndex}: ${err.message}`,
                );
                if (logBuffer.length) {
                    console.error(logBuffer.slice(-10).join('\n'));
                }
                reject(err);
            } else {
                resolve();
            }
        };

        const timeout =
            timeoutMs != null
                ? setTimeout(() => {
                      const err = new Error(
                          `${name} timed out for replay #${replayIndex} after ${timeoutMs}ms`,
                      );
                      try {
                          child.kill('SIGKILL');
                      } catch (_) {
                          // ignore
                      }
                      done(err);
                  }, timeoutMs)
                : null;

        child.on('error', (err) => {
            done(err);
        });

        child.on('exit', (code, signal) => {
            if (code === 0) {
                done();
            } else {
                done(
                    new Error(
                        `${name} exited with code ${code} (signal ${signal}) for replay #${replayIndex}`,
                    ),
                );
            }
        });
    });

const killDolphinOnEndFrame = (child) => {
    if (!child || !child.stdout) {
        return;
    }

    let endFrame = Infinity;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => {
        const lines = data.split('\r\n');
        lines.forEach((line) => {
            if (line.includes(`[PLAYBACK_END_FRAME]`)) {
                const regex = /\[PLAYBACK_END_FRAME\] ([0-9]*)/;
                const match = regex.exec(line);
                if (match && match[1]) {
                    const parsed = parseInt(match[1], 10);
                    endFrame = Number.isNaN(parsed) ? Infinity : parsed;
                } else {
                    endFrame = Infinity;
                }
            } else if (line.includes(`[CURRENT_FRAME] ${endFrame}`)) {
                child.kill();
            }
        });
    });
};

async function maybeStitchAndUpload(replay, sendStatus) {
    if (
        Number.isNaN(stitchMinTotalMinutes) ||
        stitchMinTotalMinutes <= 0 ||
        !archiveTitle
    ) {
        return;
    }

    await ensureStitchStateFile();
    const release = await lockfile.lock(stitchStatePath, { retries: 5 });
    try {
        const state = await readJsonFileSafe(stitchStatePath, {
            queue: [],
            uploads: [],
        });

        if (!state.queue.includes(replay.index)) {
            state.queue.push(replay.index);
        }

        const replaysData = await readJsonFileSafe(replaysJsonPath, []);
        const queuedReplays = state.queue
            .map((idx) => replaysData.find((r) => r.index === idx))
            .filter(Boolean);

        const videoEntries = [];
        for (const r of queuedReplays) {
            const videoPath = path.resolve(outputDir, `${pad(r.index, 6)}.avi`);
            if (!(await fileExists(videoPath))) {
                console.warn(
                    `Video missing for replay #${r.index} at ${videoPath}; skipping in stitch queue.`,
                );
                continue;
            }
            const duration = await getVideoDuration(videoPath);
            if (!duration || Number.isNaN(duration)) {
                console.warn(
                    `Could not read duration for replay #${r.index} at ${videoPath}; skipping in stitch queue.`,
                );
                continue;
            }
            videoEntries.push({
                index: r.index,
                path: videoPath,
                duration,
                date: r.date,
            });
        }

        const totalSeconds = videoEntries.reduce(
            (acc, v) => acc + v.duration,
            0,
        );

        // Update queue to only include videos we found durations for
        state.queue = videoEntries.map((v) => v.index);
        await fsPromises.writeFile(
            stitchStatePath,
            JSON.stringify(state, null, 2),
        );

        if (totalSeconds < stitchMinTotalMinutes * 60) {
            return;
        }

        const { startDate, endDate } = getDateRange(videoEntries);
        const finalTitle = `${archiveTitle}: ${startDate} - ${endDate}`;
        const stitchedFileName = `${sanitizeFileName(
            archiveTitle,
        )}_${startDate.replace(/\//g, '-')}_${endDate.replace(/\//g, '-')}.mp4`;
        const stitchedPath = path.join(outputDir, stitchedFileName);
        const concatListPath = path.join(outputDir, `concat_${Date.now()}.txt`);
        const description = buildYouTubeDescription({
            archiveTitle,
            startDate,
            endDate,
            videoEntries,
            totalSeconds,
        });

        sendStatus?.('Stitching Videos');
        await stitchVideos(videoEntries, stitchedPath, concatListPath);

        sendStatus?.('Uploading to YouTube');
        const uploadResult = await uploadToYouTube({
            filePath: stitchedPath,
            title: finalTitle,
            description,
        });

        state.queue = [];
        state.uploads = state.uploads || [];
        state.uploads.push({
            title: finalTitle,
            stitchedPath,
            uploadedAt: new Date().toISOString(),
            videoId: uploadResult?.id || uploadResult?.videoId || null,
            indices: videoEntries.map((v) => v.index),
            totalSeconds,
        });
        await fsPromises.writeFile(
            stitchStatePath,
            JSON.stringify(state, null, 2),
        );
    } finally {
        await release();
    }
}

async function stitchVideos(videoEntries, stitchedPath, concatListPath) {
    const listContent = videoEntries
        .map((v) => `file '${escapeForFfmpegList(v.path)}'`)
        .join('\n');
    await fsPromises.writeFile(concatListPath, listContent);

    const args = [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        concatListPath,
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        '18',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        stitchedPath,
    ];

    await appendRunLog(
        `ffmpeg stitch (${videoEntries.length} videos, total ~${Math.round(
            videoEntries.reduce((a, v) => a + v.duration, 0) / 60,
        )} min)`,
        'ffmpeg',
        args,
    );
    const child = spawn('ffmpeg', args);
    try {
        await runChildProcess(child, {
            name: 'ffmpeg (stitch)',
            replayIndex: 'stitch',
            timeoutMs: stitchTimeoutMs,
        });
    } finally {
        try {
            await fsPromises.unlink(concatListPath);
        } catch (_) {
            // ignore
        }
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
        const child = spawn('ffprobe', args);
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

    const res = await youtube.videos.insert({
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
    });

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

async function readJsonFileSafe(filePath, defaultValue) {
    try {
        const data = await fsPromises.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        if (err.code === 'ENOENT') {
            return defaultValue;
        }
        throw err;
    }
}

async function fileExists(filePath) {
    try {
        await fsPromises.access(filePath);
        return true;
    } catch (_) {
        return false;
    }
}

function formatDuration(seconds) {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(
        2,
        '0',
    )}:${String(secs).padStart(2, '0')}`;
}

function sanitizeFileName(name) {
    return name.replace(/[^a-z0-9-_]+/gi, '_');
}

function escapeForFfmpegList(str) {
    return str.replace(/'/g, "'\\''");
}

async function appendRunLog(info, cmd, args = []) {
    const timestamp = new Date().toISOString();
    const line = [
        `[${timestamp}] ${info}`,
        `Command: ${cmd} ${args.join(' ')}`,
        '',
    ].join('\n');
    try {
        await fsPromises.appendFile(runLogPath, `${line}\n`);
    } catch (err) {
        console.error(`Failed to write to run log: ${err.message}`);
    }
}

async function markReplayDone(jsonPath, index) {
    try {
        // Acquire a lock on the file
        const release = await lockfile.lock(jsonPath, { retries: 10 });

        try {
            // Read the replays.json file
            const data = await fsPromises.readFile(jsonPath, 'utf8');
            const replays = JSON.parse(data);

            // Find the replay object where the 'index' field matches the provided value
            const replay = replays.find(r => r.index === index);
            if (!replay) {
                throw new Error(`No replay found with index field value ${index}`);
            }

            // Add the "done: true" field to the matched replay
            replay.done = true;

            // Write the updated replays back to the JSON file
            await fsPromises.writeFile(jsonPath, JSON.stringify(replays, null, 2));

            return replay;
        } finally {
            // Release the lock
            await release();
        }
    } catch (error) {
        console.error('Error in markReplayDone:', error);
        throw error;
    }
}
