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
const METAMOA_VERIFY = (process.env.METAMOA_VERIFY || '').replace(/[^A-Za-z0-9_\-]/g, '');   // 메타모아 소유자 확인 코드
const METAMOA_WEBHOOK_SECRET = process.env.METAMOA_WEBHOOK_SECRET || '';
const WORLD_W = 3200, D_MIN = -0.25, D_MAX = 1;
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

/* ───────── 도감 완성 카드 ─────────
   다 모은 사람이 카드 그림(JPEG)을 노점에 알린다. 서버에는 남기지 않고, 주인에게 알림으로만 보낸다.
   한 사람(ipTag) 하루 한 번. NTFY_TOPIC 을 정해 두어야 알림이 간다. */
const cardLast = new Map();          // tag → 마지막으로 알린 시각
const NTFY_TOPIC = (process.env.NTFY_TOPIC || '').trim();
function postCard(req, res) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(), tag = ipTag(ip);
  let body = '', big = false;
  req.on('data', c => { body += c; if (body.length > 600e3) { big = true; req.destroy(); } });
  req.on('end', () => {
    if (big) return json(res, 413, { 안내: '그림이 너무 커요' });
    let m; try { m = JSON.parse(body); } catch (e) { return json(res, 400, { 안내: '알 수 없는 카드예요' }); }
    const name = checkSand(String(m.name || ''), 10) || '바닷가 사람';
    const buf = Buffer.from(String(m.img || '').replace(/^data:image\/jpeg;base64,/, ''), 'base64');
    if (buf.length < 2000 || buf.length > 420e3 || buf[0] !== 0xff || buf[1] !== 0xd8) return json(res, 400, { 안내: '그림이 이상해요' });
    if (Date.now() - (cardLast.get(tag) || 0) < 20 * 3600e3) return json(res, 429, { 안내: '오늘은 이미 알렸어요' });
    cardLast.set(tag, Date.now()); bump('완성카드');
    notifyOwner(`${name} 님이 파도멍 도감을 다 모았어요`, buf);
    json(res, 200, { ok: 1 });
  });
}
async function notifyOwner(text, img) {
  console.log('[완성 카드] ' + text);
  if (!NTFY_TOPIC) return 'NTFY_TOPIC 없음';
  // ntfy.sh: 카드 그림을 첨부로 같이 보낸다 (휴대폰 ntfy 앱에서 바로 보임)
  const q = new URLSearchParams({ title: '파도멍 도감 완성', message: text, tags: 'shell' });
  if (img) q.set('filename', 'padomeong-card.jpg');
  try {
    const r = await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}?${q}`, { method: img ? 'PUT' : 'POST', body: img || '', signal: AbortSignal.timeout(10000) });
    const t = (await r.text()).slice(0, 160);
    if (!r.ok) console.log('[알림] ntfy 응답', r.status, t);
    return `${r.status} ${t}`;
  } catch (e) { console.log('[알림] 못 보냄:', e.message); return '못 보냄: ' + e.message; }
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
                 최대동시접속: 0, 입장: 0, 손흔들기: 0, 띄운병: 0, 받은병: 0, 빈병: 0, 신고: 0, 모래글씨: 0 };
    const keys = Object.keys(stats).sort(); while (keys.length > 120) delete stats[keys.shift()];
  }
  return stats[k];
}
function bump(field, n = 1) { const d = day(); d[field] = (d[field] || 0) + n; save('stats.json', stats); }
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

/* ───────── 지금 접속자 수 (메타모아에 알리는 숫자) ─────────
   지금 바닷가에 들어와 있고, 최근 3분 안에 신호가 있었고, 자동 프로그램(봇·헤드리스 브라우저)이 아닌 사람만 센다. */
const BOT_UA = /bot|crawl|spider|slurp|headless|phantom|puppeteer|playwright|selenium|python|curl|wget|node-fetch|axios|go-http/i;
function liveCount() {
  const t = Date.now(); let n = 0;
  for (const p of people.values()) if (!p.bot && t - p.ws.alive < 180e3) n++;
  return n;
}

/* ───────── HTTP ───────── */
function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj, null, 1)); }
function isAdmin(u) { return ADMIN_KEY && u.searchParams.get('key') === ADMIN_KEY; }

const server = http.createServer((req, res) => {
  let u, p;
  try { u = new URL(req.url, 'http://x'); p = decodeURIComponent(u.pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (p === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok ' + people.size); }

  // 메타모아 「접속자 수 API」: 지금 접속자 수를 숫자 하나로 돌려준다 (?format=json 이면 {"count": n})
  if (p === '/live') {
    const n = liveCount(), asJson = u.searchParams.get('format') === 'json';
    res.writeHead(200, { 'content-type': asJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
                         'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    return res.end(asJson ? JSON.stringify({ count: n }) : String(n));
  }

  // 메타모아 소유자 확인 파일: /metamoa-{코드}.html
  if (METAMOA_VERIFY && p === `/metamoa-${METAMOA_VERIFY}.html`) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`metamoa-site-verification: ${METAMOA_VERIFY}`);
  }

  // 메타모아 알림(웹훅): 심사 결과 등. 서명을 확인하고 서버 기록에 남긴다
  if (p === '/metamoa/webhook' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 64e3) req.destroy(); });
    req.on('end', () => {
      if (METAMOA_WEBHOOK_SECRET) {
        const ts = String(req.headers['x-metamoa-timestamp'] || ''), sig = String(req.headers['x-metamoa-signature'] || '');
        const want = 'sha256=' + crypto.createHmac('sha256', METAMOA_WEBHOOK_SECRET).update(`${ts}.${body}`).digest('hex');
        const ok = sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
        if (!ok) { res.writeHead(401); return res.end(); }
      }
      let ev = ''; try { const j = JSON.parse(body); ev = j.event || j.type || ''; } catch (e) {}
      console.log(`[메타모아 알림] ${ev || '(이름 없음)'} ${body.slice(0, 500)}`);
      res.writeHead(204); res.end();
    });
    return;
  }

  // 도감 완성 카드: 노점(주인)에게 알리기. 어디에도 저장하지 않고 알림으로만 보낸다
  if (p === '/card' && req.method === 'POST') return postCard(req, res);

  // 관리용: ADMIN_KEY 환경변수를 정해 두었을 때만 열림
  if (p === '/stats' || p.startsWith('/admin/')) {
    if (!ADMIN_KEY) return json(res, 403, { 안내: 'ADMIN_KEY 환경변수를 정하면 열려요' });
    if (!isAdmin(u)) return json(res, 403, { 안내: '열쇠가 맞지 않아요' });
    if (p === '/stats') return json(res, 200, statsView());
    if (p === '/admin/ntfy-test') {
      if (!NTFY_TOPIC) return json(res, 200, { 안내: 'NTFY_TOPIC 환경변수가 비어 있어요' });
      notifyOwner('파도멍 서버에서 보낸 시험 알림이에요', null).then(r => json(res, 200, { 주제: NTFY_TOPIC.slice(0, 10) + '…(' + NTFY_TOPIC.length + '글자)', ntfy응답: r }));
      return;
    }
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
    if (METAMOA_VERIFY && file.endsWith('index.html'))
      data = Buffer.from(data.toString('utf8').replace('<head>', `<head>\n<meta name="metamoa-site-verification" content="${METAMOA_VERIFY}">`));
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
                         'cache-control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=3600' });
    res.end(data);
  });
});

/* ───────── 목포 날씨 (기상청 단기예보 조회서비스, 공공데이터포털) ─────────
   15분마다 대반동 격자(50,66)의 초단기실황(기온·강수·바람·습도)과 초단기예보(하늘·낙뢰)를 받아
   화면이 쓰는 모양으로 바꿔 나눠 준다. KMA_KEY가 없으면 날씨 없이 맑은 바다로 둔다.
   실패하면 이전 값을 그대로 쓴다. 출처 표기: 기상청(공공누리 제1유형). */
const KMA_KEY = process.env.KMA_KEY || '';
const KMA_NX = 50, KMA_NY = 66;
let weather = null, rainEndAt = 0; const wxHist = [];
function kmaBase(minsBack, minute) {       // 한국 시각 기준 발표 날짜·시각
  const d = new Date(Date.now() + 9 * 3600e3 - minsBack * 60e3);
  const ymd = d.toISOString().slice(0, 10).replace(/-/g, '');
  return [ymd, String(d.getUTCHours()).padStart(2, '0') + minute];
}
async function kmaCall(op, minsBack, minute) {
  const key = KMA_KEY.includes('%') ? KMA_KEY : encodeURIComponent(KMA_KEY);
  for (const back of [minsBack, minsBack + 60]) {          // 아직 안 나왔으면 한 시간 전 발표로
    const [date, time] = kmaBase(back, minute);
    const u = `https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/${op}?serviceKey=${key}`
      + `&numOfRows=60&pageNo=1&dataType=JSON&base_date=${date}&base_time=${time}&nx=${KMA_NX}&ny=${KMA_NY}`;
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
    const txt = await r.text();
    let j; try { j = JSON.parse(txt); } catch { throw new Error(op + ' 응답이 JSON이 아님: ' + txt.slice(0, 120)); }
    const h = j.response && j.response.header, items = j.response && j.response.body && j.response.body.items;
    if (h && h.resultCode === '00' && items && items.item && items.item.length) return items.item;
    if (h && h.resultCode !== '03') throw new Error(op + ' ' + h.resultCode + ' ' + h.resultMsg);
  }
  throw new Error(op + ' 자료 없음');
}
function kmaToWx(nc, fc) {
  const v = {}; for (const it of nc) v[it.category] = +it.obsrValue;
  const f = {}; if (fc) {                       // 가장 가까운 예보 시각 값만
    const first = fc.map(it => it.fcstDate + it.fcstTime).sort()[0];
    for (const it of fc) if (it.fcstDate + it.fcstTime === first) f[it.category] = it.fcstValue;
  }
  const pty = v.PTY | 0, rn = num(v.RN1, 0), sky = +f.SKY || 1, lgt = +f.LGT || 0, reh = num(v.REH, 0);
  let code = 0, d = '맑음', cc = 10;
  if (sky === 3) { code = 2; d = '구름 많음'; cc = 70; }
  if (sky === 4) { code = 3; d = '흐림'; cc = 100; }
  if (pty === 1) { code = rn < 3 ? 61 : rn < 15 ? 63 : 65; d = '비'; cc = 100; }
  else if (pty === 2) { code = 66; d = '비 또는 눈'; cc = 100; }
  else if (pty === 3) { code = rn < 1 ? 71 : rn < 5 ? 73 : 75; d = '눈'; cc = 100; }
  else if (pty === 5) { code = 51; d = '빗방울'; cc = 100; }
  else if (pty === 6) { code = 56; d = '빗방울·눈날림'; cc = 100; }
  else if (pty === 7) { code = 85; d = '눈날림'; cc = 100; }
  else if (reh >= 95) { code = 45; d = '안개'; cc = Math.max(cc, 80); }
  if (lgt > 0) { code = 95; d = pty ? '천둥 번개' : '마른 번개'; }
  return { t: num(v.T1H, null), code, d, p: rn, cc, ws: num(v.WSD, 0), h: reh, rain: pty > 0, at: Date.now() };
}
async function fetchWeather() {
  try {
    const nc = await kmaCall('getUltraSrtNcst', 10, '00');
    let fc = null; try { fc = await kmaCall('getUltraSrtFcst', 45, '30'); } catch (e) { console.log('[날씨] 예보 못 받음:', e.message); }
    const w = kmaToWx(nc, fc), was = weather;
    wxHist.push({ t: Date.now(), ws: w.ws }); while (wxHist.length && Date.now() - wxHist[0].t > 24 * 3600e3) wxHist.shift();
    w.gust = Math.max(...wxHist.map(x => x.ws));                       // 지난 24시간 가장 센 바람
    if (was && was.rain && !w.rain) rainEndAt = Date.now();             // 비가 막 그쳤다 → 무지개
    if (w.rain) rainEndAt = 0;
    w.after = rainEndAt;
    weather = w;
    if (people.size) sendAll({ t: 'wx', wx: weather });
  } catch (e) { console.log('[날씨] 받지 못함:', e.message); }
}
if (process.env.WX_FAKE) weather = JSON.parse(process.env.WX_FAKE);   // 시험용
else if (KMA_KEY) { setTimeout(fetchWeather, 2000); setInterval(fetchWeather, 15 * 60e3); }
else console.log('[날씨] KMA_KEY가 없어 날씨 없이 엽니다');
module.exports.__kmaToWx = kmaToWx;

/* ───────── 실시간 연결 ─────────
   사람이 많아지면 해변을 여러 개로 나눈다(1번 해변, 2번 해변…). 같은 해변 사람끼리만 서로 보인다.
   유리병은 모든 해변이 함께 쓰는 바다에 떠다닌다. */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2048 });
const people = new Map();      // id → {ws, room, x, d, sit, color, name, bot}
const rooms = new Map();       // 해변 번호 → Set(id)
const writings = new Map();    // 해변 번호 → [[id, x, d, text, ts, color]]  (모래 글씨, 저장하지 않음)
const castles = new Map();     // 해변 번호 → 모래성 세 개 [{lvl, gen, by}]  (함께 쌓는 모래성, 파도가 닿으면 무너짐)
const CASTLE_N = 3, CASTLE_MAX = 9, CASTLE_PER = 3;   // 한 사람이 한 모래성에 세 줌까지 → 세 사람이면 완성
// 보름달 밤에 띄운 등: 그날 밤(한국 시각 정오 기준)에 띄운 것만 모든 해변이 함께 본다. 저장하지 않음
const lanterns = { key: '', list: [], by: new Set() };
const nightKey = () => { const d = new Date(Date.now() + 9 * 3600e3 - 12 * 3600e3); return d.toISOString().slice(0, 10); };
function lanternList() { const k = nightKey(); if (lanterns.key !== k) { lanterns.key = k; lanterns.list = []; lanterns.by.clear(); } return lanterns.list; }
let nextL = 1;
const shotsBy = { key: '', n: new Map() };
// 해변 공 (해변마다 하나): [x, d, vx, vd, 찬 시각]
const balls = new Map(); const BALL_K = 1.4;
const ballOf = room => { if (!balls.has(room)) balls.set(room, [1500, 0.5, 0, 0, Date.now()]); return balls.get(room); };
function ballNow(b, ms) { const e = Math.max(0, (ms - b[4]) / 1000), f = (1 - Math.exp(-BALL_K * e)) / BALL_K; return [clamp(b[0] + b[2] * f, 80, WORLD_W - 80), clamp(b[1] + b[3] * f, 0.02, 0.7)]; }
// 모래 오목 (해변마다 한 판, 9×9)
const omoks = new Map();
const omokOf = room => { if (!omoks.has(room)) omoks.set(room, { b: Array(81).fill('0'), turn: 1, p: [null, null], win: 0, last: 0 }); return omoks.get(room); };
const omokView = o => ({ t: 'ob', b: o.b.join(''), turn: o.turn, p: o.p.map(x => (x ? x.name : '')), win: o.win });
function omokWin(b, i) {
  const c = b[i], r = Math.floor(i / 9), q = i % 9;
  for (const [dr, dq] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    let n = 1;
    for (const sg of [1, -1]) for (let k = 1; k < 5; k++) { const rr = r + dr * k * sg, qq = q + dq * k * sg; if (rr < 0 || rr > 8 || qq < 0 || qq > 8 || b[rr * 9 + qq] !== c) break; n++; }
    if (n >= 5) return true;
  }
  return false;
}

// 노을 십 분을 함께 본 사람, 오늘의 질문에 달린 답 (한국 날짜가 바뀌면 비움, 저장하지 않음)
const dayKeyNow = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const sunsetSeen = { key: '', ids: new Set() };
const qa = { key: '', list: [], by: new Map() }; let nextQ = 1;
function qaList() { const k = dayKeyNow(); if (qa.key !== k) { qa.key = k; qa.list = []; qa.by.clear(); } return qa.list; }
function sunsetCount() { const k = dayKeyNow(); if (sunsetSeen.key !== k) { sunsetSeen.key = k; sunsetSeen.ids.clear(); } return sunsetSeen.ids.size; }
const castleOf = room => { if (!castles.has(room)) castles.set(room, Array.from({ length: CASTLE_N }, () => ({ lvl: 0, gen: 1, by: new Map() }))); return castles.get(room); };
const ROOM_CAP = Number(process.env.ROOM_CAP) || 80;           // 해변 하나에 들어가는 사람 수
const perIp = new Map();
const dirty = new Set();
let nextId = 1, nextW = 1;

function cleanName(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 10);
}
const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
function sendRoom(room, obj, except) {
  const set = rooms.get(room); if (!set) return;
  const s = JSON.stringify(obj);
  for (const id of set) { const p = people.get(id); if (id !== except && p && p.ws.readyState === 1) p.ws.send(s); }
}
function sendAll(obj) {
  const s = JSON.stringify(obj);
  for (const p of people.values()) if (p.ws.readyState === 1) p.ws.send(s);
}
let lastRoomCount = 1;
function roomsChanged() {        // 해변 수가 바뀌면 모두에게 알려 "○번 해변" 표시를 맞춘다
  if (rooms.size === lastRoomCount) return;
  lastRoomCount = rooms.size; sendAll({ t: 'today', today: todayView(), rooms: rooms.size });
}
function pickRoom() {
  for (let r = 1; ; r++) { const set = rooms.get(r); if (!set || set.size < ROOM_CAP) return r; }
}
// 오늘 다녀간 사람 (화면 위에 보여 줄 숫자)
function todayView() { const d = day(); return { v: d.입장 || 0 }; }
function checkSand(text, max = 16) {
  if (typeof text !== 'string') return null;
  const s = text.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length < 1 || s.length > max) return null;
  const flat = s.replace(/\s/g, '').toLowerCase();
  if (/(https?:|www\.|\.(com|kr|net|org|io|me|gg|ly)\b|@[a-z0-9_]{3,})/i.test(s)) return null;
  if (/\d[\d\s\-.]{3,}\d/.test(s)) return null;
  if (BANNED.some(w => flat.includes(w))) return null;
  return s;
}

wss.on('connection', (ws, req) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const tag = ipTag(ip);
  const isBot = BOT_UA.test(String(req.headers['user-agent'] || '')) || !req.headers['user-agent'];
  const ipCount = (perIp.get(ip) || 0) + 1;
  if (people.size >= MAX_PEOPLE || ipCount > MAX_PER_IP) return ws.close(1013, 'full');
  perIp.set(ip, ipCount);

  let id = null, msgs = 0, windowStart = Date.now(), lastGesture = 0, lastSand = 0, lastBuild = 0;
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
      const room = pickRoom();
      const me = { ws, room, x: clamp(num(m.x, WORLD_W / 2), 40, WORLD_W - 40), d: clamp(num(m.d, 0.8), D_MIN, D_MAX),
                   sit: m.sit ? 1 : 0, k: m.k ? 1 : 0, g: m.g === 'f' ? 'f' : 'm', st: ['mat', 'chair'].includes(m.st) ? m.st : 'mat', n: m.n ? 1 : 0, color: clamp(Math.floor(num(m.color, 0)), 0, 7), name: cleanName(m.name), bot: isBot };
      if (!rooms.has(room)) rooms.set(room, new Set());
      const list = [];
      for (const pid of rooms.get(room)) { const p = people.get(pid); if (p) list.push([pid, p.x, p.d, p.sit, p.color, p.name, p.k, p.g, p.st, p.n]); }
      rooms.get(room).add(id); people.set(id, me);
      const d = day(); d.최대동시접속 = Math.max(d.최대동시접속, people.size);
      if (!isBot) bump('입장');
      const cs = castleOf(room);
      send(ws, { t: 'hi', id, now: Date.now(), room, rooms: rooms.size, p: list, w: writings.get(room) || [], today: todayView(), wx: weather, castle: cs.map(c => [c.lvl, c.gen]), ball: ballOf(room), ob: omokView(omokOf(room)), ln: lanternList(), qa: qaList().slice(-40), sn: sunsetCount() });
      sendRoom(room, { t: 'in', p: [id, me.x, me.d, me.sit, me.color, me.name, me.k, me.g, me.st, me.n] }, id);
      roomsChanged();
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
      me.sit = sit; me.k = m.k ? 1 : 0;
      dirty.add(id);

    } else if (m.t === 'g') {                     // 손 흔들기 / 랜턴 불 나누기 (같은 해변 안에서)
      const to = Number(m.to), other = people.get(to);
      if (t - lastGesture < 2000 || to === id || !other || other.room !== me.room) return;
      lastGesture = t; bump('손흔들기');
      sendRoom(me.room, { t: 'g', from: id, to });

    } else if (m.t === 'cb') {                    // 모래성에 모래 한 줌 보태기
      if (t - lastBuild < 1500) return;
      const i = m.i | 0, c = castleOf(me.room)[i]; if (!c || c.lvl >= CASTLE_MAX) return;
      const n = c.by.get(id) || 0; if (n >= CASTLE_PER) return;
      lastBuild = t; c.by.set(id, n + 1);
      c.lvl++; sendRoom(me.room, { t: 'cs', i, lvl: c.lvl, gen: c.gen, by: id });

    } else if (m.t === 'cc') {                    // 파도가 모래성에 닿았다는 알림 (누가 보내든 한 번만)
      const i = m.i | 0, c = castleOf(me.room)[i];
      if (!c || Number(m.gen) !== c.gen || c.lvl === 0) return;
      const was = c.lvl; c.lvl = 0; c.gen++; c.by.clear();
      sendRoom(me.room, { t: 'cs', i, lvl: 0, gen: c.gen, fell: was });

    } else if (m.t === 'mine' && Array.isArray(m.ids)) {   // 내가 띄운 병이 몇 명에게 닿았는지
      const r = {};
      for (const bid of m.ids.slice(0, 30)) { const b = bottles.list.find(b => b.id === Number(bid)); if (b) r[b.id] = b.reads || 0; }
      send(ws, { t: 'mineR', r });

    } else if (m.t === 'w' && m.to !== undefined) {   // 누군가의 모래 글씨 뒤에 한 낱말 이어 쓰기
      if (t - lastSand < 8000) return send(ws, { t: 'wr', ok: false, msg: '조금 있다가 다시 써요' });
      const word = checkSand(m.text, 8);
      if (!word) return send(ws, { t: 'wr', ok: false, msg: '이 글씨는 모래에 남길 수 없어요' });
      const list = writings.get(me.room) || [], w = list.find(w => w[0] === Number(m.to));
      if (!w) return send(ws, { t: 'wr', ok: false, msg: '파도가 먼저 지웠어요' });
      if (w[3].length + 1 + word.length > 40) return send(ws, { t: 'wr', ok: false, msg: '이 문장은 이제 꽉 찼어요' });
      lastSand = t; bump('이어쓰기');
      w[3] = w[3] + ' ' + word;
      send(ws, { t: 'wr', ok: true });
      sendRoom(me.room, { t: 'wu', id: w[0], text: w[3] });

    } else if (m.t === 'pf') {                    // 저녁 불꽃 한 발 (한 연결에 한 발, 한 집에 하룻밤 네 발까지)
      const k = nightKey();
      if (shotsBy.key !== k) { shotsBy.key = k; shotsBy.n.clear(); }
      const used = shotsBy.n.get(tag) || 0;
      if (me.shot === k || used >= 4) return;
      me.shot = k; shotsBy.n.set(tag, used + 1); bump('불꽃');
      const ax = clamp(num(m.ax, 0), -300, 300), ay = clamp(num(m.ay, -100), -300, 0);
      sendRoom(me.room, { t: 'pf', id, ax, ay }, id);

    } else if (m.t === 'look') {                  // 앉을 것·목걸이 바꾸기
      me.st = ['mat', 'chair'].includes(m.st) ? m.st : me.st; me.n = m.n ? 1 : 0;
      sendRoom(me.room, { t: 'look', id, st: me.st, n: me.n }, id);

    } else if (m.t === 'gc') {                    // 끼룩 (갈매기 흉내)
      if (t - (me.gcAt || 0) < 2000) return; me.gcAt = t; bump('끼룩');
      sendRoom(me.room, { t: 'gc', id }, id);

    } else if (m.t === 'kick') {                  // 해변 공 차기
      if (t - (me.kickAt || 0) < 500) return; me.kickAt = t;
      const b = ballOf(me.room), [bx, bd] = ballNow(b, t);
      if (Math.abs(me.x - bx) > 220 || Math.abs(me.d - bd) > 0.25) return;
      const nb = [bx, bd, clamp(num(m.vx, 0), -800, 800), clamp(num(m.vd, 0), -1.2, 1.2), t];
      balls.set(me.room, nb); sendRoom(me.room, { t: 'ball', b: nb }, id);

    } else if (m.t === 'om') {                    // 모래 오목에 돌 놓기
      const o = omokOf(me.room), i = m.i | 0;
      if (o.win || i < 0 || i > 80 || o.b[i] !== '0') return send(ws, omokView(o));
      const seat = o.p[o.turn - 1];
      if (seat && seat.id !== id && people.has(seat.id) && t - seat.at < 180000) return send(ws, omokView(o));
      o.p[o.turn - 1] = { id, name: me.name, at: t };
      o.b[i] = String(o.turn); o.last = t;
      if (omokWin(o.b, i)) {
        o.win = o.turn; bump('오목');
        const room = me.room;
        setTimeout(() => { const n = omokOf(room); if (n === o && o.win) { omoks.delete(room); sendRoom(room, omokView(omokOf(room))); } }, 20000);
      } else if (!o.b.includes('0')) { omoks.delete(me.room); }
      else o.turn = 3 - o.turn;
      sendRoom(me.room, omokView(o));

    } else if (m.t === 'or') {                    // 새 판 (끝났거나, 오래 멈췄거나, 앉아 있던 사람이 원할 때)
      const o = omokOf(me.room);
      if (o.win || t - o.last > 300000 || o.p.some(x => x && x.id === id)) { omoks.delete(me.room); sendRoom(me.room, omokView(omokOf(me.room))); }

    } else if (m.t === 'sn') {                    // 노을 십 분 동안 바닷가에 있었음
      sunsetCount(); if (sunsetSeen.ids.has(id)) return;
      sunsetSeen.ids.add(id); bump('노을');
      const s = JSON.stringify({ t: 'snc', n: sunsetSeen.ids.size });
      for (const p of people.values()) if (p.ws.readyState === 1) p.ws.send(s);

    } else if (m.t === 'qa') {                    // 오늘의 질문에 답 달기 (한 사람 하루 세 번까지)
      const list = qaList(), used = qa.by.get(tag) || 0;
      if (used >= 3) return send(ws, { t: 'wr', ok: false, msg: '오늘은 충분히 답했어요' });
      if (t - lastSand < 8000) return send(ws, { t: 'wr', ok: false, msg: '조금 있다가 다시 써요' });
      const text = checkSand(m.text, 16);
      if (!text) return send(ws, { t: 'wr', ok: false, msg: '이 글씨는 모래에 남길 수 없어요' });
      lastSand = t; qa.by.set(tag, used + 1); bump('질문답');
      const a = [nextQ++, text, me.color];
      list.push(a); while (list.length > 40) list.shift();
      send(ws, { t: 'wr', ok: true });
      const s = JSON.stringify({ t: 'qa', a });
      for (const p of people.values()) if (p.ws.readyState === 1) p.ws.send(s);

    } else if (m.t === 'ln') {                    // 보름달 밤 등 띄우기 (하룻밤에 한 사람 하나)
      const list = lanternList();
      if (lanterns.by.has(tag)) return send(ws, { t: 'lr', ok: false, msg: '오늘 밤 등은 이미 띄웠어요' });
      const text = checkSand(m.text, 20);
      if (!text) return send(ws, { t: 'lr', ok: false, msg: '이 글은 등에 적을 수 없어요' });
      lanterns.by.add(tag); bump('등');
      const l = [nextL++, text, t, me.color];
      list.push(l); while (list.length > 80) list.shift();
      send(ws, { t: 'lr', ok: true, l });
      const s = JSON.stringify({ t: 'ln', l });
      for (const p of people.values()) if (p.ws !== ws && p.ws.readyState === 1) p.ws.send(s);

    } else if (m.t === 'w') {                     // 모래에 글씨 쓰기 (파도가 지울 때까지만 남음)
      if (t - lastSand < 20000) return send(ws, { t: 'wr', ok: false, msg: '조금 있다가 다시 써요' });
      const text = checkSand(m.text);
      if (!text) return send(ws, { t: 'wr', ok: false, msg: '이 글씨는 모래에 남길 수 없어요' });
      lastSand = t; bump('모래글씨');
      const w = [nextW++, clamp(num(m.x, me.x), 40, WORLD_W - 40), clamp(num(m.d, me.d), -0.3, D_MAX), text, t, me.color];
      const list = writings.get(me.room) || []; list.push(w); while (list.length > 40) list.shift();
      writings.set(me.room, list);
      send(ws, { t: 'wr', ok: true });
      sendRoom(me.room, { t: 'w', w });

    } else if (m.t === 'bq') {                    // 유리병 하나 받기
      const pool = bottles.list.filter(b => !b.hidden && !mine.has(b.id) && !seen.has(b.id));
      if (!pool.length) { bump('빈병'); return send(ws, { t: 'b', id: null }); }
      // 최근 병이 조금 더 자주 오되, 오래된 병도 계속 떠다니게
      const b = pool[Math.floor(Math.pow(Math.random(), 0.7) * pool.length)];
      seen.add(b.id); bump('받은병'); b.reads = (b.reads || 0) + 1; save('bottles.json', bottles);
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
      send(ws, { t: 'bs', ok: true, id: b.id });

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
      const t = Date.now(), me = people.get(id); if (sitSince) sitTotal += t - sitSince;
      recordVisit((t - joinedAt) / 1000, sitTotal / 1000);
      people.delete(id); dirty.delete(id);
      if (me) {
        const set = rooms.get(me.room); if (set) { set.delete(id); if (!set.size && me.room > 1) { rooms.delete(me.room); writings.delete(me.room); } }
        sendRoom(me.room, { t: 'out', id });
        roomsChanged();
      }
    }
  });
  ws.on('error', () => {});
});

// 움직인 사람들의 위치를 해변별로 모아서 한 번에 전달
setInterval(() => {
  if (!dirty.size) return;
  const byRoom = new Map();
  for (const id of dirty) {
    const p = people.get(id); if (!p) continue;
    if (!byRoom.has(p.room)) byRoom.set(p.room, []);
    byRoom.get(p.room).push([id, p.x, p.d, p.sit, p.k]);
  }
  dirty.clear();
  for (const [room, list] of byRoom) {
    for (const id of rooms.get(room) || []) {
      const p = people.get(id); if (!p || p.ws.readyState !== 1) continue;
      const others = list.filter(a => a[0] !== id);
      if (others.length) p.ws.send(JSON.stringify({ t: 'm', p: others }));
    }
  }
}, 150);

// 30초마다 오늘 숫자를 모두에게, 15분 넘은 모래 글씨는 정리
setInterval(() => {
  if (people.size) sendAll({ t: 'today', today: todayView(), rooms: rooms.size, wx: weather });
  const t = Date.now();
  for (const [room, list] of writings) writings.set(room, list.filter(w => t - w[4] < 15 * 60e3));
}, 30000);

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
        body: JSON.stringify({ count: clamp(liveCount(), 0, 100000) }),
      });
      if (r.status !== 204) console.log('[메타모아] 접속자 수 전송 응답:', r.status, (await r.text()).slice(0, 200));
    } catch (e) { console.log('[메타모아] 접속자 수 전송 실패:', e.message); }
  };
  setInterval(report, 10 * 60 * 1000);
  setTimeout(report, 60 * 1000);
}

server.listen(PORT, () => console.log(`파도멍 서버가 열렸어요 → http://localhost:${PORT}`));
