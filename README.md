## replay_archiver

A pipeline that turns Slippi Melee replays into rendered videos with a text overlay,
concatenates them into multi-hour archive videos, and uploads them to YouTube in
chronological order.

It has been run to completion once on a large collection (~126k replays into 656
videos), so the pipeline and publishing tooling are shaped by real use at that
scale rather than theory.

### Requirements

- Node.js (v18+ recommended)
- `ffmpeg` and `ffprobe` on `PATH`
- Python 3 with Pillow (`pip install pillow`)
- Slippi Playback (Dolphin) AppImage or executable
- PostgreSQL — replay state lives here, shared between machines

### Setup

1. `npm install`
2. Create a `.env` in the project root. `config.js` throws at import time if any
   **required** variable is missing, so every script needs the full set.

   **Required:**

   | | |
   |---|---|
   | `OUTPUT_DIR` | where `games/` and `final/` are written |
   | `REPLAY_DIRECTORY` | root of the `.slp` files on *this* machine |
   | `SSBM_ISO_PATH`, `DOLPHIN_PATH` | Melee ISO and Slippi Playback binary |
   | `NUM_WORKERS` | worker-thread count (one slot becomes the stitcher in full mode) |
   | `QUALITY` | Dolphin's `EFBScale`. An **enum, not a multiplier**: 2 = 1x native, 3 = 1.5x, 4 = 2x, 5 = 2.5x, 6 = 3x, 7 = 4x. Required, because a recording that inherits this from whatever the operator last played at can silently dump at 4x — one such run produced a 25 GB AVI at ~4 fps for a 75-second game |
   | `DOLPHIN_TIMEOUT_MS`, `FFMPEG_TIMEOUT_MS`, `OVERLAY_TIMEOUT_MS` | per-step timeouts |
   | `STITCH_MIN_TOTAL_MINUTES` | minimum length before a batch is stitched (e.g. `480`) |
   | `ARCHIVE_TITLE` | title prefix for stitched videos |
   | `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN` | OAuth; see `scripts/get_youtube_refresh_token.cjs`. Needs the `youtube.upload` scope, plus `youtube.force-ssl` to change privacy or edit metadata |
   | `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` | Postgres connection |

   **Optional:**

   - `REPLAY_PATH_PREFIX` — stored `file_path` values are rebased from this prefix onto
     `REPLAY_DIRECTORY`. Set it when the database was populated from another machine,
     otherwise path resolution falls back to a bare filename lookup.
   - `SCRATCH_DIR` — local disk for per-replay intermediates. Set this only where
     `OUTPUT_DIR` is a network mount; the final `.avi` is published to `OUTPUT_DIR`
     atomically, which greatly reduces NFS traffic.
   - `USE_NVENC=1` — encode the overlay with `hevc_nvenc`. `overlay.py` probes the
     encoder once and falls back to libx264 if no GPU is available.
   - `BITRATE_KBPS`, `FFMPEG_CRF`, `FFMPEG_MAXRATE_KBPS`, `FFMPEG_BUFSIZE_KBPS`,
     `FFMPEG_PRESET`, `FFMPEG_PROFILE` — encoder tuning
   - `DUMP_CODEC` — **the recording speed lever. See below.**
   - `EMULATION_SPEED` — `[Core] EmulationSpeed`; `0` = unlimited
   - `DOLPHIN_PROFILE_DIR` — where per-worker throwaway Dolphin profiles are
     built (default `$TMPDIR/replay_archiver_dolphin`). Keep it on local disk
   - `STITCH_TIMEOUT_MS`, `CLAIM_TTL_MS`, `MAX_REPLAY_ERRORS`, `KEEP_TEMP_FILES`
   - `SLIPPI_UPDATE` (default `7950`) — replay index before which the overlay derives
     the archive owner's Fox costume colour from the replay's settings. Older replays predate the
     Slippi version that recorded it; above this index the lookup is skipped.
   - `YOUTUBE_PRIVACY` (default `unlisted`), `YOUTUBE_MADE_FOR_KIDS`
   - `YOUTUBE_CHANNEL_ID` — required by `verify_recent_rss.js` to read the channel feed
   - `ARCHIVE_PLAYER_CODES` / `ARCHIVE_PLAYER_TAGS` — comma-separated connect codes and
     tag substrings identifying the archive owner's own player, so overlays and index
     reports can tell them apart from opponents. Leave unset to skip that handling.

3. `overlay.py` resolves its font relative to itself (`cour_bold.ttf`), so no extra
   configuration is needed.

### Usage

**Populate the database** — scans `REPLAY_DIRECTORY` for `.slp` files, orders them
chronologically and writes one row per replay. Destructive: it clears the table first.

```bash
node index.js --init
```

**Run the pipeline.** State lives in Postgres, so a run picks up wherever the last one
stopped; there is no local progress file.

```bash
npm start                # record + overlay + stitch + upload
node index.js -r         # record/merge/overlay only
node index.js -s         # stitch/upload only
node index.js -t 123     # single replay by idx (combine with -r / -s)
node index.js -c         # reset unfinished replays and their artifacts first
```

