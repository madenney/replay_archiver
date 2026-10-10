import path from 'path'
import fs from 'fs'
import { promises as fsPromises } from 'fs'
import { createRequire } from 'module'
import { spawnProcess, runChildProcess } from './childProc.js'
import { buildProfile, record, dolphinStatus, healRealProfile } from 'slippi-dolphin-runner'
import { config } from './config.js'
import { appendRunLog } from './util_log.js'
import { pad, convertIsoToMmDdYyyyHhMm } from './lib.js'
import { probeDurationSeconds } from './ffprobe.js'

// Dolphin plays from frame -123 through (game_length_frames - 1), so the
// expected recording covers game_length_frames + 123 frames at 60 fps.
// Matches stitcher.js's LEAD_IN_FRAMES.
const DOLPHIN_LEAD_IN_FRAMES = 123
const DOLPHIN_FPS = 60
// If Dolphin dies (SIGKILL, crash, EIO on scratch) it can leave a partial .avi
// whose duration is much shorter than the game. Throwing here feeds into the
// worker's recordReplayError path (auto-skip after MAX_REPLAY_ERRORS attempts)
// instead of letting the truncation propagate through overlay -> stitch.
const DOLPHIN_DURATION_TOLERANCE_SECONDS = 5

// The Gecko codes this archive records with. Written into each throwaway
// profile's GameSettings/GALE01.ini, never the operator's own.
const GECKO_INI = [
  '[Gecko]',
  '[Gecko_Enabled]',
  '$Optional: Game Music OFF',
  '$Optional: Widescreen 16:9',
  '[Gecko_Disabled]',
  '$Optional: Show Player Names',
].join('\n')

const ASPECT_RATIO_FORCE_16_9 = 6

// Run once per process, before any worker records. Older versions of this
// pipeline spawned Dolphin with no --user at all and rewrote the operator's
// real profile in place, leaving them with a framedump rig; healRealProfile()
// forces those dump flags back off.
export async function prepareDolphin() {
  const paths = { dolphinPath: config.dolphinPath, isoPath: config.ssbmIsoPath }
  const why = dolphinStatus(paths)
  if (why) throw new Error(`Dolphin is not runnable: ${why}`)
  await healRealProfile(config.dolphinPath)
  await appendRunLog('healRealProfile() ran against the real Dolphin profile', 'dolphin-heal', [])
}

// One throwaway profile per concurrent Dolphin. Mandatory: the dump path is a
// property of the user dir, so workers sharing one would silently overwrite
// each other's frames and produce footage from the wrong replay.
const workerProfiles = new Map()
export async function ensureWorkerProfile(workerId) {
  const existing = workerProfiles.get(workerId)
  if (existing) return existing

  const userDir = path.join(config.dolphinProfileDir, `worker-${workerId}`)
  await fsPromises.rm(userDir, { recursive: true, force: true })

  const opts = {
    mode: 'record',
    dolphinPath: config.dolphinPath,
    // EFBScale is an enum, not a multiplier. Always passed: inheriting it is
    // how a run ends up dumping at 4x and crawling.
    efbScale: config.quality,
    aspectRatio: ASPECT_RATIO_FORCE_16_9,
    geckoIni: GECKO_INI,
  }
  if (Number.isFinite(config.bitrateKbps)) opts.bitrateKbps = config.bitrateKbps
  // Left unset, the codec is inherited from the operator's profile, which is
  // what this pipeline did before the runner existed.
  if (config.dumpCodec) opts.dumpCodec = config.dumpCodec
  if (config.emulationSpeed != null) opts.emulationSpeed = config.emulationSpeed

  await buildProfile(userDir, opts)
  await appendRunLog(
    `built Dolphin profile for worker ${workerId} at ${userDir} ` +
    `(efbScale=${config.quality}, dumpCodec=${config.dumpCodec ?? 'inherited'})`,
    'dolphin-profile',
    [],
  )
  workerProfiles.set(workerId, userDir)
  return userDir
}

