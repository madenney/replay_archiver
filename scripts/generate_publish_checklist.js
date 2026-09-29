#!/usr/bin/env node
// Generate an ordered click-through checklist for publishing by hand.
//
// The API costs 50 quota units per video, so a day's quota may not cover all
// 656. This produces a local page listing every video in the SAME verified
// chronological order, with a direct link to its YouTube Studio page, so the
// rest can be finished by hand the same day without losing the sequence.
//
// Videos already published by publish_sequential.js are pre-marked, so the
// list picks up exactly where the script stopped.
//
// Usage: node scripts/generate_publish_checklist.js
import 'dotenv/config';
import fs from 'fs';
import path from 'path';

const OUTPUT_DIR = process.env.OUTPUT_DIR;
const FINAL_DIR = process.env.FINAL_DIR || path.join(OUTPUT_DIR || '', 'final');
const STATE_FILE = path.resolve('reports/publish_sequential_state.json');
const OUT = path.resolve('reports/publish_checklist.html');

function buildOrder() {
  const vids = [];
  for (const mf of fs.readdirSync(FINAL_DIR).filter((f) => f.endsWith('.manifest.json'))) {
    const m = JSON.parse(fs.readFileSync(path.join(FINAL_DIR, mf), 'utf8'));
    if (!m.videoId) throw new Error(`Manifest has no videoId: ${mf}`);
    const games = [...m.games].sort((a, b) => a.index - b.index);
    const dates = games.map((g) => g.date).filter(Boolean);
    vids.push({
      videoId: m.videoId,
      title: m.title,
      lo: games[0].index,
      hi: games[games.length - 1].index,
      games: games.length,
      firstDate: dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null,
      lastDate: dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null,
    });
  }
  const byIdx = [...vids].sort((a, b) => a.lo - b.lo);
  const byDate = [...vids].sort((a, b) => String(a.firstDate).localeCompare(String(b.firstDate)));
  const byHi = [...vids].sort((a, b) => a.hi - b.hi);
  const key = (l) => l.map((v) => v.videoId).join(',');
  if (key(byIdx) !== key(byDate) || key(byIdx) !== key(byHi)) {
    throw new Error('ORDER AMBIGUOUS — refusing to emit a checklist.');
  }
  return byIdx.map((v, i) => ({ position: i + 1, ...v }));
}

let done = {};
try {
  done = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).published || {};
} catch { /* none yet */ }

const order = buildOrder();
const rows = order
  .map((v) => {
    const pub = !!done[v.videoId];
    return `<tr class="row${pub ? ' pre' : ''}" data-id="${v.videoId}" data-pos="${v.position}">
  <td class="pos">${v.position}</td>
  <td class="chk"><input type="checkbox" ${pub ? 'checked disabled' : ''} data-id="${v.videoId}"></td>
  <td class="date">${(v.firstDate || '').slice(0, 10)}</td>
  <td class="title">${v.title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</td>
  <td class="idx">${v.lo}–${v.hi}</td>
  <td class="lnk"><a href="https://studio.youtube.com/video/${v.videoId}/edit" target="_blank" rel="noopener">Studio ↗</a></td>
</tr>`;
  })
  .join('\n');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Publish Checklist</title>
