import 'dotenv/config';
import path from 'path';
import { promises as fsPromises } from 'fs';
import os from 'os';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { fileURLToPath } from 'url';

import { pad } from './lib.js';
import {
  getStats,
  claimNextReplay,
  getReadyForStitch,
  initSchema,
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
} from './media.js';
import { maybeStitchAndUpload, markReplaysField } from './stitcher.js';
const dbReady = initSchema();

const {
    gamesDir,
    finalDir,
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

// Define __filename and __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Main function to process replays with a worker pool
export async function record(replays) {
    console.log('');
    await dbReady;
    await checkHealth();
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
    const pendingCount = stats.pending;
    const alreadyUploaded = stats.uploaded;
    const stitchWorkerEnabled = true; // always keep a single dedicated stitch/upload worker
    const normalWorkerCount = Math.max(1, Math.max(1, numWorkers) - 1);
    const normalWorkerClaimOptions = { includeStitchPending: !stitchWorkerEnabled };

    console.log(
        `Starting to process ${pendingCount} pending of ${totalReplays} total replays (${alreadyUploaded} already uploaded) with ${normalWorkerCount} normal worker${normalWorkerCount === 1 ? '' : 's'} + 1 stitch/upload worker...`,
    );

    // Worker pool array and status tracking
    const workers = [];
    const workerPromises = [];
    const workerStatus = new Map(); // Map to track worker status and start time
    const workerTerminationFlags = new Map();
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
            `Processing ${totalReplays} replays with ${normalWorkerCount} normal worker${normalWorkerCount === 1 ? '' : 's'} + stitch/upload worker...`,
        );
        console.log(
            `Completed this run: ${completedThisRun}/${pendingCount} | Total uploaded: ${alreadyUploaded + completedThisRun}/${totalReplays}`,
        );
        console.log('\nWorker Statuses:');
        workerStatus.forEach((statusObj, workerId) => {
            const elapsedTime = formatElapsedTime(statusObj.startTime);
            console.log(`Worker ${workerId}: ${statusObj.message} [${elapsedTime}]`);
        });
        console.log('');
    }

    function createStitchWorker() {
        const worker = new Worker(__filename, { workerData: { workerId: STITCH_WORKER_ID, role: 'stitcher' } });
        workerStatus.set(STITCH_WORKER_ID, { message: 'Idle (stitch/upload)', startTime: Date.now() });

        stitchWorkerPromise = new Promise((resolve, reject) => {
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
                stitchWorkerBusy = false;
                if (stitchWorkerRunRejector) stitchWorkerRunRejector(err);
                reject(err);
                stitchWorkerRunResolver = null;
                stitchWorkerRunRejector = null;
                stitchWorkerRunPromise = null;
            });
            worker.on('exit', (code) => {
                workerStatus.delete(STITCH_WORKER_ID);
                stitchWorkerBusy = false;
                if (code !== 0) {
                    const err = new Error(`Stitch worker stopped with exit code ${code}`);
                    if (stitchWorkerRunRejector) stitchWorkerRunRejector(err);
                    reject(err);
                } else {
                    resolve();
                }
                stitchWorkerRunResolver = null;
                stitchWorkerRunRejector = null;
                stitchWorkerRunPromise = null;
            });
        });
        return worker;
    }

    async function triggerStitchWorker(reason) {
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

        const workerPromise = new Promise((resolve, reject) => {
            worker.on('message', (msg) => {
                if (msg.status === 'update') {
                    // Update worker status and reset timer
                    workerStatus.set(workerId, { message: msg.message, startTime: Date.now() });
                    displayWorkerStatuses();
                } else if (msg.status === 'done') {
                    workerStatus.set(workerId, { message: 'Idle - requesting next', startTime: Date.now() });
                    completedThisRun++;
                    console.log(
                        `Completed this run: ${completedThisRun}/${pendingCount} (overall ${alreadyUploaded + completedThisRun}/${totalReplays})`,
                    );
                    void fetchAndSendNext(workerId, worker, workerStatus, workerTerminationFlags, () => {
                        displayWorkerStatuses();
                    }, normalWorkerClaimOptions);
                    if (stitchWorkerEnabled) {
                        void triggerStitchWorker('normal worker completed');
                    }
                } else if (msg.status === 'error') {
                    console.error(`Worker ${workerId} error: ${msg.error}`);
                    workerStatus.set(workerId, { message: 'Idle - retry after error', startTime: Date.now() });
                    completedThisRun++;
                    console.log(
                        `Finished with error this run: ${completedThisRun}/${pendingCount} (overall ${alreadyUploaded + completedThisRun}/${totalReplays})`,
                    );
                    void fetchAndSendNext(workerId, worker, workerStatus, workerTerminationFlags, () => {
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
    for (let i = 0; i < workersToStart; i++) {
        const workerId = i + 1; // Assign a unique ID to each worker
        const worker = createWorker(workerId);
        void fetchAndSendNext(workerId, worker, workerStatus, workerTerminationFlags, () => {
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

                if (replay.recorded && !replay.overlaid) {
                    sendStatus('Already recorded; adding overlay');
                    await addOverlay(replay, buildOverlayText);
                    await markReplaysField([replay], { overlaid: true, stitch_pending: 1 });
                    replay.overlaid = true;
                    replay.stitch_pending = 1;
                    sendStatus('Deleting Files');
                    await deleteFiles(replay);
                    sendStatus('Handing to stitch/upload worker');
                    await finishReplay(replay, 'recorded fast-path - overlay added');
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
                replay.recorded = true;

                sendStatus('Adding Overlay');
                await addOverlay(replay, buildOverlayText);
                await markReplaysField([replay], { overlaid: true, stitch_pending: 1 });
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

async function fetchAndSendNext(workerId, worker, workerStatus, workerTerminationFlags, onStatus, options = {}) {
    const { includeStitchPending = true } = options;
    const shouldStop = () =>
        workerTerminationFlags.get(workerId)?.value || !worker || worker.threadId === undefined;

    if (shouldStop()) {
        return;
    }

    try {
        const replay = await claimNextReplay(claimTtlMs, { includeStitchPending });
        if (replay) {
            workerStatus.set(workerId, { message: `Replay #${replay.index} - queued`, startTime: Date.now() });
            onStatus?.();
            await appendRunLog(
                `Worker ${workerId} assigned replay #${replay.index} (recorded=${replay.recorded}, overlaid=${replay.overlaid}, stitched=${replay.stitched}, uploaded=${replay.uploaded}, skip=${replay.skip}, claimed_by=${replay.claimed_by}, claimed_at=${replay.claimed_at})`,
                'worker-assign',
                [],
            );
            if (shouldStop()) {
                return;
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
            setTimeout(() => {
                if (shouldStop()) return;
                fetchAndSendNext(workerId, worker, workerStatus, workerTerminationFlags, onStatus, options);
            }, 2000);
        } else {
            workerStatus.set(workerId, { message: 'Idle - no pending replays (will retry)', startTime: Date.now() });
            onStatus?.();
            setTimeout(() => {
                if (shouldStop()) return;
                fetchAndSendNext(workerId, worker, workerStatus, workerTerminationFlags, onStatus, options);
            }, 5000);
        }
    } catch (err) {
        console.error(`Worker ${workerId} failed to claim next replay: ${err.message}`);
        workerStatus.set(workerId, { message: 'Finished', startTime: Date.now() });
        onStatus?.();
        const flag = workerTerminationFlags.get(workerId);
        if (flag) flag.value = true;
        setTimeout(() => {
            if (shouldStop()) return;
            fetchAndSendNext(workerId, worker, workerStatus, workerTerminationFlags, onStatus, options);
        }, 5000);
    }
}
