import 'dotenv/config';
import path from 'path';
import { promises as fsPromises } from 'fs';
import os from 'os';
import readline from 'readline';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { fileURLToPath } from 'url';

import { pad } from './lib.js';
import {
  getStats,
  claimNextReplay,
  claimReplayByIndex,
  getReadyForStitch,
  getVideoEntries,
  initSchema,
  releaseClaim,
} from './db.js';
import { config } from './config.js';
import { appendRunLog, fileExists } from './util_log.js';
import { runChildProcess, killDolphinOnEndFrame } from './childProc.js';
import {
  configureDolphin,
  generateDolphinConfig,
  runDolphin,
  mergeVideo,
  addOverlay,
  deleteFiles,
  buildOverlayText,
  publishOverlay,
} from './media.js';
import { maybeStitchAndUpload, markReplaysField } from './stitcher.js';
const dbReady = initSchema();

const {
    gamesDir,
    finalDir,
    workingGamesDir,
    scratchGamesDir,
    numWorkers,
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

function getReplayArtifactPaths(replay, { includeFinal = true } = {}) {
    const fileBasename = pad(replay.index, 6);
    const intermediates = [
        `${fileBasename}-unmerged.avi`,
        `${fileBasename}-unmerged.wav`,
        `${fileBasename}-merged.avi`,
        `${fileBasename}-overlay.png`,
        `${fileBasename}.json`,
    ];
    const paths = intermediates.map((file) => path.resolve(workingGamesDir, file));
    if (scratchGamesDir) {
        // Also clear the scratch copy of the final overlay if it lingered
        paths.push(path.resolve(workingGamesDir, `${fileBasename}.avi`));
    }
    if (includeFinal) {
        // Canonical final always lives in gamesDir (NFS or local depending on setup)
        paths.push(path.resolve(gamesDir, `${fileBasename}.avi`));
    }
    return paths;
}

async function deleteReplayArtifacts(replay, files = null) {
    const targets = Array.isArray(files) ? files : getReplayArtifactPaths(replay);
    for (const filePath of targets) {
        try {
            await fsPromises.unlink(filePath);
            console.log(`Clear: deleted ${filePath}`);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error(`Failed to delete ${filePath}: ${error.message}`);
            }
        }
    }
}

// On worker startup: scrub leftover artifacts from a previous crash.
// - scratch/games/ may have stale intermediates (and possibly an unpublished final .avi)
// - gamesDir may have stale .tmp.* files from a publishOverlay() that crashed mid-rename
async function cleanOrphansOnStartup() {
    if (scratchGamesDir) {
        try {
            const entries = await fsPromises.readdir(scratchGamesDir);
            let cleaned = 0;
            for (const name of entries) {
                try {
                    await fsPromises.unlink(path.resolve(scratchGamesDir, name));
                    cleaned += 1;
                } catch (_) { /* ignore */ }
            }
            if (cleaned > 0) {
                console.log(`Startup cleanup: removed ${cleaned} orphan scratch file(s) from ${scratchGamesDir}`);
                await appendRunLog(`Startup cleanup: removed ${cleaned} scratch orphans`, 'startup-cleanup', []);
            }
        } catch (err) {
            if (err.code !== 'ENOENT') {
                console.error(`Startup cleanup of scratch failed: ${err.message}`);
            }
        }
    }
    try {
        const entries = await fsPromises.readdir(gamesDir);
        const tmpFiles = entries.filter((n) => /\.tmp\.\d+\.\d+$/.test(n));
        for (const name of tmpFiles) {
            try { await fsPromises.unlink(path.resolve(gamesDir, name)); } catch (_) {}
        }
        if (tmpFiles.length > 0) {
            console.log(`Startup cleanup: removed ${tmpFiles.length} stale .tmp file(s) from ${gamesDir}`);
            await appendRunLog(`Startup cleanup: removed ${tmpFiles.length} NFS .tmp orphans`, 'startup-cleanup', []);
        }
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error(`Startup cleanup of gamesDir failed: ${err.message}`);
        }
    }
}

