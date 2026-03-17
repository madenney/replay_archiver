import 'dotenv/config';
import { promises as fs } from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
import { createWriteStream } from 'fs';

const UPLOADS_JSON = process.env.UPLOADS_JSON
  || path.join(process.env.OUTPUT_DIR || '', 'uploads.json');

function parseTitleDates(title) {
  const m = title.match(/(\d{2}\/\d{2}\/\d{4})\s*-\s*(\d{2}\/\d{2}\/\d{4})/);
  if (!m) return { start: null, end: null };
  const parse = s => {
    const [mm, dd, yyyy] = s.split('/');
    return new Date(`${yyyy}-${mm}-${dd}T00:00:00`);
  };
  return { start: parse(m[1]), end: parse(m[2]) };
}

function fmtDate(d) {
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function daysBetween(a, b) {
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

// Helper: draw text without triggering pdfkit auto-pagination
function drawText(doc, str, x, y, opts = {}) {
  doc.text(str, x, y, { ...opts, lineBreak: false });
}

async function main() {
  const uploads = JSON.parse(await fs.readFile(UPLOADS_JSON, 'utf8'));

  // Sort by uploadedAt (newest first for the report)
  uploads.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

  // Determine out-of-order: walk in upload order (oldest first) and track max first index
  const byUploadOrder = [...uploads].sort((a, b) => new Date(a.uploadedAt) - new Date(b.uploadedAt));
  let maxFirstIdx = -1;
  const outOfOrderIds = new Set();
  for (const u of byUploadOrder) {
    const firstIdx = u.indices?.[0] ?? 0;
    if (firstIdx < maxFirstIdx) outOfOrderIds.add(u.videoId);
    if (firstIdx > maxFirstIdx) maxFirstIdx = firstIdx;
  }

  // Detect time gaps: sort by title start date, find where consecutive
  // videos have > 1 day gap between prev end and next start
  const byTitleDate = [...uploads]
    .map(u => ({ ...u, ...parseTitleDates(u.title) }))
    .filter(u => u.start && u.end)
    .sort((a, b) => a.start - b.start);

  const gapAfterVideoId = new Map();
  for (let i = 0; i < byTitleDate.length - 1; i++) {
    const currEnd = byTitleDate[i].end;
    const nextStart = byTitleDate[i + 1].start;
    const gap = daysBetween(currEnd, nextStart);
    if (gap >= 1) {
      gapAfterVideoId.set(byTitleDate[i + 1].videoId, {
        from: currEnd,
        to: nextStart,
        days: gap,
      });
    }
  }

  // Build PDF
  const outPath = path.join(import.meta.dirname, '..', 'upload_order_report.pdf');
  const doc = new PDFDocument({
    size: 'LETTER',
    margin: 40,
    layout: 'landscape',
    autoFirstPage: true,
    bufferPages: true,
  });
  const stream = createWriteStream(outPath);
  doc.pipe(stream);

  // Title
  doc.fontSize(24);
  drawText(doc, 'Hax Archive - Upload Order Report', 40, 40);
  doc.fontSize(11).fillColor('#555');
  drawText(doc, `Generated ${new Date().toISOString().slice(0, 10)}  |  ${uploads.length} videos  |  ${outOfOrderIds.size} out of order`, 40, 72);
  doc.fontSize(9).fillColor('#888');
  drawText(doc, 'Sorted by upload date (newest first). Red = out of order. Black lines = title date gaps. Blue lines = index gaps in upload order.', 40, 90);

  // Table setup
  const LEFT = 40;
  const TABLE_W = 730;
  const COL = {
    num:    { x: LEFT,       w: 30 },
    upload: { x: LEFT + 30,  w: 130 },
    idx:    { x: LEFT + 160, w: 90 },
    title:  { x: LEFT + 250, w: 290 },
    games:  { x: LEFT + 540, w: 50 },
    hours:  { x: LEFT + 590, w: 50 },
    flag:   { x: LEFT + 640, w: 90 },
  };
  const ROW_H = 14;
  const TXT_OFF = 3;
  const PAGE_BOTTOM = 570;
  let y = 115;

  function drawHeader() {
    doc.fontSize(8).fillColor('#000').font('Helvetica-Bold');
    drawText(doc, '#',        COL.num.x,    y + TXT_OFF);
    drawText(doc, 'Uploaded', COL.upload.x, y + TXT_OFF);
    drawText(doc, 'Indices',  COL.idx.x,    y + TXT_OFF);
    drawText(doc, 'Title',    COL.title.x,  y + TXT_OFF);
    drawText(doc, 'Games',    COL.games.x,  y + TXT_OFF);
    drawText(doc, 'Hours',    COL.hours.x,  y + TXT_OFF);
    drawText(doc, 'Status',   COL.flag.x,   y + TXT_OFF);
    doc.font('Helvetica');
    y += ROW_H + 2;
    doc.moveTo(LEFT, y).lineTo(LEFT + TABLE_W, y).lineWidth(0.5).strokeColor('#000').stroke();
    y += 4;
  }

  drawHeader();

  // Precompute index gaps in upload order (newest first).
  // Row i has higher indices than row i+1. If row i's firstIdx - 1 != row i+1's lastIdx,
  // there's a gap between them. We store the gap keyed by the row index.
  const indexGapAtRow = new Map();
  for (let i = 0; i < uploads.length - 1; i++) {
    const currFirst = uploads[i].indices?.[0];
    const nextLast = uploads[i + 1].indices?.[uploads[i + 1].indices.length - 1];
    if (currFirst != null && nextLast != null && currFirst - 1 !== nextLast) {
      const missingStart = nextLast + 1;
      const missingEnd = currFirst - 1;
      if (missingEnd >= missingStart) {
        indexGapAtRow.set(i, {
          missingStart,
          missingEnd,
          count: missingEnd - missingStart + 1,
        });
      } else {
        // Indices overlap or are out of order — flag it differently
        indexGapAtRow.set(i, {
          missingStart: nextLast,
          missingEnd: currFirst,
          count: 0,
          overlap: true,
        });
      }
    }
  }

  for (let i = 0; i < uploads.length; i++) {
    const u = uploads[i];
    const isOOO = outOfOrderIds.has(u.videoId);
    const gapInfo = gapAfterVideoId.get(u.videoId);
    const idxGapInfo = indexGapAtRow.get(i);
    const firstIdx = u.indices?.[0] ?? '?';
    const lastIdx = u.indices?.[u.indices.length - 1] ?? '?';
    const games = u.indices?.length || 0;
    const hours = (Math.round((u.totalSeconds || 0) / 3600 * 10) / 10).toFixed(1);

    // Count gap lines needed before this row
    const gapLines = [];
    if (gapInfo) gapLines.push('date');
    // Index gap goes AFTER the current row (between row i and i+1)
    // We'll draw it after the row instead

    // Page break check
    const neededSpace = ROW_H + (gapInfo ? 22 : 0);
    if (y + neededSpace > PAGE_BOTTOM) {
      doc.addPage();
      y = 40;
      drawHeader();
    }

    // Title date gap line
    if (gapInfo) {
      y += 4;
      doc.moveTo(LEFT, y).lineTo(LEFT + TABLE_W, y).lineWidth(2).strokeColor('#000').stroke();
      doc.fontSize(7).fillColor('#666');
      drawText(doc, `${gapInfo.days} day gap  (${gapInfo.from.toISOString().slice(0,10)}  -->  ${gapInfo.to.toISOString().slice(0,10)})`, LEFT + 220, y + 2);
      y += 14;
    }

    // Row background
    if (isOOO) {
      doc.save();
      doc.rect(LEFT, y - 1, TABLE_W, ROW_H).fill('#FFE0E0');
      doc.restore();
    } else if (i % 2 === 0) {
      doc.save();
      doc.rect(LEFT, y - 1, TABLE_W, ROW_H).fill('#F7F7F7');
      doc.restore();
    }

    const textColor = isOOO ? '#CC0000' : '#222';
    doc.fontSize(8).fillColor(textColor);
    drawText(doc, String(i + 1),                     COL.num.x,    y + TXT_OFF);
    drawText(doc, fmtDate(new Date(u.uploadedAt)),   COL.upload.x, y + TXT_OFF);
    drawText(doc, `${firstIdx}-${lastIdx}`,          COL.idx.x,    y + TXT_OFF);
    // Title as clickable YouTube link
    const ytUrl = `https://www.youtube.com/watch?v=${u.videoId}`;
    doc.fillColor(isOOO ? '#CC0000' : '#1a0dab');
    doc.text(u.title, COL.title.x, y + TXT_OFF, {
      width: COL.title.w,
      lineBreak: false,
      link: ytUrl,
      underline: true,
    });
    doc.fillColor(isOOO ? '#CC0000' : '#222');
    drawText(doc, String(games),                     COL.games.x,  y + TXT_OFF);
    drawText(doc, hours,                             COL.hours.x,  y + TXT_OFF);
    if (isOOO) {
      doc.font('Helvetica-Bold').fillColor('#CC0000');
      drawText(doc, 'OUT OF ORDER', COL.flag.x, y + TXT_OFF);
      doc.font('Helvetica');
    }

    y += ROW_H;

    // Index gap line (between this row and the next, i.e. between newer and older)
    if (idxGapInfo) {
      if (y + 18 > PAGE_BOTTOM) {
        doc.addPage();
        y = 40;
        drawHeader();
      }
      y += 2;
      doc.moveTo(LEFT, y).lineTo(LEFT + TABLE_W, y).lineWidth(2).strokeColor('#1a5fb4').stroke();
      doc.fontSize(7).fillColor('#1a5fb4');
      const label = idxGapInfo.overlap
        ? `INDEX OVERLAP: indices ${idxGapInfo.missingStart} / ${idxGapInfo.missingEnd} not contiguous (out-of-order upload)`
        : `INDEX GAP: missing indices ${idxGapInfo.missingStart}-${idxGapInfo.missingEnd} (${idxGapInfo.count} games not in upload order here)`;
      drawText(doc, label, LEFT + 180, y + 2);
      y += 14;
    }
  }

  doc.end();
  await new Promise(resolve => stream.on('finish', resolve));
  console.log('PDF saved to:', outPath);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
