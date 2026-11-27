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
                '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.json': 'application/json; charset=utf-8', '.xml': 'application/xml; charset=utf-8' };
TYPES['.json'] = 'application/manifest+json; charset=utf-8';

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
   다 모은 사람이 카드 그림(JPEG)을 노점에 알린다. 서버에는 남기지 않고, 주인 텔레그램으로만 보낸다.
   한 사람(ipTag) 하루 한 번. TELEGRAM_BOT_TOKEN 이 있어야 알림이 간다.
   TELEGRAM_CHAT_ID 가 없으면 봇에게 마지막으로 말을 건 1:1 대화방을 찾아 쓴다. */
const cardLast = new Map();          // tag → 마지막으로 알린 시각
const doneCards = load('done.json', []);
const wreps = new Map();            // 모래 글씨 id → 신고한 사람(ipTag)들   // 완성 카드 기록: 번호와 도감 뿌리만 (같은 도감이 두 번 오는지 보려고)
const TG_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
let tgChat = (process.env.TELEGRAM_CHAT_ID || '').trim() || (load('tg.json', {}).chat || '');
function postCard(req, res) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(), tag = ipTag(ip);
  let body = '', big = false;
  req.on('data', c => { body += c; if (body.length > 600e3) { big = true; req.destroy(); } });
  req.on('end', () => {
    if (big) return json(res, 413, { 안내: '그림이 너무 커요' });
    let m; try { m = JSON.parse(body); } catch (e) { return json(res, 400, { 안내: '알 수 없는 카드예요' }); }
    const name = checkSand(String(m.name || ''), 10) || '바닷가 사람';
    const BEST = ['노을', '별자리', '상괭이', '갈매기', '옛 사진 병', '불꽃', '산책하는 할머니', '비 오는 날', '모래성·오목', '그냥 파도 보기'];
    const FROM = ['메타모아', '인스타그램', '아는 사람 소개', '검색', '이음수산 가게', '기타'];
    const best = BEST.includes(m.best) ? m.best : '', from = FROM.includes(m.from) ? m.from : '';
    const word = String(m.word || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const days = Math.min(3650, Math.max(1, Math.floor(Number(m.days) || 0)));
    const buf = Buffer.from(String(m.img || '').replace(/^data:image\/jpeg;base64,/, ''), 'base64');
    if (buf.length < 2000 || buf.length > 420e3 || buf[0] !== 0xff || buf[1] !== 0xd8) return json(res, 400, { 안내: '그림이 이상해요' });
    // 같은 브라우저(tok)는 하루 한 번, 같은 인터넷 주소(휴대폰 통신사는 여럿이 나눠 씀)는 하루 다섯 번까지
    const tok = String(m.tok || '').replace(/[^a-z0-9]/gi, '').slice(0, 24) || 'x', key = tag + ':' + tok, nowMs = Date.now();
    if (nowMs - (cardLast.get(key) || 0) < 20 * 3600e3) return json(res, 429, { 안내: '오늘은 이미 알렸어요' });
    const recent = (cardLast.get(tag + ':list') || []).filter(t => nowMs - t < 20 * 3600e3);
    if (recent.length >= 5) return json(res, 429, { 안내: '지금은 알리는 사람이 많아요. 내일 다시 눌러 주세요' });
    cardLast.set(key, nowMs); cardLast.set(tag + ':list', recent.concat(nowMs));
    if (cardLast.size > 5000) cardLast.clear();
    const test = m.test === 1; if (!test) bump('완성카드');
    const no = doneNo();
    // 도감의 뿌리(옮기기로 나눠도 같이 따라감)와 옮기기 이력. 이미 완성 카드를 받은 뿌리와 겹치면 알린다
    const origin = (Array.isArray(m.origin) ? m.origin : []).map(x => String(x)).filter(x => /^[a-z0-9]{6,12}$/.test(x)).slice(0, 8);
    const mout = Math.min(99, Math.max(0, Number(m.mout) | 0)), min = Math.min(99, Math.max(0, Number(m.min) | 0));
    const seen = test ? [] : doneCards.filter(c => c.o.some(x => origin.includes(x)));
    if (!test) { doneCards.push({ no, o: origin, at: nowMs }); save('done.json', doneCards); }
    const lines = [`${test ? '🧪 [시험] ' : '🐚 '}파도멍 ${no} · ${name} 님 (${days}일 걸림)`];
    const v = visits.t[tok], md = d => d ? `${+d.slice(5, 7)}/${+d.slice(8, 10)}` : '';
    lines.push(v ? `서버가 본 방문: 처음 ${md(v[0])} · 들른 날 ${v[1]}일${v[1] <= 2 ? ' ⚠️ 너무 적어요: 확인 필요' : ''} (${md(visits.since)}부터 기록)`
                 : `⚠️ 서버가 이 브라우저의 방문을 본 적이 없어요 (${md(visits.since)}부터 기록) → 직접 요청했거나 기록이 지워진 뒤일 수 있어요`);
    if (seen.length) lines.push(`⚠️ 같은 도감에서 이미 완성 카드가 왔어요: ${seen.map(c => c.no).join(', ')} → 옮기기로 나눈 도감일 수 있어요`);
    lines.push(`도감 뿌리 ${origin.map(x => x.slice(0, 4)).join('·') || '없음'}${mout || min ? ` · 옮기기 보냄 ${mout} 받음 ${min}` : ''}${!origin.length ? ' (뿌리가 지워진 도감: 확인 필요)' : ''}`);
    if (best || from) lines.push([best && `좋았던 순간: ${best}`, from && `온 길: ${from}`].filter(Boolean).join(' · '));
    if (word) lines.push(`한마디: ${word}`);
    lines.push('→ 이 번호로 @ieumfish 에 DM이 오면 생선회와 작은 굿즈 선물');
    notifyOwner(lines.join('\n'), buf);
    json(res, 200, { ok: 1, no });
  });
}
// 완성 번호: 날짜 + 헷갈리지 않는 글자 세 개 (예: #1114-K7Q). 서버가 다시 켜져도 겹치기 어렵게
function doneNo() {
  const d = new Date(Date.now() + 9 * 3600e3), A = 'ACDEFGHJKLMNPQRTUVWXY34679';
  let r = ''; for (let i = 0; i < 3; i++) r += A[crypto.randomInt(A.length)];
  return `#${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}-${r}`;
}
async function tgCall(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, { method: 'POST', body, signal: AbortSignal.timeout(12000) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`${r.status} ${j.description || ''}`.trim());
  return j.result;
}
async function findChat() {
  if (tgChat) return tgChat;
  const ups = await tgCall('getUpdates', new URLSearchParams({ limit: '50' }));
  for (let i = ups.length - 1; i >= 0; i--) {
    const c = (ups[i].message || ups[i].edited_message || {}).chat;
    if (c && c.type === 'private') { tgChat = String(c.id); save('tg.json', { chat: tgChat }); console.log('[알림] 텔레그램 대화방을 찾았어요:', tgChat); return tgChat; }
  }
  throw new Error('봇에게 먼저 아무 말이나 한 번 보내 주세요');
}
async function notifyOwner(text, img, quiet) {
  console.log((quiet ? '[통계 알림] ' : '[완성 카드] ') + text.split('\n')[0]);
  if (!TG_TOKEN) { if (!quiet) console.log(text); return 'TELEGRAM_BOT_TOKEN 없음'; }   // 시험할 때는 알림 전문을 기록에 남긴다
  try {
    const chat = await findChat();
    if (img) {
      const f = new FormData(); f.append('chat_id', chat); f.append('caption', text);
      f.append('photo', new Blob([img], { type: 'image/jpeg' }), 'padomeong-card.jpg');
      await tgCall('sendPhoto', f);
    } else await tgCall('sendMessage', new URLSearchParams({ chat_id: chat, text }));
    return '보냈어요';
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
const lastReplyBy = new Map();    // 가림값 → 마지막으로 답장한 시각

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
// 오늘 온 사람(중복 뺀 수): 같은 인터넷 주소 + 같은 브라우저 표식은 하루 한 번만 센다
let personDay = '', persons = new Set();
// 브라우저 표식(tok)별로 서버가 직접 본 방문: [처음 본 날, 들른 날 수, 마지막 날]. 완성 카드가 진짜 다닌 사람의 것인지 가늠하려고.
// (무료 서버는 배포하면 지워지므로 기록이 시작된 날 since 도 함께 둔다)
const visits = load('visits.json', null) || { since: '', t: {} };
function noteVisit(tok) {
  if (!tok || tok === 'x') return;
  const k = kstDay(); if (!visits.since) visits.since = k;
  const v = visits.t[tok];
  if (!v) visits.t[tok] = [k, 1, k];
  else if (v[2] !== k) { v[1]++; v[2] = k; } else return;
  const keys = Object.keys(visits.t);
  if (keys.length > 30000) { keys.sort((a, b) => (visits.t[a][2] < visits.t[b][2] ? -1 : 1)); for (const x of keys.slice(0, 5000)) delete visits.t[x]; }
  save('visits.json', visits);
}
function countPerson(key) {
  const k = kstDay(); if (k !== personDay) { personDay = k; persons = new Set(); }
  if (persons.has(key)) return; persons.add(key); bump('사람');
}

/* ───────── 통계를 텔레그램으로 (무료 서버는 다시 켜지면 통계가 지워지므로) ─────────
   밤 11시 55분에 그날 기록을, 서버가 꺼지기 직전(배포·재시작)에 그때까지의 기록을 보낸다. */
const BOOT_AT = Date.now();
// 스스로 깨어 있기: Render 무료 서버는 15분 동안 바깥 요청이 없으면 잠든다.
// 9분마다 자기 공개 주소(/healthz)를 두드려 잠들지 않게 한다. (GitHub 예약 실행은 몇 시간씩 밀려서 이것만으로는 부족했다)
const SELF_URL = (process.env.SITE_URL || (process.env.RENDER_EXTERNAL_URL || '')).replace(/\/$/, '');
if (SELF_URL && process.env.KEEPALIVE !== '0') {
  setInterval(() => { fetch(SELF_URL + '/healthz', { signal: AbortSignal.timeout(20000) }).catch(e => console.log('[깨우기] 실패:', e.message)); }, 9 * 60e3).unref();
  console.log('[깨우기] 9분마다', SELF_URL + '/healthz');
}
function kstHM(ms) { const d = new Date(ms + 9 * 3600e3); return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; }
function statsReport(title) {
  const d = day(), avg = d.방문 ? (d.머문시간합_초 / d.방문 / 60).toFixed(1) : '0', dist = d.머문시간분포 || {};
  return [
    `🌊 ${title}`, `(${kstHM(BOOT_AT)} 서버가 켜진 뒤부터 ${kstHM(Date.now())}까지)`,
    `온 사람 ${d.사람 || 0}명 · 들어온 횟수 ${d.입장 || 0}번 · 5초 넘게 머문 방문 ${d.방문 || 0}번`,
    `평균 머문 시간 ${avg}분 · 가장 많이 동시에 ${d.최대동시접속 || 0}명`,
    '머문 시간: ' + (Object.entries(dist).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ') || '없음'),
    `유리병 ${d.띄운병 || 0} · 모래 글씨 ${d.모래글씨 || 0} · 손 흔들기 ${d.손흔들기 || 0} · 완성 카드 ${d.완성카드 || 0}`,
  ].join('\n');
}
// 하루 기록: 밤 11시 50분부터 보내기 시작해서, 텔레그램이 한 번 실패해도 11시 59분까지 1분마다 다시 보낸다
let reportedDay = '', reporting = false;
setInterval(async () => {
  const d = new Date(Date.now() + 9 * 3600e3);
  if (d.getUTCHours() !== 23 || d.getUTCMinutes() < 50 || reportedDay === kstDay() || reporting) return;
  reporting = true;
  try { const r = await notifyOwner(statsReport('오늘 파도멍 기록'), null, true); if (r === '보냈어요' || r === 'TELEGRAM_BOT_TOKEN 없음') reportedDay = kstDay(); else console.log('[하루 기록] 다시 보낼게요:', r); }
  finally { reporting = false; }
}, 60e3).unref();
let closing = false;
async function reportAndExit(sig) {
  if (closing) return; closing = true;
  const d = day();
  if ((d.입장 || 0) > 0) { try { await Promise.race([notifyOwner(statsReport('서버가 다시 켜지기 전 기록'), null, true), new Promise(r => setTimeout(r, 8000))]); } catch (e) {} }
  console.log('[종료]', sig); process.exit(0);
}
process.on('SIGTERM', () => reportAndExit('SIGTERM'));
process.on('SIGINT', () => reportAndExit('SIGINT'));

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
    if (p === '/admin/fill' || p === '/admin/unfill') {
      // 주인 휴대폰 시험용: 이 브라우저의 도감을 41칸으로 채우거나(원래 도감은 따로 보관), 원래대로 되돌린다
      const IDS = ['oyster','clam','pebble','kelp','crab','conch','star','glassG','feather','glassB','whelk','pearl','rain','snow','meteor','flag','beacon','crabwalk','gull','porpoise','hightide','constel','skylantern','firework','toadhouse','necklace','gullcall','rainbow','halo','starsea','gullflock','seaglass','omok','horn','mapdone','oldphoto','wish','walker','sunset','myfire','sentence'];
      const fill = p === '/admin/fill';
      const js = fill
        ? `if(localStorage.getItem('pm_test')!=='1'){localStorage.setItem('pm_dex_backup',localStorage.getItem('pm_dex')||'{}');localStorage.setItem('pm_cardhung_backup',localStorage.getItem('pm_cardhung')||'');}
           var d=JSON.parse(localStorage.getItem('pm_dex')||'{}');${JSON.stringify(IDS)}.forEach(function(i){d[i]=d[i]||1});
           localStorage.setItem('pm_dex',JSON.stringify(d));localStorage.removeItem('pm_cardhung');localStorage.removeItem('pm_doneno');localStorage.setItem('pm_test','1');
           document.body.innerHTML='<p>시험용으로 도감 41칸을 채웠어요.<br>원래 도감은 따로 보관했어요.<br><br><a href="/">파도멍으로 가기</a></p>';`
        : `if(localStorage.getItem('pm_test')==='1'){localStorage.setItem('pm_dex',localStorage.getItem('pm_dex_backup')||'{}');var h=localStorage.getItem('pm_cardhung_backup');if(h)localStorage.setItem('pm_cardhung',h);else localStorage.removeItem('pm_cardhung');
           localStorage.removeItem('pm_doneno');localStorage.removeItem('pm_test');localStorage.removeItem('pm_dex_backup');localStorage.removeItem('pm_cardhung_backup');}
           document.body.innerHTML='<p>도감을 시험 전으로 되돌렸어요.<br><br><a href="/">파도멍으로 가기</a></p>';`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>파도멍 시험</title><body style="font:17px/1.6 sans-serif;padding:32px;text-align:center"><script>${js}</script></body>`);
    }
    if (p === '/admin/report-test') { notifyOwner(statsReport('지금까지 파도멍 기록 (시험)'), null, true).then(r => json(res, 200, { 결과: r, 내용: statsReport('지금까지 파도멍 기록 (시험)') })); return; }
    if (p === '/admin/notify-test') {
      if (!TG_TOKEN) return json(res, 200, { 안내: 'TELEGRAM_BOT_TOKEN 환경변수가 비어 있어요' });
      notifyOwner('파도멍 서버에서 보낸 시험 알림이에요 🐚', null).then(r => json(res, 200, { 결과: r, 대화방: tgChat || '(아직 못 찾음)', 안내: tgChat && !process.env.TELEGRAM_CHAT_ID ? '이 대화방 번호를 TELEGRAM_CHAT_ID 환경변수에 넣어 두면 서버가 다시 켜져도 바로 보내요' : undefined }));
      return;
    }
    if (p === '/admin/bottles') return json(res, 200, bottles.list.slice().reverse().map(b => ({ id: b.id, 글: b.text, 날짜: new Date(b.ts).toISOString(), 신고: b.reports.length, 숨김: !!b.hidden, 처음온사람에게: !!b.nw, 답장: (b.replies || []).map(x => (x.hidden ? '(숨김) ' : '') + x.text) })));
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
                         'cache-control': /\.(html|json)$|sw\.js$/.test(file) ? 'no-cache' : 'public, max-age=3600' });
    res.end(data);
  });
});

/* ───────── 목포 날씨 (기상청 단기예보 조회서비스, 공공데이터포털) ─────────
   15분마다 대반동 격자(50,66)의 초단기실황(기온·강수·바람·습도)과 초단기예보(하늘·낙뢰)를 받아
   화면이 쓰는 모양으로 바꿔 나눠 준다. KMA_KEY가 없으면 날씨 없이 맑은 바다로 둔다.
   실패하면 이전 값을 그대로 쓴다. 출처 표기: 기상청(공공누리 제1유형). */
const KMA_KEY = process.env.KMA_KEY || '';
const KMA_NX = 50, KMA_NY = 66;
let weather = null, rainEndAt = +(load('rain.json', {}).end || 0), wasRain = !!load('rain.json', {}).was; const wxHist = [];   // 서버가 다시 켜져도 '비가 오고 있었다'를 기억
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
    if (((was && was.rain) || (!was && wasRain)) && !w.rain) rainEndAt = Date.now();   // 비가 막 그쳤다 → 무지개
    if (w.rain) rainEndAt = 0;
    if (wasRain !== w.rain || (was && was.after !== rainEndAt)) save('rain.json', { was: w.rain, end: rainEndAt });
    wasRain = w.rain;
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
const omoks = new Map(), ON = 15;           // 오목판 15줄 × 15줄
const omokOf = room => { if (!omoks.has(room)) omoks.set(room, { b: Array(ON * ON).fill('0'), turn: 1, p: [null, null], win: 0, last: 0 }); return omoks.get(room); };
const omokView = o => ({ t: 'ob', b: o.b.join(''), turn: o.turn, p: o.p.map(x => (x ? x.name : '')), win: o.win });
function omokWin(b, i) {
  const c = b[i], r = Math.floor(i / ON), q = i % ON;
  for (const [dr, dq] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    let n = 1;
    for (const sg of [1, -1]) for (let k = 1; k < 5; k++) { const rr = r + dr * k * sg, qq = q + dq * k * sg; if (rr < 0 || rr > ON - 1 || qq < 0 || qq > ON - 1 || b[rr * ON + qq] !== c) break; n++; }
    if (n >= 5) return true;
  }
  return false;
}

// 다녀간 사람의 자리: 1분 넘게 앉았다 간 자리를 하루 동안 기억 (흐릿한 그림자로만 보인다)
let traces = load('traces.json', []);
const traceList = () => { const t = Date.now(); traces = traces.filter(r => t - r.at < 864e5).slice(-40); return traces.map(r => [r.x, r.d, r.c]); };
function noteTrace(me, sitMs) {
  if (!me || me.bot || me.room === 'G' || sitMs < 60000) return;
  const r = { x: Math.round(me.x), d: +me.d.toFixed(3), c: me.color, at: Date.now() };
  if (traces.some(o => Math.abs(o.x - r.x) < 30 && Math.abs(o.d - r.d) < 0.05)) return;
  traces.push(r); traceList(); save('traces.json', traces);
  const msg = JSON.stringify({ t: 'tr', r: [r.x, r.d, r.c] });
  for (const [room, set] of rooms) if (room !== 'G') for (const pid of set) { const p = people.get(pid); if (p && p.ws && p.ws.readyState === 1) p.ws.send(msg); }
}

// 모래 오목의 '파도': 맞은편 자리가 비어 있으면 파도가 대신 둔다 (사람이 앉으면 비켜 준다)
const WAVE = { id: 'wave', name: '파도' };
function waveMove(b, me) {
  const op = me === '1' ? '2' : '1', N = ON;
  if (!b.includes('1') && !b.includes('2')) return 112;
  const lineScore = (i, c) => {
    const r = Math.floor(i / N), q = i % N; let sc = 0;
    for (const [dr, dq] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      let n = 1, open = 0;
      for (const sg of [1, -1]) {
        let k = 1;
        for (; k < 5; k++) { const rr = r + dr * k * sg, qq = q + dq * k * sg; if (rr < 0 || rr >= N || qq < 0 || qq >= N || b[rr * N + qq] !== c) break; n++; }
        const rr = r + dr * k * sg, qq = q + dq * k * sg; if (rr >= 0 && rr < N && qq >= 0 && qq < N && b[rr * N + qq] === '0') open++;
      }
      sc += n >= 5 ? 1e6 : n === 4 ? (open === 2 ? 5e4 : open ? 4000 : 0) : n === 3 ? (open === 2 ? 3000 : open ? 300 : 0) : n === 2 ? (open === 2 ? 120 : open ? 20 : 0) : open;
    }
    return sc;
  };
  let best = [], bs = -1;
  for (let i = 0; i < N * N; i++) {
    if (b[i] !== '0') continue;
    const r = Math.floor(i / N), q = i % N; let near = false;
    for (let dr = -2; dr <= 2 && !near; dr++) for (let dq = -2; dq <= 2; dq++) { const rr = r + dr, qq = q + dq; if (rr >= 0 && rr < N && qq >= 0 && qq < N && b[rr * N + qq] !== '0') { near = true; break; } }
    if (!near) continue;
    const sc = lineScore(i, me) * 1.1 + lineScore(i, op) * 0.95 + Math.random() * 30;   // 조금 흐트러진 수: 이길 만한 상대
    if (sc > bs) { bs = sc; best = [i]; }
  }
  return best[0];
}
function waveTurn(room) {
  const o = omokOf(room); if (o.win) return;
  const seat = o.p[o.turn - 1];
  if (seat && seat.id !== WAVE.id && people.has(seat.id) && Date.now() - seat.at < 180000) return;   // 사람이 앉아 있다
  const other = o.p[2 - o.turn]; if (!other || other.id === WAVE.id) return;                          // 사람과 두는 판에서만
  const crowd = (rooms.get(room) || new Set()).size;
  clearTimeout(o.waveT);
  o.waveT = setTimeout(() => {
    if (omokOf(room) !== o || o.win) return;
    const st = o.p[o.turn - 1];
    if (st && st.id !== WAVE.id && people.has(st.id) && Date.now() - st.at < 180000) return;
    const i = waveMove(o.b, String(o.turn)); if (i === undefined) return;
    o.p[o.turn - 1] = { id: WAVE.id, name: WAVE.name, at: Date.now() };
    o.b[i] = String(o.turn); o.last = Date.now();
    if (omokWin(o.b, i)) { o.win = o.turn; setTimeout(() => { if (omokOf(room) === o && o.win) { omoks.delete(room); sendRoom(room, omokView(omokOf(room))); } }, 20000); }
    else if (!o.b.includes('0')) omoks.delete(room); else o.turn = 3 - o.turn;
    sendRoom(room, omokView(o));
  }, crowd > 1 ? 9000 : 1400 + Math.random() * 1600);   // 다른 사람이 있으면 그 사람이 앉을 틈을 넉넉히 준다
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
const beachRooms = () => [...rooms.keys()].filter(r => r !== 'G').length;
function roomsChanged() {        // 해변 수가 바뀌면 모두에게 알려 "○번 해변" 표시를 맞춘다
  if (beachRooms() === lastRoomCount) return;
  lastRoomCount = beachRooms(); sendAll({ t: 'today', today: todayView(), rooms: lastRoomCount });
}
function pickRoom() {
  for (let r = 1; ; r++) { const set = rooms.get(r); if (!set || set.size < ROOM_CAP) return r; }
}
// 오늘 다녀간 사람 (화면 위에 보여 줄 숫자)
function todayView() { const d = day(); return { v: d.입장 || 0 }; }
function checkSand(text, max = 24) {
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

  let id = null, msgs = 0, windowStart = Date.now(), lastGesture = 0, lastSand = 0, lastDraw = 0, lastBuild = 0;
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
      if (!isBot) { const tk = String(m.tok || '').replace(/[^a-z0-9]/gi, '').slice(0, 24); bump('입장'); countPerson(tag + ':' + tk); noteVisit(tk); }
      const cs = castleOf(room);
      send(ws, { t: 'hi', id, now: Date.now(), room, rooms: beachRooms(), p: list, w: writings.get(room) || [], today: todayView(), wx: weather, castle: cs.map(c => [c.lvl, c.gen]), ball: ballOf(room), ob: omokView(omokOf(room)), ln: lanternList(), qa: qaList().slice(-40), sn: sunsetCount(), tr: traceList() });
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
      if (!sit && me.sit && sitSince) { sitTotal += t - sitSince; noteTrace(me, t - sitSince); sitSince = 0; }
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

    } else if (m.t === 'mine' && Array.isArray(m.ids)) {   // 내가 띄운 병이 몇 명에게 닿았는지, 답장 (병 열쇠가 맞을 때만)
      const r = {}, rp = {}, keys = Array.isArray(m.keys) ? m.keys : [];
      m.ids.slice(0, 30).forEach((bid, k) => {
        const b = bottles.list.find(b => b.id === Number(bid)); if (!b) return;
        r[b.id] = b.reads || 0;
        if (b.key && keys[k] === b.key && b.replies) rp[b.id] = b.replies.map((x, i) => [i, x.hidden ? '' : x.text]).filter(x => x[1]);
      });
      send(ws, { t: 'mineR', r, rp });

    } else if (m.t === 'br') {                    // 받은 병에 답장 (한 병에 한 사람 한 번, 답장은 병을 띄운 사람에게만 간다)
      const b = bottles.list.find(b => b.id === Number(m.id));
      if (!b || !seen.has(b.id) || mine.has(b.id) || b.hidden) return send(ws, { t: 'br', ok: false, msg: '이 병에는 답장할 수 없어요' });
      if (!b.key) return send(ws, { t: 'br', ok: false, msg: '이 병은 너무 오래 떠다녀서 쓴 사람에게 돌아갈 수 없어요' });
      b.rtags = b.rtags || [];
      if (b.rtags.includes(tag)) return send(ws, { t: 'br', ok: false, msg: '이 병에는 이미 답장을 보냈어요' });
      const wait = 3 * 60e3 - (t - (lastReplyBy.get(tag) || 0));
      if (wait > 0) return send(ws, { t: 'br', ok: false, msg: `조금 쉬었다가 보내요 (${Math.ceil(wait / 60e3)}분 뒤)` });
      const r = checkBottle(m.text); if (typeof r === 'string') return send(ws, { t: 'br', ok: false, msg: r });
      b.replies = b.replies || []; if (b.replies.length >= 5) return send(ws, { t: 'br', ok: false, msg: '이 병에는 답장이 벌써 가득해요' });
      b.replies.push({ text: r.text, ts: t, hidden: false }); b.rtags.push(tag); lastReplyBy.set(tag, t);
      save('bottles.json', bottles); bump('답장');
      send(ws, { t: 'br', ok: true });

    } else if (m.t === 'rrep') {                  // 내게 온 답장 신고: 병 열쇠가 맞으면 바로 숨김
      const b = bottles.list.find(b => b.id === Number(m.id)), x = b && b.replies && b.replies[m.k | 0];
      if (!x || !b.key || m.key !== b.key) return;
      x.hidden = true; save('bottles.json', bottles); bump('신고');

    } else if (m.t === 'dw') {                    // 모래에 그림 그리기 (손가락으로 그린 선, 파도가 지울 때까지)
      if (t - lastDraw < 20000) return send(ws, { t: 'wr', ok: false, msg: '조금 있다가 다시 그려요' });   // 그리기는 쓰기와 따로 센다
      const pic = String(m.pic || '');
      if (pic.length < 3 || pic.length > 2400 || !/^\d{1,2},\d{1,2}( \d{1,2},\d{1,2})*(\|\d{1,2},\d{1,2}( \d{1,2},\d{1,2})*)*$/.test(pic) || pic.split('|').length > 40)
        return send(ws, { t: 'wr', ok: false, msg: '이 그림은 모래에 남길 수 없어요' });
      lastDraw = t; bump('모래그림');
      const w = [nextW++, clamp(num(m.x, me.x), 40, WORLD_W - 40), clamp(num(m.d, me.d), -0.3, D_MAX), '', t, me.color, pic];
      const list = writings.get(me.room) || []; list.push(w); while (list.length > 40) list.shift();
      writings.set(me.room, list);
      send(ws, { t: 'wr', ok: true });
      sendRoom(me.room, { t: 'w', w });

    } else if (m.t === 'w' && m.to !== undefined) {   // 누군가의 모래 글씨 뒤에 한 낱말 이어 쓰기
      if (t - lastSand < 8000) return send(ws, { t: 'wr', ok: false, msg: '조금 있다가 다시 써요' });
      const word = checkSand(m.text, 8);
      if (!word) return send(ws, { t: 'wr', ok: false, msg: '이 글씨는 모래에 남길 수 없어요' });
      const list = writings.get(me.room) || [], w = list.find(w => w[0] === Number(m.to));
      if (!w) return send(ws, { t: 'wr', ok: false, msg: '파도가 먼저 지웠어요' });
      if (w[6]) return send(ws, { t: 'wr', ok: false, msg: '그림 뒤에는 이어 쓸 수 없어요' });
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

    } else if (m.t === 'go') {                    // 작은 배를 타고 대반동 ↔ 고하도 (고하도는 모두가 함께 쓰는 한 곳 'G')
      const next = m.to === 'gohado' ? 'G' : (me.room === 'G' ? pickRoom() : me.room);
      if (next === me.room) return;
      const from = me.room, set0 = rooms.get(from);
      if (set0) { set0.delete(id); if (!set0.size && from !== 1 && from !== 'G') { rooms.delete(from); writings.delete(from); } }
      sendRoom(from, { t: 'out', id });
      me.room = next; me.x = clamp(num(m.x, me.x), 40, WORLD_W - 40); me.d = clamp(num(m.d, me.d), D_MIN, D_MAX); me.sit = 0; me.k = 0;
      if (!rooms.has(next)) rooms.set(next, new Set());
      const list = [];
      for (const pid of rooms.get(next)) { const p = people.get(pid); if (p) list.push([pid, p.x, p.d, p.sit, p.color, p.name, p.k, p.g, p.st, p.n]); }
      rooms.get(next).add(id);
      send(ws, { t: 'moved', room: next, p: list, w: writings.get(next) || [] });
      sendRoom(next, { t: 'in', p: [id, me.x, me.d, me.sit, me.color, me.name, me.k, me.g, me.st, me.n] }, id);
      if (next === 'G') bump('고하도 건너감');
      roomsChanged();

    } else if (m.t === 'fx') {                    // 남에게도 보이는 작은 몸짓: 멸치 던지기·두꺼비집·소라에 귀 대기
      const k = ['feed', 'toad', 'shell'].includes(m.k) ? m.k : null; if (!k) return;
      const gap = { feed: 300, toad: 3000, shell: 8000 }[k];
      me.fxAt = me.fxAt || {}; if (t - (me.fxAt[k] || 0) < gap) return; me.fxAt[k] = t;
      const o = { t: 'fx', id, k };
      if (k === 'feed' || k === 'toad') { o.x = clamp(num(m.x, me.x), 40, WORLD_W - 40); o.d = clamp(num(m.d, me.d), D_MIN, D_MAX); }
      sendRoom(me.room, o, id);

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
      if (o.win || i < 0 || i > ON * ON - 1 || o.b[i] !== '0') return send(ws, omokView(o));
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
      if (!o.win && o.b.includes('0')) waveTurn(me.room);

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
      const text = checkSand(m.text, 24);
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
      const s = JSON.stringify({ t: 'ln', l, id });            // 누가 띄웠는지: 다른 사람 화면에서도 그 사람 자리에서 떠오르게
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
      let pool = bottles.list.filter(b => !b.hidden && !mine.has(b.id) && !seen.has(b.id));
      if (m.first) { pool = pool.filter(b => b.nw); if (!pool.length) return send(ws, { t: 'b', id: null, first: 1 }); }   // 처음 온 사람에게: '처음 오는 사람에게' 쓴 병만
      if (!pool.length) { bump('빈병'); return send(ws, { t: 'b', id: null }); }
      // 최근 병이 조금 더 자주 오되, 오래된 병도 계속 떠다니게
      const b = pool[Math.floor(Math.pow(Math.random(), 0.7) * pool.length)];
      seen.add(b.id); bump('받은병'); b.reads = (b.reads || 0) + 1; save('bottles.json', bottles);
      send(ws, { t: 'b', id: b.id, text: b.text, first: m.first ? 1 : 0, can: b.key && !(b.rtags || []).includes(tag) ? 1 : 0 });

    } else if (m.t === 'bs') {                    // 유리병 띄우기
      const wait = 10 * 60e3 - (t - (lastBottleBy.get(tag) || 0));
      if (wait > 0) return send(ws, { t: 'bs', ok: false, msg: `조금 쉬었다가 띄워요 (${Math.ceil(wait / 60e3)}분 뒤)` });
      const r = checkBottle(m.text);
      if (typeof r === 'string') return send(ws, { t: 'bs', ok: false, msg: r });
      const b = { id: bottles.next++, text: r.text, ts: t, reports: [], hidden: false, nw: m.nw ? 1 : 0, key: crypto.randomBytes(8).toString('hex') };
      bottles.list.push(b); while (bottles.list.length > MAX_BOTTLES) bottles.list.shift();
      mine.add(b.id); lastBottleBy.set(tag, t);
      save('bottles.json', bottles); bump('띄운병');
      send(ws, { t: 'bs', ok: true, id: b.id, key: b.key });

    } else if (m.t === 'wrep') {                  // 모래 글씨·그림 신고: 서로 다른 세 사람이 신고하면 바로 지운다
      const list = writings.get(me.room) || [], i = list.findIndex(w => w[0] === Number(m.id)); if (i < 0) return;
      const r = wreps.get(list[i][0]) || new Set(); if (r.has(tag)) return; r.add(tag); wreps.set(list[i][0], r); bump('모래신고');
      if (r.size >= 3) { const id0 = list[i][0]; list.splice(i, 1); wreps.delete(id0); sendRoom(me.room, { t: 'wdel', id: id0 }); }
      if (wreps.size > 2000) wreps.clear();

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
      const t = Date.now(), me = people.get(id); if (sitSince) { sitTotal += t - sitSince; if (me && me.sit) noteTrace(me, t - sitSince); }
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
  if (people.size) sendAll({ t: 'today', today: todayView(), rooms: beachRooms(), wx: weather });
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