async function clearUnfinishedReplays() {
    console.log('Clear: loading replay list...');
    const allReplays = await getVideoEntries();
    console.log(`Clear: loaded ${allReplays.length} replays. Selecting incomplete pre-stitch rows...`);
    const candidates = allReplays.filter(
        (replay) => !replay.skip && (!replay.recorded || !replay.overlaid),
    );
    console.log(`Clear: found ${candidates.length} replay(s) to reset.`);
    if (candidates.length === 0) {
        console.log('Clear: no unfinished replays to reset.');
        return;
    }
    for (const replay of candidates) {
        console.log(
            `Clear: replay #${replay.index} recorded=${replay.recorded} overlaid=${replay.overlaid} -> reset`,
        );
        await deleteReplayArtifacts(replay);
    }
    await markReplaysField(
        candidates,
        {
        recorded: 0,
        overlaid: 0,
        stitched: 0,
        uploaded: 0,
        stitch_pending: 0,
        claimed_by: null,
        claimed_at: null,
        },
    );
    await appendRunLog(`Clear reset ${candidates.length} unfinished replays`, 'clear', []);
    console.log('Clear: done.');
}

// Define __filename and __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Main function to process replays with a worker pool
export async function record(options = {}) {
    const { mode = 'full', includeStitchPending = false, testReplayIndex = null, clearUnfinished = false } = options;
    if (!['full', 'record-only'].includes(mode)) {
        throw new Error(`Invalid mode: ${mode}. Use 'full' or 'record-only'.`);
    }
    const stitchWorkerEnabled = mode === 'full';

    console.log('');
    await dbReady;
    if (clearUnfinished) {
        console.log('Clear mode: scanning for unfinished replays before starting.');
        await clearUnfinishedReplays();
    }
    await checkHealth();
    await fsPromises.mkdir(gamesDir, { recursive: true });
    await fsPromises.mkdir(finalDir, { recursive: true });
    if (scratchGamesDir) {
        await fsPromises.mkdir(scratchGamesDir, { recursive: true });
    }
    await cleanOrphansOnStartup();
    await printRunStats();
    if (!stitchWorkerEnabled) {
        console.log('Mode: record/merge/overlay only (stitch/upload disabled for this run).');
    }
    // Configure Dolphin settings once before processing replays
    await configureDolphin();

    if (testReplayIndex !== null && testReplayIndex !== undefined) {
        await processSingleReplay(testReplayIndex, { stitchWorkerEnabled });
        return;
    }

    // Process replays using a worker pool
    await processReplaysWithWorkers(numWorkers, { stitchWorkerEnabled, includeStitchPending });
}

export async function stitchOnly(options = {}) {
    const { testReplayIndex = null, clearUnfinished = false } = options;
    console.log('');
    await dbReady;
    if (clearUnfinished) {
        console.log('Clear mode: scanning for unfinished replays before starting.');
        await clearUnfinishedReplays();
    }
    await checkHealth();
    await fsPromises.mkdir(gamesDir, { recursive: true });
    await fsPromises.mkdir(finalDir, { recursive: true });
    await printRunStats();
    console.log('Mode: stitch/upload only (no recording/overlay).');

    if (testReplayIndex !== null && testReplayIndex !== undefined) {
        console.log(`Test mode: stitching/uploading replay #${testReplayIndex} only.`);
    }

    let didAnyWork = false;
    while (true) {
        const stitched = await maybeStitchAndUpload(null, (statusMessage) => {
            console.log(`Stitcher - ${statusMessage}`);
        }, testReplayIndex !== null && testReplayIndex !== undefined ? { onlyIndices: [testReplayIndex] } : {});
        if (!stitched) break;
        didAnyWork = true;
    }
    if (!didAnyWork) {
        console.log(
            testReplayIndex !== null && testReplayIndex !== undefined
                ? 'Stitcher found nothing ready to stitch/upload for the test replay.'
                : 'Stitcher found nothing ready to stitch/upload.',
        );
    } else {
        console.log(
            testReplayIndex !== null && testReplayIndex !== undefined
                ? 'Stitch/upload work completed for the test replay.'
                : 'Stitch/upload work completed.',
        );
    }
}

