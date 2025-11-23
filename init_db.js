import fs from 'fs/promises';
import path from 'path';
import { createRequire } from 'module';
import { clearReplays, insertReplayBatch } from './db.js';

const replay_directory_path = "/media/user/slippi_db/lunar_db/netplay/Hax$";
const ID_WIDTH = 7; // e.g., 0000001
const LOG_EVERY = Number(process.env.INIT_PROGRESS_EVERY || 1000);
const SKIP_METADATA =
  process.env.INIT_SKIP_METADATA === 'true' ||
  process.env.SKIP_METADATA === 'true';
const require = createRequire(import.meta.url);

// Function to recursively get all .slp file paths
async function getSlpFiles(dir) {
    let slpFiles = [];
    const files = await fs.readdir(dir, { withFileTypes: true });

    for (const file of files) {
        const fullPath = path.join(dir, file.name);
        if (file.isDirectory()) {
            const subFiles = await getSlpFiles(fullPath);
            slpFiles = slpFiles.concat(subFiles);
        } else if (file.name.endsWith('.slp')) {
            slpFiles.push(fullPath);
        }
    }

    return slpFiles;
}

function padId(num) {
    let str = num.toString();
    while (str.length < ID_WIDTH) {
        str = '0' + str;
    }
    return str;
}

function parseDateFromFilename(filePath) {
    // Expect filenames like Game_YYYYMMDDThhmmss.slp
    const base = path.basename(filePath);
    const match = /Game_(\d{8}T\d{6})/i.exec(base);
    if (!match) return null;
    const ts = match[1]; // YYYYMMDDThhmmss
    const iso =
        ts.slice(0, 4) +
        '-' +
        ts.slice(4, 6) +
        '-' +
        ts.slice(6, 8) +
        'T' +
        ts.slice(9, 11) +
        ':' +
        ts.slice(11, 13) +
        ':' +
        ts.slice(13, 15) +
        'Z';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
}

// Main function to create and return replays db
async function initDB(dbPathIgnored) {
    try {
        const slpFilePaths = await getSlpFiles(replay_directory_path);
        console.log(`Found ${slpFilePaths.length} .slp files`);

        const withDates = slpFilePaths.map((filePath) => {
            return {
                filePath,
                date: parseDateFromFilename(filePath),
            };
        });
        withDates.sort((a, b) => {
            const at = a.date ? new Date(a.date).getTime() : Infinity;
            const bt = b.date ? new Date(b.date).getTime() : Infinity;
            if (at === bt) return a.filePath.localeCompare(b.filePath);
            return at - bt;
        });

        clearReplays();

        const toInsert = [];

        for (let i = 0; i < withDates.length; i++) {
            const entry = withDates[i];
            const index = i + 1;
            let tags = [];
            let codes = [];
            let lastFrame = null;
            let startAt = entry.date || null;
            if (!SKIP_METADATA) {
                const meta = await extractMetadata(entry.filePath);
                tags = meta.tags;
                codes = meta.codes;
                lastFrame = meta.lastFrame;
                if (meta.startAt) {
                    startAt = meta.startAt;
                }
            }
            toInsert.push({
                file_path: entry.filePath,
                index,
                id: padId(index),
                date: startAt,
                players: tags,
                codes,
                game_length_frames: lastFrame,
                recorded: false,
                overlaid: false,
                stitched: false,
                uploaded: false,
                skip: false,
                claimed_by: null,
                claimed_at: null,
            });
            if ((index % LOG_EVERY === 0) || index === withDates.length) {
                console.log(`Prepared ${index}/${withDates.length} replays`);
            }
        }

        insertReplayBatch(toInsert);

        console.log(`Wrote ${withDates.length} entries to database`);

    } catch (error) {
        console.error('Error in initDB:', error);
        throw error;
    }
}

async function extractMetadata(filePath) {
    try {
        const SlippiGame = await loadSlippiGame();
        const game = new SlippiGame(filePath);
        const metadata = game.getMetadata() || {};
        const players = normalizePlayers(metadata.players);
        const tags = players.map((p, idx) => formatTag(p, `P${idx + 1}`));
        const codes = players.map((p) => (p?.names?.code ? p.names.code : ''));
        const lastFrame =
            typeof metadata.lastFrame === 'number' ? metadata.lastFrame : null;
        const startAt = metadata.startAt || null;
        return { tags, codes, lastFrame, startAt };
    } catch (err) {
        return { tags: [], codes: [], lastFrame: null, startAt: null };
    }
}

let cachedSlippiGame = null;
async function loadSlippiGame() {
    if (cachedSlippiGame) return cachedSlippiGame;
    try {
        const SlippiPkg = require('@slippi/slippi-js');
        const GameCtor =
            SlippiPkg.SlippiGame ||
            (SlippiPkg.default && SlippiPkg.default.SlippiGame);
        if (GameCtor) {
            cachedSlippiGame = GameCtor;
            return GameCtor;
        }
    } catch (_) {
        // ignore, fallback to dynamic import
    }
    const SlippiPkg = await import('@slippi/slippi-js');
    const GameCtor =
        SlippiPkg.SlippiGame ||
        (SlippiPkg.default && SlippiPkg.default.SlippiGame);
    if (!GameCtor) {
        throw new Error('Unable to load SlippiGame from @slippi/slippi-js');
    }
    cachedSlippiGame = GameCtor;
    return GameCtor;
}

function normalizePlayers(playersObj) {
    if (!playersObj) return [];
    if (Array.isArray(playersObj)) return playersObj;
    const entries = Object.entries(playersObj)
        .map(([k, v]) => {
            const num = Number(k);
            return { idx: Number.isNaN(num) ? k : num, data: v };
        })
        .sort((a, b) => {
            if (typeof a.idx === 'number' && typeof b.idx === 'number') {
                return a.idx - b.idx;
            }
            if (typeof a.idx === 'number') return -1;
            if (typeof b.idx === 'number') return 1;
            return String(a.idx).localeCompare(String(b.idx));
        });
    return entries.map((e) => e.data);
}

function formatTag(player, fallback) {
    if (!player) return fallback || '';
    const names = player.names || {};
    return names.netplay || names.code || fallback || '';
}

export { initDB };
