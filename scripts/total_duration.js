import 'dotenv/config'
import { initSchema, getVideoEntries, endPool } from '../db.js'

function formatDuration(secondsTotal) {
  const hrs = Math.floor(secondsTotal / 3600)
  const mins = Math.floor((secondsTotal % 3600) / 60)
  const secs = Math.floor(secondsTotal % 60)
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

async function main() {
  await initSchema()
  const rows = await getVideoEntries()
  const withDur = rows.filter((r) => typeof r.video_duration_seconds === 'number' && !Number.isNaN(r.video_duration_seconds))
  const missing = rows.length - withDur.length
  const totalSeconds = withDur.reduce((acc, r) => acc + (r.video_duration_seconds || 0), 0)

  console.log(`Replays with duration: ${withDur.length}/${rows.length}`)
  if (missing > 0) {
    console.log(`Missing durations: ${missing}`)
  }
  console.log(`Total seconds: ${Math.round(totalSeconds)}`)
  console.log(`Total duration (hh:mm:ss): ${formatDuration(totalSeconds)}`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => {
    void endPool().catch(() => {})
  })