async function processSingleReplay(testReplayIndex, { stitchWorkerEnabled } = {}) {
    const replay = await claimReplayByIndex(testReplayIndex, claimTtlMs);
    if (!replay) {
        console.error(
            `Replay #${testReplayIndex} is not available (missing, claimed, skipped, or already uploaded).`,
        );
        return;
    }
    console.log(`Test mode: processing replay #${replay.index} only.`);
    try {
        await runReplayInWorker(replay, { stitchWorkerEnabled });
    } catch (error) {
        console.error(`Replay #${replay.index} failed: ${error.message}`);
        try {
            await releaseClaim(replay.index);
        } catch (_) {
            // ignore
        }
        return;
    }

    if (!stitchWorkerEnabled) {
        return;
    }

    let didAnyWork = false;
    try {
        while (true) {
            const stitched = await maybeStitchAndUpload(null, (statusMessage) => {
                console.log(`Stitcher - ${statusMessage}`);
            }, { onlyIndices: [replay.index] });
            if (!stitched) break;
            didAnyWork = true;
        }
    } catch (error) {
        console.error(`Stitcher failed for replay #${replay.index}: ${error.message}`);
        return;
    }
    if (!didAnyWork) {
        console.log('Stitcher found nothing ready to stitch/upload for the test replay.');
    } else {
        console.log('Stitch/upload work completed for the test replay.');
    }
}

async function runReplayInWorker(replay, { stitchWorkerEnabled } = {}) {
    const workerId = 'T';
    const worker = new Worker(__filename, { workerData: { workerId, stitchWorkerEnabled } });
    let settled = false;

    const finalize = async (err) => {
        if (settled) return;
        settled = true;
        try {
            await worker.terminate();
        } catch (_) {
            // ignore
        }
        if (err) {
            throw err;
        }
    };

    return new Promise((resolve, reject) => {
        const finish = (err) => {
            finalize(err)
                .then(() => {
                    if (err) reject(err);
                    else resolve();
                })
                .catch(reject);
        };

        worker.on('message', (msg) => {
            if (!msg) return;
            if (msg.status === 'update') {
                console.log(msg.message);
            } else if (msg.status === 'done') {
                finish();
            } else if (msg.status === 'error') {
                finish(new Error(msg.error || 'Worker error'));
            }
        });
        worker.on('error', (err) => finish(err));
        worker.on('exit', (code) => {
            if (settled) return;
            if (code !== 0) {
                finish(new Error(`Worker stopped with exit code ${code}`));
            } else {
                finish();
            }
        });
        worker.postMessage(replay);
    });
}

