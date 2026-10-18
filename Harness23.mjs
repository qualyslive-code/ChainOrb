// Runs the REAL game code extracted from App.js headlessly, plays bot games, and checks the server replay agrees.
import fs from 'node:fs';
import { replay } from './supabase/functions/verify-daily/engine.ts';

const src = fs.readFileSync(process.argv[2] || './App.js', 'utf8');
const between = (a, b) => {
  const i = src.indexOf(a);
  const j = src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error('slice not found: ' + a.slice(0, 40));
  return src.slice(i, j);
};
const gStart = src.indexOf('function Game');
const betweenG = (a, b) => {
  const i = src.indexOf(a, gStart);
  const j = src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error('game slice not found: ' + a.slice(0, 40));
  return src.slice(i, j);
};
const engine = between('const COLS = 6;', '/* ============================== REALMS').replace('const sleep = (ms) => new Promise((r) => setTimeout(r, ms));', 'const sleep = () => Promise.resolve();');
const levels = between('const LEVELS = [', '/* ============================== SAFETY NET');
const seededSrc = between('const seeded = (a) => () => {', '// ad pacing');
const gameA = betweenG('  const np = () => {', '  const buzz = (n) => {');
const gameB = betweenG('  const startReal = (L) => {', '  const gameOver = () => {');
const nxData = between('/* ============================== NEXTGEN v21', 'function HatchReveal');
const gameC = betweenG('  const resolve = async () => {', '  const pan = useRef(');

const body = `
${engine}
${levels}
${seededSrc}
${nxData}
const AsyncStorage = { setItem(){ return { catch(){} }; }, getItem(){ return { then(){ return { catch(){} }; } }; } };
const Share = { share(){ return { catch(){} }; } };
const saveMeta = () => {}; const realmOf2 = 0; const fetchTopRun = async () => null; const dateKeyX = 0;
const G = {
  dex:{eggs:0,own:{},companion:'',last:null}, prof:{xp:0,s:{pops:0,games:0,wins:0,bestChain:0,perfects:0,clutches:0,fevers:0},ach:{}}, seen:{}, shards:0, stars:{}, streak:{n:0}, race:null, story:null, back:'menu', dexShow:false, nxGain:null, rankUp:0, unlocked:1, eventId:'',
  status:'menu', board: emptyBoard(), piece:null, next:newPair(), next2:newPair(), attempts:{}, startedAt:0, card:null, cardSnap:null,
  lb:null, score:0, best:0, chain:0, maxChain:0, banner:'', popping:new Set(), placed:0, level:1, goal:300, colors:3, base:700, moves:0,
  rings:[], popups:[], fails:{}, fever:0, feverPcs:0, log:'', prismNext:false, used:{}, snap:null, slowUntil:0, boss:false, lockAt:0, cell:40, daily:null,
};
const alive = { current: true };
const render = () => {}; const buzz = () => {}; const sfx = () => {}; const playChain = () => {}; const track = () => {}; const jingle = () => {};
const doShake = () => {}; const doFlash = () => {}; const doPunch = () => {}; const touchStreak = () => {};
const mk = () => ({ setValue(){}, start(){} });
const bannerScale = mk(), burst = mk(), punch = mk(), fallY = mk();
const Animated = { spring: mk, timing: mk, sequence: mk };
const win = () => { G.status = 'won'; }; const gameOver = () => { G.status = 'over'; };
${gameA}
${gameB}
${gameC}
return { G, start: startReal, move, rotate, hardDrop, softDrop, step, setClock: (t) => { clock.t = t; }, valid, tryRotate, cellsOf, COLS, ROWS };
`;
const make = new Function('clock', `
function Date() { const [y, m, d] = String(globalThis.__FORCE_DAY).split('-').map(Number); this.getFullYear = () => y; this.getMonth = () => m - 1; this.getDate = () => d; }
Date.now = () => clock.t;
` + body);

const sleepTick = () => new Promise((r) => setImmediate(r));
const settle = async (g) => { let n = 0; while (g.G.status === 'resolving' && n++ < 1e5) await sleepTick(); };

// deterministic PRNG for the bot only
const bot = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x9e3779b9) | 0; let t = Math.imul(a ^ (a >>> 16), 0x85ebca6b); t = Math.imul(t ^ (t >>> 13), 0xc2b2ae35); return ((t ^ (t >>> 16)) >>> 0) / 4294967296; }; };

