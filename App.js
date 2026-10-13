import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  View, Text, Pressable, StyleSheet, Animated,
  useWindowDimensions, StatusBar, PanResponder, Share,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { File, Paths } from 'expo-file-system';

/* ============================== ENGINE ============================== */
const COLS = 6;
const ROWS = 12;
const MAX_LEVEL = 20;
const MIN_GROUP = 4;
const COLORS = ['', '#ff3b6b', '#2bff88', '#3ba8ff', '#ffd23b', '#b46bff', '#6b6b8a', '#ff8a3b', '#9a9ac0', '#ffffff'];
const ROCK = 6;
const BOMB = 7;
const CRACK = 8;
const PRISM = 9;
// child offset by orientation: 0 up, 1 right, 2 down, 3 left
const OFF = [[-1, 0], [0, 1], [1, 0], [0, -1]];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let RNG = Math.random;
const rnd = (n) => 1 + Math.floor(RNG() * n);
const newPair = (n = 3, help = 0) => {
  const a = rnd(n);
  return { a, b: RNG() < help ? a : rnd(n) };
};
const levelCfg = (L) => ({
  goal: 300 + (L - 1) * 150,
  colors: Math.min(5, 3 + Math.floor((L - 1) / 4)),
  speed: Math.max(300, 700 - (L - 1) * 25),
  rocks: L >= 5 ? Math.min(14, (L - 4) * 2) : 0,
  moves: L % 3 === 0 ? 22 + Math.floor(L / 3) : 0,
});
const emptyBoard = () => Array.from({ length: ROWS }, () => Array(COLS).fill(0));
const spawn = (pair) => ({ r: 1, c: 2, o: 0, a: pair.a, b: pair.b });

const cellsOf = (p) => [
  [p.r, p.c, p.a],
  [p.r + OFF[p.o][0], p.c + OFF[p.o][1], p.b],
];

const valid = (board, p) =>
  cellsOf(p).every(
    ([r, c]) => c >= 0 && c < COLS && r >= 0 && r < ROWS && board[r][c] === 0
  );

function tryRotate(board, p, dir) {
  const o = (p.o + dir + 4) % 4;
  const p2 = { ...p, o };
  if (valid(board, p2)) return p2;
  // wall/floor kick: push pivot away from where the child wants to go
  const d = OFF[o];
  const p3 = { ...p2, r: p.r - d[0], c: p.c - d[1] };
  if (valid(board, p3)) return p3;
  return null;
}

