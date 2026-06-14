import 'dotenv/config';
import { promises as fs } from 'fs';
import path from 'path';
import pkg from 'pg';
const { Pool } = pkg;

const REPORT_PATH = path.resolve('reports/broken_avis.json');
const EXECUTE = process.argv.includes('--execute');

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || 'replay_archiver',
});

const report = JSON.parse(await fs.readFile(REPORT_PATH, 'utf8'));

const allBroken = [];
const allManifestIndices = new Set(); // every idx across the 23 manifests
for (const [vid, e] of Object.entries(report)) {
  for (const b of e.broken) allBroken.push({ videoId: vid, ...b });
}

// Also load uploads.json + manifest files to get every index in each affected manifest
const FINAL_DIR = '/path/to/output/hax_output/final';
const UPLOADS_PATH = '/path/to/output/hax_output/uploads.json';
const uploads = JSON.parse(await fs.readFile(UPLOADS_PATH, 'utf8'));
for (const vid of Object.keys(report)) {
  const u = uploads.find((x) => x.videoId === vid);
  if (!u) continue;
  const manifestPath = path.join(FINAL_DIR, path.basename(u.stitchedPath).replace(/\.mkv$/, '.manifest.json'));
  const m = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  for (const g of m.games || []) allManifestIndices.add(g.index);
}

console.log(`Total broken AVIs to re-record:            ${allBroken.length}`);
console.log(`Total indices in 23 affected manifests:    ${allManifestIndices.size}`);
const byReason = {};
for (const b of allBroken) byReason[b.reason] = (byReason[b.reason] || 0) + 1;
console.log(`  Broken by reason: ${JSON.stringify(byReason)}`);

if (!EXECUTE) {
  console.log('\nDRY RUN — would do:');
  console.log(`  - Unlink ${allBroken.filter((b) => b.reason !== 'missing').length} corrupt AVI files`);
  console.log(`  - Reset uploaded=0/stitched=0/stitch_pending=0 for ${allManifestIndices.size} indices across 23 manifests`);
  console.log(`  - Reset recorded=0/overlaid=0/claim cleared for ${allBroken.length} broken indices (recorder will regenerate from .slp)`);
  console.log('\nSample broken indices:');
  for (const b of allBroken.slice(0, 10)) console.log(`  idx=${b.idx} reason=${b.reason} videoId=${b.videoId}`);
  if (allBroken.length > 10) console.log(`  ... and ${allBroken.length - 10} more`);
  console.log('\nPass --execute to apply.');
  await pool.end();
  process.exit(0);
}

console.log('\n=== EXECUTING HEAL ===');
let unlinked = 0, unlinkSkipped = 0;
const brokenIndices = allBroken.map((b) => b.idx);
const allIndicesInManifests = [...allManifestIndices];

// Unlink corrupt files (those that exist on disk)
for (const b of allBroken) {
  if (b.reason === 'missing') { unlinkSkipped++; continue; }
  try {
    await fs.unlink(b.aviPath);
    unlinked++;
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`  unlink fail ${b.aviPath}: ${err.message}`);
    else unlinkSkipped++;
  }
}
console.log(`  Unlinked ${unlinked} corrupt AVI files (${unlinkSkipped} were already missing)`);

const BATCH = 500;

// Step 1: reset uploaded=0 + stitched=0 + stitch_pending=0 for ALL indices in affected manifests.
// This makes the stitcher re-pick them when ready, replacing the broken YT videos.
let mark = 0;
for (let i = 0; i < allIndicesInManifests.length; i += BATCH) {
  const chunk = allIndicesInManifests.slice(i, i + BATCH);
  const res = await pool.query(
    `UPDATE replays
       SET uploaded=0, stitched=0, stitch_pending=0
     WHERE idx = ANY($1)`,
    [chunk]
  );
  mark += res.rowCount;
  process.stderr.write(`  Step 1: uploaded/stitched reset across 23 manifests: ${mark}/${allIndicesInManifests.length}\r`);
}
process.stderr.write('\n');

// Step 2: reset recorded=0 + overlaid=0 + claim cleared ONLY for broken indices,
// so the recorder regenerates exactly those AVIs from .slp.
let healed = 0;
for (let i = 0; i < brokenIndices.length; i += BATCH) {
  const chunk = brokenIndices.slice(i, i + BATCH);
  const res = await pool.query(
    `UPDATE replays
       SET recorded=0, overlaid=0, claimed_by=NULL, claimed_at=NULL
     WHERE idx = ANY($1)`,
    [chunk]
  );
  healed += res.rowCount;
  process.stderr.write(`  Step 2: recorded/overlaid reset on broken: ${healed}/${brokenIndices.length}\r`);
}
process.stderr.write('\n');

console.log(`\n=== DONE ===`);
console.log(`  Corrupt files unlinked: ${unlinked}`);
console.log(`  uploaded/stitched reset across manifests: ${mark} rows`);
console.log(`  recorded/overlaid reset on broken AVIs:   ${healed} rows`);
console.log('\nThe recorder will now pick up the broken AVIs (low-idx priority).');
console.log('Forward production stitching will pause until the lowest-idx affected manifest is fully healed.');

await pool.end();
