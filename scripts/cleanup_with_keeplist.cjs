require('dotenv').config();
const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = process.env.OUTPUT_DIR;
if (!OUTPUT_DIR) {
  console.error('OUTPUT_DIR env var not set');
  process.exit(1);
}
const MANIFEST_DIR = process.env.FINAL_DIR || path.join(OUTPUT_DIR, 'final');
const GAMES_DIR = process.env.GAMES_DIR || path.join(OUTPUT_DIR, 'games');
const UPLOADS_PATH = process.env.UPLOADS_JSON || path.join(OUTPUT_DIR, 'uploads.json');

const EXECUTE = process.argv.includes('--execute');

// The 23 videoIds whose source AVIs must be preserved (22 truncated + 1 abandoned)
const PROTECT_VIDEO_IDS = new Set([
  // ABANDONED
  'Yy2ZNlYRPjM',
  // CATASTROPHIC
  'dRixauTreFY', 'xBDZ2xwfvF0', 'b_xOLz2u2Qo', 'mX5VigUOxYU', '4_G2ODl4cr4',
  '8BRnNBwqP0k', 'vXkWv0dd5vo', '_1Z-u9H2QOQ', '5FXMSTGK5Ks',
  // SIGNIFICANT
  'LUOgSepTGRE', '3MdOf3mTDKI', 'GgI-YGnHpMw', 'Kuao3Wnir1M', 'rzHke85f1B8',
  'pjWN3dF8QeI', 'bSh42y8Qs20',
  // MINOR-real (actually dropped games)
  'f6Vhojo4htA', 'O9LsLYcZLt0', '6i2DhBDE-kc', '2MCr4abzN9M', 'aKG9gEh1RSg',
  'KHBxumrbh2c',
]);

const uploads = JSON.parse(fs.readFileSync(UPLOADS_PATH, 'utf8'));

// Step 1: figure out which uploads.json entries are "protected" (don't delete their MKV/AVIs)
const protectedUploads = uploads.filter((u) => PROTECT_VIDEO_IDS.has(u.videoId));
console.log(`Protected uploads (no delete): ${protectedUploads.length}/${PROTECT_VIDEO_IDS.size} expected`);
if (protectedUploads.length !== PROTECT_VIDEO_IDS.size) {
  const found = new Set(protectedUploads.map((u) => u.videoId));
  const missing = [...PROTECT_VIDEO_IDS].filter((id) => !found.has(id));
  console.error(`ERROR: protected videoIds not found in uploads.json: ${missing.join(', ')}`);
  process.exit(1);
}

// Step 2: protected MKV basenames (we keep these on disk for re-upload / referencing)
const protectedMkvBasenames = new Set(protectedUploads.map((u) => path.basename(u.stitchedPath)));
console.log(`Protected MKV basenames: ${protectedMkvBasenames.size}`);

// Step 3: protected AVI basenames = every game in the protected manifests (so we can re-stitch them)
const protectedAviBasenames = new Set();
const protectedManifestBasenames = new Set();
for (const u of protectedUploads) {
  const manifestBase = path.basename(u.stitchedPath).replace(/\.mkv$/, '.manifest.json');
  protectedManifestBasenames.add(manifestBase);
  const manifestPath = path.join(MANIFEST_DIR, manifestBase);
  if (!fs.existsSync(manifestPath)) {
    console.error(`ERROR: protected manifest missing: ${manifestPath}`);
    process.exit(1);
  }
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const g of m.games || []) {
    if (g.video_path) protectedAviBasenames.add(path.basename(g.video_path));
  }
}
console.log(`Protected AVI basenames (across ${protectedUploads.length} manifests): ${protectedAviBasenames.size}`);

// Step 4: build standard cleanup view (logic mirrors scripts/cleanup_dry_run.cjs)
const uploadedStitchedPaths = new Set(uploads.map((u) => path.basename(u.stitchedPath)));

const manifestAvis = new Set();
const manifestFiles = fs.readdirSync(MANIFEST_DIR).filter((f) => f.endsWith('.manifest.json'));
for (const mf of manifestFiles) {
  const m = JSON.parse(fs.readFileSync(path.join(MANIFEST_DIR, mf), 'utf8'));
  for (const g of m.games || []) {
    if (g.video_path) manifestAvis.add(path.basename(g.video_path));
  }
}

// === AVIs ===
const diskAvis = fs.readdirSync(GAMES_DIR).filter((f) => f.endsWith('.avi'));
const avisToDelete = [];
const avisToKeep_unstitched = [];      // not in any manifest — backlog
const avisToKeep_protected = [];       // in a protected manifest
let aviDeleteSize = 0;
let aviKeepSize = 0;

for (const f of diskAvis) {
  const fullPath = path.join(GAMES_DIR, f);
  let size;
  try { size = fs.statSync(fullPath).size; } catch { continue; }
  if (protectedAviBasenames.has(f)) {
    avisToKeep_protected.push({ file: fullPath, size });
    aviKeepSize += size;
  } else if (manifestAvis.has(f)) {
    avisToDelete.push({ file: fullPath, size });
    aviDeleteSize += size;
  } else {
    avisToKeep_unstitched.push({ file: fullPath, size });
    aviKeepSize += size;
  }
}

