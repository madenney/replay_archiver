# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A pipeline that turns Slippi Melee `.slp` replays into overlaid videos, concatenates them into long MKVs, and uploads those to YouTube. Plain ESM Node.js (`"type": "module"`) plus one Python script (`overlay.py`). There are no tests and no linter; verification is running the pipeline against real data.

All state lives in a shared **Postgres** `replays` table (see `db.js`); `replays.json` in the repo root is a leftover from an earlier design and is unused.

**Status:** the Archive run is complete — 126,443 replays into 656 videos, all published publicly in chronological order. The pipeline and publishing tooling are general and can be pointed at another replay set.

## Commands

All commands need a populated `.env` (see `config_template.js`). `config.js` throws at import time if any required var is missing, so every script that imports it needs the full env.

```bash
npm start                  # full run: NUM_WORKERS-1 record workers + 1 stitch/upload worker
node index.js -r           # record/merge/overlay only (no stitch/upload)
node index.js -s           # stitch/upload only (loops until nothing is ready)
node index.js -t 123       # process a single replay by idx (combine with -r/-s)
node index.js -c           # clear unfinished replays/artifacts on startup, then run
node index.js --init       # DESTRUCTIVE: wipes the replays table and rescans REPLAY_DIRECTORY
node status.js             # DB counts + whether the stitcher is blocked (and by which idx)
node scripts/stitch_status.js
node reset.js              # DESTRUCTIVE: clears OUTPUT_DIR and resets all flags
node scripts/dump_db.js out.dump / node scripts/import_db.js in.dump   # pg_dump / pg_restore wrappers
node scripts/backup_manifests.js   # copies final/*.manifest.json -> manifest_backups/
```

During a run, `q` requests a graceful shutdown (finish in-flight replays); Ctrl+C is immediate.

## Architecture

### Per-replay pipeline (record.js worker thread → media.js)

`record.js` spawns itself as `worker_threads` Workers (`new Worker(__filename, { workerData })`); the `!isMainThread` block at the bottom is the worker body. Two roles: `normal` (records) and `stitcher` (one per full run, id `'S'`).

For each replay, a normal worker runs, all in `config.workingGamesDir`, with files named by 6-digit zero-padded idx (`pad(idx, 6)`):

1. `generateDolphinConfig` → `NNNNNN.json`
2. `runDolphin` → `NNNNNN-unmerged.avi` + `.wav` (Slippi Playback Dolphin, headless). Duration is ffprobe-verified against `game_length_frames`; a short recording throws.
3. `mergeVideo` → `NNNNNN-merged.avi` (ffmpeg, `-c:v copy`, just muxes audio)
4. `addOverlay` → `NNNNNN.avi` via `python3 overlay.py` — **the only lossy encode** (libx264, or `hevc_nvenc` when `USE_NVENC` is set)
5. `publishOverlay` → atomically copies the final `.avi` into `config.gamesDir` (no-op unless `SCRATCH_DIR` set)
6. `recorded=1, overlaid=1, stitch_pending=1` are set **together, only after** step 5 — a crash before that leaves the DB at 0/0 so the next worker redoes everything.
7. `deleteFiles` removes intermediates (kept if `KEEP_TEMP_FILES=true`).

Any throw → `recordReplayError()` increments `error_count`, releases the claim, and auto-sets `skip=1` at `MAX_REPLAY_ERRORS` (default 3).

The Dolphin lead-in is 123 frames: `LEAD_IN_FRAMES` in `stitcher.js` and `DOLPHIN_LEAD_IN_FRAMES` in `media.js` must stay equal. Expected duration everywhere is `(game_length_frames + 123) / 60`.

### DB state machine (db.js)

One row per replay, ordered by `idx` (1-based, chronological by `.slp` timestamp). Flag columns are ints 0/1: `recorded → overlaid → stitch_pending → stitched → uploaded`, plus `skip`, `error_count`, and `claimed_by`/`claimed_at`. `updateFlags()` whitelists column names via `ALLOWED_UPDATE_FIELDS`.

Multiple machines share the DB. `claimNextReplay()` uses `FOR UPDATE SKIP LOCKED` and stamps `claimed_by = os.hostname()`; claims expire after `CLAIM_TTL_MS` (default 24h) so a crashed worker's replay gets picked up again. Normal workers in a full run claim with `includeStitchPending=false` (only `overlaid=0` rows).