// every orb falls to rest. returns true if anything moved
function gravity(b) {
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

// flood fill: all same-color groups of MIN_GROUP or more
function findGroups(b) {
  const seen = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
  const groups = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (!b[r][c] || b[r][c] >= ROCK || seen[r][c]) continue;
      const col = b[r][c];
      const stack = [[r, c]];
      const g = [];
      seen[r][c] = true;
      while (stack.length) {
        const [y, x] = stack.pop();
        g.push([y, x]);
        for (const [dy, dx] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ny = y + dy;
          const nx = x + dx;
          if (
            ny >= 0 && ny < ROWS && nx >= 0 && nx < COLS &&
            !seen[ny][nx] && b[ny][nx] === col
          ) {
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

/* ============================== REALMS & LEVELS ============================== */
const REALMS = [
  { name: 'SUNRISE MEADOW', bg: '#150c06', board: '#21130a', border: '#7a4420', accent: '#ffb347' },
  { name: 'MOONLIT LAKE', bg: '#05121a', board: '#09202c', border: '#1d6272', accent: '#3be0c8' },
  { name: 'FROST PEAKS', bg: '#09121f', board: '#0f1f38', border: '#4a7ab0', accent: '#9fd8ff' },
  { name: 'NEON CITY', bg: '#0a0a14', board: '#11111f', border: '#4a2a6a', accent: '#ff3bd4' },
];
const realmOf = (L) => Math.min(3, Math.floor((L - 1) / 5));
// t: score | chain | rocks | pairs.  g goal, c colors, s speed ms, m move limit,
// rocks random rocks, rain = a rock falls every N pairs, pre = preset rows (1-5 orbs, 6 rock, 8 cracked)
const LEVELS = [
  { t: 'score', g: 200, c: 3, s: 900, coach: 'Match 4 of a color to pop them' },
  {
    t: 'chain', g: 3, c: 3, s: 900,
    pre: ['...2..', '..22..', '..33..', '3311..', '2322..'],
    seq: [[1, 1]],
    coach: 'Slide the red pair right, then DROP',
  },
  { t: 'score', g: 350, c: 3, s: 800, m: 30, coach: 'Moves are limited. Make each one count' },
  { t: 'score', g: 450, c: 4, s: 760, coach: 'A new color joins' },
  { t: 'score', g: 500, c: 4, s: 740, rocks: 2, coach: 'Grey rocks pop when a pop touches them' },
  { t: 'rocks', c: 4, s: 720, pre: ['..66..', '..66..'], rocks: 3, coach: 'Clear every rock' },
  { t: 'chain', g: 3, c: 4, s: 700, coach: 'Reach a x3 chain' },
  { t: 'score', g: 700, c: 3, s: 450, coach: 'Faster. Stay calm' },
  { t: 'score', g: 600, c: 4, s: 700, m: 24, pre: ['.1..3.', '212.31', '121323'], coach: 'A crowded board' },
  { t: 'score', g: 1200, c: 4, s: 640, m: 34, rocks: 5, coach: 'BOSS: the Lake Spirit' },
  { t: 'score', g: 600, c: 4, s: 700 },
  { t: 'pairs', g: 28, c: 4, s: 640, rain: 4, coach: 'Rocks fall from above. Survive' },
  { t: 'score', g: 900, c: 4, s: 640, rocks: 2, pre: ['8..8..'], coach: 'Cracked rocks need two hits' },
  { t: 'chain', g: 4, c: 4, s: 620, coach: 'Reach a x4 chain' },
  { t: 'pairs', g: 30, c: 4, s: 600, rain: 3, coach: 'Faster rain' },
  { t: 'score', g: 1000, c: 5, s: 680, coach: 'Five colors' },
  { t: 'rocks', c: 5, s: 650, pre: ['8..8..', '.8..8.'], coach: 'Break every cracked rock' },
  { t: 'score', g: 2000, c: 5, s: 560, coach: 'Marathon. Keep the chains coming' },
  { t: 'pairs', g: 36, c: 5, s: 560, rain: 3, rocks: 4, coach: 'Gauntlet' },
  { t: 'score', g: 2600, c: 5, s: 520, m: 40, rocks: 8, coach: 'FINAL BOSS: Neon City' },
  { t: 'endless', g: 99999999, c: 5, s: 600, rain: 6, coach: 'ENDLESS: how long can you chain?' },
  { t: 'daily', g: 40, c: 5, s: 620, rain: 5, coach: 'DAILY CHAIN: same board for everyone' },
];

/* ============================== SAFETY NET, DAILY ============================== */
const VERSION = 'v8';
// Any crash is saved and shown on the menu next launch, so every build tells us what broke.
try {
  const prevH = global.ErrorUtils && global.ErrorUtils.getGlobalHandler();
  if (global.ErrorUtils) {
    global.ErrorUtils.setGlobalHandler((e, fatal) => {
      AsyncStorage.setItem('lastError', String((e && e.stack) || e).slice(0, 1200)).catch(() => {});
      if (prevH) prevH(e, fatal);
    });
  }
} catch (e) {}
const seeded = (a) => () => {
  a |= 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const dateKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dateSeed = () => Number(dateKey().replace(/-/g, ''));

/* ============================== ORBLINGS ============================== */
// Stars hatch creatures. Each gives one power per level.
const ORBLINGS = [
  { id: 'crane', name: 'Wise Owl', icon: '🦉', need: 3, power: 'Slows time' },
  { id: 'kob', name: 'Quick Fox', icon: '🦊', need: 8, power: 'Undoes your last move' },
  { id: 'gorilla', name: 'Mighty Bear', icon: '🐻', need: 15, power: 'Smashes a column of rocks' },
  { id: 'shoebill', name: 'Hungry Octopus', icon: '🐙', need: 24, power: 'Swallows your most common color' },
];
const totalStars = (st) => Object.values(st).reduce((a, b) => a + b, 0);
const orblingLine = (st) => {
  const t = totalStars(st);
  const n = ORBLINGS.find((o) => t < o.need);
  return n ? `★ ${t}  •  next Orbling at ${n.need}★` : `★ ${t}  •  all Orblings found`;
};

/* ============================== SOUND ============================== */
// Every sound is synthesized in code at startup: no audio files.
// Pentatonic scale, so every chain sounds musical.
const SR = 22050;
const NOTES = [523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.66, 1318.51, 1567.98, 1760];
const P = {};
let MUTED = false;
let soundReady = false;

function tone(f, dur, o = {}) {
  const { decay = 5.5, attack = 0.004, gain = 0.5, harm = [1, 0.4, 0.15] } = o;
  const n = Math.floor(SR * dur);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.min(1, t / attack) * Math.exp(-decay * t);
    let v = 0;
    for (let k = 0; k < harm.length; k++) v += harm[k] * Math.sin(2 * Math.PI * f * (k + 1) * t);
    out[i] = v * env * gain;
  }
  return out;
}
function kick() {
  const n = Math.floor(SR * 0.22);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (2 * Math.PI * (50 + 120 * Math.exp(-t * 30))) / SR;
    out[i] = Math.sin(ph) * Math.exp(-t * 14) * 0.85;
  }
  return out;
}
function choir() {
  const a = tone(523.25, 0.9, { decay: 2.2, attack: 0.15, gain: 0.22, harm: [1, 0.3] });
  const b = tone(659.25, 0.9, { decay: 2.2, attack: 0.15, gain: 0.22, harm: [1, 0.3] });
  const c = tone(783.99, 0.9, { decay: 2.2, attack: 0.15, gain: 0.22, harm: [1, 0.3] });
  return a.map((v, i) => v + b[i] + c[i]);
}
function wav(x) {
  const n = x.length;
  const u = new Uint8Array(44 + n * 2);
  const dv = new DataView(u.buffer);
  const str = (o, t) => {
    for (let i = 0; i < t.length; i++) dv.setUint8(o + i, t.charCodeAt(i));
  };
  str(0, 'RIFF');
  dv.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, SR, true);
  dv.setUint32(28, SR * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  str(36, 'data');
  dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x[i])) * 32767, true);
  return u;
}
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function b64(u) {
  let o = '';
  for (let i = 0; i < u.length; i += 3) {
    const a = u[i];
    const b = u[i + 1];
    const c = u[i + 2];
    o += B64[a >> 2] + B64[((a & 3) << 4) | ((b || 0) >> 4)];
    o += i + 1 < u.length ? B64[((b & 15) << 2) | ((c || 0) >> 6)] : '=';
    o += i + 2 < u.length ? B64[c & 63] : '=';
  }
  return o;
}
async function initSound() {
  if (soundReady) return;
  soundReady = true;
  try {
    await setAudioModeAsync({ playsInSilentMode: true });
  } catch (e) {}
  const defs = {};
  NOTES.forEach((f, i) => {
    defs['n' + i] = tone(f, 0.5);
  });
  defs.bass = tone(130.81, 0.5, { decay: 5, gain: 0.6, harm: [1, 0.3] });
  defs.kick = kick();
  defs.choir = choir();
  defs.land = tone(220, 0.08, { decay: 40, gain: 0.25, harm: [1] });
  for (const name of Object.keys(defs)) {
    try {
      const bytes = wav(defs[name]);
      let uri;
      try {
        const f = new File(Paths.cache, `co_${name}.wav`);
        if (f.exists) f.delete();
        f.create();
        f.write(bytes);
        uri = f.uri;
      } catch (e) {
        uri = 'data:audio/wav;base64,' + b64(bytes);
      }
      P[name] = createAudioPlayer({ uri });
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 0));
  }
}
function sfx(name) {
  if (MUTED) return;
  const pl = P[name];
  if (!pl) return;
  try {
    Promise.resolve(pl.seekTo(0)).catch(() => {});
    pl.play();
  } catch (e) {}
}
const jingle = (seq, gap = 90) => seq.forEach((k, i) => setTimeout(() => sfx('n' + k), i * gap));
// a pop = a short run up the scale; higher chain = higher and fuller
function playChain(chain, count) {
  const base = Math.min(chain - 1, 4);
  const n = Math.min(5, Math.max(2, Math.floor(count / 2)));
  for (let i = 0; i < n; i++) setTimeout(() => sfx('n' + Math.min(9, base + i)), i * 45);
  if (chain >= 2) sfx('bass');
  if (chain >= 3) sfx('kick');
  if (chain >= 5) sfx('choir');
}