export async function runDolphin(replay, workerId) {
  const fileBasename = pad(replay.index, 6)
  const userDir = await ensureWorkerProfile(workerId)
  await fsPromises.mkdir(config.workingGamesDir, { recursive: true })

  // The frame range comes from our database, so the runner never has to scan
  // the .slp footer. endFrame stays (lastFrame - 1): frames -123..endFrame
  // inclusive is exactly game_length_frames + 123, which is what the duration
  // guard below and stitcher.js's LEAD_IN_FRAMES both assume.
  const lastFrame = typeof replay.game_length_frames === 'number' ? replay.game_length_frames : 0
  const startFrame = -DOLPHIN_LEAD_IN_FRAMES
  let endFrame = Math.max(0, lastFrame - 1)
  if (endFrame <= startFrame) endFrame = startFrame + 1

  await appendRunLog(
    `Dolphin record for replay #${replay.index} (userDir=${userDir}, frames ${startFrame}..${endFrame})`,
    'dolphin-record',
    [],
  )

  let res
  try {
    res = await record(
      { dolphinPath: config.dolphinPath, isoPath: config.ssbmIsoPath },
      replay.file_path,
      {
        outDir: config.workingGamesDir,
        userDir,
        baseName: `${fileBasename}-unmerged`,
        // Workers share one workingGamesDir and the runner's default comm
        // filename is fixed, so without this they would overwrite each other's
        // comm and each record the other's replay.
        commPath: path.join(config.workingGamesDir, `${fileBasename}.json`),
        lastFrame: lastFrame > 0 ? lastFrame : undefined,
        startFrame,
        endFrame,
        // Replaces the old wall-clock watchdog. SIGTERMs and resolves with
        // stalled:true rather than discarding a partial dump — the duration
        // guard below decides whether the footage is usable.
        hardTimeoutMs: config.dolphinTimeoutMs,
      },
    )
  } catch (err) {
    throw new Error(`Dolphin record failed for replay #${replay.index}: ${err.message}`)
  }

  if (res.stalled) {
    // Not a verdict: measured dumps at the moment of a stall have been anywhere
    // from 27% to 94% complete. Log it and let the duration check judge.
    await appendRunLog(
      `Dolphin stalled on replay #${replay.index}: ${JSON.stringify(res.diagnostic)}`,
      'dolphin-stall',
      [],
    )
  }

  const expectedFrames = typeof replay.game_length_frames === 'number' ? replay.game_length_frames : null
  if (expectedFrames && expectedFrames > 0) {
    const expectedSeconds = (expectedFrames + DOLPHIN_LEAD_IN_FRAMES) / DOLPHIN_FPS
    const outputPath = res.avi
    let actualSeconds = null
    try {
      actualSeconds = await probeDurationSeconds(outputPath)
    } catch (err) {
      throw new Error(`Dolphin post-record probe failed for replay #${replay.index}: ${err.message}`)
    }
    if (actualSeconds == null) {
      throw new Error(`Dolphin produced unreadable .avi for replay #${replay.index} (ffprobe returned no duration)`)
    }
    if (expectedSeconds - actualSeconds > DOLPHIN_DURATION_TOLERANCE_SECONDS) {
      throw new Error(
        `Dolphin recorded truncated .avi for replay #${replay.index}: ` +
        `expected ${expectedSeconds.toFixed(2)}s, got ${actualSeconds.toFixed(2)}s ` +
        `(short by ${(expectedSeconds - actualSeconds).toFixed(2)}s)` +
        (res.stalled ? ` [stalled: ${res.diagnostic?.reason ?? 'unknown'}]` : '')
      )
    }
  }
}

export async function mergeVideo(replay) {
  const fileBasename = pad(replay.index, 6)
  const ffmpegMergeArgs = [
    '-y',
    '-i',
    path.resolve(config.workingGamesDir, `${fileBasename}-unmerged.avi`),
    '-i',
    path.resolve(config.workingGamesDir, `${fileBasename}-unmerged.wav`),
    // keep video untouched; just mux audio so overlay step is the only lossy encode
    '-c:v',
    'copy',
    '-c:a',
    'pcm_s16le',
    '-shortest',
    path.resolve(config.workingGamesDir, `${fileBasename}-merged.avi`),
  ]

  await appendRunLog(`ffmpeg merge for replay #${replay.index}`, 'ffmpeg', ffmpegMergeArgs)
  const child = spawnProcess('ffmpeg', ffmpegMergeArgs)
  await runChildProcess(child, {
    name: 'ffmpeg (merge)',
    replayIndex: replay.index,
    timeoutMs: config.ffmpegTimeoutMs,
  })
}

export async function addOverlay(replay, overlayTextBuilder) {
  const fileBasename = pad(replay.index, 6)
  const overlayText = await overlayTextBuilder(replay)
  const overlayArgs = [
    path.resolve('./overlay.py'),
    path.resolve(config.workingGamesDir, `${fileBasename}-merged.avi`),
    path.resolve(config.workingGamesDir, `${fileBasename}.avi`),
    overlayText,
    path.resolve(config.workingGamesDir, `${fileBasename}-overlay.png`),
  ]

  await appendRunLog(`overlay.py for replay #${replay.index}`, 'python3', overlayArgs)
  const child = spawnProcess('python3', overlayArgs)
  await runChildProcess(child, {
    name: 'overlay.py',
    replayIndex: replay.index,
    timeoutMs: config.overlayTimeoutMs,
  })
}

