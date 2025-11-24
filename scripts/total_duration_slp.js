import 'dotenv/config'
import fs from 'fs'
import { promises as fsPromises } from 'fs'
import { SlippiGame } from '@slippi/slippi-js'
import path from 'path'
import { initSchema, getVideoEntries, endPool, updateFlags } from '../db.js'

function formatDuration(secondsTotal) {
  const hrs = Math.floor(secondsTotal / 3600)
  const mins = Math.floor((secondsTotal % 3600) / 60)
  const secs = Math.floor(secondsTotal % 60)
  return `${hrs} hours ${mins} minutes ${secs} seconds`
}

async function slpDuration(filePath) {
  try {
    const game = new SlippiGame(filePath)
    const meta = game.getMetadata() || {}
    return typeof meta?.lastFrame === 'number' ? meta.lastFrame / 60 : null
  } catch (err) {
    return null
  }
}

async function main() {
  await initSchema()
  const rows = await getVideoEntries()
  let totalSeconds = 0
  let haveDuration = 0
  const missing = []

  for (const r of rows) {
    if (typeof r.video_duration_seconds === 'number' && !Number.isNaN(r.video_duration_seconds)) {
      totalSeconds += r.video_duration_seconds
      haveDuration++
      if (haveDuration % 100 === 0) {
        console.log(`Counted ${haveDuration}/${rows.length} replays — total so far: ${formatDuration(totalSeconds)}`)
      }
      continue
    }
    const duration = await slpDuration(r.file_path)
    if (duration != null) {
      totalSeconds += duration
      haveDuration++
      // persist it so we don’t recompute next time
      await updateFlags([r.index], { video_duration_seconds: duration })
      if (haveDuration % 100 === 0) {
        console.log(`Counted ${haveDuration}/${rows.length} replays — total so far: ${formatDuration(totalSeconds)}`)
      }
    } else {
      missing.push(r.index)
    }
  }

  console.log(`Replays with duration: ${haveDuration}/${rows.length}`)
  console.log(`Missing durations: ${missing.length}`)
  if (missing.length) {
    console.log(`Missing idx: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ' ...' : ''}`)
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
