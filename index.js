
import path from 'path';
import fs from 'fs/promises';

import { createJSON } from './create_json.js';
import { record } from './record.js';
//import { analyzeSlippi } from './analyze_slippi.js';

const jsonPath = process.env.REPLAYS_JSON_PATH || path.join('replays.json');

async function main(){
    const args = process.argv.slice(2);

// Regenerate replays.json and exit
if (args.includes('--init') || args.includes('--create-json')) {
    await createJSON(jsonPath);
    console.log(`Rebuilt ${jsonPath}`);
    return;
}

let existed = true;
try {
    await fs.access(jsonPath);
} catch (err) {
    if (err.code === 'ENOENT') {
        existed = false;
        console.log(`${jsonPath} not found. Creating...`);
        await createJSON(jsonPath);
    } else {
        throw err;
    }
}

if (!existed) {
    console.log(`Created ${jsonPath}. Run the script again to start processing.`);
    return;
}

// Read and process the contents of replays.json
const allReplays = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
console.log(`Loaded ${allReplays.length} replays`);

await record(allReplays);

}

main()
