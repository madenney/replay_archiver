
import path from 'path';
import fs from 'fs/promises';

import { createJSON } from './create_json.js';
import { record } from './record.js';
//import { analyzeSlippi } from './analyze_slippi.js';

const jsonPath = path.join('replays.json');

async function main(){

    // only need to run this once
    // await createJSON(jsonPath);
    // return

    // Read and return the contents of replays.json
    const json = JSON.parse( await fs.readFile(jsonPath, 'utf8'));    
    console.log(json.length)

    await record(json)

}

main()