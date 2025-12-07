
import 'dotenv/config';
import { initDB } from './init_db.js';
import { record } from './record.js';
//import { analyzeSlippi } from './analyze_slippi.js';

async function main(){
    const args = process.argv.slice(2);

    // Regenerate replays.json and exit
    if (args.includes('--init') || args.includes('--create-json')) {
        await initDB();
        console.log(`Rebuilt database`);
        return;
    }

    await record();

}

main()
