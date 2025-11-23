
import 'dotenv/config';
import path from 'path';
import fs from 'fs/promises';

import { initDB } from './init_db.js';
import { record } from './record.js';
//import { analyzeSlippi } from './analyze_slippi.js';

const dbPath = process.env.REPLAYS_DB_PATH || path.join('replays.db');

async function main(){
    const args = process.argv.slice(2);

// Regenerate replays.json and exit
if (args.includes('--init') || args.includes('--create-json')) {
    await initDB(dbPath);
    console.log(`Rebuilt ${dbPath}`);
    return;
}

let existed = true;
try {
    await fs.access(dbPath);
} catch (err) {
    if (err.code === 'ENOENT') {
        existed = false;
        console.log(`${dbPath} not found. Creating...`);
        await initDB(dbPath);
    } else {
        throw err;
    }
}

if (!existed) {
    console.log(`Created ${dbPath}. Run the script again to start processing.`);
    return;
}

await record();

}

main()
