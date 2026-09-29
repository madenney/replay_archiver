#!/usr/bin/env node
// Local UI for publishing the archive by hand, in order, with live verification.
//
// Publishing writes a PERMANENT publishedAt and the channel sorts by it forever,
// so the sequence must be exact. This serves a page that always shows the single
// next video to publish, watches YouTube until it actually goes public, and
// checks its timestamp landed after the previous one before advancing.
//
// Quota-aware: auto-check polls ONLY the current video (1 unit per poll). A full
// sweep of all 656 costs 14 units and happens only when asked for.
//
// Usage: node scripts/publish_ui.js [--port 8777]
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { google } from 'googleapis';

const OUTPUT_DIR = process.env.OUTPUT_DIR;
const FINAL_DIR = process.env.FINAL_DIR || path.join(OUTPUT_DIR || '', 'final');
const PORT = Number((process.argv.includes('--port') && process.argv[process.argv.indexOf('--port') + 1]) || 8777);

const yt = (() => {
  const o = new google.auth.OAuth2(process.env.YOUTUBE_CLIENT_ID, process.env.YOUTUBE_CLIENT_SECRET);
  o.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });
  return google.youtube({ version: 'v3', auth: o });
})();

function buildOrder() {
  const vids = [];
  for (const mf of fs.readdirSync(FINAL_DIR).filter((f) => f.endsWith('.manifest.json'))) {
    const m = JSON.parse(fs.readFileSync(path.join(FINAL_DIR, mf), 'utf8'));
    if (!m.videoId) throw new Error(`Manifest has no videoId: ${mf}`);
    const games = [...m.games].sort((a, b) => a.index - b.index);
    const dates = games.map((g) => g.date).filter(Boolean);
    vids.push({
      videoId: m.videoId, title: m.title,
      lo: games[0].index, hi: games[games.length - 1].index, games: games.length,
      firstDate: dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null,
      lastDate: dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null,
    });
  }
  const byIdx = [...vids].sort((a, b) => a.lo - b.lo);
  const byDate = [...vids].sort((a, b) => String(a.firstDate).localeCompare(String(b.firstDate)));
  const byHi = [...vids].sort((a, b) => a.hi - b.hi);
  const key = (l) => l.map((v) => v.videoId).join(',');
  if (key(byIdx) !== key(byDate) || key(byIdx) !== key(byHi)) {
    throw new Error('ORDER AMBIGUOUS: index / first-date / last-index sorts disagree. Refusing to start.');
  }
  return byIdx.map((v, i) => ({ position: i + 1, ...v }));
}

const ORDER = buildOrder();
/** videoId -> { privacyStatus, publishedAt, checkedAt } */
const LIVE = new Map();
let quotaUsed = 0;

async function fetchMany(ids) {
  for (let i = 0; i < ids.length; i += 50) {
    const slice = ids.slice(i, i + 50);
    const r = await yt.videos.list({ part: ['status', 'snippet'], id: slice, maxResults: 50 });
    quotaUsed += 1;
    for (const v of r.data.items || []) {
      LIVE.set(v.id, {
        privacyStatus: v.status.privacyStatus,
        publishedAt: v.snippet.publishedAt,
        checkedAt: new Date().toISOString(),
      });
    }
  }
}

