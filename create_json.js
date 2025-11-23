import fs from 'fs/promises';
import path from 'path';
import SlippiPkg from '@slippi/slippi-js';
const { SlippiGame } = SlippiPkg;

const replay_directory_path = "/media/user/slippi_db/lunar_db/netplay/Hax$";
const ID_WIDTH = 7; // e.g., 0000001

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

async function extractPlayers(filePath) {
    try {
        const game = new SlippiGame(filePath);
        const metadata = game.getMetadata() || {};
        const players = normalizePlayers(metadata.players);
        const tags = players.map((p, idx) => formatTag(p, `P${idx + 1}`));
        const codes = players.map((p) => (p?.names?.code ? p.names.code : ''));
        return { tags, codes };
    } catch (err) {
        return { tags: [], codes: [] };
    }
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

// Main function to create and return replays.json
async function createJSON(jsonPath) {
    try {
        // Get all .slp files using the separate function
        const slpFilePaths = await getSlpFiles(replay_directory_path);
        console.log(`Found ${slpFilePaths.length} .slp files`);

        // Sort by date parsed from filename (oldest first)
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

        // Create array of objects with file paths
        const replays = [];
        for (let i = 0; i < withDates.length; i++) {
            const entry = withDates[i];
            const index = i + 1;
            const { tags, codes } = await extractPlayers(entry.filePath);
            replays.push({
                file_path: entry.filePath,
                index,
                id: padId(index),
                date: entry.date || null,
                players: tags,
                codes,
                recorded: false,
                overlaid: false,
                stitched: false,
                uploaded: false,
                skip: false,
            });
        }

        // Write to replays.json
        await fs.writeFile(jsonPath, JSON.stringify(replays, null, 2));
        console.log(`Wrote ${replays.length} entries to ${jsonPath}`);

    } catch (error) {
        console.error('Error in createJSON:', error);
        throw error;
    }
}

export { createJSON }; // Use ESM export syntax