export async function deleteFiles(replay) {
  if (config.keepTempFiles) {
    return
  }
  const fileBasename = pad(replay.index, 6)
  // All intermediates live in workingGamesDir (scratch when configured, else gamesDir).
  // The final NNNNNN.avi in workingGamesDir is also removed here — its canonical
  // copy lives in gamesDir (NFS) after publishOverlay ran. Final in gamesDir is NOT deleted.
  const filesToDelete = [
    `${fileBasename}-unmerged.avi`,
    `${fileBasename}-unmerged.wav`,
    `${fileBasename}-merged.avi`,
    `${fileBasename}-overlay.png`,
    `${fileBasename}.json`,
  ]
  if (config.scratchGamesDir) {
    // Scratch copy of final .avi — canonical copy is on NFS already
    filesToDelete.push(`${fileBasename}.avi`)
  }

  for (const file of filesToDelete) {
    const filePath = path.resolve(config.workingGamesDir, file)
    try {
      await fsPromises.unlink(filePath)
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error(`Failed to delete ${filePath}: ${error.message}`)
      }
    }
  }
}

// Atomically publish the final overlaid NNNNNN.avi from scratch to NFS.
// No-op when scratch is unused (everything is already in gamesDir).
//
// Atomicity guarantee: copy scratch→NFS as a temp file, then rename to the
// canonical name (rename within the same filesystem is atomic). If we crash
// before the rename, only the .tmp file exists — the next worker's full
// re-run will overwrite it cleanly.
export async function publishOverlay(replay) {
  if (!config.scratchGamesDir || config.scratchGamesDir === config.gamesDir) {
    return // legacy mode — overlay already wrote to gamesDir
  }
  const fileBasename = pad(replay.index, 6)
  const src = path.resolve(config.scratchGamesDir, `${fileBasename}.avi`)
  const finalDst = path.resolve(config.gamesDir, `${fileBasename}.avi`)
  const tmpDst = `${finalDst}.tmp.${process.pid}.${Date.now()}`

  await fsPromises.mkdir(config.gamesDir, { recursive: true })
  await fsPromises.copyFile(src, tmpDst)
  await fsPromises.rename(tmpDst, finalDst)
}

export async function ensureVideoDurationStored(replay, markReplaysField, fileExistsFn, getVideoDurationFn) {
  const fileBasename = pad(replay.index, 6)
  const finalPath = path.resolve(config.gamesDir, `${fileBasename}.avi`)
  if (!(await fileExistsFn(finalPath))) return null
  const duration = await getVideoDurationFn(finalPath)
  return duration
}

export async function buildOverlayText(replay) {
  const dateText = convertIsoToMmDdYyyyHhMm(replay.date)
  let p1 = ''
  let p2 = ''
  try {
    const playerInfo =
      replay.players && replay.players.length
        ? replay.players.map((tag, idx) => ({ tag, code: replay.codes?.[idx] || '' }))
        : await getPlayersForReplay(replay.file_path)
    const ownColor = await getArchivePlayerFoxColor(replay, playerInfo)
    if (ownColor && playerInfo[ownColor.index]) {
      playerInfo[ownColor.index] = {
        ...playerInfo[ownColor.index],
        code: `${ownColor.code} - ${ownColor.color}`,
      }
    }
    const names = playerInfo.map((p) => formatOverlayPlayerFromStored(p.tag, p.code))
    p1 = names[0] || ''
    p2 = names[1] || ''
  } catch (err) {
    console.warn(`Failed to read player names for replay #${replay.index}: ${err.message}`)
  }
  return `${dateText} - ${p1} vs ${p2}`
}

async function getPlayersForReplay(filePath) {
  const SlippiGame = await loadSlippiGame()
  const game = new SlippiGame(filePath)
  const metadata = game.getMetadata() || {}
  const players = normalizePlayers(metadata.players)
  return players.map((p, idx) => ({
    tag: extractPlayerTag(p, `P${idx + 1}`),
    code: extractPlayerCode(p),
  }))
}

function normalizePlayers(playersObj) {
  if (!playersObj) return []
  if (Array.isArray(playersObj)) return playersObj
  const entries = Object.entries(playersObj)
    .map(([k, v]) => {
      const num = Number(k)
      return { idx: Number.isNaN(num) ? k : num, data: v }
    })
    .sort((a, b) => {
      if (typeof a.idx === 'number' && typeof b.idx === 'number') {
        return a.idx - b.idx
      }
      if (typeof a.idx === 'number') return -1
      if (typeof b.idx === 'number') return 1
      return String(a.idx).localeCompare(String(b.idx))
    })
  return entries.map((e) => e.data)
}

