import pkg from '@slippi/slippi-js';
const { SlippiGame } = pkg;
import fs from 'fs/promises';

async function analyzeSlippi(jsonPath, maxIterations) {
    try {
        // Read the replays.json file
        const rawData = await fs.readFile(jsonPath, 'utf8');
        const replays = JSON.parse(rawData);

        // Limit the number of iterations for testing
        const iterations = Math.min(maxIterations, replays.length);
        console.log(`Processing ${iterations} of ${replays.length} replays...`);

        // Iterate through the replays up to maxIterations
        for (let i = 0; i < iterations; i++) {
            const replay = replays[i];
            const filePath = replay.file_path;

            try {
                // Load the Slippi game file
                const game = new SlippiGame(filePath);

                // Get game settings
                const settings = game.getSettings();

                // Get the game length in frames (from metadata)
                const metadata = game.getMetadata();
                const gameLengthFrames = metadata?.lastFrame || 0; // Last frame of the game, or 0 if not available

                // Update the replay object with game length
                replay.game_length_frames = gameLengthFrames;
                console.log(`Processed ${filePath}: ${gameLengthFrames} frames`);
            } catch (error) {
                console.error(`Error processing ${filePath}:`, error);
                replay.game_length_frames = -1; // Indicate error
            }
        }

        // Write the updated replays back to the JSON file
        await fs.writeFile(jsonPath, JSON.stringify(replays, null, 2));
        console.log(`Updated ${jsonPath} with game lengths`);

        // Return the updated replays (first maxIterations entries)
        return replays.slice(0, iterations);
    } catch (error) {
        console.error('Error in analyzeSlippi:', error);
        throw error;
    }
}

export { analyzeSlippi };