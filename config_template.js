// Example .env values for this project.
// Copy these into your .env file in the project root:
//
// OUTPUT_DIR="/path/to/output/dir"
// (Optional) SCRATCH_DIR="/local/fast/disk/scratch"
// Set SCRATCH_DIR ONLY on machines where OUTPUT_DIR is a network mount.
// When set, all per-replay intermediate files (-unmerged, -merged, overlay
// png, dolphin .json) are written to SCRATCH_DIR/games/ on local disk, and
// only the final NNNNNN.avi is published to OUTPUT_DIR/games/ (atomically
// via copy-to-tmp + rename). Drastically reduces NFS bandwidth per worker.
// Leave unset on machines where OUTPUT_DIR is already a local disk.
// REPLAY_DIRECTORY="/absolute/path/to/slippi/replays"
// SSBM_ISO_PATH="/path/to/ssbm/iso"
// DOLPHIN_PATH="/path/to/dolphin/executable"
// QUALITY=6
// REQUIRED. Dolphin's EFBScale -- an enum, not a multiplier:
//   2 = 1x native, 3 = 1.5x, 4 = 2x, 5 = 2.5x, 6 = 3x, 7 = 4x
// Always set it. A recording that inherits this from whatever the operator
// last played at can silently dump at 4x.
//
// DUMP_CODEC=utvideo
// The recording speed lever. Dolphin encodes on one thread and that thread is
// the limit, so for a bulk archive this is the difference between a day and a
// week. Measured at QUALITY=6:
//   ffv1     0.10x realtime, lossless  (0.77x at native, where it is the only option)
//   utvideo  0.81x, bit-exact, ~8x faster than ffv1, but ~12GB per 75s game
//            and refused at QUALITY=2 (native is 939px wide -- needs even width)
//   mpeg4    3.0-3.6x with EMULATION_SPEED=0, lossy (about -6 dB)
//   h264     refused -- Dolphin drops the last ~52 frames at close
//   unset    inherit the Dolphin profile's own setting
//
// EMULATION_SPEED=0
// [Core] EmulationSpeed; 0 = unlimited. Bit-identical where it applies, and
// only helps when the encoder is not the bottleneck -- pair it with mpeg4,
// not with ffv1 at a high QUALITY.
//
// DOLPHIN_PROFILE_DIR="/local/disk/dolphin-profiles"
// Where the per-worker throwaway Dolphin profiles are built. One per
// concurrent Dolphin is mandatory: the dump path is a property of the user
// dir, so two Dolphins sharing one silently overwrite each other's frames.
// Defaults to $TMPDIR/replay_archiver_dolphin. Keep it off network mounts.
// BITRATE_KBPS=15000
// FFMPEG_CRF=18
// FFMPEG_MAXRATE_KBPS=15000
// FFMPEG_BUFSIZE_KBPS=30000
// FFMPEG_PRESET=slow
// NUM_WORKERS=2
// SLIPPI_UPDATE=7950
// Optional: swap DB prefix to this machine's path
// REPLAY_PATH_PREFIX="/prefix/stored/in/db"

// Postgres (shared database of replay metadata)
// PGHOST="localhost"
// PGPORT=5432
// PGUSER="postgres"
// PGPASSWORD="password"
// PGDATABASE="replay_archiver"