function formatOverlayPlayer(player, fallback) {
  if (!player) return ''
  const names = player.names || {}
  const tag = names.netplay || ''
  const code = names.code || ''
  if (!tag) return ''
  return code ? `${tag} (${code})` : tag
}

function formatOverlayPlayerFromStored(tag, code) {
  if (!tag) return ''
  return code ? `${tag} (${code})` : tag
}

function extractPlayerTag(player, fallback) {
  if (!player) return fallback || ''
  const names = player.names || {}
  return names.netplay || names.code || fallback || ''
}

function extractPlayerCode(player) {
  if (!player) return ''
  const names = player.names || {}
  return names.code || ''
}

// Does any player match the archive owner, per ARCHIVE_PLAYER_CODES /
// ARCHIVE_PLAYER_TAGS? With neither configured this is always false and the
// owner-specific overlay handling is simply skipped.
function matchesArchivePlayer(playerInfo) {
  if (!Array.isArray(playerInfo) || playerInfo.length === 0) return false
  const codes = config.archivePlayerCodes
  const tags = config.archivePlayerTags
  if (!codes.length && !tags.length) return false
  return playerInfo.some((p) => {
    const code = String(p?.code || '').toUpperCase()
    if (codes.includes(code)) return true
    const tag = String(p?.tag || '').toLowerCase()
    return tags.some((t) => tag.includes(t))
  })
}

async function getArchivePlayerFoxColor(replay, playerInfo) {
  if (typeof replay.index !== 'number' || replay.index >= config.slippiUpdate) return null
  if (!matchesArchivePlayer(playerInfo)) return null

  const SlippiGame = await loadSlippiGame()
  const game = new SlippiGame(replay.file_path)
  const settings = game.getSettings ? game.getSettings() : null
  const players = Array.isArray(settings?.players)
    ? settings.players.filter((p) => p && typeof p.playerIndex === 'number')
    : []
  if (players.length !== 2) return null

  const slippi = await loadSlippiPkg()
  const sorted = [...players].sort((a, b) => a.playerIndex - b.playerIndex)
  const foxId = slippi.Character?.FOX ?? 2
  if (sorted[0]?.characterId !== foxId || sorted[1]?.characterId !== foxId) return null

  const ownCodes = config.archivePlayerCodes
  const ownIndex = sorted.findIndex((p, idx) => {
    const connectCode = String(p?.connectCode || '').toUpperCase()
    if (ownCodes.includes(connectCode)) return true
    const fallbackCode = String(playerInfo?.[idx]?.code || '').toUpperCase()
    return ownCodes.includes(fallbackCode)
  })
  if (ownIndex === -1) return null

  const ownPlayer = sorted[ownIndex]
  const colorName = slippi.characters?.getCharacterColorName
    ? slippi.characters.getCharacterColorName(ownPlayer.characterId, ownPlayer.characterColor ?? 0)
    : 'Default'
  const color = String(colorName || 'Default').toLowerCase()
  const code = String(ownPlayer.connectCode || playerInfo?.[ownIndex]?.code || '')
  if (!code) return null
  return { index: ownIndex, color, code }
}

let cachedSlippiGame = null
let cachedSlippiPkg = null
async function loadSlippiGame() {
  if (cachedSlippiGame) return cachedSlippiGame
  const require = createRequire(import.meta.url)
  try {
    const SlippiPkg = require('@slippi/slippi-js')
    const GameCtor = SlippiPkg.SlippiGame || (SlippiPkg.default && SlippiPkg.default.SlippiGame)
    if (GameCtor) {
      cachedSlippiGame = GameCtor
      return GameCtor
    }
  } catch (_) {
    // ignore, fallback to dynamic import
  }
  const SlippiPkg = await import('@slippi/slippi-js')
  const GameCtor = SlippiPkg.SlippiGame || (SlippiPkg.default && SlippiPkg.default.SlippiGame)
  if (!GameCtor) {
    throw new Error('Unable to load SlippiGame from @slippi/slippi-js')
  }
  cachedSlippiGame = GameCtor
  return GameCtor
}

async function loadSlippiPkg() {
  if (cachedSlippiPkg) return cachedSlippiPkg
  const require = createRequire(import.meta.url)
  try {
    const SlippiPkg = require('@slippi/slippi-js')
    cachedSlippiPkg = SlippiPkg
    return SlippiPkg
  } catch (_) {
    // ignore, fallback to dynamic import
  }
  const SlippiPkg = await import('@slippi/slippi-js')
  cachedSlippiPkg = SlippiPkg.default || SlippiPkg
  return cachedSlippiPkg
}
