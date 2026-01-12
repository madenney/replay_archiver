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