// Worker pool function to process replays
async function processReplaysWithWorkers(numWorkers, { stitchWorkerEnabled = true, includeStitchPending = false } = {}) {
    const stats = await getStats();
    const totalReplays = stats.total;
    const pendingCount = stats.pending;
    const alreadyUploaded = stats.uploaded;
    const workerPoolSize = Math.max(1, numWorkers);
    const normalWorkerCount = stitchWorkerEnabled ? Math.max(1, workerPoolSize - 1) : workerPoolSize;

    console.log(
        `Starting to process ${pendingCount} pending of ${totalReplays} total replays (${alreadyUploaded} already uploaded) with ${normalWorkerCount} normal worker${normalWorkerCount === 1 ? '' : 's'}${stitchWorkerEnabled ? ' + 1 stitch/upload worker' : ''}...`,
    );

    // Worker pool array and status tracking
    const workers = [];
    const workersById = new Map();
    const workerPromises = [];
    const workerStatus = new Map(); // Map to track worker status and start time
    const workerTerminationFlags = new Map();
    const workerBusy = new Map();
    let completedThisRun = 0;
    let statusInterval;
    const STITCH_WORKER_ID = 'S';
    let stitchWorker;
    let stitchWorkerPromise;
    let stitchWorkerBusy = false;
    let stitchWorkerRunResolver = null;
    let stitchWorkerRunRejector = null;
    let stitchWorkerRunPromise = null;
    let stitchCheckInFlight = false;
    let stitchWorkerTerminationRequested = false;
    const shutdownState = { requested: false, requestedAt: null, reason: null };
    let shutdownHandlersInstalled = false;
    let keypressHandler = null;
    let stdinWasRaw = false;
    let stdinResumed = false;
    const normalWorkerClaimOptions = { includeStitchPending, shutdownState };

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
        console.log(
            `Processing ${totalReplays} replays with ${normalWorkerCount} normal worker${normalWorkerCount === 1 ? '' : 's'}${stitchWorkerEnabled ? ' + stitch/upload worker' : ''}...`,
        );
        console.log(
            `Completed this run: ${completedThisRun}/${pendingCount} | Total uploaded: ${alreadyUploaded + completedThisRun}/${totalReplays}`,
        );
        if (shutdownState.requested && shutdownState.requestedAt) {
            const elapsedTime = formatElapsedTime(shutdownState.requestedAt);
            console.log(
                `Shutdown requested${shutdownState.reason ? ` (${shutdownState.reason})` : ''}; draining workers... [${elapsedTime}]`,
            );
        }
        console.log('Controls: press q or Ctrl+C to stop after current jobs; press Ctrl+C again to force exit.');
        console.log('\nWorker Statuses:');
        workerStatus.forEach((statusObj, workerId) => {
            const elapsedTime = formatElapsedTime(statusObj.startTime);
            console.log(`Worker ${workerId}: ${statusObj.message} [${elapsedTime}]`);
        });
        console.log('');
    }

    function requestShutdown(reason) {
        if (shutdownState.requested) {
            console.log('Shutdown already requested. Press Ctrl+C again to force exit.');
            return;
        }
        shutdownState.requested = true;
        shutdownState.requestedAt = Date.now();
        shutdownState.reason = reason || null;
        console.log(
            `Graceful shutdown requested${reason ? ` (${reason})` : ''}. Workers will finish current jobs and then stop.`,
        );
        workerTerminationFlags.forEach((flag) => {
            flag.value = true;
        });
        workersById.forEach((worker, workerId) => {
            const busy = workerBusy.get(workerId);
            if (!busy) {
                workerStatus.set(workerId, { message: 'Idle - shutdown requested', startTime: Date.now() });
                void worker.terminate();
            }
        });
        if (stitchWorker && !stitchWorkerBusy) {
            workerStatus.set(STITCH_WORKER_ID, { message: 'Stitcher idle - shutdown requested', startTime: Date.now() });
            stitchWorkerTerminationRequested = true;
            void stitchWorker.terminate();
        }
        displayWorkerStatuses();
    }

    function cleanupShutdownHandlers() {
        if (keypressHandler && process.stdin.isTTY) {
            process.stdin.off('keypress', keypressHandler);
            keypressHandler = null;
        }
        if (process.stdin.isTTY) {
            if (stdinWasRaw) {
                try {
                    process.stdin.setRawMode(false);
                } catch (_) {
                    // ignore
                }
                stdinWasRaw = false;
            }
            if (stdinResumed) {
                process.stdin.pause();
                stdinResumed = false;
            }
        }
    }

    function handleCtrlC(source) {
        if (!shutdownState.requested) {
            requestShutdown(source);
            return;
        }
        console.log('Force exit requested (second Ctrl+C).');
        process.exit(130);
    }

    function installShutdownHandlers() {
        if (shutdownHandlersInstalled) return;
        shutdownHandlersInstalled = true;
        process.on('SIGINT', () => {
            handleCtrlC('SIGINT');
        });
        process.on('SIGTERM', () => {
            requestShutdown('SIGTERM');
        });

        if (process.stdin.isTTY) {
            readline.emitKeypressEvents(process.stdin);
            try {
                process.stdin.setRawMode(true);
                stdinWasRaw = true;
                process.stdin.resume();
                stdinResumed = true;
            } catch (_) {
                // ignore
            }
            keypressHandler = (_str, key) => {
                if (!key) return;
                if (key.ctrl && key.name === 'c') {
                    handleCtrlC('Ctrl+C');
                    return;
                }
                if (key.name === 'q' && !key.ctrl && !key.meta) {
                    requestShutdown('keypress q');
                }
            };
            process.stdin.on('keypress', keypressHandler);
            process.on('exit', () => {
                cleanupShutdownHandlers();
            });
        }
    }

    function createStitchWorker() {
        const worker = new Worker(__filename, { workerData: { workerId: STITCH_WORKER_ID, role: 'stitcher' } });
        workerStatus.set(STITCH_WORKER_ID, { message: 'Idle (stitch/upload)', startTime: Date.now() });

        stitchWorkerPromise = new Promise((resolve, reject) => {
            let stitchWorkerPromiseSettled = false;
            const settleStitchWorker = (err) => {
                if (stitchWorkerPromiseSettled) return;
                stitchWorkerPromiseSettled = true;
                workerStatus.delete(STITCH_WORKER_ID);
                stitchWorkerBusy = false;
                const shutdownRequested = shutdownState.requested || stitchWorkerTerminationRequested;
                if (err && !shutdownRequested) {
                    if (stitchWorkerRunRejector) stitchWorkerRunRejector(err);
                    reject(err);
                } else {
                    resolve();
                }
                stitchWorkerRunResolver = null;
                stitchWorkerRunRejector = null;
                stitchWorkerRunPromise = null;
            };

            worker.on('message', (msg) => {
                if (msg.status === 'stitch-update') {
                    workerStatus.set(STITCH_WORKER_ID, { message: `Stitcher - ${msg.message}`, startTime: Date.now() });
                    displayWorkerStatuses();
                } else if (msg.status === 'stitch-complete') {
                    stitchWorkerBusy = false;
                    workerStatus.set(STITCH_WORKER_ID, {
                        message: msg.didWork ? 'Stitch/upload run finished' : 'Stitcher idle (nothing to do)',
                        startTime: Date.now(),
                    });
                    displayWorkerStatuses();
                    if (shutdownState.requested && stitchWorker) {
                        workerStatus.set(STITCH_WORKER_ID, { message: 'Stitcher stopped (shutdown requested)', startTime: Date.now() });
                        stitchWorkerTerminationRequested = true;
                        void stitchWorker.terminate();
                    }
                    stitchWorkerRunResolver?.(msg.didWork);
                    stitchWorkerRunResolver = null;
                    stitchWorkerRunRejector = null;
                    stitchWorkerRunPromise = null;
                } else if (msg.status === 'stitch-error') {
                    stitchWorkerBusy = false;
                    const errorMessage = msg.error || 'Unknown stitch worker error';
                    console.error(`Stitch worker error: ${errorMessage}`);
                    workerStatus.set(STITCH_WORKER_ID, { message: `Stitcher error: ${errorMessage}`, startTime: Date.now() });
                    displayWorkerStatuses();
                    const err = new Error(errorMessage);
                    if (stitchWorkerRunRejector) {
                        stitchWorkerRunRejector(err);
                    } else {
                        reject(err);
                    }
                    stitchWorkerRunResolver = null;
                    stitchWorkerRunRejector = null;
                    stitchWorkerRunPromise = null;
                }
            });
            worker.on('error', (err) => {
                const shutdownRequested = shutdownState.requested || stitchWorkerTerminationRequested;
                if (shutdownRequested) {
                    settleStitchWorker();
                    return;
                }
                stitchWorkerBusy = false;
                settleStitchWorker(err);
            });
            worker.on('exit', (code) => {
                const shutdownRequested = shutdownState.requested || stitchWorkerTerminationRequested;
                if (code !== 0 && !shutdownRequested) {
                    settleStitchWorker(new Error(`Stitch worker stopped with exit code ${code}`));
                    return;
                }
                settleStitchWorker();
            });
        });
        return worker;
    }

    async function triggerStitchWorker(reason) {
        if (shutdownState.requested) {
            return null;
        }
        if (!stitchWorkerEnabled || stitchWorkerBusy || stitchCheckInFlight) {
            return null;
        }
        stitchCheckInFlight = true;
        try {
            if (Number.isNaN(config.stitchMinTotalMinutes) || config.stitchMinTotalMinutes <= 0) {
                return null;
            }
            const ready = await getReadyForStitch();
            if (!ready.length) {
                return null;
            }
            if (!stitchWorker) {
                stitchWorker = createStitchWorker();
            }
            stitchWorkerBusy = true;
            stitchWorkerRunPromise = new Promise((resolve, reject) => {
                stitchWorkerRunResolver = resolve;
                stitchWorkerRunRejector = reject;
            });
            // Avoid unhandled rejection noise; we log/handle later.
            stitchWorkerRunPromise.catch(() => {});
            workerStatus.set(STITCH_WORKER_ID, {
                message: `Stitcher starting${reason ? ` (${reason})` : ''}`,
                startTime: Date.now(),
            });
            displayWorkerStatuses();
            stitchWorker.postMessage({ action: 'run-stitch' });
            return stitchWorkerRunPromise;
        } finally {
            stitchCheckInFlight = false;
        }
    }

    // Function to create a new normal worker
    function createWorker(workerId) {
        const worker = new Worker(__filename, { workerData: { workerId, stitchWorkerEnabled } });
        workerStatus.set(workerId, { message: 'Idle', startTime: Date.now() });
        workerTerminationFlags.set(workerId, { value: false });
        workerBusy.set(workerId, false);
        workersById.set(workerId, worker);

        const workerPromise = new Promise((resolve, reject) => {
            worker.on('message', (msg) => {
                if (msg.status === 'update') {
                    // Update worker status and reset timer
                    workerStatus.set(workerId, { message: msg.message, startTime: Date.now() });
                    displayWorkerStatuses();
                } else if (msg.status === 'done') {
                    workerBusy.set(workerId, false);
                    workerStatus.set(workerId, { message: 'Idle - requesting next', startTime: Date.now() });
                    completedThisRun++;
                    console.log(
                        `Completed this run: ${completedThisRun}/${pendingCount} (overall ${alreadyUploaded + completedThisRun}/${totalReplays})`,
                    );
                    if (shutdownState.requested) {
                        workerStatus.set(workerId, { message: 'Idle - shutdown requested', startTime: Date.now() });
                        displayWorkerStatuses();
                        void worker.terminate();
                        return;
                    }
                    void fetchAndSendNext(workerId, worker, workerStatus, workerTerminationFlags, workerBusy, () => {
                        displayWorkerStatuses();
                    }, normalWorkerClaimOptions);
                    if (stitchWorkerEnabled) {
                        void triggerStitchWorker('normal worker completed');
                    }
                } else if (msg.status === 'error') {
                    console.error(`Worker ${workerId} error: ${msg.error}`);
                    workerBusy.set(workerId, false);
                    workerStatus.set(workerId, { message: 'Idle - retry after error', startTime: Date.now() });
                    completedThisRun++;
                    console.log(
                        `Finished with error this run: ${completedThisRun}/${pendingCount} (overall ${alreadyUploaded + completedThisRun}/${totalReplays})`,
                    );
                    if (shutdownState.requested) {
                        workerStatus.set(workerId, { message: 'Idle - shutdown requested', startTime: Date.now() });
                        displayWorkerStatuses();
                        void worker.terminate();
                        return;
                    }
                    void fetchAndSendNext(workerId, worker, workerStatus, workerTerminationFlags, workerBusy, () => {
                        displayWorkerStatuses();
                    }, normalWorkerClaimOptions);
                    if (stitchWorkerEnabled) {
                        void triggerStitchWorker('normal worker errored');
                    }
                }
            });
            worker.on('error', reject);
            worker.on('exit', (code) => {
                const terminated = workerTerminationFlags.get(workerId)?.value;
                if (code !== 0 && !terminated) {
                    reject(new Error(`Worker ${workerId} stopped with exit code ${code}`));
                } else {
                    workerStatus.delete(workerId);
                    workerBusy.delete(workerId);
                    workersById.delete(workerId);
                    resolve();
                }
            });
        });

        workers.push(worker);
        workerPromises.push(workerPromise);
        return worker;
    }

    // Start the worker pool
    const workersToStart = Math.min(normalWorkerCount, pendingCount);
    if (workersToStart === 0) {
        console.log('No pending replays to process.');
        return;
    }
    installShutdownHandlers();
    for (let i = 0; i < workersToStart; i++) {
        const workerId = i + 1; // Assign a unique ID to each worker
        const worker = createWorker(workerId);
        void fetchAndSendNext(workerId, worker, workerStatus, workerTerminationFlags, workerBusy, () => {
            displayWorkerStatuses();
        }, normalWorkerClaimOptions);
    }

    if (stitchWorkerEnabled) {
        void triggerStitchWorker('initial check');
    }

    // Keep status display ticking
    statusInterval = setInterval(displayWorkerStatuses, 1000);

    // Wait for all workers to complete
    await Promise.all(workerPromises);
    if (stitchWorkerRunPromise) {
        try {
            await stitchWorkerRunPromise;
        } catch (err) {
            console.error(`Stitch worker run failed: ${err.message}`);
        }
    }
    if (stitchWorker && stitchWorkerPromise) {
        stitchWorker.terminate();
        await stitchWorkerPromise;
    }
    if (statusInterval) {
        clearInterval(statusInterval);
    }
    cleanupShutdownHandlers();
    console.clear();
    console.log('All replays processed.');
}

