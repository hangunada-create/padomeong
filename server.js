// 파도멍 서버 — 화면 파일을 내보내고, 같은 바닷가에 있는 사람들을 서로 이어 줍니다.
//   · 위치 전달           · 손 흔들기 / 랜턴 불 나누기
//   · 유리병 편지 (저장)   · 머문 시간 통계 (숫자만)
// 실행: npm install && npm start   (기본 포트 3000, PORT 환경변수로 변경)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_KEY = process.env.ADMIN_KEY || '';          // 통계·유리병 관리 주소를 여는 열쇠
const WORLD_W = 3200, D_MIN = 0.03, D_MAX = 1;
const MAX_PEOPLE = 500;        // 한 바닷가에 동시에 있을 수 있는 사람 수
const MAX_PER_IP = 8;
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
                '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
                '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.json': 'application/json; charset=utf-8' };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v, f) => (typeof v === 'number' && Number.isFinite(v) ? v : f);
const kstDay = (t = Date.now()) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);
const salt = crypto.randomBytes(16).toString('hex');      // IP는 저장하지 않고, 실행 중에만 쓰는 가림값으로 바꿔 씀
const ipTag = ip => crypto.createHash('sha256').update(salt + ip).digest('hex').slice(0, 16);

/* ───────── 저장 (data 폴더의 JSON 파일) ───────── */
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
function load(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); } catch (e) { return fallback; }
}
const saveTimers = {};
function save(name, obj) {
  clearTimeout(saveTimers[name]);
  saveTimers[name] = setTimeout(() => {
    const f = path.join(DATA_DIR, name);
    fs.writeFile(f + '.tmp', JSON.stringify(obj), err => { if (!err) fs.rename(f + '.tmp', f, () => {}); });
  }, 2000);
}

/* ───────── 유리병 편지 ───────── */
const bottles = load('bottles.json', { next: 1, list: [] });   // {id, text, ts, reports:[tag...], hidden}
const MAX_BOTTLES = 3000;
// 아주 기본적인 거르기. 운영하면서 필요한 낱말을 더하세요.
const BANNED = ['시발', '씨발', 'ㅅㅂ', '병신', 'ㅂㅅ', '좆', '개새', '미친놈', '미친년', '꺼져', '죽어', '자살', '섹스', '야동', '도박', '토토', '카지노', '대출', '텔레그램', '카톡', '오픈채팅'];
function checkBottle(text) {
  if (typeof text !== 'string') return '글을 적어 주세요';
  const s = text.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length < 2) return '두 글자 이상 적어 주세요';
  if (s.length > 80) return '80자까지 띄울 수 있어요';
  const flat = s.replace(/\s/g, '').toLowerCase();
  if (/(https?:|www\.|\.(com|kr|net|org|io|me|gg|ly)\b|@[a-z0-9_]{3,})/i.test(s)) return '주소나 계정은 띄울 수 없어요';
  if (/\d[\d\s\-.]{6,}\d/.test(s)) return '전화번호 같은 숫자는 띄울 수 없어요';
  if (BANNED.some(w => flat.includes(w))) return '이 말은 바다에 띄울 수 없어요';
  return { text: s };
}
const lastBottleBy = new Map();   // 가림값 → 마지막으로 띄운 시각

/* ───────── 통계 (숫자만 모음) ───────── */
const stats = load('stats.json', {});   // { 'YYYY-MM-DD': {...} }
const BUCKETS = ['1분 미만', '1~5분', '5~15분', '15~30분', '30~60분', '1시간 이상'];
function day() {
  const k = kstDay();
  if (!stats[k]) {
    stats[k] = { 방문: 0, 머문시간합_초: 0, 앉은시간합_초: 0, 머문시간분포: Object.fromEntries(BUCKETS.map(b => [b, 0])),
                 최대동시접속: 0, 손흔들기: 0, 띄운병: 0, 받은병: 0, 빈병: 0, 신고: 0 };
    const keys = Object.keys(stats).sort(); while (keys.length > 120) delete stats[keys.shift()];
  }
  return stats[k];
}
function bump(field, n = 1) { day()[field] += n; save('stats.json', stats); }
function recordVisit(sec, sitSec) {
  const d = day();
  if (sec < 5) return;                    // 들어오자마자 나간 연결(새로고침 등)은 세지 않음
  d.방문++; d.머문시간합_초 += Math.round(sec); d.앉은시간합_초 += Math.round(sitSec);
  const m = sec / 60, b = m < 1 ? 0 : m < 5 ? 1 : m < 15 ? 2 : m < 30 ? 3 : m < 60 ? 4 : 5;
  d.머문시간분포[BUCKETS[b]]++;
  save('stats.json', stats);
}
function statsView() {
  const out = {};
  for (const [k, d] of Object.entries(stats).sort().reverse()) {
    out[k] = { ...d, 평균머문시간_분: d.방문 ? +(d.머문시간합_초 / d.방문 / 60).toFixed(1) : 0,
               평균앉은시간_분: d.방문 ? +(d.앉은시간합_초 / d.방문 / 60).toFixed(1) : 0 };
  }
  return { 지금접속: people.size, 날짜별: out };
}