<style>
  :root{--bg:#fff;--fg:#1a1a1a;--muted:#666;--line:#e3e3e3;--accent:#2563eb;--done:#16a34a;--panel:#f7f7f8;}
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#15161a;--fg:#e8e8ea;--muted:#9a9aa2;--line:#2c2d33;--accent:#6ea8fe;--done:#4ade80;--panel:#1c1d22;}}
  :root[data-theme="dark"]{--bg:#15161a;--fg:#e8e8ea;--muted:#9a9aa2;--line:#2c2d33;--accent:#6ea8fe;--done:#4ade80;--panel:#1c1d22;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;padding:0 16px 80px}
  header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:16px 0 12px;z-index:5}
  h1{margin:0 0 4px;font-size:18px;letter-spacing:-0.01em}
  .sub{color:var(--muted);font-size:13px;margin-bottom:10px}
  .bar{height:6px;background:var(--panel);border-radius:3px;overflow:hidden;margin:10px 0 8px}
  .fill{height:100%;background:var(--done);width:0%;transition:width .2s}
  .stats{display:flex;gap:18px;flex-wrap:wrap;font-variant-numeric:tabular-nums;font-size:13px}
  .stats b{font-weight:600}
  .next{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:10px 0}
  .next .lbl{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
  .next a{color:var(--accent);font-weight:600;text-decoration:none}
  .next a:hover{text-decoration:underline}
  .controls{display:flex;gap:10px;align-items:center;margin-top:8px;flex-wrap:wrap}
  button{font:inherit;padding:5px 10px;border:1px solid var(--line);background:var(--panel);color:var(--fg);border-radius:6px;cursor:pointer}
  button:hover{border-color:var(--accent)}
  table{width:100%;border-collapse:collapse;max-width:1100px}
  td{padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:middle}
  .pos{color:var(--muted);font-variant-numeric:tabular-nums;text-align:right;width:56px}
  .chk{width:34px}
  .date{color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap;width:104px}
  .idx{color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap;font-size:13px}
  .lnk a{color:var(--accent);text-decoration:none;white-space:nowrap}
  .lnk a:hover{text-decoration:underline}
  tr.checked td,tr.pre td{opacity:.42}
  tr.current{background:color-mix(in srgb,var(--accent) 10%,transparent)}
  tr.current .pos{color:var(--accent);font-weight:700}
  .hidedone tr.checked,.hidedone tr.pre{display:none}
  @media(max-width:640px){.idx{display:none}}
</style>
</head>
<body>
<header>
  <h1>Publish Checklist — Hax Archive</h1>
  <div class="sub">${order.length} videos in verified chronological order. Work top to bottom; never skip ahead.</div>
  <div class="bar"><div class="fill" id="fill"></div></div>
  <div class="stats">
    <span><b id="cdone">0</b> published</span>
    <span><b id="cleft">0</b> remaining</span>
    <span>position <b id="cpos">—</b></span>
  </div>
  <div class="next">
    <div class="lbl">Next to publish</div>
    <div><a id="nextlink" href="#" target="_blank" rel="noopener">—</a></div>
  </div>
  <div class="controls">
    <button id="toggle">Hide completed</button>
    <button id="reset">Reset my progress</button>
    <span class="sub" style="margin:0">Progress is saved in this browser.</span>
  </div>
</header>
<table><tbody id="tb">
${rows}
</tbody></table>
<script>
(function(){
  var KEY='haxPublishChecklist';
  var saved={};
  try{saved=JSON.parse(localStorage.getItem(KEY)||'{}')}catch(e){saved={}}
  var tb=document.getElementById('tb');
  var rows=[].slice.call(tb.querySelectorAll('tr'));

  function persist(){try{localStorage.setItem(KEY,JSON.stringify(saved))}catch(e){}}

  function refresh(){
    var done=0,current=null;
    rows.forEach(function(tr){
      var id=tr.dataset.id;
      var pre=tr.classList.contains('pre');
      var on=pre||!!saved[id];
      tr.classList.toggle('checked',!!saved[id]&&!pre);
      tr.classList.remove('current');
      if(on){done++}else if(!current){current=tr}
    });
    if(current)current.classList.add('current');
    document.getElementById('cdone').textContent=done;
    document.getElementById('cleft').textContent=rows.length-done;
    document.getElementById('cpos').textContent=current?current.dataset.pos+' / '+rows.length:'done';
    document.getElementById('fill').style.width=(done/rows.length*100).toFixed(1)+'%';
    var a=document.getElementById('nextlink');
    if(current){
      a.textContent='#'+current.dataset.pos+'  '+current.querySelector('.title').textContent;
      a.href='https://studio.youtube.com/video/'+current.dataset.id+'/edit';
    }else{a.textContent='All done';a.removeAttribute('href')}
  }

  tb.addEventListener('change',function(e){
    var cb=e.target;
    if(cb.tagName!=='INPUT')return;
    if(cb.checked)saved[cb.dataset.id]=1;else delete saved[cb.dataset.id];
    persist();refresh();
  });
  rows.forEach(function(tr){
    var cb=tr.querySelector('input');
    if(cb&&!cb.disabled&&saved[tr.dataset.id])cb.checked=true;
  });
  document.getElementById('toggle').addEventListener('click',function(){
    document.body.classList.toggle('hidedone');
    this.textContent=document.body.classList.contains('hidedone')?'Show all':'Hide completed';
  });
  document.getElementById('reset').addEventListener('click',function(){
    if(!confirm('Clear your manual check-offs? Videos already published by the script stay marked.'))return;
    saved={};persist();
    rows.forEach(function(tr){var cb=tr.querySelector('input');if(cb&&!cb.disabled)cb.checked=false});
    refresh();
  });
  refresh();
})();
</script>
</body>
</html>
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
const pre = order.filter((v) => done[v.videoId]).length;
console.log(`videos            : ${order.length}`);
console.log(`already published : ${pre} (pre-marked)`);
console.log(`remaining         : ${order.length - pre}`);
console.log(`\nchecklist written : ${OUT}`);
console.log(`open with         : xdg-open ${OUT}`);
