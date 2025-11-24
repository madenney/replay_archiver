import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Main function to process replays with a worker pool
async function processReplaysWithWorkers(replays, numWorkers, workerTask) {
    const totalReplays = replays.length;
    console.log(`Starting to process ${totalReplays} replays with ${numWorkers} workers...`);

    // Create a queue of replays
    const replayQueue = [...replays];
    let completed = 0;

    // Worker pool array
    const workers = [];
    const workerPromises = [];

    // Function to create a new worker
    function createWorker() {
        return new Promise((resolve, reject) => {
            const worker = new Worker(__filename, { workerData: { task: workerTask } });
            worker.on('message', (msg) => {
                if (msg.status === 'done') {
                    completed++;
                    console.log(`Completed ${completed}/${totalReplays} replays`);
                    // Process the next replay if available
                    const nextReplay = replayQueue.shift();
                    if (nextReplay) {
                        worker.postMessage(nextReplay);
                    } else {
                        worker.terminate();
                    }
                }
            });
            worker.on('error', reject);
            worker.on('exit', (code) => {
                if (code !== 0) {
                    reject(new Error(`Worker stopped with exit code ${code}`));
                } else {
                    resolve();
                }
            });
            workers.push(worker);
            workerPromises.push(resolve);
        });
    }

    // Start the worker pool
    for (let i = 0; i < Math.min(numWorkers, replays.length); i++) {
        const workerPromise = createWorker();
        const replay = replayQueue.shift();
        if (replay) {
            workers[i].postMessage(replay);
        }
    }

    // Wait for all workers to complete
    await Promise.all(workerPromises);
    console.log('All replays processed.');
}

// Worker thread logic
if (!isMainThread) {
    const { task } = workerData;

    parentPort.on('message', async (replay) => {
        try {
            // Run the async task on the replay
            await task(replay);
            parentPort.postMessage({ status: 'done' });
        } catch (error) {
            console.error(`Worker error processing replay ${replay.index}:`, error);
            parentPort.postMessage({ status: 'error', error: error.message });
        }
    });
}

export { processReplaysWithWorkers };