While running, `q` requests a graceful shutdown (finishes in-flight replays);
Ctrl+C exits immediately. Work is claimed per replay with a TTL, so several
machines can share one database safely.

**Check progress:**

```bash
node status.js                      # counts, and whether the stitcher is blocked
node scripts/stitch_status.js
```

The stitcher refuses to run while any unskipped replay with a lower index is
unrendered — that is the usual reason for a "Stitch paused" message. Either process
the replay or mark it `skip = 1`.

**Flush the final short batch.** The stitcher only emits a video once a batch exceeds
`STITCH_MIN_TOTAL_MINUTES`, so the remainder at the end of an archive never reaches
the threshold on its own:

```bash
node scripts/finish_tail.js --dry-run
node scripts/finish_tail.js
```

### Recording speed — `DUMP_CODEC`

Dolphin encodes the frame dump **on a single thread, and that thread is the
recording speed limit**. For a bulk archive this is the difference between a
run that takes a day and one that takes a week, so it is worth setting
deliberately rather than inheriting.

Measured, at `QUALITY=6` (3x) unless noted:

| `DUMP_CODEC` | speed | quality | notes |
|---|---|---|---|
| `ffv1` | **0.10x** realtime (~12 min per game) | lossless | 0.77x at native resolution, where it is the only option |
| `utvideo` | **0.81x** — about **8x faster** than ffv1 | bit-exact | ~12 GB per 75 s game. Needs an even dump width, so it is **refused at `QUALITY=2`** (native is 939 px wide) |
| `mpeg4` | **3.0–3.6x** with `EMULATION_SPEED=0` | lossy, about −6 dB | |
| `h264` | — | — | **refused**: Dolphin drops the last ~52 frames when the dump is closed |
| unset | — | — | inherits the Dolphin profile's own setting (what this pipeline did before) |

`EMULATION_SPEED=0` is bit-identical output where it applies, and only helps
when the encoder is *not* the bottleneck — so it is worth pairing with `mpeg4`,
and pointless with `ffv1` at a high `QUALITY`.

Parallelism is the other lever and it compounds: three concurrent `utvideo`
workers measured **2.07x aggregate**. Weigh that against disk, since the
intermediates are large and transient.

### Publishing

Uploads default to `unlisted`. Making a video public writes a **permanent**
`publishedAt`, and a channel lists by that value forever — so publish order is
effectively irreversible and must be correct the first time.

```bash
node scripts/audit_publish_readiness.js   # 18 checks; derives the order 4 independent ways
node scripts/publish_sequential.js --dry-run
node scripts/publish_sequential.js --go --limit 5
node scripts/publish_sequential.js --go
```

`publish_sequential.js` publishes one video at a time, reads `publishedAt` back, and
refuses to continue unless it is strictly later than the previous video's. It halts on
any anomaly, leaving everything after it untouched, and is resumable.

Verification and manual fallback:

```bash
node scripts/verify_publish_order.js          # full check against live YouTube
node scripts/verify_recent_rss.js             # last 15 videos, costs NO API quota
node scripts/generate_publish_checklist.js    # ordered click-through page for manual publishing
node scripts/publish_ui.js                    # local UI: next video, Studio link, live checks
```

**Quota matters.** `videos.update` costs 50 units against a default 10,000/day, so
roughly 195 videos can be published per day; the quota resets at midnight Pacific.
Do not leave `publish_ui.js` running while publishing — its page polls YouTube and
will quietly consume the budget you need.

### Maintenance

```bash
node scripts/dump_db.js out.dump      # pg_dump wrapper
node scripts/import_db.js in.dump     # pg_restore wrapper
node scripts/backup_manifests.js      # copy final/*.manifest.json -> manifest_backups/
node scripts/find_youtube_gaps.js     # confirm every upload is still live
node scripts/cleanup_dry_run.cjs      # report what disk cleanup would delete
node reset.js                         # DESTRUCTIVE: clears OUTPUT_DIR and resets all flags
```

`final/*.manifest.json` is the only record of which replays went into which video, and
which YouTube video they became. Never delete them; keep a copy off the output volume.

### Notes

- `record.js` spawns itself as `worker_threads` workers, one per replay plus a
  dedicated stitch/upload worker in full mode.
- `recorded` and `overlaid` are set together only after the final `.avi` is durably in
  place, so an interrupted replay is simply redone rather than half-recorded.
- Stitching concatenates with `-c:v copy`, which requires every input to share a video
  codec. Mixing codecs produces a file whose frames do not decode, so the stitcher
  checks this and decode-samples its output before uploading.
- Container duration alone does not prove a video is intact; a file can be the right
  length and still be undecodable. Verification decodes.
- Intermediate `.avi`, `.wav`, `.json` and overlay PNG files are written to
  `SCRATCH_DIR` (or `OUTPUT_DIR`) and removed after each replay unless
  `KEEP_TEMP_FILES=true`.

`CLAUDE.md` has the architecture in more depth: the per-replay pipeline, the database
state machine, and the per-machine configuration split.