async function checkHealth() {
    const stats = await getStats();
    if (stats.claimed > 0) {
        console.warn(
            `Warning: ${stats.claimed} replays are currently claimed. If this is a fresh run, consider clearing claims/resetting flags.`,
        );
    }
    if (Number.isNaN(config.stitchMinTotalMinutes) || config.stitchMinTotalMinutes <= 0) {
        console.warn(
            `Warning: STITCH_MIN_TOTAL_MINUTES is ${config.stitchMinTotalMinutes}; stitching/upload is disabled.`,
        );
    }
}

// Worker thread logic
if (!isMainThread) {
    const { workerId, role = 'normal', stitchWorkerEnabled = false } = workerData;

    if (role === 'stitcher') {
        const sendStitchStatus = (message) => parentPort.postMessage({ status: 'stitch-update', message });

        parentPort.on('message', async (msg) => {
            if (!msg || msg.action !== 'run-stitch') {
                return;
            }
            try {
                await dbReady;
                sendStitchStatus('Checking for stitch/upload work');
                let didWork = false;
                // Loop until there is no more stitch/upload work ready.
                while (true) {
                    const stitched = await maybeStitchAndUpload(null, (statusMessage) => sendStitchStatus(statusMessage));
                    if (!stitched) {
                        break;
                    }
                    didWork = true;
                }
                parentPort.postMessage({ status: 'stitch-complete', didWork });
            } catch (error) {
                parentPort.postMessage({ status: 'stitch-error', error: error.message });
            }
        });
    } else {

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

        async function finishReplay(
            replay,
            reason,
            { clearStitchPending = false } = {},
        ) {
            const updates = {};
            if (clearStitchPending) {
                updates.stitch_pending = 0;
            }
            updates.claimed_by = null;
            updates.claimed_at = null;
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
                    sendStatus('Stitched already; handing to stitch/upload worker');
                    await markReplaysField([replay], { stitch_pending: 1, claimed_by: null, claimed_at: null });
                    replay.stitch_pending = 1;
                    await finishReplay(replay, 'stitched - deferred to stitch worker');
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
                    sendStatus('Already overlaid; queuing for stitch/upload worker');
                    await markReplaysField([replay], { stitch_pending: 1, claimed_by: null, claimed_at: null });
                    replay.stitch_pending = 1;
                    await finishReplay(replay, 'overlaid - deferred to stitch worker');
                    return;
                }

                if (!replay.overlaid) {
                    const finalVideoPath = path.resolve(gamesDir, `${pad(replay.index, 6)}.avi`);
                    if (await fileExists(finalVideoPath)) {
                        sendStatus('Final video exists; updating flags');
                        await markReplaysField([replay], { recorded: true, overlaid: true, stitch_pending: 1 });
                        replay.recorded = true;
                        replay.overlaid = true;
                        replay.stitch_pending = 1;
                        sendStatus('Handing to stitch/upload worker');
                        await finishReplay(replay, 'final video already exists - flags updated');
                        return;
                    }
                }

                if (replay.recorded && !replay.overlaid) {
                    // Legacy stale state from before SCRATCH_DIR was introduced (recorded=1 was
                    // set after merge, before overlay) — the -merged.avi may be on another
                    // worker's local scratch and inaccessible here. Reset to redo cleanly.
                    sendStatus('Stale recorded=1/overlaid=0 state; resetting for full re-run');
                    await markReplaysField([replay], {
                        recorded: 0,
                        claimed_by: null,
                        claimed_at: null,
                    });
                    await finishReplay(replay, 'stale recorded state - reset for full re-run');
                    return;
                }

                sendStatus('Starting');

                sendStatus('Generating Config');
                await generateDolphinConfig(replay);

                sendStatus('Running Dolphin');
                await runDolphin(replay);

                sendStatus('Merging Video');
                await mergeVideo(replay);

                sendStatus('Adding Overlay');
                await addOverlay(replay, buildOverlayText);

                sendStatus('Publishing final to gamesDir');
                await publishOverlay(replay);

                // Both flags set together AFTER the final .avi is durably at its canonical
                // gamesDir path. If anything crashed before this point, DB still shows
                // recorded=0/overlaid=0 and the next worker re-does the full pipeline.
                await markReplaysField([replay], { recorded: true, overlaid: true, stitch_pending: 1 });
                replay.recorded = true;
                replay.overlaid = true;
                replay.stitch_pending = 1;
                sendStatus('Overlay complete');

                sendStatus('Deleting Files');
                await deleteFiles(replay);

                sendStatus('Handing to stitch/upload worker');
                await finishReplay(replay, 'full pipeline - deferred to stitch worker');
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
}

async function fetchAndSendNext(workerId, worker, workerStatus, workerTerminationFlags, workerBusy, onStatus, options = {}) {
    const { includeStitchPending = true, shutdownState = null } = options;
    const shouldStop = () =>
        (shutdownState && shutdownState.requested) ||
        workerTerminationFlags.get(workerId)?.value ||
        !worker ||
        worker.threadId === undefined;

    if (shouldStop()) {
        if (shutdownState?.requested) {
            workerStatus.set(workerId, { message: 'Idle - shutdown requested', startTime: Date.now() });
            onStatus?.();
        }
        return;
    }

    try {
        const replay = await claimNextReplay(claimTtlMs, { includeStitchPending });
        if (shutdownState?.requested) {
            if (replay) {
                await releaseClaim(replay.index);
            }
            workerStatus.set(workerId, { message: 'Idle - shutdown requested', startTime: Date.now() });
            onStatus?.();
            return;
        }
        if (replay) {
            workerStatus.set(workerId, { message: `Replay #${replay.index} - queued`, startTime: Date.now() });
            onStatus?.();
            await appendRunLog(
                `Worker ${workerId} assigned replay #${replay.index} (recorded=${replay.recorded}, overlaid=${replay.overlaid}, stitched=${replay.stitched}, uploaded=${replay.uploaded}, skip=${replay.skip}, claimed_by=${replay.claimed_by}, claimed_at=${replay.claimed_at})`,
                'worker-assign',
                [],
            );
            if (shouldStop()) {
                await releaseClaim(replay.index);
                return;
            }
            if (workerBusy) {
                workerBusy.set(workerId, true);
            }
            worker.postMessage(replay);
            return;
        }
        const stats = await getStats();
        if (stats.pending > 0) {
            workerStatus.set(workerId, {
                message: includeStitchPending
                    ? 'Idle - waiting for next eligible replay'
                    : 'Idle - waiting for next recording/overlay replay',
                startTime: Date.now(),
            });
            onStatus?.();
            if (!shutdownState?.requested) {
                setTimeout(() => {
                    if (shouldStop()) return;
                    fetchAndSendNext(workerId, worker, workerStatus, workerTerminationFlags, workerBusy, onStatus, options);
                }, 2000);
            }
        } else {
            workerStatus.set(workerId, { message: 'Idle - no pending replays (will retry)', startTime: Date.now() });
            onStatus?.();
            if (!shutdownState?.requested) {
                setTimeout(() => {
                    if (shouldStop()) return;
                    fetchAndSendNext(workerId, worker, workerStatus, workerTerminationFlags, workerBusy, onStatus, options);
                }, 5000);
            }
        }
    } catch (err) {
        console.error(`Worker ${workerId} failed to claim next replay: ${err.message}`);
        workerStatus.set(workerId, { message: 'Finished', startTime: Date.now() });
        onStatus?.();
        const flag = workerTerminationFlags.get(workerId);
        if (flag) flag.value = true;
        if (!shutdownState?.requested) {
            setTimeout(() => {
                if (shouldStop()) return;
                fetchAndSendNext(workerId, worker, workerStatus, workerTerminationFlags, workerBusy, onStatus, options);
            }, 5000);
        }
    }
}
