import path from 'path';
import readline from 'readline';
import crypto from 'crypto';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import os from 'os';
import { spawn } from 'child_process';

import { asyncForEach, pad, convertIsoToMmDdYyyyHhMm } from './lib.js';

const outputDir = '/home/matt/Projects/replay_archiver/output';
const ssbmIsoPath = '/home/matt/Files/melee/melee(static_fd_background).iso';
const dolphinPath = '/home/matt/.config/Slippi Launcher/playback/Slippi_Playback-x86_64.AppImage';
const quality = 2;
const bitrateKbps = 15000;

export async function record(replays) {
    console.log('HEY');

    // Configure Dolphin settings once before processing replays
    await configureDolphin();

    // Process each replay sequentially
    await asyncForEach(replays, async (replay) => {

        if(replay.done) return console.log(`Skipping #${replay.index}`)

        console.log(`Replay #${replay.index} - ${replay.file_path}`);
        await generateDolphinConfig(replay);
        await run_dolphin(replay);
        await merge_video(replay);
        await add_overlay(replay);
        await delete_files(replay);
        await markReplayDone(path.join('replays.json'), replay.index);
    });
}

async function add_overlay(replay) {
    const fileBasename = pad(replay.index, 6);
    const overlayArgs = [
        path.resolve('./overlay.py'),
        path.resolve(outputDir, `${fileBasename}-merged.avi`),
        path.resolve(outputDir, `${fileBasename}.avi`),
        convertIsoToMmDdYyyyHhMm(replay.date),
    ];

    const process = spawn('python3', overlayArgs);
    const exitPromise = exit(process);
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
    //console.log(ffmpegMergeArgs.join(' '));
    const process = spawn('ffmpeg', ffmpegMergeArgs);
    const exitPromise = exit(process);
    await exitPromise;
}

async function delete_files(replay) {
    const fileBasename = pad(replay.index, 6);
    const filesToDelete = [
        `${fileBasename}-unmerged.avi`,
        `${fileBasename}-unmerged.wav`,
        `${fileBasename}-merged.avi`,
        `${fileBasename}.json`,
    ];

    for (const file of filesToDelete) {
        const filePath = path.resolve(outputDir, file);
        if (fs.existsSync(filePath)) {
            await fsPromises.unlink(filePath);
        }
    }
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

async function configureDolphin() {
    let gameSettingsPath = null;
    let graphicsSettingsPath = null;
    let dolphinSettingsPath = null;

    const dolphinDirname = path.resolve('/home/matt/.config/SlippiPlayback');
    gameSettingsPath = path.join(dolphinDirname, 'GameSettings', 'GALE01.ini');
    graphicsSettingsPath = path.join(dolphinDirname, 'Config', 'GFX.ini');
    dolphinSettingsPath = path.join(dolphinDirname, 'Config', 'Dolphin.ini');

    // Ensure directories exist and create game settings file if missing
    await fsPromises.mkdir(path.dirname(gameSettingsPath), { recursive: true });
    if (!fs.existsSync(gameSettingsPath)) {
        console.log('Creating game settings file');
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

async function markReplayDone(jsonPath, index) {
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
    } catch (error) {
        console.error('Error in markReplayDone:', error);
        throw error;
    }
}