// === MKVs ===
const diskMkvs = fs.readdirSync(MANIFEST_DIR).filter((f) => f.endsWith('.mkv'));
const mkvsToDelete = [];
const mkvsToKeep_protected = [];       // in protected set OR not uploaded yet (in-progress)
const mkvsToKeep_inprogress = [];
let mkvDeleteSize = 0;
let mkvKeepSize = 0;

for (const f of diskMkvs) {
  const fullPath = path.join(MANIFEST_DIR, f);
  let size;
  try { size = fs.statSync(fullPath).size; } catch { continue; }
  if (protectedMkvBasenames.has(f)) {
    mkvsToKeep_protected.push({ file: fullPath, size });
    mkvKeepSize += size;
  } else if (uploadedStitchedPaths.has(f)) {
    mkvsToDelete.push({ file: fullPath, size });
    mkvDeleteSize += size;
  } else {
    mkvsToKeep_inprogress.push({ file: fullPath, size });
    mkvKeepSize += size;
  }
}

const TB = 1e12;
const GB = 1e9;

console.log('\n=== CLEANUP REPORT' + (EXECUTE ? ' (EXECUTING)' : ' (DRY RUN)') + ' ===\n');

console.log('--- GAME AVIs (' + GAMES_DIR + ') ---');
console.log('  TO DELETE: ' + avisToDelete.length + ' files (' + (aviDeleteSize / TB).toFixed(2) + ' TB)');
console.log('  TO KEEP (protected, 23 manifests): ' + avisToKeep_protected.length + ' files (' + (avisToKeep_protected.reduce((a, x) => a + x.size, 0) / TB).toFixed(2) + ' TB)');
console.log('  TO KEEP (unstitched backlog):      ' + avisToKeep_unstitched.length + ' files (' + (avisToKeep_unstitched.reduce((a, x) => a + x.size, 0) / TB).toFixed(2) + ' TB)');

console.log('\n--- MKV STITCHED VIDEOS (' + MANIFEST_DIR + ') ---');
console.log('  TO DELETE: ' + mkvsToDelete.length + ' files (' + (mkvDeleteSize / TB).toFixed(2) + ' TB)');
console.log('  TO KEEP (protected): ' + mkvsToKeep_protected.length + ' files (' + (mkvsToKeep_protected.reduce((a, x) => a + x.size, 0) / GB).toFixed(2) + ' GB)');
for (const k of mkvsToKeep_protected) console.log('    KEEP-PROT: ' + path.basename(k.file) + ' (' + (k.size / GB).toFixed(2) + ' GB)');
console.log('  TO KEEP (in-progress / unfinished stitches): ' + mkvsToKeep_inprogress.length + ' files (' + (mkvsToKeep_inprogress.reduce((a, x) => a + x.size, 0) / GB).toFixed(2) + ' GB)');
for (const k of mkvsToKeep_inprogress) console.log('    KEEP-INPR: ' + path.basename(k.file) + ' (' + (k.size / GB).toFixed(2) + ' GB)');

console.log('\n--- MANIFESTS & UPLOADS ---');
console.log('  Manifests: ' + manifestFiles.length + ' (NEVER DELETING)');
console.log('  uploads.json: NEVER DELETING');

console.log('\n--- TOTALS ---');
console.log('  Space freed:  ' + ((aviDeleteSize + mkvDeleteSize) / TB).toFixed(2) + ' TB');
console.log('  Space kept:   ' + ((aviKeepSize + mkvKeepSize) / TB).toFixed(2) + ' TB');
console.log('  Files to delete: ' + (avisToDelete.length + mkvsToDelete.length));

const deleteList = [...avisToDelete.map((a) => a.file), ...mkvsToDelete.map((m) => m.file)];
const listPath = path.join(__dirname, 'cleanup_keeplist_delete_list.txt');
fs.writeFileSync(listPath, deleteList.join('\n') + '\n');
console.log('\nFull delete list written to: ' + listPath);

if (!EXECUTE) {
  console.log('\n(Dry run. Pass --execute to actually delete.)');
  process.exit(0);
}

// === EXECUTE ===
console.log('\n=== DELETING ===');
let deleted = 0;
let failed = 0;
let deletedBytes = 0;
const total = deleteList.length;
const startTime = Date.now();

for (let i = 0; i < deleteList.length; i++) {
  const p = deleteList[i];
  try {
    const sz = fs.statSync(p).size;
    fs.unlinkSync(p);
    deleted++;
    deletedBytes += sz;
  } catch (err) {
    failed++;
    if (failed < 10) console.error('  fail: ' + p + ' — ' + err.message);
  }
  if ((i + 1) % 500 === 0 || i === deleteList.length - 1) {
    const pct = ((i + 1) / total * 100).toFixed(1);
    const tbDel = (deletedBytes / TB).toFixed(2);
    const elapsedSec = (Date.now() - startTime) / 1000;
    process.stderr.write(`  ${i + 1}/${total} (${pct}%) deleted=${deleted} failed=${failed} freed=${tbDel}TB elapsed=${elapsedSec.toFixed(0)}s\r`);
  }
}
process.stderr.write('\n');
console.log('\n=== DONE ===');
console.log('  Deleted: ' + deleted + ' files (' + (deletedBytes / TB).toFixed(2) + ' TB)');
console.log('  Failed:  ' + failed);