`file_path` is stored relative to `REPLAY_DIRECTORY`; `resolveReplayPath()` rebases it per machine (`REPLAY_PATH_PREFIX` handles paths written from another host).

### Stitching and upload (stitcher.js)

`maybeStitchAndUpload()` is serialized with a `proper-lockfile` lock on `OUTPUT_DIR/stitch_state.json`. It:

- Takes overlaid, non-uploaded replays **in strict idx order** and accumulates until `STITCH_MIN_TOTAL_MINUTES` is reached.
- **Refuses to stitch if any unskipped replay with a lower idx isn't overlaid yet** (`getBlockers`). This is the usual reason a run reports "Stitch paused" — a single stuck/unrecorded replay blocks everything after it. Fix by processing it or setting `skip=1`.
- ffmpeg concat with `-c:v copy` (no re-encode) → `final/<ARCHIVE_TITLE>_<start>_<end>.mkv`, then ffprobe-verifies the result isn't truncated (60s tolerance) before uploading.
- Uploads via `googleapis` (`youtube.videos.insert`), then writes `final/<name>.manifest.json` (game list, durations, `videoId`) and appends to `OUTPUT_DIR/uploads.json`. On upload failure the manifest is still written with `videoId: null`, and `stitched=1` stays set so the next pass retries only the upload.

YouTube description timestamps come from `youtube_description.js` (`buildYouTubeDescription`), using ffprobe'd durations of each game AVI.

**Manifests in `final/` are the only record of which game idx went into which YouTube video. Never delete or overwrite them.** `scripts/backup_manifests.js` mirrors them into `manifest_backups/`.

### Per-machine config

Two worker machines share the DB and an NFS `OUTPUT_DIR`. Settings that differ per host live in `.env` and are documented inline there:

- `SCRATCH_DIR`: local-disk intermediates; set only where `OUTPUT_DIR` is an NFS mount. `config.workingGamesDir` = scratch when set, else `gamesDir`.
- `USE_NVENC`: GPU overlay encode (only on the machine with the NVIDIA card).
- `NUM_WORKERS`: in a full run one slot is the stitcher, so record parallelism is `NUM_WORKERS - 1`.

`configureDolphin()` rewrites `~/.config/SlippiPlayback/{GameSettings/GALE01.ini,Config/GFX.ini,Config/Dolphin.ini}` on every run — Dolphin settings changes belong there, not in the ini files.

### Logs

- `OUTPUT_DIR/run.log` — `appendRunLog()`; every subprocess invocation with its full argv, plus stitch-pause reasons.
- `OUTPUT_DIR/uploads.json` — one entry per successful upload.
- `childProc.js` spawns children `detached` in their own process group so `killTree()` can kill an AppImage wrapper *and* the inner Dolphin/ffmpeg on timeout.

### Publishing (scripts/publish_*, scripts/verify_*)

Uploads default to `unlisted`. Flipping a video public writes a **permanent**
`publishedAt` and the channel sorts by it forever, so publish order is a one-shot,
irreversible operation.

`publish_sequential.js` is the tool for it: publish one video, read `publishedAt`
back, and refuse to continue unless it is strictly later than the previous one. It
halts on any anomaly with everything after it untouched, and resumes from
`reports/publish_sequential_state.json`. `audit_publish_readiness.js` derives the
chronological order four independent ways — manifest indices, Postgres dates, `.slp`
filename timestamps, and manifest `startDate` strings — and refuses to proceed if
they disagree.

Quota is the binding constraint: `videos.update` costs 50 units against a default
10,000/day (~195 videos), resetting midnight Pacific. `verify_recent_rss.js` checks
recent publish order via the channel RSS feed at **no quota cost**, which is what
makes verification possible once the budget is spent. Do not leave `publish_ui.js`
running during a publish run — its page polls YouTube and will consume the budget.

### scripts/

One-off maintenance and audit tools (YouTube verification, re-stitching from a manifest, healing broken AVIs, description updates, etc.). They import from `../db.js`, `../config.js`, `../stitcher.js` directly and are run with `node scripts/<name>.js`; most print usage when called without args. `reports/` holds outputs from past audits. `backup/` is old code, not used.