// Everything the UI needs, derived from whatever we currently know.
function snapshot() {
  const rows = ORDER.map((v) => ({ ...v, live: LIVE.get(v.videoId) || null }));
  const publishedInOrder = rows.filter((r) => r.live?.privacyStatus === 'public');
  const violations = [];
  for (let i = 1; i < publishedInOrder.length; i += 1) {
    const a = publishedInOrder[i - 1], b = publishedInOrder[i];
    if (new Date(b.live.publishedAt) <= new Date(a.live.publishedAt)) {
      violations.push({
        position: b.position, videoId: b.videoId,
        detail: `#${b.position} published ${b.live.publishedAt} is not after #${a.position} (${a.live.publishedAt})`,
      });
    }
  }
  // next = first row not known to be public
  const next = rows.find((r) => r.live?.privacyStatus !== 'public') || null;
  const lastPublished = [...publishedInOrder].pop() || null;
  return {
    counts: {
      total: rows.length,
      public: rows.filter((r) => r.live?.privacyStatus === 'public').length,
      unlisted: rows.filter((r) => r.live?.privacyStatus === 'unlisted').length,
      private: rows.filter((r) => r.live?.privacyStatus === 'private').length,
      unknown: rows.filter((r) => !r.live).length,
    },
    quotaUsed,
    violations,
    next: next && {
      position: next.position, videoId: next.videoId, title: next.title,
      firstDate: next.firstDate, lo: next.lo, hi: next.hi, games: next.games,
      live: next.live || null,
    },
    lastPublished: lastPublished && {
      position: lastPublished.position, publishedAt: lastPublished.live.publishedAt,
    },
    rows: rows.map((r) => ({
      position: r.position, videoId: r.videoId, title: r.title, firstDate: r.firstDate,
      lo: r.lo, hi: r.hi, privacy: r.live?.privacyStatus || null, publishedAt: r.live?.publishedAt || null,
    })),
  };
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/') return send(res, 200, PAGE, 'text/html; charset=utf-8');

    if (url.pathname === '/api/state') return send(res, 200, snapshot());

    // Cheap: check one video (1 quota unit). Used by auto-check.
    if (url.pathname === '/api/check-one') {
      const id = url.searchParams.get('id');
      if (!id) return send(res, 400, { error: 'id required' });
      await fetchMany([id]);
      return send(res, 200, snapshot());
    }

    // Full sweep of all videos (14 units).
    if (url.pathname === '/api/sweep') {
      await fetchMany(ORDER.map((v) => v.videoId));
      return send(res, 200, snapshot());
    }

    send(res, 404, { error: 'not found' });
  } catch (err) {
    send(res, 500, { error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`Publish UI: http://localhost:${PORT}`);
  console.log('Doing an initial full sweep (14 quota units)...');
  try {
    await fetchMany(ORDER.map((v) => v.videoId));
    const s = snapshot();
    console.log(`  ${s.counts.public} public, ${s.counts.unlisted} unlisted, ${s.counts.private} private`);
    console.log(`  next: #${s.next?.position} ${s.next?.title}`);
    if (s.violations.length) console.log(`  !! ${s.violations.length} ORDER VIOLATIONS`);
  } catch (e) {
    console.error('initial sweep failed:', e.message);
  }
  console.log('Open the URL above. Ctrl+C to stop.');
});

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Publish Archive</title>
<style>
  :root{
    --bg:#ffffff;--fg:#16181d;--muted:#6b7280;--line:#e5e7eb;--panel:#f6f7f9;
    --accent:#2563eb;--ok:#15803d;--okbg:#dcfce7;--warn:#b45309;--danger:#b91c1c;--dangerbg:#fee2e2;
  }
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
    --bg:#111318;--fg:#e7e9ee;--muted:#9aa1ad;--line:#282c35;--panel:#191c22;
    --accent:#6ea8fe;--ok:#4ade80;--okbg:#0f2a19;--warn:#fbbf24;--danger:#f87171;--dangerbg:#2a1214;}}
  :root[data-theme="dark"]{
    --bg:#111318;--fg:#e7e9ee;--muted:#9aa1ad;--line:#282c35;--panel:#191c22;
    --accent:#6ea8fe;--ok:#4ade80;--okbg:#0f2a19;--warn:#fbbf24;--danger:#f87171;--dangerbg:#2a1214;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
    font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;padding:0 16px 64px}
  .wrap{max-width:1000px;margin:0 auto}
  h1{font-size:17px;margin:18px 0 2px;letter-spacing:-.01em}
  .sub{color:var(--muted);font-size:13px}
  .alert{margin:14px 0;padding:12px 14px;border-radius:9px;background:var(--dangerbg);
    border:1px solid var(--danger);color:var(--danger);font-weight:600}
  .alert ul{margin:8px 0 0 18px;font-weight:400}
  .card{margin:14px 0;padding:16px;border:1px solid var(--line);border-radius:11px;background:var(--panel)}
  .card.done{border-color:var(--ok);background:var(--okbg)}
  .lbl{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:6px}
  .bigtitle{font-size:20px;font-weight:650;letter-spacing:-.01em;margin-bottom:4px}
  .meta{color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums}
  .actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:13px}
  a.btn,button{font:inherit;font-weight:600;padding:9px 15px;border-radius:8px;border:1px solid var(--line);
    background:var(--bg);color:var(--fg);cursor:pointer;text-decoration:none;display:inline-block}
  a.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
  button:hover,a.btn:hover{border-color:var(--accent)}
  button:disabled{opacity:.5;cursor:default}
  .bar{height:8px;background:var(--panel);border:1px solid var(--line);border-radius:5px;overflow:hidden;margin:12px 0 8px}
  .fill{height:100%;background:var(--ok);width:0;transition:width .3s}
  .stats{display:flex;gap:20px;flex-wrap:wrap;font-variant-numeric:tabular-nums;font-size:13px}
  .stats b{font-weight:650}
  .pill{display:inline-block;padding:1px 8px;border-radius:99px;font-size:11px;font-weight:650;
    border:1px solid var(--line);color:var(--muted)}
  .pill.public{color:var(--ok);border-color:var(--ok)}
  .pill.unlisted{color:var(--warn);border-color:var(--warn)}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);
    font-weight:600;padding:6px 8px;border-bottom:1px solid var(--line)}
  td{padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:middle}
  .pos{color:var(--muted);text-align:right;width:52px;font-variant-numeric:tabular-nums}
  .date,.ts{color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
  tr.cur{background:color-mix(in srgb,var(--accent) 12%,transparent)}
  tr.cur .pos{color:var(--accent);font-weight:700}
  tr.pub td{opacity:.55}
  .foot{margin-top:18px;color:var(--muted);font-size:12px}
  .spin{display:inline-block;width:12px;height:12px;border:2px solid var(--line);
    border-top-color:var(--accent);border-radius:50%;animation:s .7s linear infinite;vertical-align:-2px}
  @keyframes s{to{transform:rotate(360deg)}}
  @media(max-width:640px){.hide-sm{display:none}}
</style>
</head>
<body><div class="wrap">
  <h1>Publish Archive — chronological rollout</h1>
  <div class="sub">Publish strictly top to bottom. Never skip ahead — the order is permanent.</div>

  <div id="violations"></div>

  <div class="card" id="nextcard">
    <div class="lbl">Next to publish — <span id="nextpos">—</span></div>
    <div class="bigtitle" id="nexttitle">Loading…</div>
    <div class="meta" id="nextmeta"></div>
    <div class="actions">
      <a class="btn primary" id="studio" href="#" target="_blank" rel="noopener">Open in YouTube Studio ↗</a>
      <button id="checknow">Check this one now</button>
      <label class="meta"><input type="checkbox" id="auto" checked> auto-check every
        <select id="interval"><option value="5">5s</option><option value="10" selected>10s</option><option value="20">20s</option></select>
      </label>
      <span id="watching" class="meta"></span>
    </div>
  </div>

  <div class="bar"><div class="fill" id="fill"></div></div>
  <div class="stats">
    <span><b id="cpub">0</b> public</span>
    <span><b id="cleft">0</b> remaining</span>
    <span class="hide-sm"><b id="cunl">0</b> unlisted</span>
    <span class="hide-sm">quota used <b id="quota">0</b></span>
    <span><button id="sweep">Full verify (14 units)</button></span>
  </div>

  <table>
    <thead><tr><th class="pos">#</th><th>Date</th><th>Title</th><th class="hide-sm">Games</th><th>Status</th><th class="hide-sm">Published at</th></tr></thead>
    <tbody id="tb"></tbody>
  </table>
  <div class="foot">Auto-check polls only the next video (1 quota unit each). Full verify sweeps all 656.</div>
</div>
<script>
let state=null, timer=null, busy=false;

async function get(u){const r=await fetch(u);if(!r.ok)throw new Error((await r.json()).error||r.statusText);return r.json()}

function fmt(ts){return ts?ts.replace('T',' ').replace(/\\.\\d+Z|Z/,''):''}

function render(){
  if(!state)return;
  const c=state.counts;
  document.getElementById('cpub').textContent=c.public;
  document.getElementById('cleft').textContent=c.total-c.public;
  document.getElementById('cunl').textContent=c.unlisted;
  document.getElementById('quota').textContent=state.quotaUsed;
  document.getElementById('fill').style.width=(c.public/c.total*100).toFixed(2)+'%';

  const vd=document.getElementById('violations');
  if(state.violations.length){
    vd.innerHTML='<div class="alert">⚠ '+state.violations.length+' ORDER VIOLATION(S) — STOP PUBLISHING'+
      '<ul>'+state.violations.slice(0,5).map(v=>'<li>'+v.detail+'</li>').join('')+'</ul></div>';
  } else vd.innerHTML='';

  const n=state.next, card=document.getElementById('nextcard');
  if(n){
    card.classList.remove('done');
    document.getElementById('nextpos').textContent='#'+n.position+' of '+c.total;
    document.getElementById('nexttitle').textContent=n.title;
    document.getElementById('nextmeta').textContent=
      (n.firstDate||'').slice(0,10)+'   ·   games '+n.lo+'–'+n.hi+'   ·   currently '+(n.live?n.live.privacyStatus:'unknown');
    document.getElementById('studio').href='https://studio.youtube.com/video/'+n.videoId+'/edit';
  }else{
    card.classList.add('done');
    document.getElementById('nextpos').textContent='';
    document.getElementById('nexttitle').textContent='All '+c.total+' published 🎉';
    document.getElementById('nextmeta').textContent=state.violations.length?'But there are order violations — see above.':'Every video is public and in order.';
  }

  const tb=document.getElementById('tb');
  const start=Math.max(0,(n?n.position-1:c.total)-3);
  tb.innerHTML=state.rows.slice(start,start+40).map(r=>{
    const cur=n&&r.position===n.position;
    const pub=r.privacy==='public';
    return '<tr class="'+(cur?'cur':'')+(pub?' pub':'')+'">'+
      '<td class="pos">'+r.position+'</td>'+
      '<td class="date">'+(r.firstDate||'').slice(0,10)+'</td>'+
      '<td>'+r.title+'</td>'+
      '<td class="hide-sm date">'+(r.hi-r.lo+1)+'</td>'+
      '<td><span class="pill '+(r.privacy||'')+'">'+(r.privacy||'?')+'</span></td>'+
      '<td class="hide-sm ts">'+fmt(r.publishedAt)+'</td></tr>';
  }).join('');
}

async function checkOne(){
  if(busy||!state||!state.next)return;
  busy=true;document.getElementById('watching').innerHTML='<span class="spin"></span>';
  try{state=await get('/api/check-one?id='+state.next.videoId);render()}
  catch(e){document.getElementById('watching').textContent=e.message}
  finally{busy=false;setTimeout(()=>{const w=document.getElementById('watching');if(!busy)w.textContent=''},400)}
}

async function sweep(){
  busy=true;const b=document.getElementById('sweep');b.disabled=true;b.textContent='Verifying…';
  try{state=await get('/api/sweep');render()}catch(e){alert(e.message)}
  finally{busy=false;b.disabled=false;b.textContent='Full verify (14 units)'}
}

function schedule(){
  if(timer)clearInterval(timer);
  if(document.getElementById('auto').checked){
    timer=setInterval(checkOne,Number(document.getElementById('interval').value)*1000);
  }
}

document.getElementById('checknow').addEventListener('click',checkOne);
document.getElementById('sweep').addEventListener('click',sweep);
document.getElementById('auto').addEventListener('change',schedule);
document.getElementById('interval').addEventListener('change',schedule);

get('/api/state').then(s=>{state=s;render();schedule()});
</script>
</body></html>`;