/* ============================== UI PARTS ============================== */
function Orb({ color, size, popping, worry }) {
  if (!color) return <View style={{ width: size, height: size }} />;
  return (
    <View style={{ width: size, height: size, padding: size * 0.06 }}>
      <View
        style={{
          flex: 1,
          borderRadius: size,
          backgroundColor: popping ? '#ffffff' : color === BOMB ? '#2a1408' : COLORS[color],
          borderWidth: color === BOMB || color === PRISM ? 3 : color === CRACK ? 2 : 0,
          borderColor: color === CRACK ? '#e0e0ff' : color === PRISM ? '#ff3bd4' : '#ff8a3b',
          shadowColor: COLORS[color],
          shadowOpacity: 1,
          shadowRadius: 8,
          elevation: 6,
          transform: [{ scale: popping ? 1.2 : 1 }],
          alignItems: 'center',
        }}
      >
        <View
          style={{
            marginTop: size * 0.12,
            width: size * 0.28,
            height: size * 0.14,
            borderRadius: size,
            backgroundColor: 'rgba(255,255,255,0.55)',
          }}
        />
        {color >= 1 && color <= 5 && (
          <View style={{ position: 'absolute', top: size * 0.4, flexDirection: 'row' }}>
            {[0, 1].map((i) => (
              <View
                key={i}
                style={{
                  width: size * (worry ? 0.2 : 0.13),
                  height: size * (popping ? 0.04 : worry ? 0.2 : 0.13),
                  marginHorizontal: size * 0.06,
                  borderRadius: size,
                  backgroundColor: '#14142a',
                }}
              />
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

function HoldButton({ label, onPress, repeat, style }) {
  const t = useRef(null);
  const i = useRef(null);
  const stop = () => {
    clearTimeout(t.current);
    clearInterval(i.current);
  };
  useEffect(() => stop, []);
  return (
    <Pressable
      onPressIn={() => {
        onPress();
        if (repeat) {
          t.current = setTimeout(() => {
            i.current = setInterval(onPress, 75);
          }, 170);
        }
      }}
      onPressOut={stop}
      style={({ pressed }) => [styles.btn, style, pressed && styles.btnDown]}
    >
      <Text style={styles.btnTxt}>{label}</Text>
    </Pressable>
  );
}

/* ============================== GAME ============================== */
function Game() {
  const { width, height } = useWindowDimensions();

  // all game state lives in one stable object; render() just redraws
  const G = useRef({
    status: 'menu', // menu | playing | resolving | over
    board: emptyBoard(),
    piece: null,
    next: newPair(),
    score: 0,
    best: 0,
    chain: 0,
    maxChain: 0,
    banner: '',
    popping: new Set(),
    placed: 0,
    level: 1,
    goal: 300,
    colors: 3,
    base: 700,
    unlocked: 1,
    moves: 0,
    stars: {},
    rings: [],
    earned: 1,
    fails: {},
    fever: 0,
    feverUntil: 0,
    continued: false,
    starAd: false,
    ad: null,
    daily: null,
    lastErr: '',
    prismNext: false,
    used: {},
    snap: null,
    slowUntil: 0,
    hatched: null,
    boss: false,
    lockAt: 0,
    gx: 0,
    cell: 40,
  }).current;

  const [, setT] = useState(0);
  const render = useCallback(() => setT((t) => t + 1), []);
  const alive = useRef(true);
  const shake = useRef(new Animated.Value(0)).current;
  const burst = useRef(new Animated.Value(0)).current;
  const float = useRef(new Animated.Value(0)).current;
  const np = () => {
    if (G.seq && G.seq.length) {
      const q = G.seq.shift();
      return { a: q[0], b: q[1] };
    }
    if (G.prismNext) {
      G.prismNext = false;
      return { a: PRISM, b: rnd(G.colors) };
    }
    return newPair(G.colors, G.level <= MAX_LEVEL && (G.fails[G.level] || 0) >= 2 ? 0.4 : 0);
  };
  const rocksLeft = () => G.board.flat().filter((v) => v === ROCK || v === CRACK).length;
  const goalMet = () =>
    G.t === 'chain' ? G.maxChain >= G.goal
    : G.t === 'rocks' ? rocksLeft() === 0
    : G.t === 'pairs' || G.t === 'daily' ? G.placed >= G.goal
    : G.score >= G.goal;
  const progress = () =>
    G.t === 'chain' ? G.maxChain / G.goal
    : G.t === 'rocks' ? (G.rockStart ? 1 - rocksLeft() / G.rockStart : 0)
    : G.t === 'pairs' || G.t === 'daily' ? G.placed / G.goal
    : G.score / G.goal;
  const goalText = () =>
    G.t === 'endless' ? 'ENDLESS'
    : G.t === 'chain' ? `CHAIN x${G.goal}`
    : G.t === 'rocks' ? `ROCKS ${rocksLeft()}`
    : G.t === 'pairs' || G.t === 'daily' ? `SURVIVE ${Math.min(G.placed, G.goal)}/${G.goal}`
    : `GOAL ${G.goal}`;

  const buzz = (n) => {
    try {
      const style =
        n >= 4
          ? Haptics.ImpactFeedbackStyle.Heavy
          : n >= 1
          ? Haptics.ImpactFeedbackStyle.Medium
          : Haptics.ImpactFeedbackStyle.Light;
      Haptics.impactAsync(style).catch(() => {});
    } catch (e) {}
  };

  const doShake = (p) => {
    Animated.sequence([
      Animated.timing(shake, { toValue: p, duration: 40, useNativeDriver: true }),
      Animated.timing(shake, { toValue: -p, duration: 60, useNativeDriver: true }),
      Animated.timing(shake, { toValue: p / 2, duration: 50, useNativeDriver: true }),
      Animated.timing(shake, { toValue: 0, duration: 50, useNativeDriver: true }),
    ]).start();
  };

  const start = (L) => {
    RNG = L === 22 ? seeded(dateSeed()) : Math.random;
    const cfg = LEVELS[L - 1];
    G.level = L;
    G.t = cfg.t;
    G.goal = cfg.g || 0;
    G.colors = cfg.c;
    G.base = cfg.s;
    G.moves = cfg.m || 0;
    G.rain = cfg.rain || 0;
    G.coach = cfg.coach || '';
    G.used = {};
    G.snap = null;
    G.slowUntil = 0;
    G.hatched = null;
    G.boss = false;
    G.prismNext = false;
    G.fever = 0;
    G.feverUntil = 0;
    G.continued = false;
    G.starAd = false;
    G.seq = (cfg.seq || []).map((x) => x.slice());
    G.next = np();
    G.board = emptyBoard();
    const pre = cfg.pre || [];
    pre.forEach((row, i) => {
      for (let c = 0; c < COLS; c++) {
        const ch = row[c];
        G.board[ROWS - pre.length + i][c] = ch && ch !== '.' ? Number(ch) : 0;
      }
    });
    for (let i = 0; i < cfg.rocks; i++) {
      const r = ROWS - 1 - Math.floor(RNG() * 4);
      const c = Math.floor(RNG() * COLS);
      G.board[r][c] = ROCK;
    }
    gravity(G.board);
    G.rockStart = G.board.flat().filter((v) => v === ROCK || v === CRACK).length;
    G.score = 0;
    G.chain = 0;
    G.maxChain = 0;
    G.banner = '';
    G.popping = new Set();
    G.placed = 0;
    G.piece = spawn(G.next);
    G.next = np();
    G.status = 'playing';
    render();
  };

  const gameOver = () => {
    G.fails[G.level] = (G.fails[G.level] || 0) + 1;
    if (G.t === 'daily') saveDaily();
    G.status = 'over';
    jingle([3, 2, 1, 0], 140);
    sfx('bass');
    G.piece = null;
    if (G.score > G.best) {
      G.best = G.score;
      AsyncStorage.setItem('best', String(G.best)).catch(() => {});
    }
    buzz(4);
    render();
  };

  const saveDaily = () => {
    G.daily = { d: dateKey(), s: G.score, c: G.maxChain };
    AsyncStorage.setItem('daily', JSON.stringify(G.daily)).catch(() => {});
  };
  const shareDaily = () => {
    const d = G.daily || { d: dateKey(), s: G.score, c: G.maxChain };
    Share.share({
      message: `ChainOrb Daily ${d.d}\n${d.s} pts • best chain x${d.c}\nCan you beat me?`,
    }).catch(() => {});
  };

  const showAd = (cb) => {
    G.ad = { left: 3 };
    render();
    const tick = () => {
      if (!G.ad) return;
      G.ad.left--;
      if (G.ad.left <= 0) {
        G.ad = null;
        cb();
        render();
      } else {
        render();
        setTimeout(tick, 1000);
      }
    };
    setTimeout(tick, 1000);
  };
  const continueAfterAd = () =>
    showAd(() => {
      if (G.moves && G.placed >= G.moves) G.moves = G.placed + 6;
      for (let r = 0; r < 4; r++) G.board[r] = Array(COLS).fill(0);
      G.continued = true;
      G.status = 'playing';
      G.piece = spawn(G.next);
      G.next = np();
    });
  const adStar = () =>
    showAd(() => {
      const before = totalStars(G.stars);
      G.earned = Math.min(3, G.earned + 1);
      G.stars[G.level] = Math.max(G.stars[G.level] || 0, G.earned);
      AsyncStorage.setItem('stars', JSON.stringify(G.stars)).catch(() => {});
      const after = totalStars(G.stars);
      G.hatched = ORBLINGS.find((o) => before < o.need && after >= o.need) || G.hatched;
      G.starAd = true;
    });
  const nextAction = () => {
    if (G.t === 'daily') return shareDaily();
    const nxt = G.status === 'won' && G.level < MAX_LEVEL ? G.level + 1 : G.level;
    if (G.status === 'won' && (G.level === 6 || G.level === 9 || (G.level >= 12 && G.level % 2 === 0))) showAd(() => start(nxt));
    else start(nxt);
    return null;
  };

  const win = () => {
    if (G.t === 'daily') {
      saveDaily();
      G.status = 'over';
      G.piece = null;
      jingle([0, 2, 4, 6, 9]);
      sfx('choir');
      render();
      return;
    }
    G.status = 'won';
    G.fails[G.level] = 0;
    jingle([0, 2, 4, 6, 9]);
    sfx('choir');
    G.earned =
      1 + (G.maxChain >= 3 ? 1 : 0) + (G.placed <= 10 + G.level * 2 ? 1 : 0);
    const before = totalStars(G.stars);
    if (G.earned > (G.stars[G.level] || 0)) {
      G.stars[G.level] = G.earned;
      AsyncStorage.setItem('stars', JSON.stringify(G.stars)).catch(() => {});
    }
    const after = totalStars(G.stars);
    G.hatched = ORBLINGS.find((o) => before < o.need && after >= o.need) || null;
    G.boss = G.level % 10 === 0;
    if (G.boss) {
      doShake(14);
      jingle([0, 2, 4, 6, 8, 9, 8, 9], 80);
    }
    if (G.hatched) setTimeout(() => jingle([4, 6, 7, 9], 110), 700);
    G.piece = null;
    G.banner = '';
    if (G.level < MAX_LEVEL && G.level + 1 > G.unlocked) {
      G.unlocked = G.level + 1;
      AsyncStorage.setItem('unlocked', String(G.unlocked)).catch(() => {});
    }
    buzz(4);
    render();
  };

  // the heart of the game: gravity -> find groups -> pop -> repeat
  const resolve = async () => {
    G.status = 'resolving';
    G.chain = 0;
    const wasDanger = G.board.slice(0, 4).some((row) => row.some(Boolean));
    render();
    while (alive.current) {
      if (gravity(G.board)) {
        render();
        await sleep(130);
      }
      const groups = findGroups(G.board);
      if (!groups.length) break;
      G.chain++;
      const flat = groups.flat();
      const big = groups.reduce((m, g) => (g.length > m.length ? g : m), []);
      const hit = new Set(flat.map(([r, c]) => r * COLS + c));
      for (const [r, c] of flat) {
        for (const [dy, dx] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const y = r + dy;
          const x = c + dx;
          if (y >= 0 && y < ROWS && x >= 0 && x < COLS && G.board[y][x] >= ROCK) {
            hit.add(y * COLS + x);
          }
        }
      }
      for (const k of [...hit]) {
        const br = Math.floor(k / COLS);
        const bc = k % COLS;
        if (G.board[br][bc] !== BOMB) continue;
        for (let y = br - 1; y <= br + 1; y++) {
          for (let x = bc - 1; x <= bc + 1; x++) {
            if (y >= 0 && y < ROWS && x >= 0 && x < COLS && G.board[y][x]) hit.add(y * COLS + x);
          }
        }
      }
      const cells = [...hit].map((k) => [Math.floor(k / COLS), k % COLS]);
      G.rings = cells.map(([r, c]) => ({ r, c, col: G.board[r][c] }));
      G.popping = hit;
      burst.setValue(0);
      Animated.timing(burst, { toValue: 1, duration: 280, useNativeDriver: true }).start();
      if (G.chain >= 2) G.banner = `x${G.chain} CHAIN`;
      render();
      buzz(G.chain);
      playChain(G.chain, flat.length);
      if (G.chain >= 3) G.prismNext = true;
      if (G.chain >= 2) setTimeout(() => buzz(G.chain), 90);
      if (G.chain >= 3) doShake(Math.min(4 + G.chain * 2, 16));
      await sleep(G.chain >= 3 ? 420 : 260);
      if (big.length >= 6) await sleep(60);
      G.score += flat.length * 10 * Math.pow(2, G.chain - 1) * (Date.now() < G.feverUntil ? 2 : 1);
      if (Date.now() >= G.feverUntil) {
        G.fever += flat.length * 4;
        if (G.fever >= 100) {
          G.fever = 0;
          G.feverUntil = Date.now() + 7000;
          G.banner = 'FEVER x2!';
          jingle([0, 2, 4, 6, 8, 9], 60);
          doShake(12);
        }
      }
      for (const [r, c] of cells) G.board[r][c] = G.board[r][c] === CRACK ? ROCK : 0;
      G.popping = new Set();
      G.rings = [];
      if (big.length >= 6) {
        const [br, bc] = big.reduce((m, x) => (x[0] > m[0] ? x : m));
        G.board[br][bc] = BOMB;
      }
      render();
      await sleep(110);
    }
    if (!alive.current) return;
    if (G.board.every((row) => row.every((v) => !v))) {
      G.score += 500;
      G.banner = 'PERFECT!';
      jingle([0, 2, 4, 6, 8, 9], 70);
      sfx('choir');
      doShake(16);
    } else if (wasDanger && !G.board.slice(0, 4).some((row) => row.some(Boolean))) {
      G.score += 200;
      G.banner = 'CLUTCH!';
      jingle([4, 6, 9], 80);
      doShake(10);
    }
    G.maxChain = Math.max(G.maxChain, G.chain);
    setTimeout(() => {
      G.banner = '';
      render();
    }, 800);

    if (goalMet()) {
      win();
      return;
    }
    if (G.moves && G.placed >= G.moves) {
      gameOver();
      return;
    }
    if (G.rain && G.placed % G.rain === 0) {
      const rc = Math.floor(RNG() * COLS);
      if (!G.board[0][rc]) {
        G.board[0][rc] = ROCK;
        gravity(G.board);
        render();
        await sleep(150);
      }
    }
    const p = spawn(G.next);
    if (!valid(G.board, p)) {
      gameOver();
      return;
    }
    G.piece = p;
    G.next = np();
    G.status = 'playing';
    render();
  };

  const lock = () => {
    G.lockAt = 0;
    buzz(0);
    sfx('land');
    G.snap = {
      board: G.board.map((row) => row.slice()),
      score: G.score,
      placed: G.placed,
      a: G.piece.a,
      b: G.piece.b,
    };
    for (const [r, c, col] of cellsOf(G.piece)) G.board[r][c] = col;
    const pr = cellsOf(G.piece).find((x) => x[2] === PRISM);
    if (pr) {
      const [pr_r, pr_c] = pr;
      let tc = 0;
      const below = pr_r + 1 < ROWS ? G.board[pr_r + 1][pr_c] : 0;
      if (below >= 1 && below <= 5) tc = below;
      else {
        for (const [dy, dx] of [[0, 1], [0, -1], [-1, 0]]) {
          const y = pr_r + dy;
          const x = pr_c + dx;
          if (y >= 0 && y < ROWS && x >= 0 && x < COLS && G.board[y][x] >= 1 && G.board[y][x] <= 5) {
            tc = G.board[y][x];
            break;
          }
        }
      }
      G.board[pr_r][pr_c] = 0;
      if (tc) {
        G.score += G.board.flat().filter((v) => v === tc).length * 10;
        G.board = G.board.map((row) => row.map((v) => (v === tc ? 0 : v)));
        jingle([2, 5, 7, 9], 60);
        doShake(10);
      }
    }
    G.piece = null;
    G.placed++;
    resolve();
  };

  const step = (force) => {
    if (G.status !== 'playing' || !G.piece) return false;
    const p2 = { ...G.piece, r: G.piece.r + 1 };
    if (valid(G.board, p2)) {
      G.piece = p2;
      G.lockAt = 0;
      render();
      return true;
    }
    if (force || (G.lockAt && Date.now() - G.lockAt >= 350)) lock();
    else if (!G.lockAt) G.lockAt = Date.now();
    return false;
  };

  const softDrop = () => {
    if (step(true)) G.score += 1;
  };

  const move = (dx) => {
    if (G.status !== 'playing' || !G.piece) return;
    const p2 = { ...G.piece, c: G.piece.c + dx };
    if (valid(G.board, p2)) {
      G.piece = p2;
      render();
    }
  };

  const rotate = (dir) => {
    if (G.status !== 'playing' || !G.piece) return;
    const p2 = tryRotate(G.board, G.piece, dir);
    if (p2) {
      G.piece = p2;
      render();
    }
  };

  const hardDrop = () => {
    if (G.status !== 'playing' || !G.piece) return;
    let n = 0;
    while (true) {
      const p2 = { ...G.piece, r: G.piece.r + 1 };
      if (!valid(G.board, p2)) break;
      G.piece = p2;
      n++;
    }
    G.score += n * 2;
    lock();
  };

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        G.gx = 0;
      },
      onPanResponderMove: (_, g) => {
        const dx = g.dx - G.gx;
        if (Math.abs(dx) >= G.cell) {
          move(dx > 0 ? 1 : -1);
          G.gx += dx > 0 ? G.cell : -G.cell;
        }
      },
      onPanResponderRelease: (_, g) => {
        if (g.dy > 70 && g.vy > 0.5 && Math.abs(g.dx) < 50) hardDrop();
        else if (Math.abs(g.dx) < 12 && Math.abs(g.dy) < 12) rotate(1);
      },
    })
  ).current;

  const usePower = (id) => {
    if (G.status !== 'playing' || !G.piece || G.used[id]) return;
    const isRock = (v) => v === ROCK || v === CRACK;
    if (id === 'crane') {
      G.slowUntil = Date.now() + 6000;
    } else if (id === 'kob') {
      if (!G.snap) return;
      G.board = G.snap.board.map((row) => row.slice());
      G.score = G.snap.score;
      G.placed = G.snap.placed;
      G.next = { a: G.piece.a, b: G.piece.b };
      G.piece = spawn({ a: G.snap.a, b: G.snap.b });
      G.snap = null;
    } else if (id === 'gorilla') {
      let best = 0;
      let bc = -1;
      for (let c = 0; c < COLS; c++) {
        let n = 0;
        for (let r = 0; r < ROWS; r++) if (isRock(G.board[r][c])) n++;
        if (n > best) {
          best = n;
          bc = c;
        }
      }
      if (bc < 0) return;
      for (let r = 0; r < ROWS; r++) if (isRock(G.board[r][bc])) G.board[r][bc] = 0;
      gravity(G.board);
    } else if (id === 'shoebill') {
      const cnt = {};
      G.board.forEach((row) =>
        row.forEach((v) => {
          if (v >= 1 && v <= 5) cnt[v] = (cnt[v] || 0) + 1;
        })
      );
      const top = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0];
      if (!top) return;
      G.board = G.board.map((row) => row.map((v) => (v === Number(top) ? 0 : v)));
      gravity(G.board);
    }
    G.used[id] = true;
    buzz(3);
    jingle([4, 6, 9], 70);
    render();
  };

  const speed = () =>
    Math.max(110, G.base - Math.floor(G.placed / 8) * 30) * (Date.now() < G.slowUntil ? 2.5 : 1) * (Date.now() < G.feverUntil ? 1.8 : 1);

  useEffect(() => {
    alive.current = true;
    initSound();
    AsyncStorage.getItem('lastError')
      .then((v) => {
        if (v) {
          G.lastErr = v;
          render();
        }
      })
      .catch(() => {});
    AsyncStorage.getItem('daily')
      .then((v) => {
        if (v) {
          G.daily = JSON.parse(v);
          render();
        }
      })
      .catch(() => {});
    AsyncStorage.getItem('muted')
      .then((v) => {
        MUTED = v === '1';
        render();
      })
      .catch(() => {});
    AsyncStorage.getItem('best')
      .then((v) => {
        if (v) {
          G.best = parseInt(v, 10) || 0;
          render();
        }
      })
      .catch(() => {});
    AsyncStorage.getItem('unlocked')
      .then((v) => {
        if (v) {
          G.unlocked = Math.min(MAX_LEVEL, parseInt(v, 10) || 1);
          render();
        }
      })
      .catch(() => {});
    AsyncStorage.getItem('stars')
      .then((v) => {
        if (v) {
          G.stars = JSON.parse(v) || {};
          render();
        }
      })
      .catch(() => {});
    Animated.loop(
      Animated.sequence([
        Animated.timing(float, { toValue: 1, duration: 2600, useNativeDriver: true }),
        Animated.timing(float, { toValue: 0, duration: 2600, useNativeDriver: true }),
      ])
    ).start();
    let t;
    const loop = () => {
      step();
      t = setTimeout(loop, speed());
    };
    t = setTimeout(loop, 700);
    return () => {
      alive.current = false;
      clearTimeout(t);
    };
  }, []);

  /* ---------- draw ---------- */
  const cell = Math.max(
    24,
    Math.min(Math.floor((width - 120) / COLS), Math.floor((height - 390) / ROWS))
  );

  G.cell = cell;
  const danger = G.board.slice(0, 4).some((row) => row.some(Boolean));
  const display = G.board.map((row) => row.slice());
  if (G.piece) {
    for (const [r, c, col] of cellsOf(G.piece)) {
      if (r >= 0 && r < ROWS && c >= 0 && c < COLS) display[r][c] = col;
    }
  }

  const T = REALMS[realmOf(G.status === 'menu' ? G.unlocked : G.level)];
  let ghost = [];
  if (G.piece) {
    let gp = G.piece;
    while (valid(G.board, { ...gp, r: gp.r + 1 })) gp = { ...gp, r: gp.r + 1 };
    if (gp.r !== G.piece.r) ghost = cellsOf(gp);
  }

  return (
    <View style={[styles.root, { backgroundColor: T.bg }]}>
      <StatusBar barStyle="light-content" />

      <View style={styles.hud}>
        <View>
          <Text style={styles.label}>SCORE</Text>
          <Text style={styles.score}>{G.score}</Text>
          <Text style={styles.small}>{goalText()}</Text>
          {G.moves ? (
            <Text style={[styles.small, { color: '#ffd23b' }]}>
              {Math.max(0, G.moves - G.placed)} MOVES
            </Text>
          ) : null}
        </View>
        <View style={{ alignItems: 'center' }}>
          <Text style={styles.label}>NEXT</Text>
          <Orb color={G.next.b} size={26} />
          <Orb color={G.next.a} size={26} />
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={styles.label}>LEVEL</Text>
          <Text style={styles.score}>{G.level}</Text>
          <Pressable
            onPress={() => {
              if (G.status === 'playing') {
                G.status = 'menu';
                render();
              }
            }}
          >
            <Text style={styles.small}>☰ MENU</Text>
          </Pressable>
          <Pressable
            hitSlop={10}
            onPress={() => {
              MUTED = !MUTED;
              AsyncStorage.setItem('muted', MUTED ? '1' : '0').catch(() => {});
              render();
            }}
          >
            <Text style={styles.small}>{MUTED ? '🔇 SOUND' : '🔊 SOUND'}</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.bar}>
        <View style={[styles.barFill, { width: `${Math.min(100, Math.max(0, progress() * 100))}%`, backgroundColor: T.accent }]} />
      </View>

      <View style={[styles.bar, { height: 4, marginTop: -4, marginBottom: 4 }]}>
        <View
          style={{
            height: 4,
            width: `${Date.now() < G.feverUntil ? 100 : Math.min(100, G.fever)}%`,
            backgroundColor: '#ffd23b',
          }}
        />
      </View>

      <Text style={[styles.coach, { color: T.accent }]}>
        {G.status === 'menu' ? T.name : G.coach || T.name}
      </Text>

      <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
        <View style={{ width: 46, alignItems: 'center', paddingTop: 6 }}>
          {ORBLINGS.map((o) => {
            const owned = totalStars(G.stars) >= o.need;
            const spent = G.used[o.id];
            return (
              <Pressable
                key={o.id}
                disabled={!owned || !!spent || G.status !== 'playing'}
                onPress={() => usePower(o.id)}
                style={[
                  styles.chip,
                  { borderColor: owned ? T.accent : '#2a2a4a', opacity: owned && !spent ? 1 : 0.35 },
                ]}
              >
                <Text style={{ fontSize: 20 }}>{owned ? o.icon : '🥚'}</Text>
              </Pressable>
            );
          })}
        </View>
      <Animated.View {...pan.panHandlers} style={{ transform: [{ translateX: shake }] }}>
        <View style={[styles.board, { width: cell * COLS + 8, height: cell * ROWS + 8, backgroundColor: T.board, borderColor: Date.now() < G.feverUntil ? '#ffd23b' : T.border }]}>
          {display.map((row, r) => (
            <View key={r} style={{ flexDirection: 'row' }}>
              {row.map((col, c) => (
                <Orb
                  key={c}
                  color={col}
                  size={cell}
                  popping={G.popping.has(r * COLS + c)}
                  worry={danger}
                />
              ))}
            </View>
          ))}

          {ghost.map(([r, c, col]) => (
            <View
              key={`g${r}-${c}`}
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: 2 + c * cell + cell * 0.12,
                top: 2 + r * cell + cell * 0.12,
                width: cell * 0.76,
                height: cell * 0.76,
                borderRadius: cell,
                borderWidth: 2,
                borderColor: COLORS[col],
                opacity: 0.4,
              }}
            />
          ))}

          {danger && G.status === 'playing' && (
            <Animated.View
              pointerEvents="none"
              style={[
                StyleSheet.absoluteFillObject,
                {
                  borderRadius: 10,
                  borderWidth: 3,
                  borderColor: '#ff3b6b',
                  opacity: float.interpolate({ inputRange: [0, 1], outputRange: [0.15, 0.8] }),
                },
              ]}
            />
          )}

          {G.rings.map((o) => (
            <Animated.View
              key={`${o.r}-${o.c}`}
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: 2 + o.c * cell,
                top: 2 + o.r * cell,
                width: cell,
                height: cell,
                borderRadius: cell,
                borderWidth: 3,
                borderColor: COLORS[o.col],
                opacity: burst.interpolate({ inputRange: [0, 1], outputRange: [0.9, 0] }),
                transform: [
                  { scale: burst.interpolate({ inputRange: [0, 1], outputRange: [1, 2.2] }) },
                ],
              }}
            />
          ))}

          {G.banner ? (
            <View style={styles.bannerWrap} pointerEvents="none">
              <Text style={styles.banner}>{G.banner}</Text>
            </View>
          ) : null}

          {G.status !== 'playing' && G.status !== 'resolving' && (
            <View style={styles.overlay}>
              {G.status === 'menu' ? (
                <>
                  {[1, 2, 3, 4, 5].map((k) => (
                    <Animated.View
                      key={k}
                      pointerEvents="none"
                      style={{
                        position: 'absolute',
                        left: `${k * 16 - 8}%`,
                        top: k % 2 ? '8%' : '78%',
                        opacity: 0.35,
                        transform: [
                          {
                            translateY: float.interpolate({
                              inputRange: [0, 1],
                              outputRange: [0, k % 2 ? 26 : -26],
                            }),
                          },
                        ],
                      }}
                    >
                      <Orb color={k} size={34} />
                    </Animated.View>
                  ))}
                  <Text style={[styles.title, { textShadowColor: T.accent }]}>CHAINORB</Text>
                  <Text style={styles.hint}>Hit the goal to unlock the next level</Text>
                  <Animated.View
                    style={{
                      transform: [
                        { translateY: float.interpolate({ inputRange: [0, 1], outputRange: [0, -6] }) },
                      ],
                    }}
                  >
                    <Text style={{ fontSize: 28, letterSpacing: 6, textAlign: 'center' }}>
                      {ORBLINGS.map((o) => (totalStars(G.stars) >= o.need ? o.icon : '🥚')).join(' ')}
                    </Text>
                  </Animated.View>
                  <Text style={styles.hint}>{orblingLine(G.stars)}  •  {VERSION}</Text>
                  <View style={styles.grid}>
                    {Array.from({ length: MAX_LEVEL }, (_, i) => i + 1).map((L) => {
                      const open = L <= G.unlocked;
                      return (
                        <Pressable
                          key={L}
                          disabled={!open}
                          onPress={() => start(L)}
                          style={[styles.lvl, open && { borderColor: REALMS[realmOf(L)].accent }, !open && styles.lvlLocked]}
                        >
                          <Text style={styles.lvlTxt}>{open ? L : '🔒'}</Text>
                          {open ? (
                            <Text style={styles.stars}>
                              {'★'.repeat(G.stars[L] || 0) + '☆'.repeat(3 - (G.stars[L] || 0))}
                            </Text>
                          ) : null}
                        </Pressable>
                      );
                    })}
                  </View>
                  <View style={{ flexDirection: 'row', marginTop: 8 }}>
                    <Pressable
                      onPress={() => (G.daily && G.daily.d === dateKey() ? shareDaily() : start(22))}
                      style={[styles.modeBtn, { borderColor: '#ffd23b' }]}
                    >
                      <Text style={styles.modeTxt}>
                        {G.daily && G.daily.d === dateKey() ? 'DAILY ✓ SHARE' : '🔥 DAILY'}
                      </Text>
                    </Pressable>
                    {G.stars[20] ? (
                      <Pressable onPress={() => start(21)} style={[styles.modeBtn, { borderColor: '#3be0c8' }]}>
                        <Text style={styles.modeTxt}>∞ ENDLESS</Text>
                      </Pressable>
                    ) : null}
                  </View>
                  {G.lastErr ? (
                    <Pressable
                      onPress={() => {
                        G.lastErr = '';
                        AsyncStorage.removeItem('lastError').catch(() => {});
                        render();
                      }}
                    >
                      <Text numberOfLines={5} style={{ color: '#ff3b6b', fontSize: 9, width: 280, marginTop: 6 }}>
                        LAST ERROR (tap to clear): {G.lastErr}
                      </Text>
                    </Pressable>
                  ) : null}
                </>
              ) : (
                <>
                  <Text style={styles.title}>
                    {G.status === 'won'
                      ? `LEVEL ${G.level} CLEAR`
                      : G.moves && G.placed >= G.moves
                      ? 'OUT OF MOVES'
                      : G.t === 'daily'
                      ? 'DAILY CHAIN'
                      : 'GAME OVER'}
                  </Text>
                  {G.status === 'won' && (
                    <Text style={styles.bigStars}>
                      {'★'.repeat(G.earned) + '☆'.repeat(3 - G.earned)}
                    </Text>
                  )}
                  {G.status === 'won' && G.boss && (
                    <Text style={[styles.hatch, { color: '#ffd23b' }]}>BOSS DEFEATED!</Text>
                  )}
                  {G.status === 'won' && G.hatched && (
                    <Text style={styles.hatch}>
                      {G.hatched.icon} NEW ORBLING{'\n'}
                      {G.hatched.name}{'\n'}
                      {G.hatched.power}
                    </Text>
                  )}
                  <Text style={styles.overScore}>
                    {G.status === 'won' || G.t === 'endless' || G.t === 'daily'
                      ? `${G.score} pts`
                      : `${Math.min(99, Math.round(progress() * 100))}% there`}
                    {'  •  '}best chain x{G.maxChain}
                  </Text>
                  <Pressable
                    style={styles.play}
                    onPress={nextAction}
                  >
                    <Text style={styles.playTxt}>
                      {G.t === 'daily' ? 'SHARE' : G.status === 'won' && G.level < MAX_LEVEL ? 'NEXT LEVEL' : 'RETRY'}
                    </Text>
                  </Pressable>
                  {G.status === 'over' && !G.continued && G.t !== 'daily' && (
                    <Pressable style={styles.adBtn} onPress={continueAfterAd}>
                      <Text style={styles.adBtnTxt}>▶ WATCH AD: KEEP GOING</Text>
                    </Pressable>
                  )}
                  {G.status === 'won' && G.earned < 3 && !G.starAd && (
                    <Pressable style={styles.adBtn} onPress={adStar}>
                      <Text style={styles.adBtnTxt}>▶ WATCH AD: +1 ★</Text>
                    </Pressable>
                  )}
                  <Pressable onPress={() => { G.status = 'menu'; render(); }}>
                    <Text style={styles.hint}>LEVELS</Text>
                  </Pressable>
                </>
              )}
            </View>
          )}
        </View>
      </Animated.View>
        <View style={{ width: 46 }} />
      </View>

      <View style={styles.controls}>
        <View style={styles.row}>
          <HoldButton label="⟲" onPress={() => rotate(-1)} />
          <HoldButton label="⟳" onPress={() => rotate(1)} />
          <HoldButton label="DROP" onPress={hardDrop} style={styles.dropBtn} />
        </View>
        <View style={styles.row}>
          <HoldButton label="◀" onPress={() => move(-1)} repeat />
          <HoldButton label="▼" onPress={softDrop} repeat />
          <HoldButton label="▶" onPress={() => move(1)} repeat />
        </View>
      </View>
      {G.ad && (
        <View style={styles.adCover}>
          <Text style={styles.adTxt}>AD (placeholder)</Text>
          <Text style={styles.adBig}>{G.ad.left}</Text>
        </View>
      )}
    </View>
  );
}

