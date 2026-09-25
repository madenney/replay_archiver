import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

function normalizeSeconds(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export async function probeDurationSeconds(filePath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  const parsed = Number.parseFloat(String(stdout).trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export async function getDurationsSecondsFromFfprobe(
  paths,
  fallbackSeconds = [],
  { label = 'ffprobe' } = {},
) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return Array.isArray(fallbackSeconds)
      ? fallbackSeconds.map((value) => normalizeSeconds(value))
      : [];
  }

  const durations = [];
  let ffprobeAvailable = true;
  let warnedMissing = false;

  for (let i = 0; i < paths.length; i += 1) {
    const filePath = paths[i];
    if (ffprobeAvailable && filePath) {
      try {
        const duration = await probeDurationSeconds(filePath);
        if (duration != null) {
          durations.push(duration);
          continue;
        }
        console.warn(`[${label}] ffprobe returned invalid duration for ${filePath}`);
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          ffprobeAvailable = false;
          if (!warnedMissing) {
            console.warn(`[${label}] ffprobe not available; falling back to provided durations.`);
            warnedMissing = true;
          }
        } else {
          console.warn(`[${label}] ffprobe failed for ${filePath}: ${err.message}`);
        }
      }
    }
    durations.push(normalizeSeconds(fallbackSeconds?.[i]));
  }

  return durations;
}

// Video codec name (e.g. "h264", "hevc") of the first video stream, or null.
// The concat demuxer with -c:v copy requires every input to share a codec:
// mixing h264 and hevc yields a file whose packets decode as garbage even
// though each input is individually valid, so the stitcher checks this first.
export async function probeVideoCodec(filePath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ])
  const name = String(stdout).trim()
  return name.length ? name : null
}

// Decode a few short windows spread across a file and count decoder errors.
// A full decode of an 8h video is far too slow to run after every stitch, but
// sampling catches the corruption classes that a container-level duration
// check cannot see.
export async function countDecodeErrorsSampled(filePath, durationSeconds, { windows = 6, windowSeconds = 8 } = {}) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null
  let total = 0
  for (let i = 0; i < windows; i += 1) {
    const at = Math.max(0, (durationSeconds * (i + 0.5)) / windows - windowSeconds / 2)
    try {
      const { stderr } = await execFileAsync('ffmpeg', [
        '-v', 'error',
        '-ss', String(Math.floor(at)),
        '-t', String(windowSeconds),
        '-i', filePath,
        '-f', 'null', '-',
      ], { maxBuffer: 16 * 1024 * 1024 })
      total += String(stderr || '').split('\n').filter((l) => l.trim().length).length
    } catch (err) {
      total += String(err?.stderr || err?.message || '').split('\n').filter((l) => l.trim().length).length
    }
  }
  return total
}
