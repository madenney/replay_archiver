import { spawn } from 'child_process'

// Kill a child and everything it spawned via its process group.
// spawnProcess uses { detached: true } so each child becomes its own pgroup
// leader (setsid on posix); process.kill(-pid, sig) targets that whole group.
// Prevents the AppImage-inner-binary orphan pattern where SIGKILLing the
// wrapper leaves the real Dolphin/ffmpeg running reparented under init.
export const killTree = (child, signal = 'SIGKILL') => {
  if (!child || !child.pid) return
  try {
    process.kill(-child.pid, signal)
  } catch (_) {
    try { child.kill(signal) } catch (__) { /* ignore */ }
  }
}

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
            killTree(child, 'SIGKILL');
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

// detached:true puts the child in its own process group so killTree() can
// signal the whole tree. We do NOT unref — parent still waits for exit.
export const spawnProcess = (cmd, args) => spawn(cmd, args, { detached: true });

export const killDolphinOnEndFrame = (child) => {
  if (!child || !child.stdout) {
    return;
  }

  let endFrame = Infinity;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (data) => {
    const lines = data.split('\r\n');
    lines.forEach((line) => {
      if (line.includes(`[PLAYBACK_END_FRAME]`)) {
        const regex = /\[PLAYBACK_END_FRAME\] ([0-9]*)/;
        const match = regex.exec(line);
        if (match && match[1]) {
          const parsed = parseInt(match[1], 10);
          endFrame = Number.isNaN(parsed) ? Infinity : parsed;
        } else {
          endFrame = Infinity;
        }
      } else if (line.includes(`[CURRENT_FRAME] ${endFrame}`)) {
        killTree(child, 'SIGTERM');
      }
    });
  });
};