/* ============================== STYLES ============================== */
const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0a0a14',
    alignItems: 'center',
    paddingTop: (StatusBar.currentHeight || 24) + 6,
  },
  hud: {
    width: '90%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  label: { color: '#6b6b8a', fontSize: 11, letterSpacing: 2 },
  score: { color: '#fff', fontSize: 28, fontWeight: '800' },
  small: { color: '#6b6b8a', fontSize: 12 },
  board: {
    backgroundColor: '#11111f',
    borderColor: '#2a2a4a',
    borderWidth: 2,
    borderRadius: 10,
    padding: 2,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(5,5,12,0.88)',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
  },
  title: { color: '#fff', textShadowColor: '#2bff88', textShadowRadius: 16, fontSize: 28, fontWeight: '900', letterSpacing: 4 },
  overScore: { color: '#aaa', marginTop: 8, fontSize: 15 },
  play: {
    marginTop: 22,
    backgroundColor: '#2bff88',
    paddingHorizontal: 44,
    paddingVertical: 14,
    borderRadius: 40,
  },
  playTxt: { color: '#04140b', fontSize: 20, fontWeight: '900', letterSpacing: 2 },
  hint: { color: '#6b6b8a', marginTop: 16, fontSize: 12 },
  bannerWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  banner: {
    color: '#ffd23b',
    fontSize: 40,
    fontWeight: '900',
    textShadowColor: '#ff3b6b',
    textShadowRadius: 14,
  },
  chip: { width: 38, height: 38, borderRadius: 19, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', marginBottom: 8, backgroundColor: '#14142a' },
  hatch: { color: '#fff', fontSize: 15, fontWeight: '800', textAlign: 'center', marginTop: 8, letterSpacing: 1 },
  modeBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 12, borderWidth: 1.5, marginHorizontal: 5, backgroundColor: '#14142a' },
  modeTxt: { color: '#fff', fontWeight: '800', fontSize: 12, letterSpacing: 1 },
  adBtn: { marginTop: 10, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 14, borderWidth: 1.5, borderColor: '#ffd23b', backgroundColor: '#1a1a30' },
  adBtnTxt: { color: '#ffd23b', fontWeight: '800', fontSize: 13, letterSpacing: 1 },
  adCover: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center' },
  adTxt: { color: '#aaa', fontSize: 14, letterSpacing: 3 },
  adBig: { color: '#fff', fontSize: 64, fontWeight: '900' },
  coach: { fontSize: 11, letterSpacing: 2, height: 16, marginBottom: 2 },
  bar: { width: '90%', height: 6, backgroundColor: '#1a1a30', borderRadius: 3, marginBottom: 8, overflow: 'hidden' },
  barFill: { height: 6, backgroundColor: '#2bff88' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', width: '92%', marginTop: 14 },
  lvl: { width: 46, height: 50, margin: 4, borderRadius: 12, backgroundColor: '#1a1a30', borderWidth: 1, borderColor: '#2bff88', alignItems: 'center', justifyContent: 'center' },
  lvlLocked: { borderColor: '#2a2a4a', opacity: 0.5 },
  stars: { color: '#ffd23b', fontSize: 9, marginTop: 2 },
  bigStars: { color: '#ffd23b', fontSize: 34, marginTop: 8, letterSpacing: 4 },
  lvlTxt: { color: '#fff', fontSize: 18, fontWeight: '800' },
  controls: { width: '94%', marginTop: 10 },
  row: { flexDirection: 'row', marginVertical: 4 },
  btn: {
    flex: 1,
    height: 58,
    marginHorizontal: 4,
    backgroundColor: '#1a1a30',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#2a2a4a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnDown: { backgroundColor: '#2c2c55' },
  btnTxt: { color: '#fff', fontSize: 22, fontWeight: '700' },
  dropBtn: { backgroundColor: '#3a1a30', borderColor: '#ff3b6b' },
});


class Boundary extends React.Component {
  state = { err: null };
  static getDerivedStateFromError(err) {
    return { err };
  }
  componentDidCatch(err) {
    AsyncStorage.setItem('lastError', String((err && err.stack) || err).slice(0, 1200)).catch(() => {});
  }
  render() {
    if (this.state.err) {
      const e = this.state.err;
      return (
        <View style={{ flex: 1, backgroundColor: '#0a0a14', padding: 24, paddingTop: 60 }}>
          <Text style={{ color: '#ff3b6b', fontSize: 18, fontWeight: '800' }}>
            ChainOrb crashed ({VERSION})
          </Text>
          <Text selectable style={{ color: '#ddd', marginTop: 12, fontSize: 12 }}>
            {String((e && e.stack) || e).slice(0, 1500)}
          </Text>
          <Pressable onPress={() => this.setState({ err: null })} style={{ marginTop: 20 }}>
            <Text style={{ color: '#2bff88', fontSize: 16 }}>TRY AGAIN</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <Boundary>
      <Game />
    </Boundary>
  );
}