function adjScore(g, board, p) {
  let s = 0;
  for (const [r, c, col] of g.cellsOf(p)) {
    for (const [dy, dx] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const y = r + dy, x = c + dx;
      if (y >= 0 && y < g.ROWS && x >= 0 && x < g.COLS && board[y][x] === col) s++;
    }
  }
  return s;
}

const cov = { fever: 0, bomb: 0, prism: 0, rock: 0, chain4: 0 };
async function playGame(day, seed, style) {
  const clock = { t: 1000 };
  const g = make(clock);
  const R = bot(seed);
  const origNow = 0;
  // start the daily with the given day (the game reads dateKey(); patch via G.day after start isn't enough, so shim dateKey)
  g.__day = day;
  g.start(902);
  let guard = 0;
  while (g.G.status === 'playing' && guard++ < 4000) {
    const G = g.G;
    const r = R();
    if (style === 'chaos' || r < 0.12) {
      const k = Math.floor(R() * 8);
      if (k === 0) g.move(-1); else if (k === 1) g.move(1); else if (k === 2) g.rotate(1); else if (k === 3) g.rotate(-1);
      else if (k === 4) { g.step(); } else if (k === 5) { clock.t += 400; g.step(); clock.t += 400; g.step(); }
      else if (k === 6) g.softDrop(); else g.hardDrop();
    } else {
      // planner: choose rotation + column maximizing same-colour adjacency, then walk there
      let best = null;
      for (let o = 0; o < 4; o++) for (let c = 0; c < g.COLS; c++) {
        let p = { ...G.piece, o, c };
        if (!g.valid(G.board, p)) continue;
        while (g.valid(G.board, { ...p, r: p.r + 1 })) p = { ...p, r: p.r + 1 };
        const sc = adjScore(g, G.board, p) + R() * 0.5;
        if (!best || sc > best.sc) best = { sc, o, c };
      }
      if (!best) { g.hardDrop(); }
      else {
        let n = 0;
        while (G.piece && G.piece.o !== best.o && n++ < 4) g.rotate(1);
        n = 0;
        while (G.piece && G.piece.c !== best.c && n++ < 8) g.move(G.piece.c < best.c ? 1 : -1);
        const how = R();
        if (how < 0.6) g.hardDrop();
        else if (how < 0.8) { for (let i = 0; i < 14 && G.status === 'playing' && G.piece; i++) g.softDrop(); }
        else { for (let i = 0; i < 14 && G.status === 'playing' && G.piece; i++) { g.step(); } clock.t += 400; g.step(); clock.t += 400; g.step(); }
      }
    }
    await settle(g);
    const Gx = g.G;
    if (Gx.feverPcs > 0) cov.fever++;
    if (Gx.board.some((row) => row.includes(7))) cov.bomb++;
    if (Gx.piece && (Gx.piece.a === 9 || Gx.piece.b === 9)) cov.prism++;
    if (Gx.board.some((row) => row.includes(6))) cov.rock++;
    if (Gx.chain >= 4) cov.chain4++;
  }
  await settle(g);
  return g;
}

// dateKey() inside the extracted code uses the real Date; shim so each game is seeded from the requested day
const days = [];
for (let i = 0; i < 40; i++) days.push(`2026-${String(1 + (i % 12)).padStart(2,'0')}-${String(1 + ((i * 7) % 28)).padStart(2,'0')}`);

let ok = 0, bad = 0, wins = 0, fevers = 0, maxScore = 0, bigChain = 0;
const N = Number(process.argv[3] || 300);
for (let i = 0; i < N; i++) {
  const day = days[i % days.length];
  const style = i % 5 === 0 ? 'chaos' : 'plan';
  // The extracted start() calls dateKey(); override by stubbing the global Date used there is not possible, so pass via env:
  globalThis.__FORCE_DAY = day;
  const g = await playGame(day, 1000 + i, style);
  const G = g.G;
  const r = replay(G.day, G.log);
  const same = r.ok && r.score === G.score && r.chain === G.maxChain && r.placed === G.placed && (r.won === (G.status === 'won'));
  if (same) ok++; else { bad++; if (bad <= 5) console.log('MISMATCH', G.day, style, { client: [G.score, G.maxChain, G.placed, G.status], server: r, logLen: G.log.length }); }
  if (G.status === 'won') wins++;
  maxScore = Math.max(maxScore, G.score); bigChain = Math.max(bigChain, G.maxChain);
}
console.log({ games: N, ok, bad, wins, maxScore, bigChain, cov });
