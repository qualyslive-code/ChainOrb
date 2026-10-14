// ChainOrb daily-chain engine: a faithful, deterministic port of the game rules in App.js.
// The client sends its move log; replay() re-plays it and returns the score the rules produce.

const COLS = 6;
const ROWS = 12;
const MIN_GROUP = 4;
const ROCK = 6;
const BOMB = 7;
const CRACK = 8;
const PRISM = 9;
const OFF = [[-1, 0], [0, 1], [1, 0], [0, -1]];
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// Daily level config (LEVELS[21] in App.js)
const DAILY = { goal: 40, colors: 5, rain: 5 };

export const seeded = (a: number) => () => {
  a |= 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

type Piece = { r: number; c: number; o: number; a: number; b: number };

const emptyBoard = (): number[][] => Array.from({ length: ROWS }, () => Array(COLS).fill(0));
const spawn = (pair: { a: number; b: number }): Piece => ({ r: 1, c: 2, o: 0, a: pair.a, b: pair.b });
const cellsOf = (p: Piece) => [
  [p.r, p.c, p.a],
  [p.r + OFF[p.o][0], p.c + OFF[p.o][1], p.b],
];
const valid = (board: number[][], p: Piece) =>
  cellsOf(p).every(([r, c]) => c >= 0 && c < COLS && r >= 0 && r < ROWS && board[r][c] === 0);

function tryRotate(board: number[][], p: Piece, dir: number): Piece | null {
  const o = (p.o + dir + 4) % 4;
  const p2 = { ...p, o };
  if (valid(board, p2)) return p2;
  const d = OFF[o];
  const p3 = { ...p2, r: p.r - d[0], c: p.c - d[1] };
  if (valid(board, p3)) return p3;
  return null;
}

function gravity(b: number[][]): boolean {
  let moved = false;
  for (let c = 0; c < COLS; c++) {
    let w = ROWS - 1;
    for (let r = ROWS - 1; r >= 0; r--) {
      if (b[r][c]) {
        if (r !== w) {
          b[w][c] = b[r][c];
          b[r][c] = 0;
          moved = true;
        }
        w--;
      }
    }
  }
  return moved;
}

function findGroups(b: number[][]): number[][][] {
  const seen = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
  const groups: number[][][] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (!b[r][c] || b[r][c] >= ROCK || seen[r][c]) continue;
      const col = b[r][c];
      const stack = [[r, c]];
      const g: number[][] = [];
      seen[r][c] = true;
      while (stack.length) {
        const [y, x] = stack.pop() as number[];
        g.push([y, x]);
        for (const [dy, dx] of DIRS) {
          const ny = y + dy;
          const nx = x + dx;
          if (ny >= 0 && ny < ROWS && nx >= 0 && nx < COLS && !seen[ny][nx] && b[ny][nx] === col) {
            seen[ny][nx] = true;
            stack.push([ny, nx]);
          }
        }
      }
      if (g.length >= MIN_GROUP) groups.push(g);
    }
  }
  return groups;
}

export type ReplayResult = { ok: true; score: number; chain: number; placed: number; won: boolean } | { ok: false; error: string };

