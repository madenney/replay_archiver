
import path from 'path';
import fs from 'fs/promises';

import { createJSON } from './create_json.js';
import { record } from './record.js';
//import { analyzeSlippi } from './analyze_slippi.js';

const jsonPath = path.join('replays.json');

async function main(){
    const args = process.argv.slice(2);

    // Regenerate replays.json and exit
    if (args.includes('--init') || args.includes('--create-json')) {
        await createJSON(jsonPath);
        console.log(`Rebuilt ${jsonPath}`);
        return;
    }

    // Read and return the contents of replays.json
    const allReplays = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
    const pendingReplays = allReplays.filter((replay) => !replay.done);
    console.log(`Loaded ${allReplays.length} replays, ${pendingReplays.length} pending`);

    await record(pendingReplays);

}

main()
