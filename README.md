## replay_archiver

A small pipeline to turn Slippi Melee replays into rendered videos with a text overlay.

### Requirements

- Node.js (v18+ recommended)
- `ffmpeg` and `ffprobe` available on `PATH`
- Python 3 with Pillow (`pip install pillow`)
- Slippi Playback (Dolphin) AppImage or executable

### Setup

1. Install Node dependencies:
   - `npm install`
2. Configure paths:
   - Create a `.env` file in the project root, for example:
     - `OUTPUT_DIR="/path/to/output/dir"`
     - `REPLAY_DIRECTORY="/path/to/slippi/replays"` (absolute path on this machine)
     - `SSBM_ISO_PATH="/path/to/ssbm/iso"`
     - `DOLPHIN_PATH="/path/to/dolphin/executable"`
     - (optional) `REPLAY_PATH_PREFIX="/original/db/prefix"` if the `file_path` values in Postgres were written from another machine and need to be rebased to this host
     - (optional) `QUALITY=6`
     - (optional) `BITRATE_KBPS=15000` (also used as the max bitrate cap)
     - (optional) `FFMPEG_CRF=18` (quality target; set to `none` to fall back to fixed bitrate)
     - (optional) `FFMPEG_MAXRATE_KBPS=15000` / `FFMPEG_BUFSIZE_KBPS=30000`
     - (optional) `FFMPEG_PRESET=slow` (slower = better quality per bit)
     - (optional) `NUM_WORKERS=2`
     - Postgres connection: `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`
3. Make sure `overlay.py` can find the font at the path defined in `FONT_PATH`.

### Usage

1. Generate or regenerate `replays.json`:
   - `node index.js --init`
   - This scans your Slippi directory (configured in `create_json.js`) and writes `replays.json`.
2. Render all pending replays:
   - `npm start`  
     or  
   - `node index.js`
   - The script loads `replays.json`, filters out entries with `done: true`, and processes the rest.
   - Test a single replay by index: `node index.js -t 123` (optional `-r` or `-s`)
   - Stitch/upload only: `npm start -- -s` (or `node index.js -s`)
   - Record/merge/overlay only (no stitch/upload this run): `npm start -- -r` (or `node index.js -r`)
3. Resuming:
   - If you stop the process and rerun `npm start`, it will skip any replays already marked `done` in `replays.json`.

### Notes

- `record.js` uses a worker pool (`worker_threads`) to process multiple replays in parallel.
- Intermediate `.avi`, `.wav`, and overlay PNG files are created in `outputDir` and cleaned up after each replay is finished.
