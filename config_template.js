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
// The recording speed lever. Dolphin encodes on ONE thread, so for a bulk
// archive this is the difference between a day and a week. Which codec wins
// depends on QUALITY -- at large sizes the encoder is the bottleneck, at small
// sizes emulation is, and everything converges:
//   QUALITY 6 (3x)   ffv1 0.10x   utvideo 0.81x
//   QUALITY 4 (2x)   ffv1 0.34x   utvideo 1.81x
//   QUALITY 3 (1.5x) ffv1 0.50x   utvideo 1.27x   mpeg4 1.28x  <- all converge;
//                    lossy buys NOTHING over lossless at this size
//   QUALITY 2 (1x)   ffv1 0.77x   utvideo refused (939px, needs even width)
//                    mpeg4 ~4x with EMULATION_SPEED=0, about -6 dB
//   h264   refused -- Dolphin drops the last ~52 frames at close
//   unset  inherit the Dolphin profile's own setting
// utvideo is bit-exact and writes ~12GB per 75s game. Three concurrent utvideo
// workers measured 2.07x aggregate.
//
// EMULATION_SPEED=0
// [Core] EmulationSpeed; 0 = unlimited. Bit-identical output where it applies.
// Helps THROUGHPUT only when the encoder is not the bottleneck, but it also
// shortens BOOT regardless of codec (first frame 3.8s -> 1.1s), which dominates
// short dumps.
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
