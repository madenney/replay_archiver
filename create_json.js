import fs from 'fs/promises';
import path from 'path';

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
        const replays = withDates.map((entry, idx) => ({
            file_path: entry.filePath,
            index: idx + 1,
            id: padId(idx + 1),
            date: entry.date || null,
            recorded: false,
            overlaid: false,
            stitched: false,
            uploaded: false,
            skip: false,
        }));

        // Write to replays.json
        await fs.writeFile(jsonPath, JSON.stringify(replays, null, 2));
        console.log(`Wrote ${replays.length} entries to ${jsonPath}`);

    } catch (error) {
        console.error('Error in createJSON:', error);
        throw error;
    }
}

export { createJSON }; // Use ESM export syntax
