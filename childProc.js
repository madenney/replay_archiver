import { spawn } from 'child_process'
import { killTree } from 'slippi-dolphin-runner'

// This file is now only for ffmpeg and overlay.py. Dolphin is spawned by
// slippi-dolphin-runner, which owns its own stdout parsing, stall watchdog and
// process-tree kill. What used to live here and why it is gone:
//
//   killDolphinOnEndFrame  the [CURRENT_FRAME] matcher. It used
//                          `line.includes('[CURRENT_FRAME] ' + endFrame)`, so
//                          frame 845 matched inside 8454 and the dump was cut
//                          to a tenth of the game; it also split stdout on
//                          '\r\n' only, and never reassembled a line split
//                          across two chunks.
//   killTree (pgroup)      process.kill(-pid). The package walks the actual
//                          process tree instead, which is what an AppImage
//                          needs — it execs, so the emulator is not the direct
//                          child.
//   the wall-clock timeout  for Dolphin it is now record()'s hardTimeoutMs,
//                          which SIGTERMs and still hands back the partial
//                          dump to be judged, rather than discarding it.

export const runChildProcess = (child, { name, replayIndex, timeoutMs }) =>
  new Promise((resolve, reject) => {
    let finished = false;
    const logBuffer = [];
    const pushLog = (prefix, chunk) => {
      const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
      lines.forEach((line) => {
        const entry = `[${prefix}] ${line}`;
        logBuffer.push(entry);
        if (logBuffer.length > 50) {
          logBuffer.shift();
        }
      });
    };

    // Drain both pipes. An unread stderr fills at ~64KB and blocks the child.
    if (child.stdout) {
      child.stdout.on('data', (data) => pushLog(`${name}#${replayIndex} stdout`, data));
    }
    if (child.stderr) {
      child.stderr.on('data', (data) => pushLog(`${name}#${replayIndex} stderr`, data));
    }

    const done = (err) => {
      if (finished) return;
      finished = true;
      if (timeout) clearTimeout(timeout);
      if (err) {
        console.error(`${name} failed for replay #${replayIndex}: ${err.message}`);
        if (logBuffer.length) {
          console.error(logBuffer.slice(-10).join('\n'));
        }
        reject(err);
      } else {
        resolve();
      }
    };

    const timeout =
      timeoutMs != null
        ? setTimeout(() => {
            const err = new Error(`${name} timed out for replay #${replayIndex} after ${timeoutMs}ms`);
            if (child.pid) killTree(child.pid);
            done(err);
          }, timeoutMs)
        : null;

    child.on('error', (err) => done(err));
    child.on('exit', (code, signal) => {
      if (code === 0) {
        done();
      } else {
        done(new Error(`${name} exited with code ${code} (signal ${signal}) for replay #${replayIndex}`));
      }
    });
  });

export const spawnProcess = (cmd, args) => spawn(cmd, args);
