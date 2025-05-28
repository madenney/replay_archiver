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

import { asyncForEach, pad, convertIsoToMmDdYyyyHhMm } from './lib.js';
import { outputDir, ssbmIsoPath, dolphinPath, quality, bitrateKbps, numWorkers } from './config.js';

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
    console.log(`Starting to process ${totalReplays} replays with ${numWorkers} workers...`);

    // Create a queue of replays
    const replayQueue = [...replays];
    let completed = 0;

    // Worker pool array and status tracking
    const workers = [];
    const workerPromises = [];
    const workerStatus = new Map(); // Map to track worker status

    // Helper function to get the next non-done replay
    function getNextNonDoneReplay() {
        while (replayQueue.length > 0) {
            const replay = replayQueue.shift();
            if (!replay.done) {
                return replay;
            }
            completed++;
            console.log(`Skipping #${replay.index} - Completed ${completed}/${totalReplays} replays`);
        }
        return null; // Queue is empty or all remaining replays are done
    }

    // Function to display worker statuses
    function displayWorkerStatuses() {
        console.clear(); // Clear the terminal for a cleaner display
        console.log(`Processing ${totalReplays} replays with ${numWorkers} workers...`);
        console.log(`Completed: ${completed}/${totalReplays}`);
        console.log('\nWorker Statuses:');
        workerStatus.forEach((status, workerId) => {
            console.log(`Worker ${workerId}: ${status}`);
        });
        console.log('');
    }

    // Function to create a new worker
    function createWorker(workerId) {
        return new Promise((resolve, reject) => {
            const worker = new Worker(__filename, { workerData: { workerId } });
            workerStatus.set(workerId, 'Idle');
            worker.on('message', (msg) => {
                if (msg.status === 'update') {
                    // Update worker status
                    workerStatus.set(workerId, msg.message);
                    displayWorkerStatuses();
                } else if (msg.status === 'done') {
                    completed++;
                    console.log(`Completed ${completed}/${totalReplays} replays`);
                    // Process the next non-done replay if available
                    const nextReplay = getNextNonDoneReplay();
                    if (nextReplay) {
                        worker.postMessage(nextReplay);
                    } else {
                        workerStatus.set(workerId, 'Finished');
                        displayWorkerStatuses();
                        worker.terminate();
                    }
                } else if (msg.status === 'error') {
                    console.error(`Worker ${workerId} error: ${msg.error}`);
                    completed++;
                    console.log(`Completed ${completed}/${totalReplays} replays`);
                    const nextReplay = getNextNonDoneReplay();
                    if (nextReplay) {
                        worker.postMessage(nextReplay);
                    } else {
                        workerStatus.set(workerId, 'Finished');
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
            workers.push(worker);
            workerPromises.push(resolve);
        });
    }

    // Start the worker pool
    for (let i = 0; i < Math.min(numWorkers, replays.length); i++) {
        const workerId = i + 1; // Assign a unique ID to each worker
        const workerPromise = createWorker(workerId);
        const replay = getNextNonDoneReplay();
        if (replay) {
            workers[i].postMessage(replay);
        } else {
            workers[i].terminate();
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

    // Helper function to send status updates to the main thread
    function sendStatus(message) {
        parentPort.postMessage({ status: 'update', message: `Replay #${replayIndex} - ${message}` });
    }

    let replayIndex = 0; // Track the current replay index for status updates

    parentPort.on('message', async (replay) => {
        try {
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
            await markReplayDone(path.join('replays.json'), replay.index);

            parentPort.postMessage({ status: 'done' });
        } catch (error) {
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

    const process = spawn(dolphinPath, dolphinArgs);
    const exitPromise = exit(process);
    killDolphinOnEndFrame(process);
    await exitPromise;
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

    const process = spawn('ffmpeg', ffmpegMergeArgs);
    await exit(process);
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

    const process = spawn('python3', overlayArgs);
    await exit(process);
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
    const dolphinDirname = path.resolve('/home/matt/.config/SlippiPlayback');
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
const exit = (process) =>
    new Promise((resolve) => {
        process.on('exit', resolve);
    });

const killDolphinOnEndFrame = (process) => {
    let endFrame = Infinity;
    process.stdout.setEncoding('utf8');
    process.stdout.on('data', (data) => {
        const lines = data.split('\r\n');
        lines.forEach((line) => {
            if (line.includes(`[PLAYBACK_END_FRAME]`)) {
                const regex = /\[PLAYBACK_END_FRAME\] ([0-9]*)/;
                const match = regex.exec(line);
                endFrame = match && match[1] ? match[1] : Infinity;
            } else if (line.includes(`[CURRENT_FRAME] ${endFrame}`)) {
                process.kill();
            }
        });
    });
};

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