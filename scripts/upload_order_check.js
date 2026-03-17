import 'dotenv/config';
import { promises as fs } from 'fs';
import path from 'path';

const UPLOADS_JSON = process.env.UPLOADS_JSON
  || path.join(process.env.OUTPUT_DIR || '', 'uploads.json');

async function main() {
  const uploads = JSON.parse(await fs.readFile(UPLOADS_JSON, 'utf8'));

  // Sort by uploadedAt
  uploads.sort((a, b) => new Date(a.uploadedAt) - new Date(b.uploadedAt));

  // For "out of order" detection, we compare each video's first index
  // against the running maximum. If a video's first index is less than
  // a previously uploaded video's first index, it's out of order.
  let maxFirstIndex = -1;
  const rows = uploads.map((u, i) => {
    const firstIdx = u.indices?.[0] ?? 0;
    const lastIdx = u.indices?.[u.indices.length - 1] ?? 0;
    const outOfOrder = firstIdx < maxFirstIndex;
    if (firstIdx > maxFirstIndex) maxFirstIndex = firstIdx;
    return { ...u, firstIdx, lastIdx, outOfOrder, uploadOrder: i + 1 };
  });

  let outOfOrderCount = 0;

  for (const r of rows) {
    const date = new Date(r.uploadedAt).toISOString().replace('T', ' ').slice(0, 19);
    const marker = r.outOfOrder ? ' <<<< OUT OF ORDER' : '';
    if (r.outOfOrder) outOfOrderCount++;
    console.log(
      `${String(r.uploadOrder).padStart(3)}.  ${date}  [${String(r.firstIdx).padStart(5)}-${String(r.lastIdx).padStart(5)}]  ${r.title}${marker}`
    );
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`  Total videos: ${rows.length}`);
  console.log(`  Out of order: ${outOfOrderCount}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