export function replay(day: string, log: string): ReplayResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, error: 'bad day' };
  if (typeof log !== 'string' || log.length === 0 || log.length > 30000) return { ok: false, error: 'bad log' };
  if (!/^[LRcwdskh]+$/.test(log)) return { ok: false, error: 'bad log' };

  const RNG = seeded(Number(day.replace(/-/g, '')));
  const rnd = (n: number) => 1 + Math.floor(RNG() * n);
  const newPair = (n: number, help = 0) => {
    const a = rnd(n);
    return { a, b: RNG() < help ? a : rnd(n) };
  };

  const S: any = {
    board: emptyBoard(),
    score: 0,
    chain: 0,
    maxChain: 0,
    placed: 0,
    fever: 0,
    feverPcs: 0,
    prismNext: false,
    piece: null as Piece | null,
    next: null,
    next2: null,
    ended: false,
    won: false,
  };

  // mirrors np() / shiftQueue() in App.js (daily: no scripted seq, no help, level 22 > MAX_LEVEL)
  const np = () => {
    if (S.prismNext) {
      S.prismNext = false;
      return { a: PRISM, b: rnd(DAILY.colors) };
    }
    return newPair(DAILY.colors, 0);
  };
  const shiftQueue = () => {
    if (S.prismNext) {
      S.prismNext = false;
      S.next = { a: PRISM, b: rnd(DAILY.colors) };
    } else {
      S.next = S.next2;
    }
    S.next2 = np();
  };

  // start()
  S.next = np();
  S.next2 = np();
  gravity(S.board);
  S.piece = spawn(S.next);
  shiftQueue();

  const resolve = () => {
    S.chain = 0;
    const wasDanger = S.board.slice(0, 4).some((row: number[]) => row.some(Boolean));
    const feverAtLock = S.feverPcs > 0;
    while (true) {
      gravity(S.board);
      const groups = findGroups(S.board);
      if (!groups.length) break;
      S.chain++;
      const flat = groups.flat();
      const big = groups.reduce((m, g) => (g.length > m.length ? g : m), [] as number[][]);
      const hit = new Set<number>(flat.map(([r, c]) => r * COLS + c));
      for (const [r, c] of flat) {
        for (const [dy, dx] of DIRS) {
          const y = r + dy;
          const x = c + dx;
          if (y >= 0 && y < ROWS && x >= 0 && x < COLS && S.board[y][x] >= ROCK) hit.add(y * COLS + x);
        }
      }
      for (const k of [...hit]) {
        const br = Math.floor(k / COLS);
        const bc = k % COLS;
        if (S.board[br][bc] !== BOMB) continue;
        for (let y = br - 1; y <= br + 1; y++) {
          for (let x = bc - 1; x <= bc + 1; x++) {
            if (y >= 0 && y < ROWS && x >= 0 && x < COLS && S.board[y][x]) hit.add(y * COLS + x);
          }
        }
      }
      const cells = [...hit].map((k) => [Math.floor(k / COLS), k % COLS]);
      if (S.chain >= 3) S.prismNext = true;
      const pts = flat.length * 10 * Math.pow(2, S.chain - 1) * (S.feverPcs > 0 ? 2 : 1);
      S.score += pts;
      if (!(S.feverPcs > 0)) {
        S.fever += flat.length * 4;
        if (S.fever >= 100) {
          S.fever = 0;
          S.feverPcs = 3;
        }
      }
      for (const [r, c] of cells) S.board[r][c] = S.board[r][c] === CRACK ? ROCK : 0;
      if (big.length >= 6) {
        const [br, bc] = big.reduce((m, x) => (x[0] > m[0] ? x : m));
        S.board[br][bc] = BOMB;
      }
    }
    if (feverAtLock && S.feverPcs > 0) S.feverPcs--;
    if (S.board.every((row: number[]) => row.every((v) => !v))) {
      S.score += 500;
    } else if (wasDanger && !S.board.slice(0, 4).some((row: number[]) => row.some(Boolean))) {
      S.score += 200;
    }
    S.maxChain = Math.max(S.maxChain, S.chain);

    if (S.placed >= DAILY.goal) {
      S.ended = true;
      S.won = true;
      return;
    }
    if (S.placed % DAILY.rain === 0) {
      const rc = Math.floor(RNG() * COLS);
      if (!S.board[0][rc]) {
        S.board[0][rc] = ROCK;
        gravity(S.board);
      }
    }
    const p = spawn(S.next);
    if (!valid(S.board, p)) {
      S.ended = true;
      return;
    }
    S.piece = p;
    shiftQueue();
  };

  const lock = () => {
    for (const [r, c, col] of cellsOf(S.piece)) S.board[r][c] = col;
    const pr = cellsOf(S.piece).find((x) => x[2] === PRISM);
    if (pr) {
      const [prR, prC] = pr;
      let tc = 0;
      const below = prR + 1 < ROWS ? S.board[prR + 1][prC] : 0;
      if (below >= 1 && below <= 5) tc = below;
      else {
        for (const [dy, dx] of [[0, 1], [0, -1], [-1, 0]]) {
          const y = prR + dy;
          const x = prC + dx;
          if (y >= 0 && y < ROWS && x >= 0 && x < COLS && S.board[y][x] >= 1 && S.board[y][x] <= 5) {
            tc = S.board[y][x];
            break;
          }
        }
      }
      S.board[prR][prC] = 0;
      if (tc) {
        S.score += S.board.flat().filter((v: number) => v === tc).length * 10;
        S.board = S.board.map((row: number[]) => row.map((v) => (v === tc ? 0 : v)));
      }
    }
    S.piece = null;
    S.placed++;
    resolve();
  };

  for (let i = 0; i < log.length; i++) {
    if (S.ended) return { ok: false, error: 'moves after end' };
    const t = log[i];
    const p: Piece = S.piece;
    if (t === 'L' || t === 'R') {
      const p2 = { ...p, c: p.c + (t === 'R' ? 1 : -1) };
      if (valid(S.board, p2)) S.piece = p2;
    } else if (t === 'c' || t === 'w') {
      const p2 = tryRotate(S.board, p, t === 'c' ? 1 : -1);
      if (p2) S.piece = p2;
    } else if (t === 'd') {
      const p2 = { ...p, r: p.r + 1 };
      if (!valid(S.board, p2)) return { ok: false, error: 'illegal step' };
      S.piece = p2;
    } else if (t === 's') {
      const p2 = { ...p, r: p.r + 1 };
      if (valid(S.board, p2)) {
        S.piece = p2;
        S.score += 1;
      } else lock();
    } else if (t === 'k') {
      const p2 = { ...p, r: p.r + 1 };
      if (valid(S.board, p2)) return { ok: false, error: 'illegal lock' };
      lock();
    } else if (t === 'h') {
      let n = 0;
      while (true) {
        const p2 = { ...S.piece, r: S.piece.r + 1 };
        if (!valid(S.board, p2)) break;
        S.piece = p2;
        n++;
      }
      S.score += n * 2;
      lock();
    }
  }
  if (!S.ended) return { ok: false, error: 'game not finished' };
  return { ok: true, score: S.score, chain: S.maxChain, placed: S.placed, won: S.won };
}
