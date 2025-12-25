
import 'dotenv/config';
import { initDB } from './init_db.js';
import { record, stitchOnly } from './record.js';
//import { analyzeSlippi } from './analyze_slippi.js';

function getFlagValue(args, flags) {
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        for (const flag of flags) {
            if (arg === flag) return args[i + 1];
            if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
        }
    }
    return null;
}

function parseTestReplayIndex(args) {
    const raw = getFlagValue(args, ['-t', '--test']);
    if (raw === null) return null;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
        console.error(`Invalid --test/-t value: ${raw}. Expected a non-negative integer.`);
        process.exit(1);
    }
    return value;
}

async function main(){
    const args = process.argv.slice(2);
    const stitchOnlyFlag = args.includes('-s') || args.includes('--stitch-only');
    const recordOnlyFlag = args.includes('-r') || args.includes('--record-only');
    const clearFlag = args.includes('-c') || args.includes('--clear');
    const testReplayIndex = parseTestReplayIndex(args);

    if (stitchOnlyFlag && recordOnlyFlag) {
        console.error('Choose either stitch-only (-s) or record-only (-r), not both.');
        process.exit(1);
    }

    if (testReplayIndex !== null && (args.includes('--init') || args.includes('--create-json'))) {
        console.error('Choose either --test/-t or --init/--create-json, not both.');
        process.exit(1);
    }

    // Regenerate replays.json and exit
    if (args.includes('--init') || args.includes('--create-json')) {
        await initDB();
        console.log(`Rebuilt database`);
        return;
    }

    if (stitchOnlyFlag) {
        await stitchOnly({ testReplayIndex, clearUnfinished: clearFlag });
        return;
    }

    const mode = recordOnlyFlag ? 'record-only' : 'full';
    await record({ mode, testReplayIndex, clearUnfinished: clearFlag });

}

main()