/* ───────── HTTP ───────── */
function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj, null, 1)); }
function isAdmin(u) { return ADMIN_KEY && u.searchParams.get('key') === ADMIN_KEY; }

const server = http.createServer((req, res) => {
  let u, p;
  try { u = new URL(req.url, 'http://x'); p = decodeURIComponent(u.pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (p === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok ' + people.size); }

  // 관리용: ADMIN_KEY 환경변수를 정해 두었을 때만 열림
  if (p === '/stats' || p.startsWith('/admin/')) {
    if (!ADMIN_KEY) return json(res, 403, { 안내: 'ADMIN_KEY 환경변수를 정하면 열려요' });
    if (!isAdmin(u)) return json(res, 403, { 안내: '열쇠가 맞지 않아요' });
    if (p === '/stats') return json(res, 200, statsView());
    if (p === '/admin/bottles') return json(res, 200, bottles.list.slice().reverse().map(b => ({ id: b.id, 글: b.text, 날짜: new Date(b.ts).toISOString(), 신고: b.reports.length, 숨김: !!b.hidden })));
    if (p === '/admin/hide' || p === '/admin/show') {
      const b = bottles.list.find(b => b.id === Number(u.searchParams.get('id')));
      if (!b) return json(res, 404, { 안내: '없는 병이에요' });
      b.hidden = p === '/admin/hide'; save('bottles.json', bottles);
      return json(res, 200, { id: b.id, 숨김: b.hidden });
    }
    return json(res, 404, {});
  }

  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('없는 주소예요'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
                         'cache-control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=3600' });
    res.end(data);
  });
});

/* ───────── 실시간 연결 ───────── */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2048 });
const people = new Map();      // id → {ws, x, d, sit, color, name}
const perIp = new Map();
const dirty = new Set();
let nextId = 1;

function cleanName(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 10);
}
function sendAll(obj, except) {
  const s = JSON.stringify(obj);
  for (const [id, p] of people) if (id !== except && p.ws.readyState === 1) p.ws.send(s);
}
const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

