require('dotenv').config();
const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = process.env.OUTPUT_DIR;
if (!OUTPUT_DIR) {
  console.error('OUTPUT_DIR env var not set');
  process.exit(1);
}
const manifestDir = process.env.FINAL_DIR || path.join(OUTPUT_DIR, 'final');
const gamesDir = process.env.GAMES_DIR || path.join(OUTPUT_DIR, 'games');
const uploads = JSON.parse(fs.readFileSync(process.env.UPLOADS_JSON || path.join(OUTPUT_DIR, 'uploads.json'), 'utf8'));

// Build set of uploaded MKV stitched paths (from uploads.json)
const uploadedStitchedPaths = new Set();
for (const u of uploads) {
  // stitchedPath may use old mount path, normalize to current
  const basename = path.basename(u.stitchedPath);
  uploadedStitchedPaths.add(basename);
}

// Build set of game AVIs referenced by manifests (all are uploaded)
const manifestAvis = new Set();
const manifestFiles = fs.readdirSync(manifestDir).filter(f => f.endsWith('.manifest.json'));
for (const mf of manifestFiles) {
  const m = JSON.parse(fs.readFileSync(path.join(manifestDir, mf)));
  for (const g of m.games) {
    manifestAvis.add(path.basename(g.video_path));
  }
}

// === GAME AVIs TO DELETE ===
const diskAvis = fs.readdirSync(gamesDir).filter(f => f.endsWith('.avi')).sort();
const avisToDelete = [];
const avisToKeep = [];
let aviDeleteSize = 0;
let aviKeepSize = 0;

for (const f of diskAvis) {
  const fullPath = path.join(gamesDir, f);
  const size = fs.statSync(fullPath).size;
  if (manifestAvis.has(f)) {
    avisToDelete.push({ file: fullPath, size });
    aviDeleteSize += size;
  } else {
    avisToKeep.push(f);
    aviKeepSize += size;
  }
}

// === MKVs TO DELETE ===
const diskMkvs = fs.readdirSync(manifestDir).filter(f => f.endsWith('.mkv')).sort();
const mkvsToDelete = [];
const mkvsToKeep = [];
let mkvDeleteSize = 0;
let mkvKeepSize = 0;

for (const f of diskMkvs) {
  const fullPath = path.join(manifestDir, f);
  const size = fs.statSync(fullPath).size;
  if (uploadedStitchedPaths.has(f)) {
    mkvsToDelete.push({ file: fullPath, size });
    mkvDeleteSize += size;
  } else {
    mkvsToKeep.push({ file: f, size });
    mkvKeepSize += size;
  }
}

// === REPORT ===
const TB = 1e12;
const GB = 1e9;

console.log('=== DRY RUN: CLEANUP REPORT ===\n');

console.log('--- GAME AVIs (in ' + gamesDir + ') ---');
console.log('  TO DELETE:', avisToDelete.length, 'files (' + (aviDeleteSize / TB).toFixed(2) + ' TB)');
console.log('  TO KEEP: ', avisToKeep.length, 'files (' + (aviKeepSize / TB).toFixed(2) + ' TB)');
console.log('  First delete:', avisToDelete[0]?.file);
console.log('  Last delete: ', avisToDelete[avisToDelete.length - 1]?.file);
console.log();

console.log('--- MKV STITCHED VIDEOS (in ' + manifestDir + ') ---');
console.log('  TO DELETE:', mkvsToDelete.length, 'files (' + (mkvDeleteSize / TB).toFixed(2) + ' TB)');
console.log('  TO KEEP: ', mkvsToKeep.length, 'files (' + (mkvKeepSize / GB).toFixed(2) + ' GB)');
for (const k of mkvsToKeep) {
  console.log('    KEEPING:', k.file, '(' + (k.size / GB).toFixed(2) + ' GB)');
}
console.log();

console.log('--- MANIFESTS & UPLOADS ---');
console.log('  Manifests:', manifestFiles.length, '(NEVER DELETING)');
console.log('  uploads.json: NEVER DELETING');
console.log();

console.log('--- TOTALS ---');
console.log('  Space freed:', ((aviDeleteSize + mkvDeleteSize) / TB).toFixed(2), 'TB');
console.log('  Space kept: ', ((aviKeepSize + mkvKeepSize) / TB).toFixed(2), 'TB');
console.log();

// Write delete lists to files for review
const deleteList = [
  ...avisToDelete.map(a => a.file),
  ...mkvsToDelete.map(m => m.file),
];
const listPath = path.join(__dirname, 'cleanup_delete_list.txt');
fs.writeFileSync(listPath, deleteList.join('\n') + '\n');
console.log('Full delete list written to:', listPath);
console.log('Total files to delete:', deleteList.length);
