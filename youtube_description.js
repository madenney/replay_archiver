export function extractArchiveTitle(title) {
  if (!title || typeof title !== 'string') {
    return null;
  }
  const idx = title.indexOf(':');
  if (idx === -1) {
    const trimmed = title.trim();
    return trimmed.length ? trimmed : null;
  }
  const candidate = title.slice(0, idx).trim();
  return candidate.length ? candidate : null;
}

const TIMESTAMP_BUFFER_SECONDS = 0.5;

function formatYouTubeTimestamp(totalSeconds) {
  const safeSeconds = Math.max(0, Math.ceil((totalSeconds || 0) + TIMESTAMP_BUFFER_SECONDS));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function buildYouTubeDescription({
  archiveTitle = 'Archive',
  startDate,
  endDate,
  indices = [],
  totalSeconds,
  durationsSeconds = [],
  durationsFrames = [],
  framesPerSecond = 60,
}) {
  const safeIndices = Array.isArray(indices) ? indices : [];
  const safeDurations = Array.isArray(durationsSeconds)
    ? durationsSeconds.map((duration) =>
        Number.isFinite(duration) && duration >= 0 ? duration : 0
      )
    : [];
  const safeDurationsFrames = Array.isArray(durationsFrames)
    ? durationsFrames.map((duration) =>
        Number.isFinite(duration) && duration >= 0 ? duration : 0
      )
    : [];
  const safeFps =
    Number.isFinite(framesPerSecond) && framesPerSecond > 0 ? framesPerSecond : 60;
  const lines = [`Total Games: ${safeIndices.length}`];

  lines.push('');
  lines.push('Game Index - Video Timestamp');
  if (safeDurationsFrames.length) {
    let elapsedFrames = 0;
    safeDurationsFrames.forEach((durationFrames, idx) => {
      const label = safeIndices[idx];
      const labelText =
        (typeof label === 'number' && Number.isFinite(label)) ||
        (typeof label === 'string' && label.trim())
          ? label
          : idx + 1;
      lines.push(`${labelText} - ${formatYouTubeTimestamp(elapsedFrames / safeFps)}`);
      elapsedFrames += durationFrames;
    });
  } else if (safeDurations.length) {
    let elapsedSeconds = 0;
    safeDurations.forEach((duration, idx) => {
      const label = safeIndices[idx];
      const labelText =
        (typeof label === 'number' && Number.isFinite(label)) ||
        (typeof label === 'string' && label.trim())
          ? label
          : idx + 1;
      lines.push(`${labelText} - ${formatYouTubeTimestamp(elapsedSeconds)}`);
      elapsedSeconds += duration;
    });
  } else {
    lines.push('None');
  }

  lines.push('');
  return lines.join('\n');
}