wss.on('connection', (ws, req) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const tag = ipTag(ip);
  const ipCount = (perIp.get(ip) || 0) + 1;
  if (people.size >= MAX_PEOPLE || ipCount > MAX_PER_IP) return ws.close(1013, 'full');
  perIp.set(ip, ipCount);

  let id = null, msgs = 0, windowStart = Date.now(), lastGesture = 0;
  const joinedAt = Date.now(); let sitSince = 0, sitTotal = 0;
  const mine = new Set(), seen = new Set();          // 이 연결이 띄운 병, 이미 받은 병
  ws.alive = Date.now();

  ws.on('message', raw => {
    const t = Date.now();
    if (t - windowStart > 1000) { windowStart = t; msgs = 0; }
    if (++msgs > 25) return;                 // 너무 잦은 전송은 버림
    ws.alive = t;
    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;

    if (m.t === 'join' && id === null) {
      id = nextId++;
      const me = { ws, x: clamp(num(m.x, WORLD_W / 2), 40, WORLD_W - 40), d: clamp(num(m.d, 0.8), D_MIN, D_MAX),
                   sit: m.sit ? 1 : 0, color: clamp(Math.floor(num(m.color, 0)), 0, 7), name: cleanName(m.name) };
      const list = [];
      for (const [pid, p] of people) list.push([pid, p.x, p.d, p.sit, p.color, p.name]);
      people.set(id, me);
      const d = day(); d.최대동시접속 = Math.max(d.최대동시접속, people.size);
      send(ws, { t: 'hi', id, now: Date.now(), p: list });
      sendAll({ t: 'in', p: [id, me.x, me.d, me.sit, me.color, me.name] }, id);
      return;
    }
    if (id === null) return;
    const me = people.get(id); if (!me) return;

    if (m.t === 's') {
      me.x = clamp(num(m.x, me.x), 40, WORLD_W - 40);
      me.d = clamp(num(m.d, me.d), D_MIN, D_MAX);
      const sit = m.sit ? 1 : 0;
      if (sit && !me.sit) sitSince = t;
      if (!sit && me.sit && sitSince) { sitTotal += t - sitSince; sitSince = 0; }
      me.sit = sit;
      dirty.add(id);

    } else if (m.t === 'g') {                     // 손 흔들기 / 랜턴 불 나누기
      const to = Number(m.to);
      if (t - lastGesture < 2000 || to === id || !people.has(to)) return;
      lastGesture = t; bump('손흔들기');
      sendAll({ t: 'g', from: id, to });

    } else if (m.t === 'bq') {                    // 유리병 하나 받기
      const pool = bottles.list.filter(b => !b.hidden && !mine.has(b.id) && !seen.has(b.id));
      if (!pool.length) { bump('빈병'); return send(ws, { t: 'b', id: null }); }
      // 최근 병이 조금 더 자주 오되, 오래된 병도 계속 떠다니게
      const b = pool[Math.floor(Math.pow(Math.random(), 0.7) * pool.length)];
      seen.add(b.id); bump('받은병');
      send(ws, { t: 'b', id: b.id, text: b.text });

    } else if (m.t === 'bs') {                    // 유리병 띄우기
      const wait = 10 * 60e3 - (t - (lastBottleBy.get(tag) || 0));
      if (wait > 0) return send(ws, { t: 'bs', ok: false, msg: `조금 쉬었다가 띄워요 (${Math.ceil(wait / 60e3)}분 뒤)` });
      const r = checkBottle(m.text);
      if (typeof r === 'string') return send(ws, { t: 'bs', ok: false, msg: r });
      const b = { id: bottles.next++, text: r.text, ts: t, reports: [], hidden: false };
      bottles.list.push(b); while (bottles.list.length > MAX_BOTTLES) bottles.list.shift();
      mine.add(b.id); lastBottleBy.set(tag, t);
      save('bottles.json', bottles); bump('띄운병');
      send(ws, { t: 'bs', ok: true });

    } else if (m.t === 'rep') {                   // 신고: 서로 다른 사람 셋이 신고하면 숨김
      const b = bottles.list.find(b => b.id === Number(m.id));
      if (!b || b.reports.includes(tag)) return;
      b.reports.push(tag); if (b.reports.length >= 3) b.hidden = true;
      save('bottles.json', bottles); bump('신고');
    }
  });

  ws.on('close', () => {
    const c = (perIp.get(ip) || 1) - 1; if (c <= 0) perIp.delete(ip); else perIp.set(ip, c);
    if (id !== null) {
      const t = Date.now(); if (sitSince) sitTotal += t - sitSince;
      recordVisit((t - joinedAt) / 1000, sitTotal / 1000);
      people.delete(id); dirty.delete(id); sendAll({ t: 'out', id });
    }
  });
  ws.on('error', () => {});
});

// 움직인 사람들의 위치를 모아서 한 번에 전달
setInterval(() => {
  if (!dirty.size) return;
  const list = [];
  for (const id of dirty) { const p = people.get(id); if (p) list.push([id, p.x, p.d, p.sit]); }
  dirty.clear();
  if (list.length) {
    for (const [id, p] of people) {
      if (p.ws.readyState !== 1) continue;
      const others = list.filter(a => a[0] !== id);
      if (others.length) p.ws.send(JSON.stringify({ t: 'm', p: others }));
    }
  }
}, 150);

// 60초 동안 소식이 없는 연결은 정리 (화면은 15초마다 한 번씩 위치를 다시 보냄)
setInterval(() => {
  const t = Date.now();
  for (const ws of wss.clients) if (t - ws.alive > 60000) ws.terminate();
}, 20000);

// 하루에 한 번, 어제 숫자를 서버 기록에 남김
let lastDay = kstDay();
setInterval(() => {
  const k = kstDay(); if (k === lastDay) return;
  const d = stats[lastDay];
  if (d) console.log(`[통계 ${lastDay}] 방문 ${d.방문}, 평균 머문 시간 ${d.방문 ? (d.머문시간합_초 / d.방문 / 60).toFixed(1) : 0}분, 최대 동시 ${d.최대동시접속}명, 띄운 병 ${d.띄운병}`);
  lastDay = k;
}, 60e3);

// 메타모아에 접속자 수 보내기 (선택). 환경변수 METAMOA_SPACE_ID, METAMOA_KEY 가 있을 때만 동작.
const { METAMOA_SPACE_ID, METAMOA_KEY } = process.env;
if (METAMOA_SPACE_ID && METAMOA_KEY) {
  const report = async () => {
    try {
      const r = await fetch(`https://metamoa.com/api/live/${encodeURIComponent(METAMOA_SPACE_ID)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${METAMOA_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: clamp(people.size, 0, 100000) }),
      });
      if (r.status !== 204) console.log('[메타모아] 접속자 수 전송 응답:', r.status);
    } catch (e) { console.log('[메타모아] 접속자 수 전송 실패:', e.message); }
  };
  setInterval(report, 10 * 60 * 1000);
  setTimeout(report, 30 * 1000);
}

server.listen(PORT, () => console.log(`파도멍 서버가 열렸어요 → http://localhost:${PORT}`));
