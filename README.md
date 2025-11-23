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
   - Either copy `config_template.js` to `config.js` and edit the values, or
   - Set environment variables:
     - `OUTPUT_DIR`
     - `SSBM_ISO_PATH`
     - `DOLPHIN_PATH`
     - (optional) `QUALITY`
     - (optional) `BITRATE_KBPS`
     - (optional) `NUM_WORKERS`
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
3. Resuming:
   - If you stop the process and rerun `npm start`, it will skip any replays already marked `done` in `replays.json`.

### Notes

- `record.js` uses a worker pool (`worker_threads`) to process multiple replays in parallel.
- Intermediate `.avi`, `.wav`, and overlay PNG files are created in `outputDir` and cleaned up after each replay is finished.
