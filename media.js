import path from 'path'
import fs from 'fs'
import os from 'os'
import readline from 'readline'
import crypto from 'crypto'
import { promises as fsPromises } from 'fs'
import { createRequire } from 'module'
import { spawnProcess, runChildProcess, killDolphinOnEndFrame } from './childProc.js'
import { config } from './config.js'
import { appendRunLog } from './util_log.js'
import { pad, convertIsoToMmDdYyyyHhMm } from './lib.js'

export async function configureDolphin() {
  const { bitrateKbps, quality } = config
  const dolphinDirname = path.join(os.homedir(), '.config', 'SlippiPlayback')
  const gameSettingsPath = path.join(dolphinDirname, 'GameSettings', 'GALE01.ini')
  const graphicsSettingsPath = path.join(dolphinDirname, 'Config', 'GFX.ini')
  const dolphinSettingsPath = path.join(dolphinDirname, 'Config', 'Dolphin.ini')

  await fsPromises.mkdir(path.dirname(gameSettingsPath), { recursive: true })
  if (!fs.existsSync(gameSettingsPath)) {
    const fd = await fsPromises.open(gameSettingsPath, 'a')
    await fd.close()
  }

  if (!fs.existsSync(gameSettingsPath)) {
    throw new Error('Error: could not find game settings file')
  }

  let newSettings = [
    '[Gecko]',
    '[Gecko_Enabled]',
    '$Optional: Game Music OFF',
    '$Optional: Widescreen 16:9',
    '[Gecko_Disabled]',
    '$Optional: Show Player Names',
  ]
  await fsPromises.writeFile(gameSettingsPath, newSettings.join('\n'))

  await fsPromises.mkdir(path.dirname(graphicsSettingsPath), { recursive: true })
  if (!fs.existsSync(graphicsSettingsPath)) {
    await fsPromises.writeFile(graphicsSettingsPath, '')
  }

  let rl = readline.createInterface({
    input: fs.createReadStream(graphicsSettingsPath),
    crlfDelay: Infinity,
  })
  newSettings = []
  const aspectRatioSetting = 6
  for await (const line of rl) {
    if (line.startsWith('AspectRatio')) {
      newSettings.push(`AspectRatio = ${aspectRatioSetting}`)
    } else if (line.startsWith('InternalResolutionFrameDumps')) {
      newSettings.push(`InternalResolutionFrameDumps = True`)
    } else if (line.startsWith('BitrateKbps')) {
      if (Number.isFinite(bitrateKbps)) {
        newSettings.push(`BitrateKbps = ${bitrateKbps}`)
      } else {
        newSettings.push(line)
      }
    } else if (line.startsWith('EFBScale')) {
      if (Number.isFinite(quality)) {
        newSettings.push(`EFBScale = ${quality}`)
      } else {
        newSettings.push(line)
      }
    } else {
      newSettings.push(line)
    }
  }
  await fsPromises.writeFile(graphicsSettingsPath, newSettings.join('\n'))

  await fsPromises.mkdir(path.dirname(dolphinSettingsPath), { recursive: true })
  if (!fs.existsSync(dolphinSettingsPath)) {
    await fsPromises.writeFile(dolphinSettingsPath, '')
  }

  rl = readline.createInterface({
    input: fs.createReadStream(dolphinSettingsPath),
    crlfDelay: Infinity,
  })
  newSettings = []
  for await (const line of rl) {
    if (line.startsWith('DumpFrames ')) {
      newSettings.push(`DumpFrames = True`)
    } else if (line.startsWith('DumpFramesSilent ')) {
      newSettings.push(`DumpFramesSilent = True`)
    } else if (line.startsWith('DumpAudio ')) {
      newSettings.push(`DumpAudio = True`)
    } else if (line.startsWith('DumpAudioSilent ')) {
      newSettings.push(`DumpAudioSilent = True`)
    } else {
      newSettings.push(line)
    }
  }
  await fsPromises.writeFile(dolphinSettingsPath, newSettings.join('\n'))
}

export async function generateDolphinConfig(replay) {
  const lastFrame = typeof replay.game_length_frames === 'number' ? replay.game_length_frames : 0
  const startFrame = -123
  let endFrame = Math.max(0, lastFrame - 1)
  if (endFrame <= startFrame) {
    endFrame = startFrame + 1
  }

  const dolphinConfig = {
    mode: 'normal',
    replay: replay.file_path,
    startFrame,
    endFrame,
    isRealTimeMode: false,
    commandId: `${crypto.randomBytes(12).toString('hex')}`,
  }
  await fsPromises.mkdir(config.workingGamesDir, { recursive: true })
  return fsPromises.writeFile(
    path.join(config.workingGamesDir, `${pad(replay.index, 6)}.json`),
    JSON.stringify(dolphinConfig)
  )
}

export async function runDolphin(replay) {
  const fileBasename = pad(replay.index, 6)
  const dolphinArgs = [
    '-i',
    path.resolve(config.workingGamesDir, `${fileBasename}.json`),
    '-o',
    `${fileBasename}-unmerged`,
    `--output-directory=${config.workingGamesDir}`,
    '-b',
    '-e',
    config.ssbmIsoPath,
    '--cout',
  ]

  await appendRunLog(`Dolphin playback for replay #${replay.index}`, config.dolphinPath, dolphinArgs)
  const child = spawnProcess(config.dolphinPath, dolphinArgs)
  killDolphinOnEndFrame(child)
  await runChildProcess(child, {
    name: 'Dolphin',
    replayIndex: replay.index,
    timeoutMs: config.dolphinTimeoutMs,
  })
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
    const haxColor = await getHaxFoxColor(replay, playerInfo)
    if (haxColor && playerInfo[haxColor.index]) {
      playerInfo[haxColor.index] = {
        ...playerInfo[haxColor.index],
        code: `${haxColor.code} - ${haxColor.color}`,
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

function hasHaxCodeOrTag(playerInfo) {
  if (!Array.isArray(playerInfo) || playerInfo.length === 0) return false
  return playerInfo.some((p) => {
    const code = String(p?.code || '')
    if (code === 'XX#02' || code === 'HAX#472') return true
    const tag = String(p?.tag || '').toLowerCase()
    return tag.includes('hax') || tag.includes('b0xx')
  })
}

async function getHaxFoxColor(replay, playerInfo) {
  if (typeof replay.index !== 'number' || replay.index >= config.slippiUpdate) return null
  if (!hasHaxCodeOrTag(playerInfo)) return null

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

  const haxIndex = sorted.findIndex((p, idx) => {
    const connectCode = String(p?.connectCode || '')
    if (connectCode === 'XX#02' || connectCode === 'HAX#472') return true
    const fallbackCode = String(playerInfo?.[idx]?.code || '')
    return fallbackCode === 'XX#02' || fallbackCode === 'HAX#472'
  })
  if (haxIndex === -1) return null

  const haxPlayer = sorted[haxIndex]
  const colorName = slippi.characters?.getCharacterColorName
    ? slippi.characters.getCharacterColorName(haxPlayer.characterId, haxPlayer.characterColor ?? 0)
    : 'Default'
  const color = String(colorName || 'Default').toLowerCase()
  const code = String(haxPlayer.connectCode || playerInfo?.[haxIndex]?.code || '')
  if (!code) return null
  return { index: haxIndex, color, code }
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
