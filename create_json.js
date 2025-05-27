import fs from 'fs/promises';
import path from 'path';

const replay_directory_path = "/media/matt/slippi_db/lunar_db/netplay/Hax$";

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

// Main function to create and return replays.json
async function createJSON(jsonPath) {
    try {
        // Get all .slp files using the separate function
        const slpFilePaths = await getSlpFiles(replay_directory_path);
        console.log(`Found ${slpFilePaths.length} .slp files`);

        // Create array of objects with file paths
        const replays = slpFilePaths.map(filePath => ({ file_path: filePath }));

        // Write to replays.json
        await fs.writeFile(jsonPath, JSON.stringify(replays, null, 2));
        console.log(`Wrote ${replays.length} entries to ${jsonPath}`);

    } catch (error) {
        console.error('Error in createJSON:', error);
        throw error;
    }
}

export { createJSON }; // Use ESM export syntax