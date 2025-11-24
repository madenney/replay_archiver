import fs from 'fs'
import { promises as fsPromises } from 'fs'
import { runLogPath } from './paths.js'

export async function appendRunLog(info, cmd, args = []) {
  const timestamp = new Date().toISOString();
  const line = [
    `[${timestamp}]`,
    info,
    cmd && cmd !== 'worker-assign' && !cmd.startsWith('worker-')
      ? `Command: ${cmd} ${args.join(' ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  try {
    await fsPromises.appendFile(runLogPath, `${line}\n\n`);
  } catch (err) {
    console.error(`Failed to write to run log: ${err.message}`);
  }
}

export function formatDuration(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function sanitizeFileName(name) {
  return name.replace(/[^a-z0-9-_]+/gi, '_');
}

export function escapeForFfmpegList(str) {
  return str.replace(/'/g, "'\\''");
}

export async function appendUploadsLog(entry, uploadsLogPath) {
  try {
    const existing = await readJsonFileSafe(uploadsLogPath, []);
    existing.push(entry);
    await fsPromises.writeFile(uploadsLogPath, JSON.stringify(existing, null, 2));
  } catch (err) {
    console.error(`Failed to write uploads log: ${err.message}`);
  }
}

export async function readJsonFileSafe(filePath, defaultValue) {
  try {
    const data = await fsPromises.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return defaultValue;
    }
    throw err;
  }
}

export async function fileExists(filePath) {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch (_) {
    return false;
  }
}

