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
