import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, Pressable, StyleSheet, Animated, ScrollView,
  useWindowDimensions, StatusBar, PanResponder, Share, Platform, AppState, TextInput, Linking, BackHandler,
} from 'react-native';
import { Image, Easing } from 'react-native';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import { useFonts, Fredoka_700Bold } from '@expo-google-fonts/fredoka';
import { Canvas, Group, Path, Circle, Rect, RoundedRect, Oval, Line, Points, Shadow, Skia, LinearGradient, RadialGradient, DashPathEffect, vec } from '@shopify/react-native-skia';
import { useSharedValue, useDerivedValue, withTiming, withRepeat, withSpring, interpolate, Easing as REasing } from 'react-native-reanimated';

const FONT = 'Fredoka_700Bold';

/* ============================== ENGINE ============================== */
const COLS = 6;
const ROWS = 12;
const MAX_LEVEL = 100; // campaign length: levels 1-20 handcrafted, 21-100 generated (server can override any)
const ENDLESS_L = 901, DAILY_L = 902, EVENT_L = 903; // reserved ids, never collide with campaign levels
const MIN_GROUP = 4;
const COLORS = ['', '#ff3355', '#2ee86b', '#2e9bff', '#ffd21a', '#c64dff', '#6b6b8a', '#ff8a3b', '#9a9ac0', '#ffffff', '#ffe14a'];
const GLYPHS = ['', '●', '▲', '■', '◆', '★'];
const CHAIN_COLORS = ['','#ffd23b','#ff8a3b','#ff3b6b','#cc44ff','#ffffff','#00ffff','#00ff88'];
const CHAIN_SIZES  = [0, 38, 44, 52, 60, 68, 76, 84]; // shapes keep colors readable for color-blind players
const ROCK = 6;
const BOMB = 7;
const CRACK = 8;
const PRISM = 9;
const ZAP = 10; // v29: made by a 5-orb pop (never in the Daily); when touched by a pop it clears its whole row
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

// render-only: how far each orb will fall (keyed by destination cell). never touches the engine
function fallMap(b) {
  const m = new Map();
  let max = 0;
  for (let c = 0; c < COLS; c++) {
    let w = ROWS - 1;
    for (let r = ROWS - 1; r >= 0; r--) {
      if (b[r][c]) {
        if (r !== w) { m.set(w * COLS + c, w - r); max = Math.max(max, w - r); }
        w--;
      }
    }
  }
  return { m, max };
}
const fallMs = (d) => Math.min(280, 80 + 45 * d);

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
  { name: 'TWILIGHT GROVE', bg: '#1b1a5e', sky: ['#161552', '#3c2a86', '#a63f93'], board: 'rgba(40,10,60,0.50)', border: '#ffd36b', accent: '#ffd36b' },
  { name: 'MOONLIT LAKE', bg: '#2a7fd4', sky: ['#35d0c4', '#2a7fd4', '#3b3fb5'], board: 'rgba(5,20,70,0.50)', border: '#7ff3e0', accent: '#7ff3e0' },
  { name: 'FROST PEAKS', bg: '#5aa2f0', sky: ['#a8e0ff', '#5aa2f0', '#4a5fd0'], board: 'rgba(10,25,80,0.45)', border: '#e6f6ff', accent: '#ffffff' },
  { name: 'NEON CITY', bg: '#8a3bff', sky: ['#ff4fd8', '#8a3bff', '#2a1a7a'], board: 'rgba(15,5,50,0.55)', border: '#ff9bec', accent: '#ff9bec' },
  { name: 'SUNNY MEADOW', bg: '#2f77d8', sky: ['#1d4fb0', '#2f77d8', '#f2d9a0'], board: 'rgba(8,24,80,0.42)', border: '#fff2a8', accent: '#ffe27a', glass: 'rgba(6,18,60,0.30)', dim: 'rgba(6,18,60,0.14)' },
  { name: 'DUSTY DUNES', bg: '#6a1a5a', sky: ['#1a0b45', '#b02a7a', '#ffb050'], board: 'rgba(40,8,40,0.5)', border: '#ffc27a', accent: '#ffc27a', glass: 'rgba(24,6,30,0.26)', dim: 'rgba(24,6,30,0.10)' },
  { name: 'STORM JUNGLE', bg: '#10242e', sky: ['#0a1a22', '#183a46', '#2a5a62'], board: 'rgba(4,16,26,0.55)', border: '#9fd8ff', accent: '#9fd8ff', glass: 'rgba(4,14,24,0.26)', dim: 'rgba(4,14,24,0.12)' },
  { name: 'GOLDEN DAWN', bg: '#7a3a8a', sky: ['#2a2a6e', '#ff7a8a', '#ffe0a0'], board: 'rgba(50,14,60,0.46)', border: '#ffe0a0', accent: '#ffd08a', glass: 'rgba(40,10,50,0.28)', dim: 'rgba(40,10,50,0.12)' },
];
// campaign worlds: 1-20 as before, then 21-100 loop through the four realms in blocks of 10
const secOf = (L) => (L <= 20 ? Math.floor((L - 1) / 5) : 4 + Math.floor((L - 21) / 10));
const ACT2 = [4, 5, 6, 1, 7, 2, 0, 3]; // levels 21-100: meadow, desert, storm, lake, dawn, frost, grove, neon
const realmOf = (L) => (L <= 20 ? Math.min(3, Math.floor((L - 1) / 5)) : L === DAILY_L ? ACT2[dateSeed() % 8] : L >= 900 ? 3 : ACT2[Math.floor((L - 21) / 10) % 8]);
const lvlName = (L) => (L === DAILY_L ? 'D' : L === ENDLESS_L ? '∞' : L === EVENT_L ? '★' : String(L));
// t: score | chain | rocks | pairs.  g goal, c colors, s speed ms, m move limit,
// rocks random rocks, rain = a rock falls every N pairs, pre = preset rows (1-5 orbs, 6 rock, 8 cracked)
const LEVELS = [
  { t: 'score', g: 200, c: 3, s: 900, coach: 'Match 4 of a color to pop them' },
  {
    t: 'chain', g: 3, c: 3, s: 900,
    pre: ['...2..', '..22..', '..33..', '3311..', '2322..'],
    seq: [[1, 1]],
    coach: 'Slide the red pair right, then swipe down',
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


/* ============================== CHAIN TOWERS (v29) ============================== */
// 33 authored openers. Each is a stack where ONE placement of the forced first pair sets off a chain of k.
// Generated + proven offline with the real engine (see SESSION_NOTES). k = chain length, c = colours, p = rows top->bottom,
// s = the forced first pair, h = [orientation, pivot column] of the winning drop.
const TOWERS = [
  { k: 3, c: 3, p: ['.221.2', '2333.1', '1122.1'], s: [1, 3], h: [0, 4] },
  { k: 3, c: 3, p: ['..3...', '..3...', '..22..', '..112.', '233311'], s: [3, 2], h: [0, 1] },
  { k: 3, c: 3, p: ['.....2', '.....1', '..2113', '..3221', '331132'], s: [2, 3], h: [3, 2] },
  { k: 3, c: 3, p: ['...1.1', '...1.3', '...233', '...122', '.2.133'], s: [3, 2], h: [0, 4] },
  { k: 3, c: 3, p: ['.....1', '....13', '....13', '....23', '....22', '.2.331'], s: [3, 2], h: [3, 4] },
  { k: 3, c: 3, p: ['2.2...', '2.1...', '121222'], s: [1, 2], h: [2, 1] },
  { k: 3, c: 4, p: ['.3....', '.4....', '12.4..', '12.3..', '13.3..', '32234.'], s: [1, 3], h: [1, 1] },
  { k: 3, c: 4, p: ['.14...', '223...', '243...', '12343.'], s: [4, 3], h: [1, 2] },
  { k: 3, c: 4, p: ['.3.2..', '.1.3..', '.1.3..', '.1.122', '.43312'], s: [2, 1], h: [3, 3] },
  { k: 3, c: 4, p: ['...2..', '..33..', '..41..', '..43..', '1.12..', '1344.2'], s: [3, 1], h: [3, 2] },
  { k: 3, c: 5, p: ['5.....', '1.325.', '4.133.', '243535', '242111'], s: [4, 2], h: [0, 1] },
  { k: 3, c: 5, p: ['.3.5..', '.5335.', '435535', '213525'], s: [5, 3], h: [3, 5] },
  { k: 4, c: 3, p: ['...2..', '...31.', '.2.131', '133132', '131322'], s: [1, 3], h: [2, 2] },
  { k: 4, c: 3, p: ['...3..', '...2..', '12.2..', '32.1..', '33.2.2', '221122'], s: [3, 1], h: [3, 2] },
  { k: 4, c: 3, p: ['....21', '..3.11', '..3.23', '232.22', '131333'], s: [1, 2], h: [0, 3] },
  { k: 4, c: 3, p: ['.1.1..', '.2.3.3', '12.1.2', '123133', '211223'], s: [3, 2], h: [0, 4] },
  { k: 4, c: 4, p: ['.4.11.', '.1322.', '.34214', '334413'], s: [4, 2], h: [1, 4] },
  { k: 4, c: 4, p: ['..3.3.', '..3.4.', '..1.42', '4.1134', '3.2224'], s: [1, 3], h: [0, 3] },
  { k: 4, c: 4, p: ['...21.', '...12.', '...32.', '..2133', '.44413'], s: [4, 1], h: [1, 1] },
  { k: 4, c: 4, p: ['.3.2.1', '.424.2', '.44112', '122242'], s: [1, 2], h: [3, 5] },
  { k: 4, c: 4, p: ['..4...', '..2...', '.22...', '134.4.', '343232', '443322'], s: [2, 3], h: [3, 5] },
  { k: 4, c: 5, p: ['..4...', '..3...', '..535.', '1.1315', '431551', '214535'], s: [1, 4], h: [0, 1] },
  { k: 4, c: 5, p: ['.....3', '.....1', '.4...3', '.1.523', '55.155', '541335'], s: [5, 1], h: [0, 2] },
  { k: 4, c: 5, p: ['...43.', '...55.', '...14.', '..3544', '.41455', '544333'], s: [4, 5], h: [3, 5] },
  { k: 5, c: 4, p: ['..34..', '.114..', '.1334.', '.2311.', '.3243.', '224433'], s: [3, 4], h: [0, 5] },
  { k: 5, c: 4, p: ['...2..', '...2..', '...11.', '11.31.', '44143.', '322133'], s: [1, 4], h: [0, 2] },
  { k: 5, c: 4, p: ['.2.1.2', '.4.223', '.2.133', '.44211', '.42123'], s: [2, 4], h: [2, 2] },
  { k: 5, c: 5, p: ['..553.', '..2252', '..3522', '..3433', '131132'], s: [3, 1], h: [0, 1] },
  { k: 5, c: 5, p: ['..33..', '2.443.', '2.5521', '214542', '413225'], s: [5, 2], h: [2, 1] },
  { k: 5, c: 5, p: ['...3..', '.1.34.', '12.55.', '21.431', '244135', '253453'], s: [4, 1], h: [0, 2] },
  { k: 6, c: 5, p: ['...1..', '..133.', '..442.', '1.524.', '55425.', '512553'], s: [3, 5], h: [1, 4] },
  { k: 6, c: 5, p: ['.51...', '.35.1.', '.3151.', '.4131.', '.43151', '431333'], s: [1, 4], h: [2, 0] },
  { k: 6, c: 5, p: ['...44.', '...54.', '.5.51.', '.3221.', '43512.', '443314'], s: [4, 2], h: [1, 0] },
];
const towerFor = (chain, maxC, idx) => {
  for (let k = chain; k >= 3; k--) {
    const pool = TOWERS.filter((t) => t.k === k && t.c <= maxC);
    if (pool.length) return pool[idx % pool.length];
  }
  return null;
};
const withTower = (cfg, tw, hint) => {
  if (!tw) return cfg;
  cfg.pre = tw.p.slice();
  cfg.rocks = 0; // random rocks would break the authored chain
  cfg.seq = [tw.s.slice()];
  cfg.c = Math.max(cfg.c, tw.c);
  if (hint) cfg.hint = tw.h.slice();
  return cfg;
};
// handcrafted campaign levels that open with a tower: [chain, tower index, beam hint?, coach]
const AUTH = {
  3: [3, 0, true, 'Slide the pair under the beam, then swipe down'],
  5: [3, 1, true, 'See the beam? One drop sets off a chain'],
  7: [3, 2, true, 'Drop on the beam to reach a x3 chain'],
  12: [4, 0, true, 'Bigger chain. Follow the beam'],
  14: [4, 1, false, 'A x4 chain is hiding in this stack. Find it!'],
  16: [4, 2, false, 'Look for the one drop that topples everything'],
  18: [5, 0, false, 'A x5 opener. Think it through'],
};
const authored = (L, base) => {
  const a = AUTH[L];
  if (!a || !base || base.pre) return base;
  const cfg = { ...base };
  withTower(cfg, towerFor(a[0], cfg.c, a[1]), a[2]);
  cfg.coach = a[3];
  return cfg;
};

/* ============================== CAMPAIGN 21-100 + REMOTE CONFIG (v23) ============================== */
const BOSS_NAMES = ['Mossback', 'Tide Titan', 'Frost Warden', 'Neon Queen', 'Gloom Weaver', 'Storm Kraken', 'Ice Colossus', 'Glitch King'];
const GEN_CACHE = {};
// Deterministic level designer: the same level number always gives the same level, offline or online.
function genLevel(n) {
  if (GEN_CACHE[n]) return GEN_CACHE[n];
  const r = seeded(n * 7919 + 13);
  const d = Math.min(1, (n - 20) / 80); // difficulty ramp 0..1 across 21-100
  const boss = n % 10 === 0;
  const kinds = ['score', 'chain', 'pairs', 'rocks', 'score', 'pairs'];
  let t = kinds[(n + Math.floor(r() * 2)) % kinds.length];
  if (boss) t = 'score';
  const cfg = { t, c: n < 30 ? 4 : 5, s: Math.round(560 - d * 150 - (boss ? 20 : 0)) };
  const rockRow = (k) => {
    const row = Array(6).fill('.');
    for (let i = 0; i < k; i++) row[Math.floor(r() * 6)] = r() < 0.5 ? '6' : '8';
    return row.join('');
  };
  if (t === 'score') {
    cfg.g = Math.round((1500 + d * 3000 + (boss ? 1000 : 0)) / 100) * 100;
    if (boss || r() < 0.35) cfg.m = Math.round(46 - d * 4 + (boss ? 6 : 0));
    cfg.rocks = 1 + Math.floor(d * 5) + (boss ? 3 : 0);
    if (!boss && r() < 0.3) {
      const rows = [];
      for (let i = 0; i < 2 + Math.floor(r() * 2); i++) {
        rows.push(Array.from({ length: 6 }, () => (r() < 0.25 ? '.' : String(1 + Math.floor(r() * cfg.c)))).join(''));
      }
      cfg.pre = rows;
    }
  } else if (t === 'chain') {
    cfg.g = 4 + Math.floor(d * 2.99);
  } else if (t === 'pairs') {
    cfg.g = 30 + Math.floor(d * 18);
    cfg.rain = d < 0.4 ? 4 : 3;
    cfg.rocks = Math.floor(d * 5);
  } else {
    cfg.pre = [rockRow(2 + Math.floor(d * 2)), rockRow(2 + Math.floor(d * 2))];
    cfg.rocks = 3 + Math.floor(d * 6);
  }
  if (boss) cfg.coach = `BOSS: ${BOSS_NAMES[(n / 10 - 3) % BOSS_NAMES.length]}`;
  // v29: chain levels start from a tower; every third other level opens with a smaller one
  if (t === 'chain') {
    withTower(cfg, towerFor(Math.min(6, cfg.g), cfg.c, n), false);
    cfg.coach = 'A big chain is hiding in this stack';
  } else if (!cfg.pre && !boss && n % 3 === 1) {
    withTower(cfg, towerFor(3 + (n % 2), cfg.c, n), false);
    cfg.coach = 'OPENER: find the drop that pops the tower';
  }
  GEN_CACHE[n] = cfg;
  return cfg;
}
// Remote data is untrusted input: every field is clamped or the whole config is dropped.
const OK_T = ['score', 'chain', 'rocks', 'pairs'];
function cleanCfg(x) {
  if (!x || typeof x !== 'object' || !OK_T.includes(x.t)) return null;
  const num = (v, lo, hi, d) => (typeof v === 'number' && isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d);
  const cfg = { t: x.t, c: num(x.c, 3, 5, 4), s: num(x.s, 250, 1500, 640) };
  if (x.t !== 'rocks') cfg.g = num(x.g, 1, 99999999, 500);
  if (x.m) cfg.m = num(x.m, 1, 99, 30);
  if (x.rocks) cfg.rocks = num(x.rocks, 0, 16, 0);
  if (x.rain) cfg.rain = num(x.rain, 1, 12, 4);
  if (typeof x.coach === 'string') cfg.coach = x.coach.slice(0, 70);
  if (Array.isArray(x.pre)) {
    const pre = x.pre.slice(0, 8).filter((row) => typeof row === 'string' && /^[.0-9]{6}$/.test(row));
    if (pre.length) cfg.pre = pre;
  }
  if (Array.isArray(x.seq)) {
    const seq = x.seq.slice(0, 6).filter((p) => Array.isArray(p) && p.length === 2 && p.every((v) => Number.isInteger(v) && v >= 1 && v <= 9));
    if (seq.length) cfg.seq = seq;
  }
  return cfg;
}
const REMOTE = { levels: {}, events: [] };
function applyRemote(raw) {
  const levels = {};
  (Array.isArray(raw && raw.levels) ? raw.levels : []).forEach((row) => {
    const n = row && Number(row.n);
    const cfg = n >= 1 && n <= MAX_LEVEL ? cleanCfg(row.cfg) : null;
    if (cfg) levels[n] = cfg;
  });
  const events = [];
  (Array.isArray(raw && raw.events) ? raw.events : []).forEach((e) => {
    const cfg = e && cleanCfg(e.cfg);
    const a = e && Date.parse(e.starts_at);
    const b = e && Date.parse(e.ends_at);
    if (!cfg || typeof e.id !== 'string' || !isFinite(a) || !isFinite(b)) return;
    events.push({ id: e.id.slice(0, 40), title: String(e.title || 'EVENT').slice(0, 40), blurb: String(e.blurb || '').slice(0, 80), s: a, e: b, cfg });
  });
  REMOTE.levels = levels;
  REMOTE.events = events;
}
const activeEvent = () => {
  const now = Date.now();
  return REMOTE.events.find((e) => now >= e.s && now < e.e) || null;
};
const evLeft = (ev) => {
  const m = Math.max(0, Math.floor((ev.e - Date.now()) / 60000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return d > 0 ? `${d}d ${h}h` : `${h}h ${m % 60}m`;
};
const cfgOf = (L) => {
  if (L === DAILY_L) return LEVELS[21]; // daily rules are verified server-side: never remote, never generated
  if (L === ENDLESS_L) return LEVELS[20];
  if (L === EVENT_L) {
    const ev = activeEvent();
    return ev ? { ...ev.cfg, coach: ev.cfg.coach || ev.title } : LEVELS[0];
  }
  return REMOTE.levels[L] || (L <= 20 ? authored(L, LEVELS[L - 1]) : genLevel(L));
};

/* ============================== SAFETY NET, DAILY ============================== */
const VERSION = 'v33';
const PRIVACY_URL = 'https://qualyslive-code.github.io/ChainOrb/privacy.html';
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
const dateKey = (d = new Date()) => {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dateSeed = () => Number(dateKey().replace(/-/g, ''));

// ad pacing: one place to tune. Never two interstitials within 2 minutes.
let lastAdAt = 0;
// v30 ADS (Google AdMob). The module is optional: without it, or if no ad is loaded, the old 3-second countdown runs instead.
// Until you paste real unit ids into AD_UNITS, Google's TEST ads are used (safe, but they earn nothing).
let Ads = null;
try {
  Ads = require('react-native-google-mobile-ads');
} catch (e) {}
const AD_UNITS = { rewarded: '', interstitial: '' }; // e.g. 'ca-app-pub-XXXXXXXXXXXXXXXX/YYYYYYYYYY'
const adState = { ready: false, rewarded: null, interstitial: null, rewardedLoaded: false, interstitialLoaded: false };
const adUnit = (k) => AD_UNITS[k] || (Ads && Ads.TestIds ? (k === 'rewarded' ? Ads.TestIds.REWARDED : Ads.TestIds.INTERSTITIAL) : '');
const loadAd = (k) => {
  if (!Ads || !adState.ready) return;
  try {
    const rw = k === 'rewarded';
    const ad = (rw ? Ads.RewardedAd : Ads.InterstitialAd).createForAdRequest(adUnit(k));
    adState[k] = ad;
    adState[k + 'Loaded'] = false;
    ad.addAdEventListener(rw ? Ads.RewardedAdEventType.LOADED : Ads.AdEventType.LOADED, () => {
      adState[k + 'Loaded'] = true;
    });
    ad.addAdEventListener(Ads.AdEventType.ERROR, () => {
      adState[k + 'Loaded'] = false;
      setTimeout(() => loadAd(k), 30000); // no fill / offline: try again in 30s
    });
    ad.load();
  } catch (e) {}
};
const initAds = async () => {
  if (!Ads || adState.ready) return;
  try {
    // GDPR / UK / US-state consent form, shown only where the law requires it
    if (Ads.AdsConsent && Ads.AdsConsent.gatherConsent) await Ads.AdsConsent.gatherConsent();
  } catch (e) {}
  try {
    await Ads.default().initialize();
    adState.ready = true;
    loadAd('rewarded');
    loadAd('interstitial');
  } catch (e) {}
};
// returns true if a real ad was shown. rewarded: onDone only if the reward was earned, otherwise onSkip.
const presentAd = (k, onDone, onSkip) => {
  const ad = adState[k];
  if (!Ads || !ad || !adState[k + 'Loaded']) return false;
  const rw = k === 'rewarded';
  let earned = false;
  const offs = [];
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    offs.forEach((f) => {
      try {
        f();
      } catch (e) {}
    });
    if (!rw || earned) onDone();
    else onSkip();
    loadAd(k);
  };
  try {
    offs.push(ad.addAdEventListener(Ads.AdEventType.CLOSED, finish));
    offs.push(ad.addAdEventListener(Ads.AdEventType.ERROR, finish));
    if (rw) offs.push(ad.addAdEventListener(Ads.RewardedAdEventType.EARNED_REWARD, () => { earned = true; }));
    adState[k + 'Loaded'] = false;
    ad.show();
    return true;
  } catch (e) {
    return false;
  }
};
const adDue = (L) => L < 900 && (L === 6 || L === 9 || (L >= 12 && L % 2 === 0)) && Date.now() - lastAdAt > 120000;

const CHEST_SHARDS = 1; // daily chest reward: flat on purpose (shards only buy cosmetic skins)
// free orb skins, earned with shards from daily missions
let SKIN = 'gel';
const SKINS = [
  { id: 'gel', name: 'GEL', cost: 0 },
  { id: 'gem', name: 'GEM', cost: 3 },
  { id: 'ring', name: 'RING', cost: 6 },
  { id: 'candy', name: 'CANDY', cost: 10 },
];
const MPOOL = [
  { k: 'pops', need: 60, text: 'Pop 60 orbs' },
  { k: 'pops', need: 120, text: 'Pop 120 orbs' },
  { k: 'chain', need: 3, text: 'Reach a x3 chain' },
  { k: 'chain', need: 4, text: 'Reach a x4 chain' },
  { k: 'levels', need: 2, text: 'Clear 2 levels' },
  { k: 'levels', need: 3, text: 'Clear 3 levels' },
  { k: 'stars', need: 4, text: 'Earn 4 stars' },
  { k: 'fever', need: 1, text: 'Trigger Fever' },
];
const genMissions = () => {
  const r = seeded(dateSeed() + 7);
  const pool = MPOOL.slice();
  const items = [];
  while (items.length < 3 && pool.length) {
    const it = pool.splice(Math.floor(r() * pool.length), 1)[0];
    if (!items.some((x) => x.k === it.k)) items.push({ ...it, have: 0, done: false });
  }
  return { d: dateKey(), items };
};

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
  await genInstruments();
  loadAllMusic();
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

/* ============================== REALM INSTRUMENTS ============================== */
// Chain notes change instrument with the realm:
// Savanna = kalimba, Lake = adungu (harp), Ice = glass bell, Neon = afrobeat conga.
// All synthesized in code. Files are written once; only the active realm's 10 players stay loaded.
function normalize(x, peak) {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
  const s = m > 0 ? peak / m : 1;
  for (let i = 0; i < x.length; i++) x[i] *= s;
  return x;
}
function kalimba(f) {
  const n = Math.floor(SR * 0.6);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const body = Math.sin(2 * Math.PI * f * t) * Math.exp(-5 * t);
    const tine = Math.sin(2 * Math.PI * f * 5.4 * t) * Math.exp(-30 * t) * 0.35; // metallic ping
    const wood = Math.sin(2 * Math.PI * f * 0.5 * t) * Math.exp(-35 * t) * 0.25; // thumb on wood
    out[i] = Math.min(1, t / 0.002) * (body + tine + wood);
  }
  return normalize(out, 0.6);
}
function adungu(f) {
  const n = Math.floor(SR * 0.9);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    for (let k = 1; k <= 6; k++) v += (Math.sin(2 * Math.PI * f * k * t) * Math.exp(-(2 + 2.8 * k) * t)) / k;
    out[i] = Math.min(1, t / 0.002) * v;
  }
  return normalize(out, 0.6);
}
function glassBell(f) {
  const ratio = [1, 2.76, 5.4, 8.93];
  const amp = [1, 0.5, 0.25, 0.12];
  const dec = [3, 4.5, 7, 10];
  const n = Math.floor(SR * 0.9);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    for (let k = 0; k < 4; k++) v += amp[k] * Math.sin(2 * Math.PI * f * ratio[k] * t) * Math.exp(-dec[k] * t);
    out[i] = Math.min(1, t / 0.002) * v;
  }
  return normalize(out, 0.55);
}
function conga(f) {
  const n = Math.floor(SR * 0.35);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (2 * Math.PI * (f * 0.9 + f * 0.6 * Math.exp(-t * 60))) / SR; // pitch drops on the hit
    const slap = (Math.random() * 2 - 1) * Math.exp(-t * 120) * 0.3;
    out[i] = Math.sin(ph) * Math.exp(-t * 9) + slap;
  }
  return normalize(out, 0.7);
}
function pluckBright(f) { // meadow: bright music-box pluck
  const n = Math.floor(SR * 0.7);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const v = Math.sin(2 * Math.PI * f * t) * Math.exp(-4.5 * t) + 0.4 * Math.sin(2 * Math.PI * f * 2 * t) * Math.exp(-7 * t) + 0.18 * Math.sin(2 * Math.PI * f * 3.01 * t) * Math.exp(-12 * t);
    out[i] = Math.min(1, t / 0.002) * v;
  }
  return normalize(out, 0.55);
}
function handpan(f) { // desert: round, warm hum with a slow bloom
  const n = Math.floor(SR * 1.0);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const v = Math.sin(2 * Math.PI * f * t) * Math.exp(-3 * t) + 0.5 * Math.sin(2 * Math.PI * f * 2 * t) * Math.exp(-4 * t) + 0.22 * Math.sin(2 * Math.PI * f * 3 * t) * Math.exp(-6 * t) + 0.14 * Math.sin(2 * Math.PI * f * 1.006 * t) * Math.exp(-3.4 * t);
    out[i] = Math.min(1, t / 0.004) * v;
  }
  return normalize(out, 0.6);
}
function marimba(f) { // storm: soft wooden mallet
  const n = Math.floor(SR * 0.5);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const v = Math.sin(2 * Math.PI * f * t) * Math.exp(-8 * t) + 0.45 * Math.sin(2 * Math.PI * f * 4 * t) * Math.exp(-26 * t) + 0.12 * Math.sin(2 * Math.PI * f * 10 * t) * Math.exp(-60 * t);
    out[i] = Math.min(1, t / 0.0015) * v;
  }
  return normalize(out, 0.6);
}
function harp(f) { // dawn: plucked string, long shimmering tail
  const n = Math.floor(SR * 1.1);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    for (let k = 1; k <= 8; k++) v += (Math.sin(2 * Math.PI * f * k * t) * Math.exp(-(1.4 + 2.2 * k) * t)) / (k * 0.9);
    out[i] = Math.min(1, t / 0.002) * v;
  }
  return normalize(out, 0.58);
}
const INSTR = [kalimba, adungu, glassBell, conga, pluckBright, handpan, marimba, harp];
const INSTR_URI = {};
let instrReady = false;
let instrWant = -1;
let instrCur = -1;

function saveWav(name, samples) {
  const bytes = wav(samples);
  try {
    const f = new File(Paths.cache, name);
    if (f.exists) f.delete();
    f.create();
    f.write(bytes);
    return f.uri;
  } catch (e) {
    return 'data:audio/wav;base64,' + b64(bytes);
  }
}
async function genInstruments() {
  try {
    for (let r = 0; r < INSTR.length; r++) {
      INSTR_URI[r] = NOTES.map((f, i) => saveWav(`co_r${r}_n${i}.wav`, INSTR[r](f)));
      await new Promise((res) => setTimeout(res, 0));
    }
    instrReady = true;
    applyInstrument();
  } catch (e) {}
}
function applyInstrument() {
  if (!instrReady || instrWant < 0 || instrWant === instrCur) return;
  for (let i = 0; i < NOTES.length; i++) {
    try {
      const old = P['n' + i];
      P['n' + i] = createAudioPlayer({ uri: INSTR_URI[instrWant][i] });
      if (old) {
        try {
          old.remove();
        } catch (e) {}
      }
    } catch (e) {}
  }
  instrCur = instrWant;
}
function setInstrument(r) {
  instrWant = r;
  applyInstrument();
}

/* ============================== MUSIC ============================== */
// One looping background track per realm, synthesized in code (no audio files).
// Generated in small chunks so the game never stutters; current realm loads first.
const hz = (s) => 440 * Math.pow(2, s / 12); // semitones from A4
const TRACKS = [
  // 0 SUNRISE MEADOW: warm, bright, gentle arpeggio
  {
    bpm: 88, bassEvery: 4, kick: false, arpGain: 0.2, padGain: 0.16,
    chords: [[-9, -5, -2], [-12, -9, -5], [-16, -12, -9], [-14, -10, -7]],
    pat: [0, 1, 2, 3, 2, 1, 4, 2, 0, 1, 2, 3, 4, 3, 2, 1],
  },
  // 1 MOONLIT LAKE: slow, deep, bell-like
  {
    bpm: 70, bassEvery: 8, kick: false, arpGain: 0.17, padGain: 0.2,
    chords: [[-12, -9, -5], [-16, -12, -9], [-9, -5, -2], [-5, -2, 2]],
    pat: [0, -1, 2, -1, 1, -1, 3, -1, 2, -1, 4, -1, 1, -1, 3, -1],
  },
  // 2 FROST PEAKS: airy, sparse, glassy
  {
    bpm: 80, bassEvery: 8, kick: false, arpGain: 0.15, padGain: 0.14, arpUp: 2,
    chords: [[-7, -3, 0], [-12, -8, -5], [-10, -7, -3], [-14, -10, -7]],
    pat: [0, -1, -1, 2, -1, -1, 4, -1, 1, -1, -1, 3, -1, -1, 4, -1],
  },
  // 3 NEON CITY: driving, kick and pulse bass
  {
    bpm: 112, bassEvery: 1, kick: true, arpGain: 0.2, padGain: 0.1,
    chords: [[-17, -14, -10], [-9, -5, -2], [-14, -10, -7], [-7, -3, 0]],
    pat: [0, 2, 1, 2, 3, 2, 1, 2, 0, 2, 1, 4, 3, 2, 4, 2],
  },
  // 4 SUNNY MEADOW: bright, bouncy, light
  {
    bpm: 98, bassEvery: 4, kick: false, arpGain: 0.2, padGain: 0.12,
    chords: [[-9, -5, -2], [-5, -2, 2], [-12, -8, -5], [-7, -3, 0]],
    pat: [0, 2, 1, 3, 2, 4, 3, 2, 0, 2, 1, 3, 4, 3, 2, 1],
  },
  // 5 DUSTY DUNES: Phrygian-dominant pull (A major / Bb major), sparse, with a wind bed
  {
    bpm: 84, bassEvery: 2, kick: false, arpGain: 0.18, padGain: 0.16,
    chords: [[-12, -8, -5], [-11, -7, -4], [-12, -8, -5], [-17, -13, -10]],
    pat: [0, -1, 1, 2, -1, 2, 3, -1, 0, -1, 1, 2, -1, 4, 3, -1],
    noise: { g: 0.5, a: 0.04, mod: 3 },
  },
  // 6 STORM JUNGLE: slow minor, with rain hiss under it
  {
    bpm: 66, bassEvery: 8, kick: false, arpGain: 0.16, padGain: 0.22,
    chords: [[-12, -9, -5], [-14, -10, -7], [-16, -12, -9], [-17, -14, -10]],
    pat: [0, -1, 1, -1, 2, -1, 1, -1, 0, -1, 2, -1, 3, -1, 2, -1],
    noise: { g: 0.1, a: 0.45, mod: 4 },
  },
  // 7 GOLDEN DAWN: gentle major, rising lines
  {
    bpm: 76, bassEvery: 4, kick: false, arpGain: 0.18, padGain: 0.18,
    chords: [[-14, -10, -7], [-12, -8, -5], [-9, -5, -2], [-5, -2, 2]],
    pat: [0, 1, 2, 3, 4, 3, 2, 1, 0, 1, 2, 4, 3, 2, 1, 2],
  },
];

const musTick = () => new Promise((r) => setTimeout(r, 0));

async function makeTrack(d) {
  const beat = 60 / d.bpm;
  const total = Math.floor(SR * beat * 32); // 4 chords x 8 beats
  const buf = new Float32Array(total);
  // wraps around the end, so tails fade into the start of the loop
  const add = (t0, sig, g = 1) => {
    const s = Math.floor(t0 * SR);
    for (let i = 0; i < sig.length; i++) buf[(s + i) % total] += sig[i] * g;
  };
  for (let ci = 0; ci < d.chords.length; ci++) {
    const ch = d.chords[ci].map(hz);
    const t0 = ci * 8 * beat;
    // pad: soft sustained chord
    for (const f of ch) {
      add(t0, tone(f, beat * 8 + 0.8, { decay: 0.55, attack: 0.5, gain: 1, harm: [1, 0.2] }), d.padGain);
      await musTick();
    }
    // bass
    const bd = d.bassEvery * beat;
    for (let b = 0; b * bd < beat * 8 - 0.001; b++) {
      add(t0 + b * bd, tone(ch[0] / 2, Math.min(0.6, bd + 0.1), { decay: 4, attack: 0.01, gain: 1, harm: [1, 0.3] }), 0.3);
    }
    await musTick();
    // kick on every beat
    if (d.kick) {
      const k = kick();
      for (let b = 0; b < 8; b++) add(t0 + b * beat, k, 0.45);
      await musTick();
    }
    // arpeggio on eighth notes (16 per chord, two bars)
    const notes = [ch[0], ch[1], ch[2], ch[0] * 2, ch[1] * 2];
    const up = d.arpUp || 1;
    for (let i = 0; i < 16; i++) {
      const idx = d.pat[i];
      if (idx >= 0) {
        add(t0 + i * (beat / 2), tone(notes[idx] * up, 0.5, { decay: 6, attack: 0.005, gain: 1, harm: [1, 0.3] }), d.arpGain);
      }
      if (i % 4 === 3) await musTick();
    }
  }
  if (d.noise) {
    // rain hiss / desert wind: low-passed noise with a slow swell. Whole swell cycles per loop, so the loop is seamless.
    const nz = d.noise;
    let y = 0;
    for (let i = 0; i < total; i++) {
      y += nz.a * (Math.random() * 2 - 1 - y);
      const m = nz.mod ? 0.65 + 0.35 * Math.sin((i / total) * Math.PI * 2 * nz.mod) : 1;
      buf[i] += y * nz.g * m;
      if ((i & 32767) === 0) await musTick();
    }
  }
  let peak = 0;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(buf[i]));
  const sc = peak > 0 ? 0.85 / peak : 1;
  for (let i = 0; i < total; i++) buf[i] *= sc;
  return buf;
}

const MUS = {};
const musBusy = {};
let musWant = -1;
let musRate = 1;
let musHold = false;

// music speeds up when the stack is near the top
function setMusicRate(rate) {
  musRate = rate;
  for (const k of Object.keys(MUS)) {
    try {
      MUS[k].setPlaybackRate(rate);
    } catch (e) {}
  }
}

async function loadMusic(r) {
  if (MUS[r] || musBusy[r]) return;
  musBusy[r] = true;
  try {
    const bytes = wav(await makeTrack(TRACKS[r]));
    let uri;
    try {
      const f = new File(Paths.cache, `co_music${r}.wav`);
      if (f.exists) f.delete();
      f.create();
      f.write(bytes);
      uri = f.uri;
    } catch (e) {
      uri = 'data:audio/wav;base64,' + b64(bytes);
    }
    const pl = createAudioPlayer({ uri });
    pl.loop = true;
    pl.volume = 0.3;
    try {
      pl.setPlaybackRate(musRate);
    } catch (e) {}
    MUS[r] = pl;
  } catch (e) {}
  musBusy[r] = false;
  if (musWant === r) applyMusic();
}

function applyMusic() {
  for (const k of Object.keys(MUS)) {
    const pl = MUS[k];
    try {
      if (Number(k) === musWant && !MUTED && !musHold) pl.play();
      else pl.pause();
    } catch (e) {}
  }
  if (musWant >= 0 && !MUS[musWant]) loadMusic(musWant);
}

function setMusic(r) {
  musWant = r;
  applyMusic();
}

// current realm first, then the rest in the background
async function loadAllMusic() {
  const first = musWant >= 0 ? musWant : 0;
  const order = [first, ...[0, 1, 2, 3, 4, 5, 6, 7].filter((x) => x !== first)];
  for (const r of order) {
    await loadMusic(r);
    await new Promise((res) => setTimeout(res, 1500));
  }
}

/* ============================== ONLINE (optional) ============================== */
// Fully optional: with the two constants below left empty, the game never touches the network.
// Fill them in once the Supabase tables exist (see supabase_chainorb.sql).
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL || 'https://ipaophblasfxycicsurn.supabase.co';
const SUPABASE_ANON = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || 'sb_publishable_za3YxnBct36Q_n8I-rniLg_o4u4C3tN'; // public client key; access is limited by row-level security
const ONLINE = !!(SUPABASE_URL && SUPABASE_ANON);
let PID = 'p' + Math.random().toString(36).slice(2, 10);
let NICK = 'Orb' + (1000 + Math.floor(Math.random() * 9000));
let COUNTRY = 'XX';
try {
  const loc = (Intl.DateTimeFormat().resolvedOptions().locale || '').split('-')[1];
  if (loc) COUNTRY = loc.slice(0, 2).toUpperCase();
} catch (e) {}
let evQ = [];
let evBusy = false;

const sbHeaders = () => {
  const h = { apikey: SUPABASE_ANON, 'Content-Type': 'application/json', Prefer: 'return=minimal' };
  if (SUPABASE_ANON.startsWith('eyJ')) h.Authorization = 'Bearer ' + SUPABASE_ANON;
  return h;
};
function fetchT(url, opts, ms = 8000) {
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const t = ac ? setTimeout(() => ac.abort(), ms) : null;
  return fetch(url, { ...opts, signal: ac ? ac.signal : undefined }).finally(() => {
    if (t) clearTimeout(t);
  });
}
async function sbPost(table, rows) {
  const res = await fetchT(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: sbHeaders(),
    body: JSON.stringify(rows),
  });
  return res.ok;
}
async function loadOnline() {
  if (!ONLINE) return;
  try {
    const pid = await AsyncStorage.getItem('pid');
    if (pid) PID = pid;
    else AsyncStorage.setItem('pid', PID).catch(() => {});
    const nick = await AsyncStorage.getItem('nick');
    if (nick) NICK = nick;
    else AsyncStorage.setItem('nick', NICK).catch(() => {});
    const q = await AsyncStorage.getItem('evq');
    if (q) evQ = JSON.parse(q) || [];
  } catch (e) {}
  flushEvents();
  resendDaily();
}
// events wait in a small offline queue and are sent whenever the network allows
async function flushEvents() {
  if (!ONLINE || evBusy || !evQ.length) return;
  evBusy = true;
  try {
    const batch = evQ.slice(0, 50);
    if (await sbPost('level_events', batch)) {
      evQ.splice(0, batch.length);
      AsyncStorage.setItem('evq', JSON.stringify(evQ)).catch(() => {});
    }
  } catch (e) {}
  evBusy = false;
}
function queueEvent(e) {
  if (!ONLINE) return;
  evQ.push(e);
  if (evQ.length > 200) evQ.shift();
  AsyncStorage.setItem('evq', JSON.stringify(evQ)).catch(() => {});
  flushEvents();
}
// Scores go through server functions only (validated, one best score per player per day).
async function sbRpc(fn, args) {
  const h = { apikey: SUPABASE_ANON, 'Content-Type': 'application/json' };
  if (SUPABASE_ANON.startsWith('eyJ')) h.Authorization = 'Bearer ' + SUPABASE_ANON;
  return fetchT(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: h, body: JSON.stringify(args) });
}
// The server replays the move log and computes the score itself, so a client can't claim a score.
async function postDaily(p) {
  try {
    const res = await fetchT(`${SUPABASE_URL}/functions/v1/verify-daily`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify(p),
    }, 12000);
    const j = await res.json().catch(() => null);
    if (res.status >= 500 || !j) return null; // transient: keep for retry
    return j; // { ok, score, chain, placed } or { ok:false, error }
  } catch (e) {
    return null; // offline: keep for retry
  }
}
async function submitDaily(p) {
  if (!ONLINE) return null;
  AsyncStorage.setItem('pdaily', JSON.stringify(p)).catch(() => {});
  const r = await postDaily(p);
  if (r) AsyncStorage.removeItem('pdaily').catch(() => {});
  return r;
}
async function resendDaily() {
  if (!ONLINE) return;
  try {
    const raw = await AsyncStorage.getItem('pdaily');
    if (!raw) return;
    const r = await postDaily(JSON.parse(raw));
    if (r) AsyncStorage.removeItem('pdaily').catch(() => {});
  } catch (e) {}
}
async function fetchTopRun(day) {
  if (!ONLINE) return null;
  try {
    const res = await sbRpc('top_run', { p_day: day });
    if (!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) && rows[0] && rows[0].log ? rows[0] : null;
  } catch (e) {
    return null;
  }
}
async function fetchBoard(day) {
  if (!ONLINE) return null;
  try {
    const res = await sbRpc('get_daily_board', { p_day: day, p_pid: PID, p_limit: 40 });
    if (!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) ? rows : null;
  } catch (e) {
    return null;
  }
}
async function loadRemote() {
  try {
    const c = await AsyncStorage.getItem('rcfg');
    if (c) applyRemote(JSON.parse(c));
  } catch (e) {}
  if (!ONLINE) return;
  try {
    const h = { apikey: SUPABASE_ANON };
    if (SUPABASE_ANON.startsWith('eyJ')) h.Authorization = 'Bearer ' + SUPABASE_ANON;
    const [a, b] = await Promise.all([
      fetchT(`${SUPABASE_URL}/rest/v1/chainorb_levels?select=n,cfg&active=eq.true&order=n.asc&limit=200`, { headers: h }),
      fetchT(`${SUPABASE_URL}/rest/v1/chainorb_events?select=id,title,blurb,starts_at,ends_at,cfg&active=eq.true&order=starts_at.asc&limit=20`, { headers: h }),
    ]);
    if (!a.ok || !b.ok) return;
    const raw = { levels: await a.json(), events: await b.json() };
    applyRemote(raw);
    AsyncStorage.setItem('rcfg', JSON.stringify(raw)).catch(() => {});
  } catch (e) {}
}
const EMO = ['⬜', '🟥', '🟩', '🟦', '🟨', '🟪', '⬛', '💣', '🪨', '🌈'];

/* ============================== UI PARTS ============================== */
// drawn position is separate from the logical one: slides in from above, then squashes on landing
function Fall({ dist, cell, children }) {
  const y = useRef(new Animated.Value(-dist * cell)).current;
  const sq = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.sequence([
      Animated.timing(y, { toValue: 0, duration: fallMs(dist), easing: Easing.in(Easing.quad), useNativeDriver: true }),
      Animated.timing(sq, { toValue: 0.82, duration: 45, useNativeDriver: true }),
      Animated.spring(sq, { toValue: 1, friction: 4, tension: 260, useNativeDriver: true }),
    ]).start();
  }, []);
  return (
    <Animated.View style={{ width: cell, height: cell, transform: [{ translateY: y }, { translateY: sq.interpolate({ inputRange: [0.82, 1], outputRange: [cell * 0.09, 0] }) }, { scaleY: sq }, { scaleX: sq.interpolate({ inputRange: [0.82, 1], outputRange: [1.1, 1] }) }] }}>
      {children}
    </Animated.View>
  );
}

function Orb({ color, size, popping, worry, active }) {
  if (!color) return <View style={{ width: size, height: size }} />;
  const sk = color >= 1 && color <= 5 ? SKIN : 'gel';
  const shape = sk === 'gel' && color >= 1 && color <= 5 ? color : 0;
  const gemLike = sk === 'gem' || shape === 4;
  const R = size;
  const radii =
    sk === 'gem' || shape === 4 ? { borderRadius: R * 0.2 }
    : shape === 2 ? { borderRadius: R * 0.3 }
    : shape === 3 ? { borderTopLeftRadius: R * 0.5, borderBottomRightRadius: R * 0.5, borderTopRightRadius: R * 0.12, borderBottomLeftRadius: R * 0.12 }
    : shape === 5 ? { borderTopLeftRadius: R * 0.5, borderTopRightRadius: R * 0.5, borderBottomLeftRadius: R * 0.2, borderBottomRightRadius: R * 0.2 }
    : { borderRadius: R };
  return (
    <View style={{ width: size, height: size, padding: size * 0.06 }}>
      <View
        style={{
          flex: 1,
          ...radii,
          backgroundColor: popping ? '#ffffff' : sk === 'ring' ? 'rgba(10,10,20,0.6)' : color === BOMB ? '#2a1408' : COLORS[color],
          borderWidth: color === BOMB || color === PRISM ? 3 : color === CRACK ? 2 : sk === 'ring' ? size * 0.14 : sk === 'candy' ? 3 : size * 0.05,
          borderColor: color === CRACK ? '#e0e0ff' : color === PRISM ? '#ff3bd4' : sk === 'ring' ? COLORS[color] : sk === 'candy' ? 'rgba(255,255,255,0.75)' : color === BOMB ? '#ff8a3b' : 'rgba(0,0,0,0.35)',
          shadowColor: active ? COLORS[color] : '#000',
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: active ? 1 : 0.5,
          shadowRadius: active ? 14 : 4,
          elevation: active ? 12 : 5,
          transform: [{ scale: popping ? 1.2 : 1 }, ...(gemLike ? [{ rotate: '45deg' }, { scale: 0.78 }] : [])],
          alignItems: 'center',
        }}
      >
        <View
          style={{
            position: 'absolute',
            bottom: size * 0.07,
            left: size * 0.12,
            right: size * 0.12,
            height: size * 0.3,
            borderRadius: size,
            backgroundColor: 'rgba(0,0,0,0.14)',
          }}
        />
        <View
          style={{
            position: 'absolute',
            top: size * 0.08,
            left: size * 0.16,
            width: size * 0.38,
            height: size * 0.18,
            borderRadius: size,
            backgroundColor: 'rgba(255,255,255,0.85)',
            transform: [{ rotate: '-20deg' }],
          }}
        />
        <View
          style={{
            position: 'absolute',
            bottom: size * 0.14,
            right: size * 0.16,
            width: size * 0.14,
            height: size * 0.08,
            borderRadius: size,
            backgroundColor: 'rgba(255,255,255,0.28)',
            transform: [{ rotate: '-20deg' }],
          }}
        />
        <View
          style={{
            position: 'absolute',
            top: size * 0.06,
            left: size * 0.06,
            right: size * 0.06,
            bottom: size * 0.06,
            borderRadius: size,
            borderWidth: size * 0.07,
            borderColor: 'rgba(0,0,0,0.12)',
          }}
        />
        {color >= 1 && color <= 5 && !gemLike && (
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
        {popping && color >= 1 && color <= 5 && !gemLike && (
          <View style={{ position: 'absolute', top: size * 0.5, width: size * 0.3, height: size * 0.16, borderBottomLeftRadius: size, borderBottomRightRadius: size, borderWidth: size * 0.04, borderTopWidth: 0, borderColor: '#14142a', backgroundColor: 'rgba(255,120,140,0.9)' }} />
        )}
        {color >= 1 && color <= 5 && (
          <Text
            style={{
              position: 'absolute',
              top: gemLike ? size * 0.3 : size * 0.62,
              fontSize: size * 0.26,
              fontWeight: '900',
              includeFontPadding: false,
              color: sk === 'ring' ? COLORS[color] : 'rgba(20,20,42,0.6)',
              transform: gemLike ? [{ rotate: '-45deg' }] : [],
            }}
          >
            {GLYPHS[color]}
          </Text>
        )}
      </View>
    </View>
  );
}


/* ============================== SKIA BOARD ============================== */
// render-only: reads G and draws the playfield on one GPU canvas. never touches the engine.
const USE_SKIA = true; // false = the old per-cell View renderer (kept for side-by-side comparison)

const _pathCache = new Map();
function _rr(x, y, w, h, tl, tr, br, bl) {
  const f = Math.min(1, w / (tl + tr || 1), w / (bl + br || 1), h / (tl + bl || 1), h / (tr + br || 1));
  tl *= f; tr *= f; br *= f; bl *= f;
  const arc = (r, ex, ey) => (r > 0.01 ? `A${r} ${r} 0 0 1 ${ex} ${ey}` : `L${ex} ${ey}`);
  return (
    `M${x + tl} ${y}H${x + w - tr}${arc(tr, x + w, y + tr)}V${y + h - br}${arc(br, x + w - br, y + h)}` +
    `H${x + bl}${arc(bl, x, y + h - bl)}V${y + tl}${arc(tl, x + tl, y)}Z`
  );
}
function rrPath(x, y, w, h, rad) {
  const key = [x, y, w, h, ...rad].map((n) => Math.round(n * 100)).join('|');
  let p = _pathCache.get(key);
  if (!p) {
    p = Skia.Path.MakeFromSVGString(_rr(x, y, w, h, rad[0], rad[1], rad[2], rad[3]));
    _pathCache.set(key, p);
  }
  return p;
}
function svgPath(d) {
  let p = _pathCache.get(d);
  if (!p) {
    p = Skia.Path.MakeFromSVGString(d);
    _pathCache.set(d, p);
  }
  return p;
}
// unit-size glyph shapes for the colour-blind markers, centred on 0,0
const STAR_D = (() => {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 ? 0.2 : 0.5;
    pts.push(`${(Math.cos(a) * r).toFixed(3)} ${(Math.sin(a) * r).toFixed(3)}`);
  }
  return 'M' + pts.join('L') + 'Z';
})();
const GLYPH_D = [null, null, 'M0 -0.5L0.5 0.42L-0.5 0.42Z', 'M-0.42 -0.42H0.42V0.42H-0.42Z', 'M0 -0.55L0.5 0L0 0.55L-0.5 0Z', STAR_D];

/* ---- v19 colour helpers (render-only) ---- */
const _rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const _mix = (h, t, to) => `rgb(${_rgb(h).map((v) => Math.round(v + (to - v) * t)).join(',')})`;
const lighten = (h, t) => _mix(h, t, 255);
const darken = (h, t) => _mix(h, t, 0);
const rgba = (h, a) => `rgba(${_rgb(h).join(',')},${a})`;
const GOLD = ['#fff3bf', '#f6cf74', '#d9a13f', '#8f5a16'];

// one orb, drawn in its own 0..size box at (x, y). v19: gradient body, rim light, aura, sparkle eyes.
const OrbSk = React.memo(function OrbSk({ color, size, x, y, popping, worry, active, sk }) {
  const s = size;
  const shape = sk === 'gel' && color >= 1 && color <= 5 ? color : 0;
  const gemLike = sk === 'gem' || shape === 4;
  const nice = color >= 1 && color <= 5;
  const base = COLORS[color] || '#ffffff';
  const pad = s * 0.06;
  const bw = color === BOMB || color === PRISM ? 3 : color === CRACK ? 2 : sk === 'ring' ? s * 0.14 : sk === 'candy' ? 3 : s * 0.06;
  const w = s - pad * 2;
  const rad =
    gemLike ? [s * 0.2, s * 0.2, s * 0.2, s * 0.2]
    : shape === 2 ? [s * 0.3, s * 0.3, s * 0.3, s * 0.3]
    : shape === 3 ? [s * 0.5, s * 0.12, s * 0.5, s * 0.12]
    : shape === 5 ? [s * 0.5, s * 0.5, s * 0.2, s * 0.2]
    : [s, s, s, s];
  const useGrad = !popping && sk !== 'ring' && color !== BOMB;
  const fill = popping ? '#ffffff' : sk === 'ring' ? 'rgba(10,10,20,0.6)' : color === BOMB ? '#2a1408' : base;
  const edge =
    color === CRACK ? '#e0e0ff' : color === PRISM ? '#ff3bd4' : sk === 'ring' ? base
    : sk === 'candy' ? 'rgba(255,255,255,0.75)' : color === BOMB ? '#ff8a3b' : color === ZAP ? '#fff3a0' : nice ? darken(base, 0.55) : 'rgba(0,0,0,0.5)';
  const body = rrPath(pad, pad, w, w, rad);
  const ring = rrPath(pad + bw / 2, pad + bw / 2, w - bw, w - bw, rad.map((r) => Math.max(0, r - bw / 2)));
  const ox = pad + bw;
  const iw = s - 2 * pad - 2 * bw;
  const face = nice && !gemLike;
  const ew = s * (worry ? 0.2 : 0.14);
  const eh = s * (popping ? 0.04 : worry ? 0.22 : 0.18);
  const rowW = 2 * (ew + s * 0.12);
  const ex = ox + (iw - rowW) / 2 + s * 0.06;
  const ey = ox + s * 0.36;
  const mw = s * 0.3;
  const mh = s * 0.16;
  const mx = ox + (iw - mw) / 2;
  const my = ox + s * 0.52;
  const gy = ox + (gemLike ? s * 0.3 : s * 0.62) + s * 0.13;
  const gs = s * 0.26;
  const gcol = sk === 'ring' ? base : 'rgba(20,20,42,0.78)';
  const tf = [{ scale: popping ? 1.2 : 1 }, ...(gemLike ? [{ rotate: Math.PI / 4 }, { scale: 0.78 }] : [])];
  const showGlyph = nice && sk !== 'gel'; // gel skin already differs by shape
  return (
    <Group transform={[{ translateX: x }, { translateY: y }]}>
      {active && nice && !popping && (
        <Circle cx={s / 2} cy={s / 2} r={s * 0.82}>
          <RadialGradient c={vec(s / 2, s / 2)} r={s * 0.82} colors={[rgba(base, 0.62), rgba(base, 0)]} positions={[0.4, 1]} />
        </Circle>
      )}
      <Group transform={tf} origin={{ x: s / 2, y: s / 2 }}>
        <Path path={body} color={useGrad ? undefined : fill}>
          {useGrad && (
            <RadialGradient c={vec(s * 0.38, s * 0.3)} r={s * 0.82} colors={[lighten(base, 0.52), base, darken(base, 0.4)]} positions={[0, 0.5, 1]} />
          )}
          <Shadow dx={0} dy={2} blur={active ? 5 : 2} color={active ? rgba(base, 0.9) : 'rgba(0,0,0,0.5)'} />
        </Path>
        <Path path={ring} style="stroke" strokeWidth={bw} color={edge} />
        {nice && !popping && (
          <Path path={rrPath(ox + s * 0.02, ox + s * 0.02, iw - s * 0.04, iw - s * 0.04, rad.map((r) => Math.max(0, r - ox * 0.5)))} style="stroke" strokeWidth={s * 0.03} color="rgba(255,255,255,0.34)" />
        )}
        <RoundedRect x={ox + s * 0.12} y={ox + iw - s * 0.07 - s * 0.3} width={iw - s * 0.24} height={s * 0.3} r={s * 0.15} color="rgba(0,0,0,0.12)" />
        <Group transform={[{ rotate: -Math.PI / 9 }]} origin={{ x: ox + s * 0.16 + s * 0.19, y: ox + s * 0.08 + s * 0.09 }}>
          <RoundedRect x={ox + s * 0.16} y={ox + s * 0.08} width={s * 0.38} height={s * 0.18} r={s * 0.09} color="rgba(255,255,255,0.88)" />
        </Group>
        <Group transform={[{ rotate: -Math.PI / 9 }]} origin={{ x: ox + iw - s * 0.16 - s * 0.07, y: ox + iw - s * 0.14 - s * 0.04 }}>
          <RoundedRect x={ox + iw - s * 0.16 - s * 0.14} y={ox + iw - s * 0.14 - s * 0.08} width={s * 0.14} height={s * 0.08} r={s * 0.04} color="rgba(255,255,255,0.28)" />
        </Group>
        {shape === 3 && !popping && (
          <Path path={svgPath(`M${ox + iw * 0.3} ${ox + iw * 0.7}Q${ox + iw * 0.5} ${ox + iw * 0.4} ${ox + iw * 0.76} ${ox + iw * 0.2}`)} style="stroke" strokeWidth={s * 0.03} strokeCap="round" color="rgba(255,255,255,0.5)" />
        )}
        {face && (
          <>
            <Oval x={ex} y={ey} width={ew} height={eh} color="#1a1030" />
            <Oval x={ex + ew + s * 0.12} y={ey} width={ew} height={eh} color="#1a1030" />
          </>
        )}
        {face && !popping && (
          <>
            <Circle cx={ex + ew * 0.68} cy={ey + eh * 0.3} r={s * 0.034} color="rgba(255,255,255,0.98)" />
            <Circle cx={ex + ew * 0.3} cy={ey + eh * 0.72} r={s * 0.016} color="rgba(255,255,255,0.85)" />
            <Circle cx={ex + ew + s * 0.12 + ew * 0.68} cy={ey + eh * 0.3} r={s * 0.034} color="rgba(255,255,255,0.98)" />
            <Circle cx={ex + ew + s * 0.12 + ew * 0.3} cy={ey + eh * 0.72} r={s * 0.016} color="rgba(255,255,255,0.85)" />
            <Circle cx={ex - s * 0.04} cy={ey + eh + s * 0.05} r={s * 0.06} color="rgba(255,110,170,0.5)" />
            <Circle cx={ex + 2 * ew + s * 0.12 + s * 0.04} cy={ey + eh + s * 0.05} r={s * 0.06} color="rgba(255,110,170,0.5)" />
            {!worry && <Path path={svgPath(`M${ox + iw / 2 - s * 0.09} ${ey + eh + s * 0.06}Q${ox + iw / 2} ${ey + eh + s * 0.17} ${ox + iw / 2 + s * 0.09} ${ey + eh + s * 0.06}`)} style="stroke" strokeWidth={s * 0.035} strokeCap="round" color="#1a1030" />}
          </>
        )}
        {face && popping && (
          <>
            <Path path={svgPath(`M${mx} ${my}L${mx + mw} ${my}A${mw / 2} ${mh} 0 0 1 ${mx} ${my}Z`)} color="rgba(255,120,140,0.9)" />
            <Path path={svgPath(`M${mx} ${my}A${mw / 2} ${mh} 0 0 0 ${mx + mw} ${my}`)} style="stroke" strokeWidth={s * 0.04} color="#14142a" />
          </>
        )}
        {color === ZAP && !popping && (
          <Group transform={[{ translateX: ox + iw / 2 }, { translateY: ox + iw / 2 }, { scale: iw }]}>
            <Path path={svgPath('M0.08 -0.5L-0.3 0.06L-0.04 0.06L-0.12 0.5L0.3 -0.1L0.04 -0.1Z')} color="#7a3a00" />
            <Path path={svgPath('M0.08 -0.5L-0.3 0.06L-0.04 0.06L-0.12 0.5L0.3 -0.1L0.04 -0.1Z')} style="stroke" strokeWidth={0.035} strokeJoin="round" color="#fff3a0" />
          </Group>
        )}
        {showGlyph && (
          <Group transform={[{ translateX: ox + iw / 2 }, { translateY: gy }, ...(gemLike ? [{ rotate: -Math.PI / 4 }] : []), { scale: gs }]}>
            {color === 1 ? <Circle cx={0} cy={0} r={0.45} color={gcol} /> : <Path path={svgPath(GLYPH_D[color])} color={gcol} />}
          </Group>
        )}
      </Group>
    </Group>
  );
});

// slide-in + landing squash for one orb. progress comes from one shared clock (ms), so the UI thread does the work
function FallCell({ dist, cell, x, y, clock, children }) {
  const slide = fallMs(dist);
  const tf = useDerivedValue(() => {
    'worklet';
    const ms = clock.value;
    const u = Math.min(1, ms / slide);
    let sy = 1;
    if (ms > slide) {
      const t2 = ms - slide;
      sy = t2 < 45 ? 1 - 0.18 * (t2 / 45) : 1 - 0.18 * Math.exp(-(t2 - 45) / 70) * Math.cos((t2 - 45) / 45);
    }
    return [{ translateY: -dist * cell * (1 - u * u) }, { scaleX: 1 + (1 - sy) * 0.55 }, { scaleY: sy }];
  });
  return (
    <Group transform={tf} origin={{ x: x + cell / 2, y: y + cell }}>
      {children}
    </Group>
  );
}

function ParticleLayer({ items, burst, cell }) {
  const pts = useDerivedValue(() => {
    'worklet';
    const b = burst.value;
    return items.map((p) => ({ x: p.x + p.dx * b, y: p.y + p.dy * b }));
  });
  const sw = useDerivedValue(() => {
    'worklet';
    return Math.max(0.5, cell * 0.2 * (1 - 0.7 * burst.value));
  });
  return <Points points={pts} mode="points" style="stroke" strokeWidth={sw} strokeCap="round" color={items[0].color} />;
}

function BoardCanvas({ board, cell, skin, popping, fall, fallId, rings, glow, danger, playing, accent, sv, hide, landKeys, landId }) {
  const W = cell * COLS + 2;
  const H = cell * ROWS + 2;
  const { float, burst, flash, fall: fallClock, land: landClock } = sv;
  const wob = useDerivedValue(() => {
    'worklet';
    return [{ translateY: cell * 0.02 * float.value }, { scaleY: 1 - 0.03 * float.value }];
  });
  const glowOp = useDerivedValue(() => {
    'worklet';
    return 0.1 + 0.12 * float.value;
  });
  const dangerOp = useDerivedValue(() => {
    'worklet';
    return 0.15 + 0.65 * float.value;
  });
  const partOp = useDerivedValue(() => {
    'worklet';
    return interpolate(burst.value, [0, 0.7, 1], [1, 0.9, 0]);
  });
  const ringOp = useDerivedValue(() => {
    'worklet';
    return interpolate(burst.value, [0, 1], [0.9, 0]);
  });
  const ringT = useDerivedValue(() => {
    'worklet';
    return [{ scale: 1 + 1.2 * burst.value }];
  });
  const dotA = useDerivedValue(() => {
    'worklet';
    return 0.08 + 0.14 * float.value;
  });
  const dotB = useDerivedValue(() => {
    'worklet';
    return 0.18 - 0.12 * float.value;
  });
  const dotAT = useDerivedValue(() => {
    'worklet';
    return [{ translateY: -18 * float.value }];
  });
  const dotBT = useDerivedValue(() => {
    'worklet';
    return [{ translateY: 14 * float.value }];
  });

  // particles: 5 per popped orb (first 16), grouped by colour so each colour is one animated Points node
  const parts = useMemo(() => {
    const byCol = new Map();
    rings.slice(0, 16).forEach((o) => {
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + (o.r * 7 + o.c * 3) * 0.5;
        const d = cell * (0.9 + (i % 2) * 0.35);
        const item = { x: o.c * cell + cell / 2, y: o.r * cell + cell / 2, dx: Math.cos(a) * d, dy: Math.sin(a) * d + cell * 0.3, color: COLORS[o.col] };
        if (!byCol.has(o.col)) byCol.set(o.col, []);
        byCol.get(o.col).push(item);
      }
    });
    return [...byCol.entries()];
  }, [rings, cell]);

  const dots = (even) =>
    [0, 1, 2, 3, 4, 5]
      .filter((i) => (i % 2 === 0) === even)
      .map((i) => ({ x: (W * (12 + i * 15)) / 100, y: (H * (10 + ((i * 37) % 70))) / 100 }));

  return (
    <Canvas pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, width: W, height: H }}>
      <Group transform={[{ translateX: 2 }, { translateY: 2 }]}>
        {board.map((row, r) =>
          row.map((col, c) => {
            if (!col) return null;
            const k = r * COLS + c;
            if (hide && hide.has(k)) return null;
            const x = c * cell;
            const y = r * cell;
            const pop = popping.has(k);
            const orb = <OrbSk color={col} size={cell} x={x} y={y} popping={pop} worry={danger} sk={col >= 1 && col <= 5 ? skin : 'gel'} />;
            const fd = fall ? fall.get(k) : 0;
            if (fd) {
              return (
                <FallCell key={`f${k}-${fallId}`} dist={fd} cell={cell} x={x} y={y} clock={fallClock}>
                  {orb}
                </FallCell>
              );
            }
            if (pop) return <Group key={k}>{orb}</Group>;
            if (landKeys && landKeys.has(k)) {
              return (
                <LandCell key={`l${k}-${landId}`} cell={cell} x={x} y={y} clock={landClock}>
                  {orb}
                </LandCell>
              );
            }
            return (
              <Group key={k} transform={wob} origin={{ x: x + cell / 2, y: y + cell / 2 }}>
                {orb}
              </Group>
            );
          })
        )}
      </Group>

      {Array.from({ length: ROWS - 1 }, (_, i) => (
        <Rect key={`hr${i}`} x={2} y={2 + (i + 1) * cell} width={W - 4} height={1} color="rgba(255,150,230,0.26)" />
      ))}
      {Array.from({ length: COLS - 1 }, (_, i) => (
        <Rect key={`vc${i}`} x={2 + (i + 1) * cell} y={2} width={1} height={H - 4} color="rgba(255,150,230,0.26)" />
      ))}
      <Rect x={1.5} y={2} width={1.5} height={H - 4} color="rgba(255,170,235,0.5)" />
      <Rect x={W - 3} y={2} width={1.5} height={H - 4} color="rgba(255,170,235,0.5)" />
      <Rect x={2} y={H - 3} width={W - 4} height={1.5} color="rgba(255,170,235,0.5)" />

      <Group opacity={glowOp}>
        {[...glow].map((k) => {
          const gr = Math.floor(k / COLS);
          const gc = k % COLS;
          if (popping.has(k) || !board[gr][gc]) return null;
          return <Circle key={`gl${k}`} cx={2 + gc * cell + cell / 2} cy={2 + gr * cell + cell / 2} r={cell * 0.42} color={COLORS[board[gr][gc]]} />;
        })}
      </Group>

      <RoundedRect x={0} y={0} width={W} height={H} r={10} color={accent} opacity={flash} />

      {danger && playing && (
        <RoundedRect x={1.5} y={1.5} width={W - 3} height={H - 3} r={10} style="stroke" strokeWidth={3} color="#ff3b6b" opacity={dangerOp} />
      )}

      <Group transform={[{ translateX: 2 }, { translateY: 2 }]} opacity={partOp}>
        {parts.map(([col, items]) => (
          <ParticleLayer key={col} items={items} burst={burst} cell={cell} />
        ))}
      </Group>

      <Group opacity={ringOp}>
        {rings.map((o) => (
          <Group key={`${o.r}-${o.c}`} transform={ringT} origin={{ x: 2 + o.c * cell + cell / 2, y: 2 + o.r * cell + cell / 2 }}>
            <Circle cx={2 + o.c * cell + cell / 2} cy={2 + o.r * cell + cell / 2} r={cell / 2 - 1.5} style="stroke" strokeWidth={3} color={COLORS[o.col]} />
          </Group>
        ))}
      </Group>

      {playing && (
        <>
          <Group opacity={dotA} transform={dotAT}>
            <Points points={dots(true)} mode="points" style="stroke" strokeWidth={3} strokeCap="round" color={accent} />
          </Group>
          <Group opacity={dotB} transform={dotBT}>
            <Points points={dots(false)} mode="points" style="stroke" strokeWidth={3} strokeCap="round" color={accent} />
          </Group>
        </>
      )}
    </Canvas>
  );
}

/* ============================== V19 ART (Skia, render-only) ============================== */
// Everything below is drawn in "mockup units" (the 768-wide concept art) and scaled by s = width / 768.

function Gem({ cx, cy, r, c }) {
  const d = `M${cx} ${cy - r}L${cx + r * 0.85} ${cy}L${cx} ${cy + r}L${cx - r * 0.85} ${cy}Z`;
  return (
    <Group>
      <Path path={svgPath(d)}>
        <LinearGradient start={vec(cx - r, cy - r)} end={vec(cx + r, cy + r)} colors={[lighten(c, 0.7), c, darken(c, 0.45)]} />
      </Path>
      <Path path={svgPath(d)} style="stroke" strokeWidth={r * 0.14} color="rgba(255,255,255,0.55)" />
      <Path path={svgPath(`M${cx - r * 0.1} ${cy - r * 0.8}L${cx + r * 0.45} ${cy - r * 0.1}L${cx} ${cy - r * 0.1}Z`)} color="rgba(255,255,255,0.7)" />
    </Group>
  );
}

// gold-framed plate (pill by default). fill = 3 gradient colours, top to bottom
function Plate({ x, y, w, h, fill, bw = 5, r }) {
  const rr = r == null ? h / 2 : r;
  const ir = Math.max(2, rr - bw);
  return (
    <>
      <RoundedRect x={x} y={y + 3} width={w} height={h} r={rr} color="rgba(0,0,0,0.38)" />
      <RoundedRect x={x} y={y} width={w} height={h} r={rr}>
        <LinearGradient start={vec(x, y)} end={vec(x, y + h)} colors={GOLD} />
      </RoundedRect>
      <RoundedRect x={x + bw} y={y + bw} width={w - bw * 2} height={h - bw * 2} r={ir}>
        <LinearGradient start={vec(x, y + bw)} end={vec(x, y + h - bw)} colors={fill} />
      </RoundedRect>
      <RoundedRect x={x + bw + 5} y={y + bw + 3} width={w - bw * 2 - 10} height={(h - bw * 2) * 0.36} r={ir * 0.6} color="rgba(255,255,255,0.20)" />
    </>
  );
}

// round gold-ringed sphere: ring radius R, body gradient colours (light to dark)
function Sphere({ cx, cy, R, body, ring = GOLD, ringW = 0.13 }) {
  const rb = R * (1 - ringW);
  return (
    <>
      <Circle cx={cx} cy={cy + R * 0.06} r={R} color="rgba(0,0,0,0.4)" />
      <Circle cx={cx} cy={cy} r={R}>
        <LinearGradient start={vec(cx - R, cy - R)} end={vec(cx + R, cy + R)} colors={ring} />
      </Circle>
      <Circle cx={cx} cy={cy} r={rb}>
        <RadialGradient c={vec(cx - rb * 0.3, cy - rb * 0.38)} r={rb * 1.35} colors={body} />
      </Circle>
      <Oval x={cx - rb * 0.62} y={cy - rb * 0.9} width={rb * 1.24} height={rb * 0.7} color="rgba(255,255,255,0.28)" />
      <Circle cx={cx - rb * 0.42} cy={cy - rb * 0.58} r={rb * 0.09} color="rgba(255,255,255,0.85)" />
    </>
  );
}

const SPARK_D = 'M0 -1Q0.14 -0.14 1 0Q0.14 0.14 0 1Q-0.14 0.14 -1 0Q-0.14 -0.14 0 -1Z';
const gearD = (R1, R2, n) => {
  const pts = [];
  for (let i = 0; i < n * 4; i++) {
    const a = (i / (n * 4)) * Math.PI * 2 - Math.PI / (n * 4);
    const k = i % 4 === 0 || i % 4 === 1 ? R2 : R1;
    pts.push(`${(Math.cos(a) * k).toFixed(2)} ${(Math.sin(a) * k).toFixed(2)}`);
  }
  return 'M' + pts.join('L') + 'Z';
};
const GEAR_D = gearD(11, 15, 8);
// circular arrow: arc + arrowhead, radius r, clockwise
function rotArrow(r) {
  const a0 = (-125 * Math.PI) / 180;
  const a1 = (140 * Math.PI) / 180;
  const sx = r * Math.cos(a0), sy = r * Math.sin(a0);
  const ex = r * Math.cos(a1), ey = r * Math.sin(a1);
  const tx = -Math.sin(a1), ty = Math.cos(a1); // clockwise tangent
  const nx = Math.cos(a1), ny = Math.sin(a1);
  const hx = ex + tx * r * 0.5, hy = ey + ty * r * 0.5;
  return {
    arc: `M${sx.toFixed(2)} ${sy.toFixed(2)}A${r} ${r} 0 1 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`,
    head: `M${hx.toFixed(2)} ${hy.toFixed(2)}L${(ex + nx * r * 0.42 - tx * r * 0.1).toFixed(2)} ${(ey + ny * r * 0.42 - ty * r * 0.1).toFixed(2)}L${(ex - nx * r * 0.42 - tx * r * 0.1).toFixed(2)} ${(ey - ny * r * 0.42 - ty * r * 0.1).toFixed(2)}Z`,
  };
}
const ROT_ARROW = rotArrow(16);

/* ---------- HUD ---------- */
const HudArt = React.memo(function HudArt({ w, h, goal, fever, feverOn, muted }) {
  const s = w / 768;
  const g = Math.max(0, Math.min(1, goal));
  const f = feverOn ? 1 : Math.max(0, Math.min(1, fever));
  return (
    <Canvas pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, width: w, height: h }}>
      <Group transform={[{ scale: s }]}>
        {/* level medallion */}
        <Circle cx={70} cy={87} r={78}>
          <RadialGradient c={vec(70, 87)} r={78} colors={['rgba(255,200,90,0.35)', 'rgba(255,200,90,0)']} positions={[0.6, 1]} />
        </Circle>
        <Circle cx={70} cy={90} r={62} color="rgba(0,0,0,0.4)" />
        <Circle cx={70} cy={87} r={62}>
          <LinearGradient start={vec(20, 30)} end={vec(120, 145)} colors={GOLD} />
        </Circle>
        <Circle cx={70} cy={87} r={50} color="#5b3510" />
        <Circle cx={70} cy={87} r={47}>
          <RadialGradient c={vec(60, 72)} r={62} colors={['#7a4aa8', '#3a1d62', '#22103f']} positions={[0, 0.6, 1]} />
        </Circle>
        <Circle cx={70} cy={87} r={47} style="stroke" strokeWidth={2} color="rgba(255,230,160,0.55)" />
        <Gem cx={70} cy={26} r={13} c="#4fe3ff" />
        <Gem cx={9} cy={87} r={11} c="#ff5cc8" />
        <Gem cx={131} cy={87} r={11} c="#ff5cc8" />
        <Gem cx={70} cy={148} r={11} c="#ff5cc8" />
        {/* goal bar */}
        <Plate x={132} y={44} w={198} h={48} fill={['#27408f', '#16286a', '#0e1a4c']} />
        <Group clip={rrPath(137, 49, 188, 38, [19, 19, 19, 19])}>
          {g > 0 && (
            <Rect x={137} y={49} width={188 * g} height={38}>
              <LinearGradient start={vec(0, 49)} end={vec(0, 87)} colors={['#9ff3ff', '#35b6ff', '#1f7ae0']} />
            </Rect>
          )}
        </Group>
        <RoundedRect x={142} y={52} width={178} height={11} r={5.5} color="rgba(255,255,255,0.16)" />
        <Gem cx={141} cy={68} r={11} c="#ff5cc8" />
        <Gem cx={321} cy={68} r={11} c="#ff5cc8" />
        {/* fever bar */}
        <Plate x={132} y={104} w={198} h={48} fill={['#e0932f', '#b8651b', '#7d3f0e']} />
        <Group clip={rrPath(137, 109, 188, 38, [19, 19, 19, 19])}>
          {f > 0 && (
            <Rect x={137} y={109} width={188 * f} height={38}>
              <LinearGradient start={vec(0, 109)} end={vec(0, 147)} colors={['#fff4a8', '#ffc23a', '#ff8a1f']} />
            </Rect>
          )}
        </Group>
        <RoundedRect x={142} y={112} width={178} height={11} r={5.5} color="rgba(255,255,255,0.2)" />
        {feverOn && <RoundedRect x={130} y={102} width={202} height={52} r={26} style="stroke" strokeWidth={3} color="rgba(255,236,120,0.95)" />}
        <Gem cx={141} cy={128} r={11} c="#ff9a3b" />
        <Gem cx={321} cy={128} r={11} c="#ff9a3b" />
        {/* score */}
        <Plate x={606} y={40} w={156} h={52} fill={['#7a4228', '#4c2515', '#331509']} />
        {/* gems + stars */}
        <Plate x={428} y={104} w={90} h={50} fill={['#d443b5', '#9b2a9e', '#5e1a78']} bw={4} />
        <Gem cx={457} cy={129} r={15} c="#3fd8ff" />
        <Plate x={526} y={104} w={90} h={50} fill={['#8a5fe0', '#5f3cb8', '#3a2290']} bw={4} />
        <Group transform={[{ translateX: 556 }, { translateY: 130 }, { scale: 34 }]}>
          <Path path={svgPath(STAR_D)} color="#ffd23b" />
          <Path path={svgPath(STAR_D)} style="stroke" strokeWidth={0.05} color="#fff3bf" />
        </Group>
        {/* pause + sound */}
        <Sphere cx={651} cy={129} R={30} body={['#d9a05a', '#a8672a', '#5e3412']} />
        <Group transform={[{ translateX: 651 }, { translateY: 129 }]}>
          <RoundedRect x={-11} y={-13} width={8} height={26} r={3} color="#fff1cf" />
          <RoundedRect x={3} y={-13} width={8} height={26} r={3} color="#fff1cf" />
        </Group>
        <Sphere cx={722} cy={129} R={30} body={['#c99a58', '#8f5f28', '#4e2c10']} />
        <Group transform={[{ translateX: 722 }, { translateY: 129 }]}>
          <Path path={svgPath('M-14 -6H-6L4 -14V14L-6 6H-14Z')} color="#fff1cf" />
          {muted ? (
            <Path path={svgPath('M10 -8L22 8M22 -8L10 8')} style="stroke" strokeWidth={3.5} strokeCap="round" color="#ff8a8a" />
          ) : (
            <>
              <Path path={svgPath('M9 -7A10 10 0 0 1 9 7')} style="stroke" strokeWidth={3} strokeCap="round" color="#fff1cf" />
              <Path path={svgPath('M14 -13A18 18 0 0 1 14 13')} style="stroke" strokeWidth={3} strokeCap="round" color="rgba(255,241,207,0.75)" />
            </>
          )}
        </Group>
      </Group>
    </Canvas>
  );
});

/* ---------- NEXT capsule (frosted ice, icicles) ---------- */
const NEXT_ICICLES = [[22, 32], [38, 22], [53, 40], [68, 25], [82, 30]];
const NextArt = React.memo(function NextArt({ s, orbs, skin }) {
  const cw = Math.round(100 * s);
  const ch = Math.round(312 * s);
  const slots = [[50, 100, 56], [50, 160, 56], [50, 218, 46]];
  return (
    <Canvas pointerEvents="none" style={{ width: cw, height: ch }}>
      <Group transform={[{ scale: s }]}>
        <RoundedRect x={0} y={0} width={100} height={284} r={48} style="stroke" strokeWidth={10} color="rgba(150,225,255,0.22)" />
        <RoundedRect x={5} y={4} width={90} height={276} r={44}>
          <LinearGradient start={vec(5, 4)} end={vec(95, 280)} colors={['rgba(210,243,255,0.85)', 'rgba(130,195,255,0.6)', 'rgba(80,140,235,0.55)']} />
        </RoundedRect>
        <RoundedRect x={12} y={44} width={76} height={228} r={36}>
          <LinearGradient start={vec(0, 44)} end={vec(0, 272)} colors={['rgba(26,60,140,0.55)', 'rgba(18,36,106,0.45)']} />
        </RoundedRect>
        <RoundedRect x={5} y={4} width={90} height={276} r={44} style="stroke" strokeWidth={3.5}>
          <LinearGradient start={vec(5, 4)} end={vec(95, 280)} colors={['#ffffff', '#8fd6ff', '#e6f7ff']} />
        </RoundedRect>
        <RoundedRect x={14} y={10} width={26} height={120} r={13} color="rgba(255,255,255,0.14)" />
        {NEXT_ICICLES.map(([cx, len], i) => (
          <Path key={i} path={svgPath(`M${cx - 8} 270L${cx} ${272 + len}L${cx + 8} 270Z`)}>
            <LinearGradient start={vec(cx, 270)} end={vec(cx, 272 + len)} colors={['rgba(190,235,255,0.9)', 'rgba(255,255,255,0.55)']} />
          </Path>
        ))}
      </Group>
      {slots.map(([cx, cy, sz], i) =>
        orbs[i] ? <OrbSk key={i} color={orbs[i]} size={sz * s} x={(cx - sz / 2) * s} y={(cy - sz / 2) * s} sk={orbs[i] >= 1 && orbs[i] <= 5 ? skin : 'gel'} /> : null
      )}
    </Canvas>
  );
});

/* ---------- controls ---------- */
// press: shared value 0..1. returns a derived squish transform about (cx, cy)
function usePressT(press, cx, cy) {
  return useDerivedValue(() => {
    'worklet';
    const k = 1 - 0.07 * press.value;
    return [{ translateX: cx * (1 - k) }, { translateY: cy * (1 - k) + 2 * press.value }, { scale: k }];
  });
}
function usePressOp(press, max) {
  return useDerivedValue(() => {
    'worklet';
    return max * press.value;
  });
}

// action cluster, 120x120 mockup units: UNDO only (d-pad, TURN and DROP removed: the whole screen is the control)
const ACT = { undo: [60, 58, 49] };
const ActArt = React.memo(function ActArt({ size, pUndo }) {
  const k = size / 120;
  const [ux, uy, ur] = ACT.undo;
  const tU = usePressT(pUndo, ux, uy);
  const gU = usePressOp(pUndo, 0.4);
  return (
    <Canvas pointerEvents="none" style={{ width: size, height: size }}>
      <Group transform={[{ scale: k }]}>
        <Group transform={tU}>
          <Sphere cx={ux} cy={uy} R={ur} body={['#e0b27a', '#a56a3e', '#5e3522']} />
          <Group transform={[{ translateX: ux }, { translateY: uy + 2 }, { scaleX: -1 }]}>
            <Path path={svgPath(ROT_ARROW.arc)} style="stroke" strokeWidth={5} strokeCap="round" color="#fff1cf" />
            <Path path={svgPath(ROT_ARROW.head)} color="#fff1cf" />
          </Group>
          <Circle cx={ux} cy={uy} r={ur * 0.87} color="#ffffff" opacity={gU} />
        </Group>
      </Group>
    </Canvas>
  );
});

/* ---------- coach text sparkles ---------- */
const SPARKS = [[0.06, 0.22, 11], [0.22, 0.02, 7], [0.93, 0.08, 12], [0.8, 0.9, 9], [0.12, 0.88, 8], [0.52, 0.0, 6], [0.98, 0.55, 7]];
const Sparkles = React.memo(function Sparkles({ w, h, tw }) {
  const a = useDerivedValue(() => {
    'worklet';
    return 0.35 + 0.65 * tw.value;
  });
  const b = useDerivedValue(() => {
    'worklet';
    return 1 - 0.65 * tw.value;
  });
  return (
    <Canvas pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, width: w, height: h }}>
      {SPARKS.map(([fx, fy, sz], i) => (
        <Group key={i} opacity={i % 2 ? a : b} transform={[{ translateX: fx * w }, { translateY: fy * h }, { scale: sz }]}>
          <Path path={svgPath(SPARK_D)} color="#fff3c4" />
        </Group>
      ))}
    </Canvas>
  );
});

/* ---------- smooth piece layer: every pixel of motion runs on the UI thread ---------- */
const PieceLayer = React.memo(function PieceLayer({ a, b, cell, W, H, danger, skin, pv }) {
  const pad = cell;
  const { x, y, r, gx, gy, gr } = pv;
  const tA = useDerivedValue(() => {
    'worklet';
    return [{ translateX: x.value }, { translateY: y.value }];
  });
  const tB = useDerivedValue(() => {
    'worklet';
    return [{ translateX: x.value + cell * Math.sin(r.value) }, { translateY: y.value - cell * Math.cos(r.value) }];
  });
  const gA = useDerivedValue(() => {
    'worklet';
    return [{ translateX: gx.value }, { translateY: gy.value }];
  });
  const gB = useDerivedValue(() => {
    'worklet';
    return [{ translateX: gx.value + cell * Math.sin(gr.value) }, { translateY: gy.value - cell * Math.cos(gr.value) }];
  });
  const gOp = useDerivedValue(() => {
    'worklet';
    return interpolate(gy.value - y.value, [cell * 0.3, cell * 0.95], [0, 1], 'clamp');
  });
  const m = cell / 2;
  const ghost = (col) => (
    <>
      <Circle cx={m} cy={m} r={cell * 0.38} color={rgba(COLORS[col] || '#ffffff', 0.14)} />
      <Circle cx={m} cy={m} r={cell * 0.38} style="stroke" strokeWidth={2.5} color={COLORS[col] || '#ffffff'} opacity={0.85} />
      <Circle cx={m} cy={m} r={cell * 0.47} style="stroke" strokeWidth={1} color={COLORS[col] || '#ffffff'} opacity={0.4} />
    </>
  );
  const skA = a >= 1 && a <= 5 ? skin : 'gel';
  const skB = b >= 1 && b <= 5 ? skin : 'gel';
  return (
    <Canvas pointerEvents="none" style={{ position: 'absolute', left: -pad, top: -pad, width: W + pad * 2, height: H + pad * 2 }}>
      <Group transform={[{ translateX: pad }, { translateY: pad }]}>
        <Group opacity={gOp}>
          <Group transform={gB}>{ghost(b)}</Group>
          <Group transform={gA}>{ghost(a)}</Group>
        </Group>
        <Group transform={tB}>
          <OrbSk color={b} size={cell} x={0} y={0} worry={danger} active sk={skB} />
        </Group>
        <Group transform={tA}>
          <OrbSk color={a} size={cell} x={0} y={0} worry={danger} active sk={skA} />
        </Group>
      </Group>
    </Canvas>
  );
});

// squash on the cell where a locked orb lands. clock = ms since landing
function LandCell({ cell, x, y, clock, children }) {
  const tf = useDerivedValue(() => {
    'worklet';
    const t2 = clock.value;
    const sy = t2 < 45 ? 1 - 0.18 * (t2 / 45) : 1 - 0.18 * Math.exp(-(t2 - 45) / 70) * Math.cos((t2 - 45) / 45);
    return [{ scaleX: 1 + (1 - sy) * 0.55 }, { scaleY: sy }];
  });
  return (
    <Group transform={tf} origin={{ x: x + cell / 2, y: y + cell }}>
      {children}
    </Group>
  );
}

/* ============================== V19 FOREST SCENE (realm 0, Skia) ============================== */
const _h = (n) => {
  const v = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
};

function fernD(len) {
  const segs = 9;
  const pts = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts.push([Math.sin(t * 1.4) * len * 0.22, -t * len]);
  }
  let d = 'M' + pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('L');
  for (let i = 1; i <= segs; i++) {
    const [x, y] = pts[i];
    const l = len * 0.2 * (1 - i / (segs + 1)) + 3;
    d += `M${x.toFixed(1)} ${y.toFixed(1)}L${(x - l).toFixed(1)} ${(y - l * 0.45).toFixed(1)}M${x.toFixed(1)} ${y.toFixed(1)}L${(x + l).toFixed(1)} ${(y - l * 0.45).toFixed(1)}`;
  }
  return d;
}
const FERN_D = fernD(100);

function Fern({ x, y, sc, color, fan = [-0.9, -0.55, -0.2, 0.15, 0.5, 0.85] }) {
  return (
    <Group transform={[{ translateX: x }, { translateY: y }, { scale: sc }]}>
      {fan.map((a, i) => (
        <Group key={i} transform={[{ rotate: a }]}>
          <Path path={svgPath(FERN_D)} style="stroke" strokeWidth={2.4 / Math.max(0.4, sc)} strokeCap="round" color={color} opacity={0.85 - (i % 2) * 0.2} />
        </Group>
      ))}
    </Group>
  );
}

function Mushroom({ cx, by, cw, ch, sw, sh, c1, c2, glow }) {
  const top = by - sh;
  const cap = `M${cx - cw / 2} ${top}C${cx - cw / 2} ${top - ch * 1.3} ${cx + cw / 2} ${top - ch * 1.3} ${cx + cw / 2} ${top}Q${cx} ${top + ch * 0.3} ${cx - cw / 2} ${top}Z`;
  const spots = [[-0.28, -0.55, 0.075], [0.05, -0.8, 0.09], [0.3, -0.5, 0.065], [-0.05, -0.38, 0.05], [0.18, -0.95, 0.045]];
  return (
    <>
      <Circle cx={cx} cy={top - ch * 0.4} r={cw * 0.85}>
        <RadialGradient c={vec(cx, top - ch * 0.4)} r={cw * 0.85} colors={[rgba(glow, 0.38), rgba(glow, 0)]} />
      </Circle>
      <RoundedRect x={cx - sw / 2} y={top - 4} width={sw} height={sh + 4} r={sw * 0.4}>
        <LinearGradient start={vec(cx - sw / 2, 0)} end={vec(cx + sw / 2, 0)} colors={['#6a74c4', '#c5d2ff', '#7480d0']} />
      </RoundedRect>
      <Oval x={cx - cw * 0.46} y={top - ch * 0.12} width={cw * 0.92} height={ch * 0.42} color={rgba(glow, 0.55)} />
      <Path path={svgPath(cap)}>
        <LinearGradient start={vec(cx, top - ch * 0.98)} end={vec(cx, top + ch * 0.2)} colors={[c1, c2, darken(c2, 0.5)]} />
      </Path>
      <Path path={svgPath(cap)} style="stroke" strokeWidth={Math.max(1.5, cw * 0.012)} color={rgba(glow, 0.6)} />
      {spots.map(([fx, fy, fr], i) => (
        <Circle key={i} cx={cx + fx * cw} cy={top + fy * ch} r={fr * cw} color="rgba(255,235,250,0.82)" />
      ))}
    </>
  );
}

function Stone({ x, y, w, h, rot, clock, k }) {
  const op = useDerivedValue(() => {
    'worklet';
    return 0.55 + 0.45 * Math.sin((clock.value * 6 + k * 0.37) * Math.PI * 2);
  });
  return (
    <Group transform={[{ translateX: x }, { translateY: y }, { rotate: rot }]}>
      <Path path={svgPath(`M${-w / 2} 0L${-w * 0.42} ${-h}Q0 ${-h * 1.1} ${w * 0.42} ${-h}L${w / 2} 0Z`)}>
        <LinearGradient start={vec(-w / 2, -h)} end={vec(w / 2, 0)} colors={['#5a6aa0', '#2e3a66', '#161c3c']} />
      </Path>
      <Group opacity={op}>
        <Path path={svgPath(`M${-w * 0.16} ${-h * 0.8}L${w * 0.16} ${-h * 0.8}M0 ${-h * 0.8}L0 ${-h * 0.55}M${-w * 0.16} ${-h * 0.55}L${w * 0.16} ${-h * 0.4}M${-w * 0.14} ${-h * 0.3}L${w * 0.14} ${-h * 0.3}`)} style="stroke" strokeWidth={Math.max(1.6, w * 0.045)} strokeCap="round" color="#6ff0ff" />
      </Group>
    </Group>
  );
}

function ShootingStar({ x0, y0, dx, dy, K, ph, clock }) {
  const p1 = useDerivedValue(() => {
    'worklet';
    const p = (clock.value * K + ph) % 1;
    const u = Math.min(1, p / 0.16);
    return { x: x0 + dx * u - dx * 0.3, y: y0 + dy * u - dy * 0.3 };
  });
  const p2 = useDerivedValue(() => {
    'worklet';
    const p = (clock.value * K + ph) % 1;
    const u = Math.min(1, p / 0.16);
    return { x: x0 + dx * u, y: y0 + dy * u };
  });
  const op = useDerivedValue(() => {
    'worklet';
    const p = (clock.value * K + ph) % 1;
    return p < 0.16 ? Math.sin((p / 0.16) * Math.PI) : 0;
  });
  return (
    <Group opacity={op}>
      <Line p1={p1} p2={p2} strokeWidth={5} strokeCap="round" color="rgba(130,200,255,0.35)" />
      <Line p1={p1} p2={p2} strokeWidth={2} strokeCap="round" color="#ffffff" />
    </Group>
  );
}

function Twinkle({ pts, k, ph, clock, sw }) {
  const op = useDerivedValue(() => {
    'worklet';
    return 0.3 + 0.7 * (0.5 + 0.5 * Math.sin((clock.value * k + ph) * Math.PI * 2));
  });
  return (
    <Group opacity={op}>
      <Points points={pts} mode="points" style="stroke" strokeWidth={sw} strokeCap="round" color="#ffffff" />
    </Group>
  );
}

function Flies({ items, color, clock, sw }) {
  const pts = useDerivedValue(() => {
    'worklet';
    const t = clock.value * Math.PI * 2;
    return items.map((f) => ({ x: f.x + f.ax * Math.sin(t * f.kx + f.p1), y: f.y + f.ay * Math.sin(t * f.ky + f.p2) }));
  });
  const op = useDerivedValue(() => {
    'worklet';
    return 0.55 + 0.45 * Math.sin(clock.value * Math.PI * 2 * 12 + items[0].p1);
  });
  return (
    <Group opacity={op}>
      <Points points={pts} mode="points" style="stroke" strokeWidth={sw * 2.6} strokeCap="round" color={rgba(color, 0.25)} />
      <Points points={pts} mode="points" style="stroke" strokeWidth={sw} strokeCap="round" color={color} />
    </Group>
  );
}

function SpinRing({ cx, cy, r, color, clock, dir, dash }) {
  const tf = useDerivedValue(() => {
    'worklet';
    return [{ rotate: dir * clock.value * Math.PI * 2 * 2 }];
  });
  return (
    <>
      <Circle cx={cx} cy={cy} r={r + 5}>
        <RadialGradient c={vec(cx, cy)} r={r + 5} colors={[rgba(color, 0), rgba(color, 0.35), rgba(color, 0)]} positions={[0.6, 0.9, 1]} />
      </Circle>
      <Group transform={tf} origin={{ x: cx, y: cy }}>
        <Circle cx={cx} cy={cy} r={r} style="stroke" strokeWidth={2.4} color={color}>
          <DashPathEffect intervals={dash} />
        </Circle>
        <Circle cx={cx} cy={cy} r={r * 0.82} style="stroke" strokeWidth={1.4} color={rgba(color, 0.7)} />
      </Group>
    </>
  );
}

/* ============================== V28 JUNGLE LAYERS (Skia) ============================== */
// leaf: pointing right from (0,0), length len
const leafD = (len, w) => `M0 0Q${len * 0.45} ${-w} ${len} 0Q${len * 0.45} ${w * 0.45} 0 0Z`;
const LEAF_D = leafD(100, 17);
const VEIN_D = 'M4 0L92 -1';

// a fan of leaves from one pivot (palm / monstera crown). angles in radians (0 = right, negative = up)
function Crown({ x, y, sc, angles, dark, rim, clock, k, amp = 0.025 }) {
  const tf = useDerivedValue(() => {
    'worklet';
    return [{ rotate: amp * Math.sin((clock.value * k) * Math.PI * 2) }];
  });
  return (
    <Group transform={tf} origin={{ x, y }}>
      <Group transform={[{ translateX: x }, { translateY: y }, { scale: sc }]}>
        {angles.map((a, i) => (
          <Group key={i} transform={[{ rotate: a }, { scale: 0.85 + (i % 3) * 0.1 }]}>
            <Path path={svgPath(LEAF_D)}>
              <LinearGradient start={vec(0, 0)} end={vec(100, 0)} colors={[dark, rim]} />
            </Path>
            <Path path={svgPath(VEIN_D)} style="stroke" strokeWidth={1.6} color="rgba(120,255,210,0.35)" />
          </Group>
        ))}
      </Group>
    </Group>
  );
}

function Vine({ x, len, drift, clock, k, ph }) {
  const tf = useDerivedValue(() => {
    'worklet';
    return [{ rotate: 0.035 * Math.sin((clock.value * k + ph) * Math.PI * 2) }];
  });
  const d = `M${x} -4C${x + drift * 0.9} ${len * 0.3} ${x - drift * 0.7} ${len * 0.62} ${x + drift * 0.3} ${len}`;
  return (
    <Group transform={tf} origin={{ x, y: 0 }}>
      <Path path={svgPath(d)} style="stroke" strokeWidth={3.2} strokeCap="round" color="rgba(10,70,52,0.9)" />
      <Path path={svgPath(d)} style="stroke" strokeWidth={1.2} strokeCap="round" color="rgba(90,230,170,0.45)" />
      {[0.3, 0.5, 0.7, 0.9].map((t, i) => (
        <Group key={i} transform={[{ translateX: x + drift * (0.3 + 0.2 * Math.sin(t * 6 + ph)) }, { translateY: len * t }, { rotate: i % 2 ? 0.9 : 2.2 }, { scale: 0.22 }]}>
          <Path path={svgPath(LEAF_D)} color="rgba(24,120,92,0.85)" />
        </Group>
      ))}
    </Group>
  );
}

function Flower({ x, y, r, c, clock, k, ph }) {
  const op = useDerivedValue(() => {
    'worklet';
    return 0.55 + 0.45 * Math.sin((clock.value * k + ph) * Math.PI * 2);
  });
  return (
    <>
      <Group opacity={op}>
        <Circle cx={x} cy={y} r={r * 2.6}>
          <RadialGradient c={vec(x, y)} r={r * 2.6} colors={[rgba(c, 0.5), rgba(c, 0)]} />
        </Circle>
      </Group>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <Group key={i} transform={[{ translateX: x }, { translateY: y }, { rotate: (i / 6) * Math.PI * 2 }]}>
          <Oval x={r * 0.1} y={-r * 0.32} width={r * 1.15} height={r * 0.64} color={rgba(c, 0.88)} />
        </Group>
      ))}
      <Circle cx={x} cy={y} r={r * 0.34} color="#fff6c8" />
    </>
  );
}

function Rays({ W, H, clock, ray }) {
  const op = useDerivedValue(() => {
    'worklet';
    return 0.5 + 0.5 * Math.sin(clock.value * Math.PI * 2 * 3);
  });
  return (
    <Group opacity={op}>
      {[[0.1, 0.18], [0.34, 0.14], [0.62, 0.2], [0.86, 0.13]].map(([fx, fw], i) => (
        <Path key={i} path={svgPath(`M${W * fx} 0L${W * (fx + fw)} 0L${W * (fx + fw + 0.2)} ${H * 0.62}L${W * (fx - 0.04)} ${H * 0.62}Z`)}>
          <LinearGradient start={vec(0, 0)} end={vec(0, H * 0.62)} colors={[`rgba(${ray},0.14)`, `rgba(${ray},0)`]} />
        </Path>
      ))}
    </Group>
  );
}

function Mist({ W, H, y, clock, k, ph, a, mist }) {
  const tf = useDerivedValue(() => {
    'worklet';
    return [{ translateX: W * 0.12 * Math.sin((clock.value * k + ph) * Math.PI * 2) }];
  });
  return (
    <Group transform={tf}>
      <Oval x={-W * 0.2} y={y} width={W * 1.4} height={H * 0.07}>
        <LinearGradient start={vec(0, y)} end={vec(0, y + H * 0.07)} colors={[`rgba(${mist},0)`, `rgba(${mist},${a})`, `rgba(${mist},0)`]} />
      </Oval>
    </Group>
  );
}

const rad = (d) => (d * Math.PI) / 180;
const JungleBack = React.memo(function JungleBack({ W, H, clock, pal }) {
  const S = W / 411;
  return (
    <>
      <Rays W={W} H={H} clock={clock} ray={pal.ray} />
      <Crown x={-8 * S} y={H * 0.03} sc={2.4 * S} angles={[rad(-5), rad(10), rad(26), rad(42), rad(58), rad(72)]} dark={pal.l1[0]} rim={pal.l1[1]} clock={clock} k={2} />
      <Crown x={W + 8 * S} y={H * 0.05} sc={2.4 * S} angles={[rad(185), rad(170), rad(154), rad(138), rad(122), rad(108)]} dark={pal.l1[0]} rim={pal.l1[1]} clock={clock} k={3} />
      <Crown x={W * 0.18} y={-6} sc={1.5 * S} angles={[rad(40), rad(62), rad(84), rad(106), rad(128)]} dark={pal.l2[0]} rim={pal.l2[1]} clock={clock} k={4} amp={0.03} />
      <Crown x={W * 0.78} y={-6} sc={1.7 * S} angles={[rad(52), rad(74), rad(96), rad(118), rad(140)]} dark={pal.l2[0]} rim={pal.l2[1]} clock={clock} k={5} amp={0.03} />
      <Vine x={W * 0.3} len={H * 0.2} drift={22 * S} clock={clock} k={2} ph={0.1} />
      <Vine x={W * 0.52} len={H * 0.15} drift={-18 * S} clock={clock} k={3} ph={0.4} />
      <Vine x={W * 0.66} len={H * 0.24} drift={26 * S} clock={clock} k={2} ph={0.7} />
      <Vine x={W * 0.9} len={H * 0.17} drift={-20 * S} clock={clock} k={3} ph={0.2} />
    </>
  );
});
const JungleFront = React.memo(function JungleFront({ W, H, clock, pal }) {
  const S = W / 411;
  return (
    <>
      <Mist W={W} H={H} y={H * 0.74} clock={clock} k={1} ph={0.2} a={0.16} mist={pal.mist} />
      <Mist W={W} H={H} y={H * 0.84} clock={clock} k={2} ph={0.6} a={0.2} mist={pal.mist} />
      <Flower x={W * 0.12} y={H * 0.9} r={15 * S} c={pal.fl[0]} clock={clock} k={4} ph={0.1} />
      <Flower x={W * 0.2} y={H * 0.945} r={11 * S} c={pal.fl[1]} clock={clock} k={5} ph={0.5} />
      <Flower x={W * 0.7} y={H * 0.93} r={13 * S} c={pal.fl[2]} clock={clock} k={4} ph={0.8} />
      <Flower x={W * 0.9} y={H * 0.885} r={17 * S} c={pal.fl[3]} clock={clock} k={3} ph={0.3} />
      <Flower x={W * 0.56} y={H * 0.965} r={10 * S} c={pal.fl[4]} clock={clock} k={5} ph={0.6} />
      <Crown x={-6 * S} y={H * 1.0} sc={2.0 * S} angles={[rad(-80), rad(-62), rad(-44), rad(-26), rad(-8)]} dark={pal.l3[0]} rim={pal.l3[1]} clock={clock} k={2} amp={0.02} />
      <Crown x={W + 6 * S} y={H * 1.0} sc={2.0 * S} angles={[rad(-100), rad(-118), rad(-136), rad(-154), rad(-172)]} dark={pal.l3[0]} rim={pal.l3[1]} clock={clock} k={3} amp={0.02} />
    </>
  );
});


function HintBeam({ left, width, cell, H, pulse }) {
  const op = useDerivedValue(() => {
    'worklet';
    return 0.45 + 0.55 * pulse.value;
  });
  return (
    <Canvas pointerEvents="none" style={{ position: 'absolute', left, top: 0, width, height: H }}>
      <Group opacity={op}>
        <Rect x={0} y={0} width={width} height={H}>
          <LinearGradient start={vec(0, 0)} end={vec(0, H)} colors={['rgba(255,226,120,0)', 'rgba(255,226,120,0.2)', 'rgba(255,226,120,0.42)']} />
        </Rect>
        <Rect x={0} y={0} width={2} height={H} color="rgba(255,236,150,0.8)" />
        <Rect x={width - 2} y={0} width={2} height={H} color="rgba(255,236,150,0.8)" />
        {[0.5, 0.64, 0.78].map((f, i) => (
          <Path key={i} path={svgPath(`M${width / 2 - cell * 0.28} ${H * f}L${width / 2} ${H * f + cell * 0.22}L${width / 2 + cell * 0.28} ${H * f}`)} style="stroke" strokeWidth={4} strokeCap="round" strokeJoin="round" color="#ffe88a" />
        ))}
      </Group>
    </Canvas>
  );
}

/* ============================== V29 BIOMES ============================== */
// 8 palettes = 4 realms x 2 moods. Each game also gets a random mirror + seed, so no two games look the same.
// The world cools as you progress: realm 0 (violet grove) -> 1 (moonlit lake) -> 2 (frost) -> 3 (neon night),
// and inside a game a cool tint rises with your goal progress.
const PALS = [
  { n: 'Twilight Grove', sky: ['#0b0f40', '#1c1670', '#2b1b82', '#17428c', '#0f5c78', '#0a4048', '#06282c'], neb: ['rgba(255,90,210,0.4)', 'rgba(170,70,255,0.2)'], neb2: ['rgba(90,230,255,0.3)', 'rgba(80,120,255,0.15)'], ground: ['#14604a', '#0b4036', '#062a2c'], l1: ['#04251f', '#13806a'], l2: ['#03201b', '#0f6e5c'], l3: ['#021a16', '#0d5a4a'], fern: '#5ef0d0', m1: ['#ffb0e8', '#a45ad8', '#ff7ad9'], m2: ['#ffd08a', '#e08a3a', '#ffb04a'], fl: ['#ff7ad9', '#7ff3e0', '#ffd86b', '#ff7ad9', '#8ab4ff'], flies: ['#ffe98a', '#ff9a3b', '#7ff3e0', '#ff7ad9'], ray: '150,255,230', mist: '160,255,230', row: '#0a3a4a', ring: ['#5cd8ff', '#ff7a4a'], tint: '90,190,255' },
  { n: 'Emerald Canopy', sky: ['#04140f', '#08271d', '#0d3d2c', '#0f5a3e', '#0c6b4a', '#084a38', '#052b24'], neb: ['rgba(120,255,160,0.35)', 'rgba(40,200,120,0.18)'], neb2: ['rgba(255,230,120,0.22)', 'rgba(120,255,200,0.12)'], ground: ['#17713f', '#0d4a2c', '#06301e'], l1: ['#021d12', '#17a35e'], l2: ['#021a10', '#128a4e'], l3: ['#01140c', '#0e6f3e'], fern: '#7dffa6', m1: ['#fff0a0', '#ff9a4a', '#ffb04a'], m2: ['#ffc0e8', '#c060e0', '#ff7ad9'], fl: ['#ffe36b', '#ff9a4a', '#7dffd0', '#ff7a9a', '#ffe36b'], flies: ['#fff08a', '#9dff7a', '#7dffd0', '#ffb04a'], ray: '200,255,170', mist: '170,255,200', row: '#0a4a2c', ring: ['#9dff7a', '#ffb04a'], tint: '120,255,190' },
  { n: 'Moonlit Lake', sky: ['#050a2a', '#0b1850', '#12296e', '#1a4a8f', '#1d6aa0', '#134a78', '#0a2a4a'], neb: ['rgba(150,190,255,0.35)', 'rgba(110,120,255,0.18)'], neb2: ['rgba(200,230,255,0.3)', 'rgba(120,170,255,0.15)'], ground: ['#1d5f9a', '#124878', '#0a2c52'], l1: ['#031a2c', '#2a86b8'], l2: ['#021626', '#22729c'], l3: ['#01101c', '#1a5a7c'], fern: '#8fd8ff', m1: ['#cfe6ff', '#7a8fe0', '#9fc8ff'], m2: ['#e8f4ff', '#8aa4e8', '#bcd8ff'], fl: ['#cfe6ff', '#9fd0ff', '#ffffff', '#a0b4ff', '#cfe6ff'], flies: ['#dff0ff', '#9fd0ff', '#ffffff', '#b8c8ff'], ray: '180,220,255', mist: '190,225,255', row: '#0a2e4e', ring: ['#9fd8ff', '#c8b8ff'], tint: '110,180,255' },
  { n: 'Aqua Glade', sky: ['#04141f', '#08293a', '#0d4358', '#106a78', '#12868a', '#0b5f68', '#06393f'], neb: ['rgba(90,255,230,0.3)', 'rgba(60,180,255,0.16)'], neb2: ['rgba(200,255,240,0.25)', 'rgba(120,230,255,0.12)'], ground: ['#17808a', '#0e5a68', '#073a46'], l1: ['#03222a', '#22a4a4'], l2: ['#021c22', '#1a8c8e'], l3: ['#01141a', '#147072'], fern: '#7ff3e8', m1: ['#d0fff4', '#5ac8d8', '#7ff3e8'], m2: ['#fff0c8', '#ffb88a', '#ffd08a'], fl: ['#7ff3e8', '#ffd86b', '#ff9ad8', '#9fd0ff', '#7ff3e8'], flies: ['#d0fff4', '#7ff3e8', '#ffe98a', '#ffffff'], ray: '170,255,240', mist: '180,255,240', row: '#0a4a54', ring: ['#7ff3e8', '#ffd08a'], tint: '100,230,230' },
  { n: 'Frost Peaks', sky: ['#0b1236', '#1a2a6e', '#2c4a98', '#4f7cc0', '#7fa8d8', '#4a7098', '#243e5e'], neb: ['rgba(170,220,255,0.35)', 'rgba(120,160,255,0.18)'], neb2: ['rgba(230,245,255,0.3)', 'rgba(170,210,255,0.15)'], ground: ['#8ab4d8', '#5a88b0', '#2f5578'], l1: ['#0a1c34', '#6aa6d8'], l2: ['#08162c', '#5a90c0'], l3: ['#051020', '#4a78a4'], fern: '#d0eaff', m1: ['#eaf6ff', '#8ab0e8', '#cfe6ff'], m2: ['#ffffff', '#a8c4f0', '#e0f0ff'], fl: ['#ffffff', '#bfe0ff', '#e8d8ff', '#9fd0ff', '#ffffff'], flies: ['#ffffff', '#cfe6ff', '#e8d8ff', '#bfe0ff'], ray: '210,235,255', mist: '220,240,255', row: '#244a74', ring: ['#cfe6ff', '#b8c8ff'], tint: '150,210,255' },
  { n: 'Aurora Ridge', sky: ['#070a28', '#14185a', '#2a1a7a', '#3a4aa0', '#4f8ac0', '#3a6a8f', '#1d3a52'], neb: ['rgba(120,255,200,0.3)', 'rgba(160,120,255,0.2)'], neb2: ['rgba(255,150,230,0.25)', 'rgba(150,170,255,0.14)'], ground: ['#6aa0c8', '#42709c', '#223c60'], l1: ['#0a1430', '#5a8ad0'], l2: ['#08102a', '#4a76b8'], l3: ['#050a1c', '#3a5c94'], fern: '#b8f0ff', m1: ['#e8d8ff', '#9a7ae0', '#c8a8ff'], m2: ['#d8fff0', '#7ad8c0', '#a8ffe0'], fl: ['#c8a8ff', '#7affd0', '#ffffff', '#ff9ad8', '#c8a8ff'], flies: ['#e8d8ff', '#a8ffe0', '#ffffff', '#c8a8ff'], ray: '170,255,220', mist: '190,240,255', row: '#1c3a68', ring: ['#a8ffe0', '#c8a8ff'], tint: '130,200,255' },
  { n: 'Neon Night', sky: ['#0a0220', '#1c0540', '#3a0a6a', '#6a1a8a', '#8a2a8a', '#4a1a5a', '#240a34'], neb: ['rgba(255,60,200,0.4)', 'rgba(150,60,255,0.22)'], neb2: ['rgba(0,240,255,0.3)', 'rgba(60,120,255,0.16)'], ground: ['#3a1060', '#240a46', '#140628'], l1: ['#12041f', '#c02a9a'], l2: ['#0e031a', '#9a2088'], l3: ['#080212', '#701870'], fern: '#ff7ae0', m1: ['#ff9af0', '#8a3ae0', '#ff3ad0'], m2: ['#9afff8', '#3a8ae0', '#00f0ff'], fl: ['#00f0ff', '#ff3ad0', '#ffe23a', '#00f0ff', '#ff3ad0'], flies: ['#00f0ff', '#ff3ad0', '#ffe23a', '#7aff9a'], ray: '255,120,230', mist: '255,140,230', row: '#3a0a5a', ring: ['#00f0ff', '#ff3ad0'], tint: '0,200,255' },
  { n: 'Cyber Reef', sky: ['#020a22', '#041a46', '#062c6e', '#0a4a9a', '#0a6aaa', '#06406a', '#031e34'], neb: ['rgba(0,230,255,0.35)', 'rgba(60,140,255,0.2)'], neb2: ['rgba(255,60,200,0.28)', 'rgba(150,80,255,0.15)'], ground: ['#0e4a8a', '#08305e', '#041a34'], l1: ['#021428', '#1a9ad8'], l2: ['#010f20', '#1580b8'], l3: ['#010a16', '#0e6090'], fern: '#5ae8ff', m1: ['#9af8ff', '#3a7ae0', '#00e0ff'], m2: ['#ffa0f0', '#a03ae0', '#ff3ad0'], fl: ['#00e0ff', '#ff3ad0', '#ffe23a', '#7aff9a', '#00e0ff'], flies: ['#00e0ff', '#ff3ad0', '#7aff9a', '#ffe23a'], ray: '120,230,255', mist: '140,230,255', row: '#0a3a6a', ring: ['#00e0ff', '#ff3ad0'], tint: '0,170,255' },
  // ---- v33: realm 4 sunny meadow (8,9) ----
  { n: 'Sunny Meadow', sky: ['#1b4aa8', '#2d74d6', '#58a2ea', '#98cbf0', '#f0dca4'], sun: [0.78, 0.2], sunc: '255,240,190', ray: '255,236,170', mist: '255,255,255', cloud: '255,255,255', hills: [['#2f9a58', '#1a6a3c'], ['#27864a', '#145a34'], ['#1d7040', '#0e4a2c']], ground: ['#3cab52', '#23803c', '#12552a'], tree: ['#0f4a2a', '#2f9a58'], fl: ['#ffe36b', '#ff7aa8', '#ffffff', '#ff9a4a', '#c8a8ff'], flies: ['#ffffff', '#ffe36b', '#ffb0d8', '#bfe8ff'], fern: '#6adb7a', tint: '255,150,80' },
  { n: 'Golden Afternoon', sky: ['#274a9a', '#5a7ad0', '#ffa878', '#ffcf8a', '#ffe8b0'], sun: [0.22, 0.3], sunc: '255,205,140', ray: '255,205,140', mist: '255,225,190', cloud: '255,235,215', hills: [['#4a9a48', '#25683a'], ['#3a8640', '#1a5a32'], ['#2a7038', '#104a2a']], ground: ['#4aa84a', '#2a7a38', '#14502a'], tree: ['#123a24', '#3a8a48'], fl: ['#ffd36b', '#ff8a6a', '#ffffff', '#ffb04a', '#ffa8c8'], flies: ['#fff0c0', '#ffd36b', '#ffc0a0', '#ffffff'], fern: '#8adb7a', tint: '120,60,160' },
  // ---- realm 5 dusty dunes (10 dusk, 11 night) ----
  { n: 'Dusk Dunes', sky: ['#0d0a3a', '#2e1a6e', '#a02a7a', '#ff6a4a', '#ffb050', '#ffe09a'], sun: [0.5, 0.58], sunc: '255,190,110', mesa: '#4a1a4a', dunes: [['#e88a48', '#8a3a2a'], ['#c8683a', '#6a2a28'], ['#a24a30', '#4a1c24'], ['#7a3428', '#2a1020']], crest: '255,210,150', cactus: '#1a0a1e', sand: '255,200,140', mist: '255,170,110', tint: '40,20,120' },
  { n: 'Desert Night', night: 1, sky: ['#04081f', '#0b1450', '#1c2a7a', '#3a4a9a', '#7a6aa0', '#c09a9a'], sun: [0.5, 0.58], sunc: '200,210,255', mesa: '#10183a', dunes: [['#5a6ab0', '#1c2860'], ['#4a5aa0', '#141e50'], ['#3a4a8a', '#0e1640'], ['#2a3870', '#080e30']], crest: '170,190,255', cactus: '#050a1c', sand: '170,190,255', mist: '120,150,230', tint: '0,60,160' },
  // ---- realm 6 storm jungle (12, 13): same fields as the grove palettes ----
  { n: 'Storm Jungle', sky: ['#06121a', '#0c2430', '#133a46', '#1b4f58', '#1d5a5e', '#134046', '#0a2a30'], neb: ['rgba(120,200,220,0.2)', 'rgba(80,140,200,0.1)'], neb2: ['rgba(170,230,240,0.16)', 'rgba(100,170,210,0.1)'], ground: ['#1c5a54', '#103c3c', '#082628'], l1: ['#031418', '#1d7a72'], l2: ['#02101a', '#186862'], l3: ['#010b10', '#12524e'], fern: '#8fe8d8', m1: ['#b8fff0', '#4a9a9a', '#7fe8d8'], m2: ['#d8f0ff', '#6a9ac0', '#9fd0f0'], fl: ['#9fe8ff', '#7ff3e0', '#ffffff', '#9fd0ff', '#9fe8ff'], flies: ['#b8fff0', '#7ff3e0', '#dff8ff', '#9fd0ff'], ray: '140,210,230', mist: '150,220,230', row: '#0a3038', ring: ['#7fe8f0', '#9fd0ff'], tint: '60,120,170' },
  { n: 'Midnight Downpour', sky: ['#0a0a22', '#16183e', '#262a5a', '#34407a', '#3a5a88', '#26405e', '#121e34'], neb: ['rgba(150,130,255,0.22)', 'rgba(100,90,220,0.1)'], neb2: ['rgba(120,200,255,0.18)', 'rgba(90,130,230,0.1)'], ground: ['#2a4a7a', '#1a3258', '#0e1e38'], l1: ['#050a1c', '#2a5a9a'], l2: ['#040818', '#244c84'], l3: ['#030612', '#1c3c6a'], fern: '#9ac8ff', m1: ['#cfd8ff', '#6a7ae0', '#9aa8ff'], m2: ['#e8f0ff', '#7a98d8', '#b8d0ff'], fl: ['#b8c8ff', '#9fd0ff', '#ffffff', '#c8b8ff', '#b8c8ff'], flies: ['#cfd8ff', '#9fd0ff', '#ffffff', '#c8b8ff'], ray: '170,190,255', mist: '170,190,255', row: '#14224a', ring: ['#9fb8ff', '#c8b8ff'], tint: '90,110,200' },
  // ---- realm 7 golden dawn (14, 15) ----
  { n: 'Golden Dawn', dawn: 1, sky: ['#241e66', '#6a3a96', '#d85a8a', '#ff9a6a', '#ffd08a'], sun: [0.5, 0.6], sunc: '255,210,140', ray: '255,200,140', mist: '255,200,170', cloud: '255,180,160', hills: [['#7a3a7a', '#3a1a5a'], ['#5a2a6a', '#2a1250'], ['#3a1a52', '#1a0c3a']], ground: ['#4a2a5a', '#2a1646', '#160a30'], tree: ['#120a2a', '#3a1a52'], fl: ['#ffb0d0', '#ffe0a0', '#ffffff', '#ff8ab0', '#ffd08a'], flies: ['#ffe0a0', '#ffffff', '#ffb0d0', '#ffd08a'], fern: '#ff9ac0', tint: '255,120,80' },
  { n: 'First Light', dawn: 1, sky: ['#0f1a4a', '#2a3a8a', '#5a6aa8', '#e89a8a', '#ffcf9a'], sun: [0.3, 0.62], sunc: '255,200,150', ray: '255,200,160', mist: '255,200,180', cloud: '255,200,190', hills: [['#2a5a7a', '#183a58'], ['#204a6a', '#12304a'], ['#183a58', '#0c2238']], ground: ['#2a5a78', '#1a3a58', '#0e2238'], tree: ['#08142a', '#204a6a'], fl: ['#ffc0d8', '#ffe0a0', '#ffffff', '#a8d0ff', '#ffd08a'], flies: ['#ffe0a0', '#ffffff', '#ffc0d8', '#a8d0ff'], fern: '#8adcf0', tint: '255,140,90' },
];

function Moon({ W, H, clock }) {
  const op = useDerivedValue(() => {
    'worklet';
    return 0.8 + 0.2 * Math.sin(clock.value * Math.PI * 2 * 2);
  });
  const x = W * 0.74;
  const y = H * 0.17;
  const r = W * 0.1;
  return (
    <Group opacity={op}>
      <Circle cx={x} cy={y} r={r * 3.2}>
        <RadialGradient c={vec(x, y)} r={r * 3.2} colors={['rgba(210,230,255,0.45)', 'rgba(210,230,255,0)']} />
      </Circle>
      <Circle cx={x} cy={y} r={r}>
        <RadialGradient c={vec(x - r * 0.3, y - r * 0.3)} r={r * 1.3} colors={['#ffffff', '#e4eeff', '#b8ccf0']} />
      </Circle>
      <Circle cx={x + r * 0.3} cy={y + r * 0.2} r={r * 0.2} color="rgba(120,140,190,0.2)" />
      <Circle cx={x - r * 0.3} cy={y + r * 0.35} r={r * 0.13} color="rgba(120,140,190,0.18)" />
    </Group>
  );
}
function Ripples({ W, H, clock }) {
  const op = useDerivedValue(() => {
    'worklet';
    return 0.35 + 0.35 * Math.sin(clock.value * Math.PI * 2 * 6);
  });
  return (
    <Group opacity={op}>
      {[[0.3, 0.88, 0.22], [0.62, 0.92, 0.28], [0.18, 0.96, 0.18], [0.78, 0.86, 0.16]].map(([fx, fy, fw], i) => (
        <Oval key={i} x={W * (fx - fw / 2)} y={H * fy} width={W * fw} height={H * 0.012} color="rgba(220,240,255,0.5)" />
      ))}
    </Group>
  );
}
function Snow({ W, H, clock }) {
  const flakes = useMemo(() => Array.from({ length: 70 }, (_, i) => ({ x: _h(i + 900) * W, y: _h(i + 950) * H, a: 4 + _h(i + 990) * 10, k: 3 + (i % 3), m: 1 + (i % 3), p: _h(i + 1000) * 6.28 })), [W, H]);
  const pts = useDerivedValue(() => {
    'worklet';
    const t = clock.value;
    return flakes.map((f) => ({ x: f.x + f.a * Math.sin(t * Math.PI * 2 * f.k + f.p), y: (f.y + t * H * f.m * 2) % H }));
  });
  return (
    <>
      <Points points={pts} mode="points" style="stroke" strokeWidth={5} strokeCap="round" color="rgba(255,255,255,0.28)" />
      <Points points={pts} mode="points" style="stroke" strokeWidth={2.4} strokeCap="round" color="#ffffff" />
    </>
  );
}
function Aurora({ W, H, clock }) {
  const o1 = useDerivedValue(() => {
    'worklet';
    return 0.4 + 0.4 * Math.sin(clock.value * Math.PI * 2 * 2);
  });
  const o2 = useDerivedValue(() => {
    'worklet';
    return 0.35 + 0.35 * Math.sin(clock.value * Math.PI * 2 * 3 + 1.3);
  });
  const band = (y0, a, c1, c2) =>
    `M0 ${y0}C${W * 0.25} ${y0 - H * a} ${W * 0.5} ${y0 + H * a} ${W} ${y0 - H * a * 0.5}L${W} ${y0 + H * 0.14}C${W * 0.6} ${y0 + H * (0.14 + a)} ${W * 0.3} ${y0 + H * (0.14 - a)} 0 ${y0 + H * 0.14}Z`;
  return (
    <>
      <Group opacity={o1}>
        <Path path={svgPath(band(H * 0.1, 0.05, 0, 0))}>
          <LinearGradient start={vec(0, H * 0.1)} end={vec(0, H * 0.28)} colors={['rgba(120,255,200,0.4)', 'rgba(120,255,200,0)']} />
        </Path>
      </Group>
      <Group opacity={o2}>
        <Path path={svgPath(band(H * 0.18, 0.04, 0, 0))}>
          <LinearGradient start={vec(0, H * 0.18)} end={vec(0, H * 0.34)} colors={['rgba(190,140,255,0.35)', 'rgba(190,140,255,0)']} />
        </Path>
      </Group>
    </>
  );
}
function IceSpikes({ W, H }) {
  return (
    <>
      {[[0.05, 0.9, 0.05, 0.1], [0.12, 0.93, 0.04, 0.07], [0.9, 0.9, 0.06, 0.12], [0.84, 0.94, 0.04, 0.07], [0.5, 0.98, 0.05, 0.05]].map(([fx, fy, fw, fh], i) => (
        <Path key={i} path={svgPath(`M${W * (fx - fw / 2)} ${H * fy}L${W * fx} ${H * (fy - fh)}L${W * (fx + fw / 2)} ${H * fy}Z`)}>
          <LinearGradient start={vec(W * fx, H * (fy - fh))} end={vec(W * fx, H * fy)} colors={['rgba(255,255,255,0.9)', 'rgba(150,210,255,0.55)']} />
        </Path>
      ))}
    </>
  );
}
function NeonGrid({ W, H, clock }) {
  const op = useDerivedValue(() => {
    'worklet';
    return 0.6 + 0.4 * Math.sin(clock.value * Math.PI * 2 * 4);
  });
  const hy = H * 0.84;
  let d = '';
  for (let i = -8; i <= 8; i++) d += `M${W / 2} ${hy}L${W / 2 + i * W * 0.28} ${H}`;
  for (let k = 1; k <= 7; k++) {
    const y = hy + (H - hy) * (k / 7) ** 2;
    d += `M0 ${y}L${W} ${y}`;
  }
  return (
    <>
      <Circle cx={W / 2} cy={hy - H * 0.01} r={W * 0.16}>
        <LinearGradient start={vec(0, hy - W * 0.17)} end={vec(0, hy)} colors={['#ffe23a', '#ff6ad0', '#8a2aff']} />
      </Circle>
      {[0.2, 0.42, 0.62, 0.8].map((f, i) => (
        <Rect key={i} x={W / 2 - W * 0.17} y={hy - W * 0.16 + W * 0.16 * f} width={W * 0.34} height={2 + i * 1.5} color="rgba(30,6,60,0.85)" />
      ))}
      <Group opacity={op}>
        <Path path={svgPath(d)} style="stroke" strokeWidth={1.6} color="rgba(0,240,255,0.5)" />
      </Group>
    </>
  );
}

/* ============================== V33 NEW REALMS: MEADOW (day), DESERT, STORM (rain), DAWN ============================== */
const TAU = Math.PI * 2;
// gentle wave used for hills and dunes: y of the surface at u (0..1 across the width)
const waveAt = (H, y, amp, n, ph, u) => H * y + Math.sin(u * TAU * n + ph) * H * amp + Math.sin(u * TAU * n * 2.3 + ph * 1.7) * H * amp * 0.35;
function waveD(W, H, y, amp, n, ph, bottom) {
  const N = 20;
  const pts = [];
  for (let i = 0; i <= N; i++) pts.push([(i / N) * W, waveAt(H, y, amp, n, ph, i / N)]);
  let top = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < N; i++) {
    top += `Q${pts[i][0]} ${pts[i][1]} ${(pts[i][0] + pts[i + 1][0]) / 2} ${(pts[i][1] + pts[i + 1][1]) / 2}`;
  }
  top += `L${pts[N][0]} ${pts[N][1]}`;
  return { top, fill: `${top}L${W} ${bottom}L0 ${bottom}Z` };
}

// a scene that throws while drawing falls back to the grove instead of crashing the game
class SceneGuard extends React.Component {
  state = { bad: false };
  static getDerivedStateFromError() {
    return { bad: true };
  }
  componentDidCatch(e) {
    try {
      AsyncStorage.setItem('lastError', ('scene: ' + String((e && e.stack) || e)).slice(0, 1200)).catch(() => {});
    } catch (x) {}
  }
  render() {
    return this.state.bad ? this.props.fallback : this.props.children;
  }
}

// vignette + the "world cools as you progress" tint, shared by the new scenes
function SceneFinish({ W, H, pal, cool, vig = 0.4 }) {
  const coolOp = useDerivedValue(() => {
    'worklet';
    return cool.value;
  });
  return (
    <>
      <Rect x={0} y={0} width={W} height={H}>
        <RadialGradient c={vec(W / 2, H * 0.48)} r={H * 0.78} colors={['rgba(2,4,24,0)', 'rgba(2,4,24,0)', `rgba(2,4,24,${vig})`]} positions={[0, 0.55, 1]} />
      </Rect>
      <Group opacity={coolOp}>
        <Rect x={0} y={0} width={W} height={H}>
          <LinearGradient start={vec(0, 0)} end={vec(0, H)} colors={[`rgba(${pal.tint},0)`, `rgba(${pal.tint},0.1)`, `rgba(${pal.tint},0.26)`]} />
        </Rect>
      </Group>
    </>
  );
}

// puffy cloud that drifts left to right. k must be a whole number so the 24s loop is seamless.
function Cloud({ x0, y, w, k, clock, W, col, a = 0.95, sh = 'rgba(120,150,200,0.28)' }) {
  const span = W + w * 2;
  const tf = useDerivedValue(() => {
    'worklet';
    return [{ translateX: ((x0 + clock.value * span * k) % span) - w }, { translateY: y }];
  });
  const h = w * 0.3;
  const c = `rgba(${col},${a})`;
  return (
    <Group transform={tf}>
      <Oval x={w * 0.02} y={h * 0.55} width={w * 0.96} height={h * 0.62} color={c} />
      <Circle cx={w * 0.28} cy={h * 0.62} r={h * 0.58} color={c} />
      <Circle cx={w * 0.5} cy={h * 0.42} r={h * 0.78} color={c} />
      <Circle cx={w * 0.72} cy={h * 0.6} r={h * 0.56} color={c} />
      <Oval x={w * 0.08} y={h * 0.98} width={w * 0.84} height={h * 0.26} color={sh} />
    </Group>
  );
}

function Bird({ x0, y, s, k, ph, clock, W, col }) {
  const span = W + 80;
  const tf = useDerivedValue(() => {
    'worklet';
    const t = clock.value;
    const flap = 0.3 + 0.7 * Math.abs(Math.sin(t * 48 * Math.PI + ph));
    return [{ translateX: ((x0 + t * span * k) % span) - 40 }, { translateY: y + Math.sin(t * TAU * 3 + ph) * 7 }, { scale: s }, { scaleY: flap }];
  });
  const p = useMemo(() => svgPath('M-10 0Q-5 -8 0 0Q5 -8 10 0'), []);
  return (
    <Group transform={tf}>
      <Path path={p} style="stroke" strokeWidth={2.2} strokeCap="round" strokeJoin="round" color={col} />
    </Group>
  );
}

function Sun({ x, y, r, c, clock }) {
  const op = useDerivedValue(() => {
    'worklet';
    return 0.86 + 0.14 * Math.sin(clock.value * TAU * 3);
  });
  return (
    <Group opacity={op}>
      <Circle cx={x} cy={y} r={r * 5.5}>
        <RadialGradient c={vec(x, y)} r={r * 5.5} colors={[`rgba(${c},0.55)`, `rgba(${c},0.16)`, `rgba(${c},0)`]} positions={[0, 0.3, 1]} />
      </Circle>
      <Circle cx={x} cy={y} r={r * 1.55} color={`rgba(${c},0.28)`} />
      <Circle cx={x} cy={y} r={r}>
        <RadialGradient c={vec(x - r * 0.2, y - r * 0.2)} r={r * 1.25} colors={['#ffffff', `rgba(${c},1)`, `rgba(${c},0.92)`]} />
      </Circle>
    </Group>
  );
}

function Tree({ x, y, s, pal }) {
  const g = (cx, cy, r) => (
    <Circle cx={cx} cy={cy} r={r}>
      <RadialGradient c={vec(cx - r * 0.35, cy - r * 0.4)} r={r * 1.5} colors={[pal.tree[1], pal.tree[0]]} />
    </Circle>
  );
  return (
    <>
      <RoundedRect x={x - 3 * s} y={y - 30 * s} width={6 * s} height={32 * s} r={2 * s} color={pal.tree[0]} />
      {g(x, y - 46 * s, 22 * s)}
      {g(x - 15 * s, y - 36 * s, 15 * s)}
      {g(x + 15 * s, y - 38 * s, 16 * s)}
    </>
  );
}

const MeadowScene = React.memo(function MeadowScene({ W, H, clock, pal, flip, seed, cool }) {
  const S = W / 768;
  const sd = (seed || 1) * 97;
  const dawn = !!pal.dawn;
  const base = dawn ? 0.6 : 0.5;
  const geo = useMemo(() => {
    const hp = pal.hills.map((_, i) => [base + i * 0.095, 0.028 + i * 0.006, 1.1 + i * 0.5, sd * 0.01 + i * 2.1]);
    const hd = hp.map((p) => waveD(W, H, p[0], p[1], p[2], p[3], H));
    const trees = Array.from({ length: 9 }, (_, i) => {
      const li = i % 2;
      const u = 0.04 + _h(i + 11 + sd) * 0.92;
      const p = hp[li];
      return { li, x: u * W, y: waveAt(H, p[0], p[1], p[2], p[3], u) + 6 * S, s: (0.55 + _h(i + 33 + sd) * 0.45) * (S * 1.6 + 0.2) * (li ? 1.15 : 0.85) };
    });
    const stars = Array.from({ length: 36 }, (_, i) => ({ x: _h(i * 3 + 5 + sd) * W, y: _h(i * 3 + 9 + sd) * H * 0.38 }));
    let grass = '';
    for (let i = 0; i < 46; i++) {
      const x = _h(i + 70 + sd) * W;
      const y = H * (0.86 + _h(i + 120 + sd) * 0.13);
      const l = (10 + _h(i + 170) * 16) * (S * 1.2 + 0.4);
      grass += `M${x} ${y}Q${x - l * 0.2} ${y - l * 0.6} ${x - l * 0.45} ${y - l}M${x} ${y}Q${x + l * 0.05} ${y - l * 0.7} ${x + l * 0.1} ${y - l * 1.1}M${x} ${y}Q${x + l * 0.25} ${y - l * 0.55} ${x + l * 0.5} ${y - l * 0.9}`;
    }
    const flowers = Array.from({ length: 11 }, (_, i) => ({ x: _h(i + 300 + sd) * W, y: H * (0.87 + _h(i + 340 + sd) * 0.1), r: (4 + _h(i + 380) * 3.2) * (S * 1.1 + 0.55), c: pal.fl[i % 5], k: 2 + (i % 3), ph: _h(i + 420) }));
    const stems = flowers.map((f) => `M${f.x} ${f.y + f.r * 5}L${f.x} ${f.y}`).join('');
    const flies = pal.flies.map((c, ci) => ({
      c,
      items: Array.from({ length: 6 }, (_, i) => {
        const n = ci * 6 + i;
        return { x: _h(n + 200 + sd) * W, y: (0.35 + _h(n + 300 + sd) * 0.55) * H, ax: 10 + _h(n + 400) * 22, ay: 8 + _h(n + 500) * 18, kx: 2 + (n % 3), ky: 2 + ((n + 1) % 3), p1: _h(n + 600) * 6.28, p2: _h(n + 700) * 6.28 };
      }),
    }));
    const clouds = dawn
      ? [[0.1, 0.12, 0.5, 1], [0.6, 0.2, 0.4, 1], [0.35, 0.3, 0.55, 2]]
      : [[0.05, 0.1, 0.36, 1], [0.5, 0.17, 0.3, 1], [0.25, 0.3, 0.44, 2], [0.8, 0.26, 0.34, 2], [0.65, 0.4, 0.26, 1]];
    return { hp, hd, trees, stars, grass, flowers, stems, flies, clouds };
  }, [W, H, sd, pal]);
  const sway = useDerivedValue(() => {
    'worklet';
    return [{ skewX: 0.05 * Math.sin(clock.value * TAU * 3) }];
  });
  const sunX = W * pal.sun[0];
  const sunY = H * pal.sun[1];
  const sunR = W * (dawn ? 0.1 : 0.065);
  return (
    <Canvas pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, width: W, height: H }}>
      <Group transform={flip ? [{ translateX: W }, { scaleX: -1 }] : []}>
        <Rect x={0} y={0} width={W} height={H}>
          <LinearGradient start={vec(0, 0)} end={vec(0, H)} colors={pal.sky} positions={[0, 0.25, 0.45, 0.62, 0.82]} />
        </Rect>
        {dawn && <Twinkle pts={geo.stars} k={9} ph={0.2} clock={clock} sw={2} />}
        <Sun x={sunX} y={sunY} r={sunR} c={pal.sunc} clock={clock} />
        {[0.35, 0.55, 0.8].map((t, i) => (
          <Circle key={`fl${i}`} cx={sunX + (W / 2 - sunX) * t * 1.6} cy={sunY + (H * 0.5 - sunY) * t * 1.6} r={W * (0.03 + i * 0.015)} color={`rgba(${pal.sunc},${0.1 - i * 0.025})`} />
        ))}
        {geo.clouds.map(([fx, fy, fw, k], i) => (
          <Cloud key={`c${i}`} x0={W * fx} y={H * fy} w={W * fw} k={k} clock={clock} W={W} col={pal.cloud} a={0.92} sh={dawn ? 'rgba(200,110,140,0.3)' : 'rgba(110,140,200,0.28)'} />
        ))}
        <Rays W={W} H={H} clock={clock} ray={pal.ray} />
        {geo.hd.map((p, i) => (
          <Group key={`h${i}`}>
            <Path path={svgPath(p.fill)}>
              <LinearGradient start={vec(0, H * (geo.hp[i][0] - 0.04))} end={vec(0, H)} colors={pal.hills[i]} />
            </Path>
            <Path path={svgPath(p.top)} style="stroke" strokeWidth={2} color={`rgba(${pal.ray},0.35)`} />
            {geo.trees.filter((t) => t.li === i).map((t, j) => (
              <Tree key={`t${i}${j}`} x={t.x} y={t.y} s={t.s} pal={pal} />
            ))}
            {i === 0 && <Mist W={W} H={H} y={H * (base + 0.03)} clock={clock} k={2} ph={0.2} a={0.35} mist={pal.mist} />}
          </Group>
        ))}
        {[[0.1, 0.2, 0.9, 2, 0.1], [0.5, 0.14, 0.7, 2, 0.4], [0.3, 0.26, 1.1, 1, 0.7], [0.75, 0.3, 0.8, 1, 0.2]].map(([fx, fy, s, k, ph], i) => (
          <Bird key={`b${i}`} x0={W * fx} y={H * fy} s={s * (S + 0.55)} k={k} ph={ph} clock={clock} W={W} col={dawn ? 'rgba(40,20,60,0.75)' : 'rgba(20,40,70,0.7)'} />
        ))}
        <Path path={svgPath(`M0 ${H * 0.86}Q${W * 0.3} ${H * 0.84} ${W * 0.55} ${H * 0.865}T${W} ${H * 0.85}V${H}H0Z`)}>
          <LinearGradient start={vec(0, H * 0.82)} end={vec(0, H)} colors={pal.ground} />
        </Path>
        <Group transform={sway} origin={{ x: W / 2, y: H }}>
          <Path path={svgPath(geo.grass)} style="stroke" strokeWidth={2.2} strokeCap="round" color={rgba(pal.fern, 0.85)} />
        </Group>
        <Path path={svgPath(geo.stems)} style="stroke" strokeWidth={1.6} color={rgba(pal.fern, 0.8)} />
        {geo.flowers.map((f, i) => (
          <Flower key={`f${i}`} x={f.x} y={f.y} r={f.r} c={f.c} clock={clock} k={f.k} ph={f.ph} />
        ))}
        {geo.flies.map((f, i) => (
          <Flies key={`y${i}`} items={f.items} color={f.c} clock={clock} sw={3.2} />
        ))}
      </Group>
      <SceneFinish W={W} H={H} pal={pal} cool={cool} vig={0.34} />
    </Canvas>
  );
});

function Cactus({ x, y, s, col, rim }) {
  return (
    <>
      <RoundedRect x={x - 5 * s} y={y - 70 * s} width={10 * s} height={72 * s} r={5 * s} color={col} />
      <RoundedRect x={x - 22 * s} y={y - 40 * s} width={18 * s} height={8 * s} r={4 * s} color={col} />
      <RoundedRect x={x - 22 * s} y={y - 58 * s} width={8 * s} height={26 * s} r={4 * s} color={col} />
      <RoundedRect x={x + 4 * s} y={y - 52 * s} width={18 * s} height={8 * s} r={4 * s} color={col} />
      <RoundedRect x={x + 14 * s} y={y - 68 * s} width={8 * s} height={24 * s} r={4 * s} color={col} />
      <RoundedRect x={x + 2.4 * s} y={y - 66 * s} width={2.2 * s} height={62 * s} r={1.1 * s} color={rim} />
    </>
  );
}

function Tumble({ W, y, r, k, clock, col }) {
  const tf = useDerivedValue(() => {
    'worklet';
    const u = (clock.value * k) % 1;
    const x = u * (W + r * 4) - r * 2;
    const bob = Math.abs(Math.sin(clock.value * TAU * 20)) * r * 0.9;
    return [{ translateX: x }, { translateY: y - bob }, { rotate: x / r }];
  });
  return (
    <Group transform={tf}>
      <Circle cx={0} cy={0} r={r} style="stroke" strokeWidth={2} color={col}>
        <DashPathEffect intervals={[7, 4]} />
      </Circle>
      <Circle cx={0} cy={0} r={r * 0.66} style="stroke" strokeWidth={1.6} color={col}>
        <DashPathEffect intervals={[4, 5]} />
      </Circle>
      <Path path={svgPath(`M${-r} 0L${r} 0M0 ${-r}L0 ${r}`)} style="stroke" strokeWidth={1.4} color={col} />
    </Group>
  );
}

function SandDrift({ W, H, clock, col }) {
  const pts = useMemo(() => Array.from({ length: 46 }, (_, i) => ({ x: _h(i + 800) * W, y: H * (0.62 + _h(i + 850) * 0.36), m: 3 + (i % 4), w: 3 + _h(i + 880) * 9, l: 10 + _h(i + 900) * 22 })), [W, H]);
  const dots = useDerivedValue(() => {
    'worklet';
    const t = clock.value;
    return pts.map((p) => ({ x: (p.x + t * W * p.m) % W, y: p.y + Math.sin(t * TAU * 6 + p.x) * p.w }));
  });
  const streaks = useDerivedValue(() => {
    'worklet';
    const t = clock.value;
    const out = [];
    for (let i = 0; i < pts.length; i += 2) {
      const p = pts[i];
      const x = (p.x + t * W * (p.m + 2)) % W;
      const y = p.y + Math.sin(t * TAU * 5 + p.x) * p.w;
      out.push({ x, y }, { x: x - p.l, y: y + 0.6 });
    }
    return out;
  });
  return (
    <>
      <Points points={streaks} mode="lines" style="stroke" strokeWidth={1.4} strokeCap="round" color={`rgba(${col},0.3)`} />
      <Points points={dots} mode="points" style="stroke" strokeWidth={2} strokeCap="round" color={`rgba(${col},0.45)`} />
    </>
  );
}

const DesertScene = React.memo(function DesertScene({ W, H, clock, pal, flip, seed, cool }) {
  const S = W / 768;
  const sd = (seed || 1) * 97;
  const night = !!pal.night;
  const geo = useMemo(() => {
    const dp = pal.dunes.map((_, i) => [0.6 + i * 0.1, 0.05 - i * 0.008, 0.7 + i * 0.4, sd * 0.013 + i * 1.9]);
    const dd = dp.map((p) => waveD(W, H, p[0], p[1], p[2], p[3], H));
    const cacti = [[0.1, 2, 1.0], [0.88, 3, 1.25], [0.62, 1, 0.7], [0.3, 2, 0.8]].map(([u, li, s], i) => {
      const p = dp[li];
      const uu = Math.min(0.96, Math.max(0.04, u + (_h(i + sd) - 0.5) * 0.08));
      return { li, x: uu * W, y: waveAt(H, p[0], p[1], p[2], p[3], uu) + 4 * S, s: s * (S * 1.5 + 0.35) };
    });
    const stars = [[], [], []];
    for (let i = 0; i < 66; i++) stars[i % 3].push({ x: _h(i * 3 + 5 + sd) * W, y: _h(i * 3 + 9 + sd) * H * 0.42 });
    const mesas = [[0.04, 0.2, 0.09], [0.55, 0.24, 0.13], [0.82, 0.16, 0.075]]
      .map(([u, w, h]) => {
        const x = u * W, ww = w * W, hh = h * H, by = H * 0.64;
        return `M${x} ${by}L${x + ww * 0.06} ${by - hh}L${x + ww * 0.22} ${by - hh}L${x + ww * 0.26} ${by - hh * 0.72}L${x + ww * 0.74} ${by - hh * 0.72}L${x + ww * 0.78} ${by - hh}L${x + ww * 0.94} ${by - hh}L${x + ww} ${by}Z`;
      })
      .join('');
    const rocks = Array.from({ length: 6 }, (_, i) => ({ x: _h(i + 55 + sd) * W, y: H * (0.93 + _h(i + 66 + sd) * 0.06), w: W * (0.04 + _h(i + 77) * 0.05), h: H * (0.012 + _h(i + 88) * 0.014) }));
    return { dp, dd, cacti, stars, mesas, rocks };
  }, [W, H, sd, pal]);
  const sx = W * pal.sun[0];
  const sy = H * pal.sun[1];
  return (
    <Canvas pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, width: W, height: H }}>
      <Group transform={flip ? [{ translateX: W }, { scaleX: -1 }] : []}>
        <Rect x={0} y={0} width={W} height={H}>
          <LinearGradient start={vec(0, 0)} end={vec(0, H)} colors={pal.sky} positions={[0, 0.18, 0.34, 0.5, 0.62, 0.76]} />
        </Rect>
        <Group opacity={night ? 1 : 0.55}>
          {geo.stars.map((g, i) => (
            <Twinkle key={i} pts={g} k={[9, 14, 20][i]} ph={i * 0.31} clock={clock} sw={[2.2, 1.7, 1.3][i]} />
          ))}
        </Group>
        {night ? <Moon W={W} H={H} clock={clock} /> : <Sun x={sx} y={sy} r={W * 0.12} c={pal.sunc} clock={clock} />}
        <Path path={svgPath(geo.mesas)}>
          <LinearGradient start={vec(0, H * 0.5)} end={vec(0, H * 0.66)} colors={[rgba(pal.mesa, 0.55), rgba(pal.mesa, 0.95)]} />
        </Path>
        <Mist W={W} H={H} y={H * 0.58} clock={clock} k={2} ph={0.1} a={0.3} mist={pal.mist} />
        {geo.dd.map((p, i) => (
          <Group key={`d${i}`}>
            <Path path={svgPath(p.fill)}>
              <LinearGradient start={vec(0, H * (geo.dp[i][0] - 0.05))} end={vec(0, H)} colors={pal.dunes[i]} />
            </Path>
            <Path path={svgPath(p.top)} style="stroke" strokeWidth={2.2} color={`rgba(${pal.crest},${night ? 0.5 : 0.65})`} />
            {geo.cacti.filter((c) => c.li === i).map((c, j) => (
              <Cactus key={`c${i}${j}`} x={c.x} y={c.y} s={c.s} col={pal.cactus} rim={`rgba(${pal.crest},0.45)`} />
            ))}
            {i === 0 && <Mist W={W} H={H} y={H * 0.66} clock={clock} k={3} ph={0.5} a={0.22} mist={pal.mist} />}
          </Group>
        ))}
        {geo.rocks.map((r, i) => (
          <Oval key={`r${i}`} x={r.x} y={r.y} width={r.w} height={r.h} color={pal.cactus} />
        ))}
        <Tumble W={W} y={H * 0.915} r={W * 0.035} k={1} clock={clock} col={`rgba(${pal.sand},0.6)`} />
        <SandDrift W={W} H={H} clock={clock} col={pal.sand} />
      </Group>
      <SceneFinish W={W} H={H} pal={pal} cool={cool} vig={0.42} />
    </Canvas>
  );
});

/* ---------- storm: rain, puddle ripples, lightning, dark cloud deck (drawn inside ForestScene for realm 6) ---------- */
function Rain({ W, H, clock, n, m, len, sw, col, slant }) {
  const seeds = useMemo(
    () => Array.from({ length: n }, (_, i) => ({ x: _h(i + 1300 + n) * (W + H * slant), y: _h(i + 1700 + n) * H, m: m + (i % 5), l: len * (0.7 + _h(i + 2100 + n) * 0.6) })),
    [W, H, n, m, len, slant]
  );
  const pts = useDerivedValue(() => {
    'worklet';
    const t = clock.value;
    const out = [];
    for (let i = 0; i < seeds.length; i++) {
      const s = seeds[i];
      const y = (s.y + t * H * s.m) % H;
      const x = s.x - y * slant;
      out.push({ x, y }, { x: x - s.l * slant, y: y + s.l });
    }
    return out;
  });
  return <Points points={pts} mode="lines" style="stroke" strokeWidth={sw} strokeCap="round" color={col} />;
}

function Ripple({ cx, cy, rw, ph, k, clock }) {
  const tf = useDerivedValue(() => {
    'worklet';
    const p = (clock.value * k + ph) % 1;
    return [{ scale: 0.15 + p * 0.85 }];
  });
  const op = useDerivedValue(() => {
    'worklet';
    const p = (clock.value * k + ph) % 1;
    return (1 - p) * 0.6;
  });
  return (
    <Group transform={tf} origin={{ x: cx, y: cy }} opacity={op}>
      <Oval x={cx - rw} y={cy - rw * 0.22} width={rw * 2} height={rw * 0.44} style="stroke" strokeWidth={1.6} color="rgba(220,240,255,0.9)" />
    </Group>
  );
}

function Bolt({ W, H, x, ph, clock, seed }) {
  const d = useMemo(() => {
    let s = `M${x} 0`;
    let cx = x;
    const n = 9;
    const dy = (H * 0.52) / n;
    let br = '';
    for (let i = 1; i <= n; i++) {
      cx += (_h(i * 7 + seed + x) - 0.5) * W * 0.12;
      s += `L${cx} ${dy * i}`;
      if (i === 4) br = `M${cx} ${dy * i}L${cx + W * 0.07} ${dy * (i + 1.5)}L${cx + W * 0.05} ${dy * (i + 3)}`;
    }
    return s + br;
  }, [W, H, x, seed]);
  const op = useDerivedValue(() => {
    'worklet';
    const p = (clock.value + ph) % 1;
    if (p < 0.004) return 1;
    if (p > 0.008 && p < 0.014) return 0.75;
    if (p > 0.014 && p < 0.03) return 0.5 * (1 - (p - 0.014) / 0.016);
    return 0;
  });
  const path = useMemo(() => svgPath(d), [d]);
  return (
    <Group opacity={op}>
      <Rect x={0} y={0} width={W} height={H} color="rgba(190,215,255,0.5)" />
      <Path path={path} style="stroke" strokeWidth={9} strokeCap="round" strokeJoin="round" color="rgba(170,200,255,0.3)" />
      <Path path={path} style="stroke" strokeWidth={2.6} strokeCap="round" strokeJoin="round" color="#ffffff" />
    </Group>
  );
}

function StormClouds({ W, H, clock }) {
  return (
    <>
      <Rect x={0} y={0} width={W} height={H * 0.5}>
        <LinearGradient start={vec(0, 0)} end={vec(0, H * 0.5)} colors={['rgba(4,10,16,0.85)', 'rgba(8,20,28,0.55)', 'rgba(8,20,28,0)']} />
      </Rect>
      {[[0.0, 0.03, 0.7, 1], [0.45, 0.06, 0.6, 1], [0.2, 0.13, 0.8, 2], [0.7, 0.16, 0.6, 2]].map(([fx, fy, fw, k], i) => (
        <Cloud key={i} x0={W * fx} y={H * fy} w={W * fw} k={k} clock={clock} W={W} col="14,26,36" a={0.8} sh="rgba(60,90,110,0.3)" />
      ))}
    </>
  );
}

function StormFX({ W, H, clock }) {
  return (
    <>
      <Rain W={W} H={H} clock={clock} n={60} m={22} len={16} sw={1} col="rgba(190,220,255,0.26)" slant={0.18} />
      <Rain W={W} H={H} clock={clock} n={34} m={30} len={32} sw={1.8} col="rgba(225,242,255,0.5)" slant={0.18} />
      {[[0.2, 0.93, 0.06, 0], [0.55, 0.96, 0.07, 0.33], [0.8, 0.91, 0.05, 0.66], [0.38, 0.89, 0.045, 0.5], [0.9, 0.97, 0.06, 0.15], [0.1, 0.985, 0.05, 0.8]].map(([fx, fy, fw, ph], i) => (
        <Ripple key={i} cx={W * fx} cy={H * fy} rw={W * fw} ph={ph} k={12} clock={clock} />
      ))}
      <Bolt W={W} H={H} x={W * 0.25} ph={0.9} clock={clock} seed={3} />
      <Bolt W={W} H={H} x={W * 0.72} ph={0.57} clock={clock} seed={8} />
      <Bolt W={W} H={H} x={W * 0.45} ph={0.23} clock={clock} seed={5} />
    </>
  );
}

// the right scene for the realm. 4 + 7 = open sky (day / dawn), 5 = desert, 6 = storm (grove art + rain), the rest = the original forest
function WorldScene({ realm, bio, W, H, clock, cool }) {
  const pal = PALS[Math.min(PALS.length - 1, realm * 2 + (bio.v & 1))];
  const c = { W, H, clock, pal, flip: !!(bio.v & 2), seed: bio.seed, cool };
  if (realm === 4 || realm === 7) return <MeadowScene {...c} />;
  if (realm === 5) return <DesertScene {...c} />;
  return <ForestScene {...c} realm={realm} />;
}

/* ---------- world map: every realm gets its own sky ---------- */
const BAND_G = [
  ['#140e46', '#2a1c78', '#173d68'], // grove
  ['#12307a', '#1d63b4', '#168a9a'], // lake
  ['#5a9ae0', '#9ccdf4', '#dff2ff'], // frost
  ['#2a0a5a', '#7a1aa8', '#c02a9a'], // neon
  ['#2a6ad0', '#6ab4ee', '#f4e0a8'], // meadow
  ['#2a1470', '#c0357a', '#ff9a4a'], // desert
  ['#0c1a24', '#1c3c48', '#2e5a60'], // storm
  ['#3a2a7a', '#e06a8a', '#ffc27a'], // dawn
];
function bandDeco(realm, w, h) {
  const R = (i, s = 0) => _h(i * 13 + s * 101 + realm * 7 + 3);
  const dots = (n, ymax, s) => Array.from({ length: n }, (_, i) => ({ x: R(i, s) * w, y: R(i, s + 1) * h * ymax }));
  const glow = (key, x, y, r, c, a) => (
    <Circle key={key} cx={x} cy={y} r={r}>
      <RadialGradient c={vec(x, y)} r={r} colors={[`rgba(${c},${a})`, `rgba(${c},0)`]} />
    </Circle>
  );
  const cloud = (key, x, y, s, c) => (
    <Group key={key}>
      <Oval x={x} y={y + s * 0.2} width={s * 1.6} height={s * 0.5} color={c} />
      <Circle cx={x + s * 0.55} cy={y + s * 0.2} r={s * 0.34} color={c} />
      <Circle cx={x + s * 0.95} cy={y + s * 0.28} r={s * 0.27} color={c} />
    </Group>
  );
  const out = [];
  if (realm === 0) {
    for (let i = 0; i < 7; i++) out.push(glow(`g${i}`, R(i, 4) * w, R(i, 5) * h, 40 + R(i, 6) * 40, '255,122,217', 0.2));
    out.push(<Points key="st" points={dots(24, 0.5, 8)} mode="points" style="stroke" strokeWidth={2} strokeCap="round" color="rgba(255,255,255,0.65)" />);
  } else if (realm === 1) {
    out.push(glow('m', w * 0.78, h * 0.14, 90, '210,230,255', 0.5));
    for (let i = 0; i < 9; i++) out.push(<Oval key={`rf${i}`} x={R(i, 2) * w * 0.8} y={h * (0.5 + R(i, 3) * 0.45)} width={w * (0.1 + R(i, 4) * 0.2)} height={3} color="rgba(220,240,255,0.18)" />);
    out.push(<Points key="st" points={dots(18, 0.4, 9)} mode="points" style="stroke" strokeWidth={2} strokeCap="round" color="rgba(255,255,255,0.7)" />);
  } else if (realm === 2) {
    out.push(<Points key="sn" points={dots(70, 1, 11)} mode="points" style="stroke" strokeWidth={3} strokeCap="round" color="rgba(255,255,255,0.8)" />);
    out.push(glow('g', w * 0.3, h * 0.3, 120, '255,255,255', 0.3));
  } else if (realm === 3) {
    let d = '';
    for (let y = 30; y < h; y += 46) d += `M0 ${y}L${w} ${y}`;
    for (let x = 0; x <= w; x += 46) d += `M${x} 0L${x} ${h}`;
    out.push(<Path key="grid" path={svgPath(d)} style="stroke" strokeWidth={1} color="rgba(0,240,255,0.14)" />);
    out.push(glow('a', w * 0.2, h * 0.3, 110, '255,60,200', 0.3));
    out.push(glow('b', w * 0.85, h * 0.65, 110, '0,220,255', 0.25));
  } else if (realm === 4) {
    out.push(glow('s', w * 0.78, h * 0.14, 110, '255,240,190', 0.7));
    for (let i = 0; i < 4; i++) out.push(cloud(`c${i}`, R(i, 2) * w * 0.7, h * (0.05 + i * 0.2 + R(i, 3) * 0.06), 60 + R(i, 4) * 40, 'rgba(255,255,255,0.8)'));
    out.push(<Path key="hl" path={svgPath(waveD(w, h, 0.93, 0.02, 1.4, 1.3, h).fill)} color="rgba(30,130,60,0.5)" />);
  } else if (realm === 5) {
    out.push(<Points key="st" points={dots(16, 0.3, 12)} mode="points" style="stroke" strokeWidth={2} strokeCap="round" color="rgba(255,235,200,0.7)" />);
    out.push(glow('s', w * 0.3, h * 0.5, 120, '255,170,90', 0.55));
    out.push(<Path key="d1" path={svgPath(waveD(w, h, 0.8, 0.03, 1.2, 0.6, h).fill)} color="rgba(210,100,50,0.35)" />);
    out.push(<Path key="d2" path={svgPath(waveD(w, h, 0.9, 0.025, 1.6, 2.2, h).fill)} color="rgba(120,40,40,0.4)" />);
  } else if (realm === 6) {
    for (let i = 0; i < 5; i++) out.push(<Oval key={`k${i}`} x={R(i, 2) * w * 0.8 - 20} y={h * (0.02 + i * 0.09)} width={w * (0.4 + R(i, 3) * 0.4)} height={50 + R(i, 4) * 30} color="rgba(6,14,20,0.45)" />);
    let d = '';
    for (let i = 0; i < 70; i++) {
      const x = R(i, 7) * (w + 60);
      const y = R(i, 8) * h;
      d += `M${x} ${y}L${x - 5} ${y + 16}`;
    }
    out.push(<Path key="rn" path={svgPath(d)} style="stroke" strokeWidth={1.2} strokeCap="round" color="rgba(200,225,255,0.22)" />);
  } else {
    out.push(<Points key="st" points={dots(14, 0.25, 13)} mode="points" style="stroke" strokeWidth={2} strokeCap="round" color="rgba(255,255,255,0.6)" />);
    out.push(glow('s', w * 0.5, h * 0.9, 190, '255,210,140', 0.7));
    for (let i = 0; i < 4; i++) out.push(<Oval key={`st${i}`} x={R(i, 2) * w * 0.6} y={h * (0.2 + i * 0.17)} width={w * (0.5 + R(i, 3) * 0.4)} height={9} color="rgba(255,190,170,0.35)" />);
  }
  return out;
}
const RealmBand = React.memo(function RealmBand({ realm, w, top, h, locked, ft, fb }) {
  const g = BAND_G[realm] || BAND_G[0];
  const A = 0.86;
  const f = Math.min(0.2, 70 / h);
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: -40, width: w, top, height: h }}>
      <Canvas style={{ width: w, height: h }}>
        <Rect x={0} y={0} width={w} height={h}>
          <LinearGradient start={vec(0, 0)} end={vec(0, h)} colors={[rgba(g[0], ft ? A : 0), rgba(g[0], A), rgba(g[1], A), rgba(g[2], A), rgba(g[2], fb ? A : 0)]} positions={[0, f, 0.5, 1 - f, 1]} />
        </Rect>
        {bandDeco(realm, w, h)}
        {locked ? <Rect x={0} y={0} width={w} height={h} color="rgba(6,4,28,0.3)" /> : null}
      </Canvas>
    </View>
  );
});

const ForestScene = React.memo(function ForestScene({ W, H, clock, pal, flip, seed, cool, realm }) {
  const S = W / 768;
  const sd = (seed || 1) * 97;
  const coolOp = useDerivedValue(() => {
    'worklet';
    return cool.value;
  });
  const bokeh = useMemo(
    () => Array.from({ length: 18 }, (_, i) => ({ x: _h(i + 1 + sd) * W, y: (0.3 + _h(i + 40 + sd) * 0.6) * H, r: (0.04 + _h(i + 80 + sd) * 0.06) * W, c: pal.fl[i % 5] })),
    [W, H, sd, pal]
  );
  const stars = useMemo(() => {
    const g = [[], [], []];
    for (let i = 0; i < 84; i++) g[i % 3].push({ x: _h(i * 3 + 5 + sd) * W, y: _h(i * 3 + 9 + sd) * H * 0.5 });
    return g;
  }, [W, H, sd]);
  const flies = useMemo(
    () =>
      pal.flies.map((c, ci) => ({
        c,
        items: Array.from({ length: 10 }, (_, i) => {
          const n = ci * 10 + i;
          return { x: _h(n + 200 + sd) * W, y: (0.26 + _h(n + 300 + sd) * 0.66) * H, ax: 6 + _h(n + 400) * 18, ay: 8 + _h(n + 500) * 22, kx: 2 + (n % 3), ky: 2 + ((n + 1) % 3), p1: _h(n + 600) * 6.28, p2: _h(n + 700) * 6.28 };
        }),
      })),
    [W, H, sd, pal]
  );
  const blobs = useMemo(
    () => [0, 1, 2].map((row) => Array.from({ length: 9 }, (_, i) => ({ x: (i / 8) * W + (_h(i + row * 11 + sd) - 0.5) * 0.08 * W, y: (0.5 + row * 0.075) * H + _h(i + row * 17 + sd) * 0.03 * H, r: (0.1 + _h(i + row * 23 + sd) * 0.06) * W }))),
    [W, H, sd]
  );
  const rowCols = [rgba(pal.row, 0.5), rgba(pal.row, 0.65), rgba(pal.row, 0.8)];
  const sparks = [[0.28, 0.2, 8], [0.7, 0.16, 6], [0.5, 0.3, 5], [0.14, 0.34, 6], [0.86, 0.36, 5]];
  const r = realm || 0;
  return (
    <Canvas pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, width: W, height: H }}>
      <Group transform={flip ? [{ translateX: W }, { scaleX: -1 }] : []}>
        <Rect x={0} y={0} width={W} height={H}>
          <LinearGradient start={vec(0, 0)} end={vec(0, H)} colors={pal.sky} positions={[0, 0.14, 0.28, 0.48, 0.64, 0.82, 1]} />
        </Rect>
        <Circle cx={W * 0.2} cy={H * 0.07} r={W * 0.6}>
          <RadialGradient c={vec(W * 0.2, H * 0.07)} r={W * 0.6} colors={[pal.neb[0], pal.neb[1], 'rgba(0,0,0,0)']} />
        </Circle>
        <Circle cx={W * 0.85} cy={H * 0.2} r={W * 0.65}>
          <RadialGradient c={vec(W * 0.85, H * 0.2)} r={W * 0.65} colors={[pal.neb2[0], pal.neb2[1], 'rgba(0,0,0,0)']} />
        </Circle>
        <Circle cx={W * 0.5} cy={H * 0.5} r={W * 0.8}>
          <RadialGradient c={vec(W * 0.5, H * 0.5)} r={W * 0.8} colors={[rgba(pal.row, 0.35), 'rgba(0,0,0,0)']} />
        </Circle>
        {r === 2 && <Aurora W={W} H={H} clock={clock} />}
        {r === 1 && <Moon W={W} H={H} clock={clock} />}
        {r === 6 && <StormClouds W={W} H={H} clock={clock} />}
        {r !== 6 && stars.map((g, i) => (
          <Twinkle key={i} pts={g} k={[9, 14, 20][i]} ph={i * 0.31} clock={clock} sw={[2.2, 1.7, 1.3][i]} />
        ))}
        {r !== 6 && sparks.map(([fx, fy, sz], i) => (
          <Group key={i} transform={[{ translateX: fx * W }, { translateY: fy * H }, { scale: sz }]} opacity={0.9}>
            <Path path={svgPath(SPARK_D)} color="#ffffff" />
          </Group>
        ))}
        {r !== 6 && (<>
        <ShootingStar x0={W * 0.26} y0={H * 0.2} dx={W * 0.22} dy={-H * 0.07} K={4} ph={0.1} clock={clock} />
        <ShootingStar x0={W * 0.55} y0={H * 0.17} dx={W * 0.24} dy={-H * 0.06} K={5} ph={0.55} clock={clock} />
        <ShootingStar x0={W * 0.1} y0={H * 0.1} dx={W * 0.2} dy={-H * 0.04} K={3} ph={0.8} clock={clock} />
        </>)}
        <RoundedRect x={-W * 0.03} y={-10} width={W * 0.085} height={H * 0.5} r={W * 0.04} color="rgba(4,8,30,0.82)" />
        <Path path={svgPath(`M${W * 0.04} ${H * 0.1}Q${W * 0.16} ${H * 0.08} ${W * 0.26} ${H * 0.14}M${W * 0.03} ${H * 0.18}Q${W * 0.12} ${H * 0.2} ${W * 0.2} ${H * 0.27}`)} style="stroke" strokeWidth={W * 0.018} strokeCap="round" color="rgba(4,8,30,0.8)" />
        {[[0.1, 0.1, 0.1], [0.2, 0.15, 0.08], [0.06, 0.22, 0.09], [0.16, 0.26, 0.07]].map(([fx, fy, fr], i) => (
          <Circle key={i} cx={W * fx} cy={H * fy} r={W * fr} color={rgba(pal.row, 0.85)} />
        ))}
        <RoundedRect x={W * 0.9} y={H * 0.18} width={W * 0.07} height={H * 0.4} r={W * 0.03} color="rgba(4,14,36,0.7)" />
        <JungleBack W={W} H={H} clock={clock} pal={pal} />
        {blobs.map((row, ri) => row.map((b, i) => <Circle key={`${ri}-${i}`} cx={b.x} cy={b.y} r={b.r} color={rowCols[ri]} />))}
        {bokeh.map((b, i) => (
          <Circle key={`bk${i}`} cx={b.x} cy={b.y} r={b.r}>
            <RadialGradient c={vec(b.x, b.y)} r={b.r} colors={[rgba(b.c, 0.22), rgba(b.c, 0)]} />
          </Circle>
        ))}
        <Mushroom cx={W * 0.9} by={H * 0.66} cw={W * 0.44} ch={H * 0.12} sw={W * 0.07} sh={H * 0.22} c1={pal.m1[0]} c2={pal.m1[1]} glow={pal.m1[2]} />
        <Mushroom cx={W * 0.9} by={H * 0.64} cw={W * 0.17} ch={H * 0.04} sw={W * 0.03} sh={H * 0.1} c1={pal.m2[0]} c2={pal.m2[1]} glow={pal.m2[2]} />
        <Mushroom cx={W * 0.03} by={H * 0.76} cw={W * 0.28} ch={H * 0.075} sw={W * 0.045} sh={H * 0.11} c1={pal.m1[0]} c2={pal.m1[1]} glow={pal.m1[2]} />
        <Fern x={W * 0.86} y={H * 0.8} sc={1.15 * S + 0.25} color={pal.fern} />
        <Fern x={W * 0.95} y={H * 0.7} sc={0.9 * S + 0.2} color={pal.fern} fan={[-1.0, -0.6, -0.2, 0.2]} />
        <Fern x={W * 0.08} y={H * 0.82} sc={0.95 * S + 0.2} color={pal.fern} />
        <Fern x={W * 0.58} y={H * 0.98} sc={0.8 * S + 0.2} color={pal.fern} />
        <Path path={svgPath(`M0 ${H * 0.865}Q${W * 0.25} ${H * 0.82} ${W * 0.5} ${H * 0.855}T${W} ${H * 0.84}V${H}H0Z`)}>
          <LinearGradient start={vec(0, H * 0.82)} end={vec(0, H)} colors={pal.ground} />
        </Path>
        <Oval x={W * 0.15} y={H * 0.9} width={W * 0.6} height={H * 0.1} color={rgba(pal.row, 0.25)} />
        {r === 1 && <Ripples W={W} H={H} clock={clock} />}
        {r === 2 && <IceSpikes W={W} H={H} />}
        {r === 3 && <NeonGrid W={W} H={H} clock={clock} />}
        {[[0.085, 0.935, 0.1, 0.1, -0.16], [0.44, 0.86, 0.075, 0.09, 0.08], [0.29, 0.93, 0.07, 0.07, -0.05], [0.64, 0.925, 0.085, 0.09, 0.14], [0.74, 0.985, 0.09, 0.08, -0.1]].map(([fx, fy, fw, fh, rot], i) => (
          <Stone key={i} x={W * fx} y={H * fy} w={W * fw} h={H * fh} rot={rot} clock={clock} k={i} />
        ))}
        <SpinRing cx={W * 0.43} cy={H * 0.865} r={W * 0.065} color={pal.ring[0]} clock={clock} dir={1} dash={[5, 9]} />
        <SpinRing cx={W * 0.415} cy={H * 0.955} r={W * 0.08} color={pal.ring[1]} clock={clock} dir={-1} dash={[4, 7]} />
        <JungleFront W={W} H={H} clock={clock} pal={pal} />
        {flies.map((f, i) => (
          <Flies key={i} items={f.items} color={f.c} clock={clock} sw={3.2} />
        ))}
        {r === 2 && <Snow W={W} H={H} clock={clock} />}
        {r === 6 && <StormFX W={W} H={H} clock={clock} />}
      </Group>
      <Rect x={0} y={0} width={W} height={H}>
        <RadialGradient c={vec(W / 2, H * 0.48)} r={H * 0.78} colors={['rgba(2,4,24,0)', 'rgba(2,4,24,0)', 'rgba(2,4,24,0.6)']} positions={[0, 0.55, 1]} />
      </Rect>
      <Group opacity={coolOp}>
        <Rect x={0} y={0} width={W} height={H}>
          <LinearGradient start={vec(0, 0)} end={vec(0, H)} colors={[`rgba(${pal.tint},0)`, `rgba(${pal.tint},0.1)`, `rgba(${pal.tint},0.26)`]} />
        </Rect>
      </Group>
    </Canvas>
  );
});

function Scene({ realm, width, height }) {
  const W = width;
  const tri = (left, base, h, color, bottom = 0) => ({
    position: 'absolute', left, bottom, width: 0, height: 0,
    borderLeftWidth: base, borderRightWidth: base, borderBottomWidth: h,
    borderLeftColor: 'transparent', borderRightColor: 'transparent', borderBottomColor: color,
  });
  if (realm === 0) {
    const stars = Array.from({ length: 30 }, (_, i) => ({
      x: ((i * 37 + 11) % 97) / 97 * W,
      y: ((i * 53 + 7) % 61) / 100 * height,
      z: 2 + (i % 3),
      o: 0.45 + ((i * 17) % 50) / 100,
    }));
    const bush = [[-0.05, 90, 70], [0.12, 110, 90], [0.3, 80, 60], [0.55, 100, 80], [0.74, 120, 100], [0.92, 90, 70]];
    const fire = [[0.12, 0.74, '#ffe98a'], [0.28, 0.82, '#7ff3e0'], [0.46, 0.78, '#ffe98a'], [0.63, 0.86, '#ff9bec'], [0.8, 0.76, '#7ff3e0'], [0.9, 0.84, '#ffe98a'], [0.2, 0.9, '#ff9bec'], [0.7, 0.92, '#ffe98a']];
    const ember = [[0.18, 0.5], [0.34, 0.42], [0.78, 0.46], [0.86, 0.58], [0.1, 0.62], [0.64, 0.36]];
    return (
      <>
        <View style={{ position: 'absolute', right: -30, top: 30, width: 190, height: 190, borderRadius: 190, backgroundColor: 'rgba(190,210,255,0.14)' }} />
        <View style={{ position: 'absolute', right: 8, top: 70, width: 100, height: 100, borderRadius: 100, backgroundColor: 'rgba(225,235,255,0.20)' }} />
        {stars.map((st, i) => (
          <View key={`s${i}`} style={{ position: 'absolute', left: st.x, top: st.y, width: st.z, height: st.z, borderRadius: st.z, backgroundColor: '#fff', opacity: st.o }} />
        ))}
        <View style={tri(-40, 120, 210, '#0e2a45', 0)} />
        <View style={tri(W - 150, 120, 240, '#0e2a45', 0)} />
        <View style={tri(W * 0.5 - 60, 90, 150, '#102f48', 0)} />
        <View style={{ position: 'absolute', left: -W * 0.1, bottom: -120, width: W * 1.2, height: 240, borderRadius: 240, backgroundColor: '#1d6b4a' }} />
        <View style={{ position: 'absolute', left: W * 0.1, bottom: -150, width: W * 1.1, height: 240, borderRadius: 240, backgroundColor: '#2a9a55' }} />
        {bush.map(([x, w, h], i) => (
          <View key={`b${i}`} style={{ position: 'absolute', left: W * x, bottom: -h * 0.35, width: w, height: h, borderRadius: w, backgroundColor: i % 2 ? '#0c3a3f' : '#0a2f3a' }} />
        ))}
        {fire.map(([x, y, c], i) => (
          <View key={`f${i}`} style={{ position: 'absolute', left: W * x, top: height * y }}>
            <View style={{ position: 'absolute', left: -6, top: -6, width: 16, height: 16, borderRadius: 16, backgroundColor: c, opacity: 0.22 }} />
            <View style={{ width: 4, height: 4, borderRadius: 4, backgroundColor: c, opacity: 0.95 }} />
          </View>
        ))}
        {ember.map(([x, y], i) => (
          <View key={`e${i}`} style={{ position: 'absolute', left: W * x, top: height * y, width: 3, height: 7, borderRadius: 3, backgroundColor: 'rgba(255,150,60,0.8)', transform: [{ rotate: '35deg' }] }} />
        ))}
      </>
    );
  }
  if (realm === 1) {
    return (
      <>
        <View style={{ position: 'absolute', left: 28, top: 70, width: 70, height: 70, borderRadius: 70, backgroundColor: '#fffbe0', opacity: 0.95 }} />
        {[[0.3, 0.07], [0.55, 0.12], [0.8, 0.06], [0.68, 0.2], [0.2, 0.22]].map(([x, y], i) => (
          <View key={i} style={{ position: 'absolute', left: W * x, top: height * y, width: 4, height: 4, borderRadius: 4, backgroundColor: '#fff', opacity: 0.8 }} />
        ))}
        <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 130, backgroundColor: 'rgba(255,255,255,0.14)' }} />
        <View style={{ position: 'absolute', left: -20, right: -20, bottom: 100, height: 60, borderRadius: 60, backgroundColor: 'rgba(255,255,255,0.10)' }} />
      </>
    );
  }
  if (realm === 2) {
    return (
      <>
        <View style={tri(-30, 150, 230, 'rgba(255,255,255,0.40)')} />
        <View style={tri(W * 0.35, 170, 290, 'rgba(255,255,255,0.55)')} />
        <View style={tri(W * 0.7, 120, 190, 'rgba(255,255,255,0.35)')} />
        {[[0.15, 0.1], [0.5, 0.05], [0.85, 0.14], [0.35, 0.2], [0.72, 0.28]].map(([x, y], i) => (
          <View key={i} style={{ position: 'absolute', left: W * x, top: height * y, width: 6, height: 6, borderRadius: 6, backgroundColor: '#fff', opacity: 0.85 }} />
        ))}
      </>
    );
  }
  const bld = [[0.02, 60, 150], [0.16, 48, 220], [0.3, 70, 130], [0.5, 52, 250], [0.64, 66, 170], [0.82, 56, 210]];
  return (
    <>
      {bld.map(([x, w, h], i) => (
        <View key={i} style={{ position: 'absolute', left: W * x, bottom: 0, width: w, height: h, backgroundColor: 'rgba(25,0,70,0.72)' }}>
          {[0, 1, 2, 3, 4].map((j) => (
            <View key={j} style={{ position: 'absolute', left: 8 + (j % 2) * 22, top: 12 + j * 26, width: 8, height: 10, backgroundColor: (i + j) % 3 === 0 ? 'rgba(255,230,120,0.9)' : 'rgba(255,120,230,0.55)' }} />
          ))}
        </View>
      ))}
    </>
  );
}

function Confetti({ w = 320, h = 520, n = 26 }) {
  const t = useRef(new Animated.Value(0)).current;
  const P = useRef(Array.from({ length: n }, (_, i) => ({
    x: Math.random() * w, d: Math.random() * 0.35, s: 6 + Math.random() * 6,
    sw: (Math.random() - 0.5) * 70, rot: 2 + Math.random() * 4,
    col: ['#ff4d6d', '#ffd23b', '#3bd6ff', '#7dff6b', '#c46bff'][i % 5],
  }))).current;
  useEffect(() => {
    Animated.timing(t, { toValue: 1, duration: 2600, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  }, []);
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, width: w, height: h, overflow: 'hidden' }}>
      {P.map((p, i) => (
        <Animated.View
          key={i}
          style={{
            position: 'absolute', left: p.x, top: -20, width: p.s, height: p.s * 0.5, backgroundColor: p.col,
            opacity: t.interpolate({ inputRange: [0, p.d, p.d + 0.05, 0.85, 1], outputRange: [0, 0, 1, 1, 0] }),
            transform: [
              { translateY: t.interpolate({ inputRange: [0, 1], outputRange: [0, h + 40] }) },
              { translateX: t.interpolate({ inputRange: [0, 1], outputRange: [0, p.sw] }) },
              { rotate: t.interpolate({ inputRange: [0, 1], outputRange: ['0deg', `${p.rot * 360}deg`] }) },
            ],
          }}
        />
      ))}
    </View>
  );
}

function CountUp({ to, style }) {
  const [v, setV] = useState(0);
  useEffect(() => {
    const a = new Animated.Value(0);
    const id = a.addListener(({ value }) => setV(Math.round(value)));
    Animated.timing(a, { toValue: to, duration: Math.min(1400, 400 + to / 4), easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
    return () => a.removeListener(id);
  }, [to]);
  return <Text style={style}>{v}</Text>;
}

const MAP_W = 300, NODE = 58, NODE_H = 78, HEAD_H = 112;
// the first node of a realm sits straight above the last node of the one before it, so the bridge between them runs vertically
const nodeX = (L) => (L > 1 && secOf(L) !== secOf(L - 1) ? nodeX(L - 1) : MAP_W / 2 + Math.sin((L - 1) * 0.95) * 86);
// FLIPPED_MAP
const nodeTop = (L) => 46 + (L - 1) * NODE_H + secOf(L) * HEAD_H;
const mapH = () => nodeTop(MAX_LEVEL) + NODE_H + 70;
const nodeY = (L) => nodeTop(MAX_LEVEL) - nodeTop(L) + 46; // level 1 at the bottom, MAX at the top
const secName = (L) => REALMS[realmOf(L)].name + (L > 20 && realmOf(L) < 4 ? ' II' : '');
// ---- realm covers, outer-layer scenery and bridges ----
const REALM_CREST = ['🍄', '🌊', '🏔️', '🌆', '🌻', '🌵', '⛈️', '🌅'];
const REALM_TEASE = [
  'Glowing mushrooms. Watchful owls.',
  'Rocks creep in. The Lake Spirit waits.',
  'Rocks rain down. Cracks run deep.',
  'Five colors. One final boss.',
  'Sunlit hills. A breeze full of butterflies.',
  'Hot sand. Long shadows. Hidden rocks.',
  'Thunder rolls. The rain never stops.',
  'First light on the peaks. Everything glows.',
];
// scenery that fills the empty edges of the map, one set per realm (skulls and bones included)
const REALM_PROPS = [
  ['🍄', '🦉', '🌳', '🕸️', '💀', '🦇', '🌿', '🕯️', '🍂'],
  ['🌾', '🐸', '🛶', '🦴', '💀', '🐚', '🦆', '🌿', '🪨'],
  ['🧊', '❄️', '🌲', '💀', '🦴', '⛄', '🐧', '🏔️', '🪨'],
  ['🏙️', '🤖', '📡', '🛸', '⚡', '🔌', '💿', '🧪', '👾'],
  ['🌻', '🦋', '🐝', '🌼', '🐞', '🌳', '🐇', '🌷', '☁️'],
  ['🌵', '🐪', '🦂', '🏜️', '🦎', '🪨', '🌴', '☀️', '🦴'],
  ['🌧️', '☔', '🐸', '⚡', '🍃', '🌿', '🦆', '🪵', '🌫️'],
  ['🌅', '🐓', '🦌', '🌾', '🕊️', '🌸', '🦉', '🌄', '🍃'],
];
// one bridge look per realm: root bridge, rope-and-plank over water, ice span, neon light bridge
const BRIDGE = [
  { plank: '#4a331d', plank2: '#6b4a2b', rail: '#7bd13b', post: '🍄', band: 'rgba(24,8,52,0.62)', edge: '#c9ff7a', deco: ['🕸️', '🦇', '🍄', '🕸️', '🦇'] },
  { plank: '#8a5e33', plank2: '#b27d46', rail: '#f0dcae', post: '🏮', band: 'rgba(16,88,168,0.58)', edge: '#7ff3e0', deco: ['🌾', '🐸', '🌾', '🦆', '🌾'] },
  { plank: '#bfe6fa', plank2: '#e4f6ff', rail: '#ffffff', post: '❄️', band: 'rgba(110,180,236,0.52)', edge: '#ffffff', deco: ['🧊', '❄️', '🧊', '❄️', '🧊'] },
  { plank: '#2b0e5c', plank2: '#5a1fa8', rail: '#00f5ff', post: '⚡', band: 'rgba(22,6,66,0.7)', edge: '#ff9bec', deco: ['⚡', '📡', '⚡', '🔌', '⚡'], neon: true },
  { plank: '#9a7a4a', plank2: '#c29a5a', rail: '#fff6d0', post: '🌻', band: 'rgba(90,190,255,0.5)', edge: '#ffffff', deco: ['🌼', '🦋', '🌼', '🐝', '🌼'] },
  { plank: '#a8683a', plank2: '#d08a4a', rail: '#ffd9a0', post: '🌵', band: 'rgba(200,90,40,0.5)', edge: '#ffc080', deco: ['🌵', '🐪', '🌵', '🦂', '🌵'] },
  { plank: '#3a4a4a', plank2: '#5a6e6e', rail: '#9fd0ff', post: '🪵', band: 'rgba(30,60,80,0.62)', edge: '#9fd0ff', deco: ['🌧️', '🐸', '🌿', '🌧️', '🍃'] },
  { plank: '#b0707a', plank2: '#e09a8a', rail: '#ffe0b0', post: '🌸', band: 'rgba(255,140,110,0.5)', edge: '#ffe0b0', deco: ['🌸', '🕊️', '🌸', '🌾', '🌸'] },
];
const BRIDGE_W = 46;
function Bridge({ cx, top, h, realm, open, float }) {
  const B = BRIDGE[realm];
  const n = Math.max(6, Math.floor(h / 13));
  const gap = (h - n * 9) / (n - 1);
  const planks = [];
  for (let i = 0; i < n; i++) {
    planks.push(
      <View key={i} style={{ height: 9, marginBottom: i < n - 1 ? gap : 0, backgroundColor: i % 2 ? B.plank : B.plank2, borderRadius: 3, borderWidth: B.neon ? 1 : 0, borderColor: '#00f5ff' }} />
    );
  }
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: cx - BRIDGE_W / 2, top, width: BRIDGE_W, height: h, opacity: open ? 1 : 0.55 }}>
      {B.neon ? (
        <Animated.View style={{ position: 'absolute', left: -8, right: -8, top: -4, bottom: -4, borderRadius: 10, backgroundColor: 'rgba(255,79,216,0.22)', opacity: float.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }) }} />
      ) : null}
      <View style={{ position: 'absolute', left: 6, right: 6, top: 0, bottom: 0 }}>{planks}</View>
      <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, borderRadius: 2, backgroundColor: B.rail }} />
      <View style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 4, borderRadius: 2, backgroundColor: B.rail }} />
      <Text style={{ position: 'absolute', left: -16, top: -8, fontSize: 20 }}>{B.post}</Text>
      <Text style={{ position: 'absolute', right: -16, top: -8, fontSize: 20 }}>{B.post}</Text>
      <Text style={{ position: 'absolute', left: -16, bottom: -10, fontSize: 20 }}>{B.post}</Text>
      <Text style={{ position: 'absolute', right: -16, bottom: -10, fontSize: 20 }}>{B.post}</Text>
    </View>
  );
}
function RealmSign({ L, left, top, width }) {
  const r = realmOf(L);
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left, top, width, paddingVertical: 5, paddingHorizontal: 8, borderRadius: 12, backgroundColor: 'rgba(8,6,28,0.74)', borderWidth: 2, borderColor: REALMS[r].accent }}>
      <Text adjustsFontSizeToFit numberOfLines={1} style={{ color: REALMS[r].accent, fontFamily: FONT, fontSize: 13, letterSpacing: 2 }}>
        {REALM_CREST[r]} {secName(L)}
      </Text>
      <Text style={{ color: '#e8e8ff', fontFamily: FONT, fontSize: 10, lineHeight: 13, marginTop: 2 }}>{REALM_TEASE[r]}</Text>
    </View>
  );
}
function WorldMap({ unlocked, stars, float, onPlay, onReady, crew, buddy }) {
  const H = mapH();
  const hr = new Date().getHours();
  const tint = hr >= 20 || hr < 5 ? 'rgba(4,6,40,0.38)' : hr < 7 || hr >= 17 ? 'rgba(255,110,60,0.13)' : null;
  const done = useRef(false); // fresh per mount, so it scrolls once each time the menu opens
  const items = [];
  const nSec = secOf(MAX_LEVEL) + 1;
  const firstOfSec = (s) => {
    let L = 1;
    while (L < MAX_LEVEL && secOf(L) !== s) L++;
    return L;
  };
  const bands = [];
  for (let s = 0; s < nSec; s++) {
    const f = firstOfSec(s);
    const bTop = s === nSec - 1 ? 0 : nodeY(firstOfSec(s + 1)) + 124 - 70;
    const bBot = s === 0 ? H : nodeY(f) + 124 + 70;
    bands.push(<RealmBand key={`bd${s}`} realm={realmOf(f)} w={MAP_W + 80} top={bTop} h={Math.max(60, bBot - bTop)} locked={f > unlocked} ft={s === nSec - 1} fb={s === 0} />);
  }
  for (let L = 1; L <= MAX_LEVEL; L++) {
    const x = nodeX(L), y = nodeY(L);
    const cross = L > 1 && secOf(L) !== secOf(L - 1);
    const R = realmOf(L);
    // outer-layer scenery on whichever side of the path has room
    {
      const xa = nodeX(Math.max(1, L - 1)), xc = nodeX(Math.min(MAX_LEVEL, L + 1));
      const lo = Math.min(xa, x, xc), hi = Math.max(xa, x, xc) + NODE;
      const leftFree = lo - 6, rightFree = MAP_W - hi - 6;
      const sz = 26 + ((L * 7) % 3) * 6;
      const side = leftFree >= rightFree ? 0 : 1;
      const free = side ? rightFree : leftFree;
      if (free >= sz + 6) {
        const set = REALM_PROPS[R];
        const jx = ((L * 37) % 100) / 100;
        const px = side ? hi + 6 + jx * (free - sz) : 2 + jx * (free - sz);
        const py = y + ((L * 53) % 50) - 6;
        const rot = ((L * 11) % 25) - 12;
        const emo = set[(L * 5 + (L >> 1)) % set.length];
        const common = { position: 'absolute', left: px, top: py, fontSize: sz, opacity: 0.92 };
        items.push(
          L % 3 === 0 ? (
            <Animated.Text key={`pp${L}`} pointerEvents="none" style={[common, { transform: [{ rotate: rot + 'deg' }, { translateY: float.interpolate({ inputRange: [0, 1], outputRange: [0, L % 2 ? -5 : 5] }) }] }]}>{emo}</Animated.Text>
          ) : (
            <Text key={`pp${L}`} pointerEvents="none" style={[common, { transform: [{ rotate: rot + 'deg' }] }]}>{emo}</Text>
          )
        );
      }
    }
    if (cross) {
      const B = BRIDGE[R];
      const cx = x + NODE / 2;
      items.push(
        <View key={`rv${L}`} pointerEvents="none" style={{ position: 'absolute', left: -40, right: -40, top: y + 86, height: 76, backgroundColor: B.band, borderTopWidth: 2, borderBottomWidth: 2, borderColor: B.edge + '66' }} />
      );
      B.deco.forEach((e, i) => items.push(
        <Text key={`rd${L}-${i}`} pointerEvents="none" style={{ position: 'absolute', left: 4 + i * 62, top: y + (i % 2 ? 90 : 138), fontSize: 17, opacity: 0.7 }}>{e}</Text>
      ));
      items.push(<Bridge key={`br${L}`} cx={cx} top={y + NODE + 24} h={102} realm={R} open={L <= unlocked} float={float} />);
      const bw = cx < MAP_W / 2 ? MAP_W - (cx + 34) - 6 : cx - 34 - 6;
      items.push(<RealmSign key={`h${L}`} L={L} left={cx < MAP_W / 2 ? cx + 34 : 6} top={y + 88} width={bw} />);
    } else if (L === 1) {
      items.push(<RealmSign key="h1" L={1} left={40} top={y + NODE + 22} width={220} />);
    }
    if (L > 1 && !cross) {
      const px = nodeX(L - 1), py = nodeY(L - 1);
      [0.28, 0.5, 0.72].forEach((t, i) => items.push(
        <View key={`d${L}-${i}`} style={{ position: 'absolute', left: px + (x - px) * t + NODE / 2 - 4, top: py + (y - py) * t + NODE / 2 - 4, width: 8, height: 8, borderRadius: 4, backgroundColor: L <= unlocked ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.25)' }} />
      ));
    }
    const open = L <= unlocked;
    const cur = L === unlocked;
    items.push(
      <Pressable
        key={`n${L}`}
        disabled={!open}
        onPress={() => onPlay(L)}
        style={{ position: 'absolute', left: x, top: y, width: NODE, height: NODE, borderRadius: NODE, alignItems: 'center', justifyContent: 'center', borderWidth: cur ? 4 : 3, borderColor: open ? (cur ? '#ffd23b' : '#fff') : '#3a3a5a', backgroundColor: open ? REALMS[realmOf(L)].sky[1] : '#22223a', opacity: open ? 1 : 0.8, shadowColor: cur ? '#ffd23b' : '#000', shadowOpacity: cur ? 1 : 0.4, shadowRadius: cur ? 12 : 4, elevation: cur ? 10 : 4 }}
      >
        <Text style={styles.lvlTxt}>{open ? L : '🔒'}</Text>
        {open ? <Text style={{ position: 'absolute', bottom: -16, color: '#ffd23b', fontSize: 11, letterSpacing: 1 }}>{'★'.repeat(stars[L] || 0) + '☆'.repeat(3 - (stars[L] || 0))}</Text> : null}
      </Pressable>
    );
    if ((crew || []).length && L % 3 === 2 && L <= unlocked && L > unlocked - 12) {
      const ci = Math.floor(L / 3) % crew.length;
      items.push(
        <Animated.Text
          key={`crew${L}`}
          pointerEvents="none"
          style={{ position: 'absolute', left: L % 2 ? x - 34 : x + NODE + 4, top: y + 10, fontSize: 24, transform: [{ translateY: float.interpolate({ inputRange: [0, 1], outputRange: [0, L % 2 ? -6 : 6] }) }] }}
        >
          {crew[ci]}
        </Animated.Text>
      );
    }
    if (cur) {
      if (buddy) {
        items.push(
          <Animated.Text key="buddy" pointerEvents="none" style={{ position: 'absolute', left: x - 34, top: y + 8, fontSize: 28, transform: [{ translateY: float.interpolate({ inputRange: [0, 1], outputRange: [0, -5] }) }] }}>
            {buddy}
          </Animated.Text>
        );
      }
      items.push(
        <Animated.View key="mascot" pointerEvents="none" style={{ position: 'absolute', left: x + NODE - 6, top: y - 14, transform: [{ translateY: float.interpolate({ inputRange: [0, 1], outputRange: [0, -7] }) }] }}>
          <Orb color={(L % 5) + 1} size={30} />
        </Animated.View>
      );
    }
  }
  return (
    <View
      style={{ width: MAP_W, height: H, marginTop: 6 }}
      onLayout={(e) => {
        if (done.current) return;
        done.current = true;
        if (onReady) onReady(e.nativeEvent.layout.y);
      }}
    >
      {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => (
        <Animated.View
          key={`ff${k}`}
          pointerEvents="none"
          style={{
            position: 'absolute', left: (k * 53 + 20) % (MAP_W - 10), top: ((k * 211) % Math.max(200, H - 20)) + 20,
            width: 5, height: 5, borderRadius: 3, backgroundColor: hr >= 19 || hr < 6 ? '#fff6a8' : '#ffffff',
            opacity: float.interpolate({ inputRange: [0, 1], outputRange: [k % 2 ? 0.15 : 0.7, k % 2 ? 0.7 : 0.15] }),
            transform: [{ translateY: float.interpolate({ inputRange: [0, 1], outputRange: [0, k % 2 ? -14 : 10] }) }, { translateX: float.interpolate({ inputRange: [0, 1], outputRange: [0, k % 3 ? 8 : -8] }) }],
          }}
        />
      ))}
      {bands}
      {tint ? <View pointerEvents="none" style={{ position: 'absolute', left: -40, right: -40, top: 0, bottom: 0, backgroundColor: tint }} /> : null}
      {items}
    </View>
  );
}


/* ============================== NEXTGEN v21: ORBDEX, RANKS, STORY, SETTINGS ============================== */
let HAPTICS = true;
let LITE = false;
let DOCK = false; // controls live in their own strip under the board; false = old free-floating pads
const MENUISH = ['menu', 'shop', 'dex', 'profile', 'settings', 'story', 'race', 'season'];
const RARITY = {
  c: { name: 'COMMON', col: '#9fd0ff' },
  r: { name: 'RARE', col: '#7dffb0' },
  e: { name: 'EPIC', col: '#d58bff' },
  l: { name: 'LEGEND', col: '#ffd23b' },
};
// 24 collectible Orblings, 6 per realm. Cosmetic companions only: never a gameplay advantage.
const DEX = [
  { id: 'ekiro', name: 'Ekiro', icon: '🦉', realm: 0, rar: 'c', line: 'Keeps watch while the grove sleeps.' },
  { id: 'pinko', name: 'Pinko', icon: '🦔', realm: 0, rar: 'c', line: 'Rolls into a ball when chains get big.' },
  { id: 'nabuu', name: 'Nabuu', icon: '🦋', realm: 0, rar: 'c', line: 'Follows the brightest orb.' },
  { id: 'wiggo', name: 'Wiggo', icon: '🐛', realm: 0, rar: 'r', line: 'Dreams of becoming a x9 chain.' },
  { id: 'mushi', name: 'Mushi', icon: '🍄', realm: 0, rar: 'e', line: 'Glows brighter every pop.' },
  { id: 'kasi', name: 'Kasi', icon: '🦊', realm: 0, rar: 'l', line: 'The fastest fox in Twilight Grove.' },
  { id: 'ribbo', name: 'Ribbo', icon: '🐸', realm: 1, rar: 'c', line: 'Sings when the lake lights up.' },
  { id: 'bata', name: 'Bata', icon: '🦆', realm: 1, rar: 'c', line: 'Always first to the water.' },
  { id: 'kobe', name: 'Kobe', icon: '🐢', realm: 1, rar: 'c', line: 'Slow, steady, never loses a column.' },
  { id: 'samaki', name: 'Samaki', icon: '🐟', realm: 1, rar: 'r', line: 'Swims upstream through every chain.' },
  { id: 'flamo', name: 'Flamo', icon: '🦩', realm: 1, rar: 'e', line: 'Balances on one leg through a x6.' },
  { id: 'sealo', name: 'Sealo', icon: '🦭', realm: 1, rar: 'l', line: 'Claps for every perfect clear.' },
  { id: 'pengo', name: 'Pengo', icon: '🐧', realm: 2, rar: 'c', line: 'Slides into every combo.' },
  { id: 'floki', name: 'Floki', icon: '❄️', realm: 2, rar: 'c', line: 'No two flakes pop alike.' },
  { id: 'elku', name: 'Elku', icon: '🦌', realm: 2, rar: 'c', line: 'Leaps over rock walls.' },
  { id: 'polo', name: 'Polo', icon: '🐻‍❄️', realm: 2, rar: 'r', line: 'Hibernates between boss fights.' },
  { id: 'wolfi', name: 'Wolfi', icon: '🐺', realm: 2, rar: 'e', line: 'Howls when fever starts.' },
  { id: 'snowy', name: 'Snowy', icon: '⛄', realm: 2, rar: 'l', line: 'Never melts, never misses.' },
  { id: 'bitzo', name: 'Bitzo', icon: '🤖', realm: 3, rar: 'c', line: 'Calculates the perfect drop.' },
  { id: 'pixl', name: 'Pixl', icon: '👾', realm: 3, rar: 'c', line: 'Lives inside the neon grid.' },
  { id: 'neona', name: 'Neona', icon: '🦄', realm: 3, rar: 'c', line: 'Leaves rainbow trails.' },
  { id: 'octa', name: 'Octa', icon: '🐙', realm: 3, rar: 'r', line: 'Eight arms, eight chains.' },
  { id: 'rexo', name: 'Rexo', icon: '🦖', realm: 3, rar: 'e', line: 'Stomps rocks flat.' },
  { id: 'draco', name: 'Draco', icon: '🐲', realm: 3, rar: 'l', line: 'Guardian of the last chain.' },
];
const dexLv = (n) => Math.min(5, 1 + Math.floor((Math.max(1, n) - 1) / 2));
const rankLv = (xp) => Math.floor(Math.sqrt(Math.max(0, xp) / 60)) + 1;
const rankXp = (lv) => 60 * (lv - 1) * (lv - 1);
const RANKS = ['Sprout', 'Spark', 'Chainer', 'Weaver', 'Tidecaller', 'Frostwalker', 'Neon Sage', 'Orb Master', 'Legend'];
const rankName = (lv) => RANKS[Math.min(RANKS.length - 1, Math.floor((lv - 1) / 3))];
const ACH = [
  { id: 'pop1', t: 'First Pop', d: 'Pop your first orbs', ok: (p) => p.s.pops >= 1, r: { sh: 1 } },
  { id: 'ch3', t: 'Chain Starter', d: 'Reach a x3 chain', ok: (p) => p.s.bestChain >= 3, r: { sh: 1 } },
  { id: 'ch5', t: 'Chain Weaver', d: 'Reach a x5 chain', ok: (p) => p.s.bestChain >= 5, r: { eggs: 1 } },
  { id: 'ch8', t: 'Chain Legend', d: 'Reach a x8 chain', ok: (p) => p.s.bestChain >= 8, r: { eggs: 2, sh: 3 } },
  { id: 'w10', t: 'Seasoned', d: 'Clear 10 levels', ok: (p) => p.s.wins >= 10, r: { eggs: 1 } },
  { id: 'w50', t: 'Veteran', d: 'Clear 50 levels', ok: (p) => p.s.wins >= 50, r: { eggs: 2 } },
  { id: 'pf1', t: 'Spotless', d: 'Perfect clear the board', ok: (p) => p.s.perfects >= 1, r: { eggs: 1 } },
  { id: 'cl3', t: 'Nerves of Steel', d: 'Make 3 clutch saves', ok: (p) => p.s.clutches >= 3, r: { sh: 2 } },
  { id: 'fv5', t: 'Feverish', d: 'Trigger Fever 5 times', ok: (p) => p.s.fevers >= 5, r: { sh: 2 } },
  { id: 'pp1k', t: 'Popper', d: 'Pop 1,000 orbs', ok: (p) => p.s.pops >= 1000, r: { eggs: 1 } },
  { id: 'pp10k', t: 'Pop Machine', d: 'Pop 10,000 orbs', ok: (p) => p.s.pops >= 10000, r: { eggs: 3 } },
  { id: 'g100', t: 'Regular', d: 'Play 100 games', ok: (p) => p.s.games >= 100, r: { sh: 3 } },
  { id: 'st30', t: 'Star Collector', d: 'Earn 30 stars', ok: (p, G) => totalStars(G.stars) >= 30, r: { eggs: 2 } },
  { id: 'bs1', t: 'Boss Slayer', d: 'Defeat the Lake Spirit', ok: (p, G) => !!G.stars[10], r: { eggs: 2 } },
  { id: 'sk7', t: 'Devoted', d: 'Reach a 7 day streak', ok: (p, G) => G.streak.n >= 7, r: { eggs: 1, sh: 2 } },
  { id: 'dx6', t: 'Collector', d: 'Hatch 6 different Orblings', ok: (p, G) => Object.keys(G.dex.own).length >= 6, r: { sh: 3 } },
  { id: 'dx24', t: 'Orbdex Complete', d: 'Hatch all 24 Orblings', ok: (p, G) => Object.keys(G.dex.own).length >= DEX.length, r: { sh: 20 } },
  { id: 'rc1', t: 'Ghost Buster', d: 'Beat a ghost in a race', ok: (p) => (p.s.raceWins || 0) >= 1, r: { eggs: 1 } },
  { id: 'rc10', t: 'Ghost Hunter', d: 'Beat 10 ghosts', ok: (p) => (p.s.raceWins || 0) >= 10, r: { eggs: 2, sh: 3 } },
  { id: 'rk5', t: 'Rising Star', d: 'Reach rank 5', ok: (p) => rankLv(p.xp) >= 5, r: { eggs: 1 } },
];
// scenes that play the first time you reach a level
const STORY_AT = { 1: 'intro', 6: 'realm2', 10: 'boss10', 11: 'realm3', 16: 'realm4', 20: 'boss20', 21: 'realm5', 31: 'realm6', 41: 'realm7', 61: 'realm8' };
const STORY = {
  intro: [
    ['🦉', 'Elder Ekiro', 'The orbs are waking, little one. Something is making the realms go quiet.'],
    ['🦉', 'Elder Ekiro', 'Line up four of a color and they sing. Sing a chain, and the whole world hears it.'],
    ['🦊', 'Kasi', 'Drop fast, think faster. I will be right here.'],
  ],
  realm2: [
    ['🐸', 'Ribbo', 'Welcome to Moonlit Lake! The water has stopped glowing.'],
    ['🐸', 'Ribbo', 'Pop the stones, wake the lights. The lake remembers every chain.'],
  ],
  boss10: [
    ['🌊', 'Lake Spirit', 'You woke me? Then show me a chain worth remembering.'],
  ],
  realm3: [
    ['🐧', 'Pengo', 'Frost Peaks! The cold makes rocks stubborn, so plan your pops.'],
    ['🐧', 'Pengo', 'A big chain melts everything. Trust me.'],
  ],
  realm4: [
    ['🤖', 'Bitzo', 'Neon City is flickering. The grid needs one huge chain to come back online.'],
  ],
  boss20: [
    ['👑', 'Neon King', 'Every realm hangs on this board. Make it a legend.'],
  ],
  realm5: [
    ['🐝', 'Buzzi', 'Sunshine! The Meadow is wide open, but the orbs hide in the tall grass.'],
    ['🐝', 'Buzzi', 'Chain high and the clouds part. Faster drops ahead, little chainer.'],
  ],
  realm6: [
    ['🦎', 'Zuri', 'Welcome to the Dunes. The sand shifts, but a good chain never does.'],
    ['🦎', 'Zuri', 'Watch the cracks. The desert hides more than it shows.'],
  ],
  realm7: [
    ['🐸', 'Ribbo', 'Thunder! I love this. Rain makes everything slick, so keep your columns clean.'],
  ],
  realm8: [
    ['🦉', 'Elder Ekiro', 'First light. You carried a chain through every realm. The world is waking.'],
  ],
};

// ---- Season Path (free track): earn Season XP from everything you already do, claim a reward every tier ----
const SEASON = { id: 's1', name: 'FIREFLY FESTIVAL', s: 1792368000000, e: 1795996800000, tiers: 30, per: 800 };
const SEASON_TITLES = { 10: 'Firefly Friend', 20: 'Lantern Bearer', 30: 'Firefly Keeper' };
const tierReward = (t) => {
  const big = t % 10 === 0;
  return { sh: (t % 2 ? 2 : 1) + (big ? 5 : 0), eggs: (t % 3 === 0 ? 1 : 0) + (big ? 2 : 0), title: SEASON_TITLES[t] || '' };
};
const seasonActive = () => {
  const n = Date.now();
  return n >= SEASON.s && n < SEASON.e;
};
const seasonState = (p) => {
  if (!p.season || p.season.id !== SEASON.id) p.season = { id: SEASON.id, xp: 0, claimed: 0 };
  return p.season;
};
const seasonTier = (p) => Math.min(SEASON.tiers, Math.floor(seasonState(p).xp / SEASON.per));

function HatchReveal({ d, isNew, n }) {
  const sc = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(sc, { toValue: 1, friction: 4, tension: 120, useNativeDriver: true }).start();
  }, []);
  const R = RARITY[d.rar];
  return (
    <Animated.View style={{ alignItems: 'center', marginVertical: 8, transform: [{ scale: sc }] }}>
      <Text style={{ fontSize: 68 }}>{d.icon}</Text>
      <Text style={[styles.title, { fontSize: 22, textShadowColor: R.col }]}>{d.name}</Text>
      <Text style={{ color: R.col, fontFamily: FONT, letterSpacing: 2, fontSize: 13 }}>
        {R.name}{isNew ? '  •  NEW!' : `  •  Lv ${dexLv(n)}`}
      </Text>
      <Text style={[styles.hint, { textAlign: 'center', maxWidth: 260 }]}>{d.line}</Text>
    </Animated.View>
  );
}

function OrbdexScreen({ G, onHatch, onPick, onBack }) {
  const own = G.dex.own;
  const have = Object.keys(own).length;
  const last = G.dexShow && G.dex.last ? G.dex.last : null;
  const lastD = last ? DEX.find((d) => d.id === last.id) : null;
  return (
    <ScrollView style={{ width: '100%' }} contentContainerStyle={{ alignItems: 'center', paddingVertical: 14 }}>
      <Text style={styles.title}>ORBDEX</Text>
      <Text style={styles.hint}>{have}/{DEX.length} found  •  🥚 {G.dex.eggs} egg{G.dex.eggs === 1 ? '' : 's'}</Text>
      {lastD ? <HatchReveal key={last.at} d={lastD} isNew={last.isNew} n={(own[lastD.id] || { n: 1 }).n} /> : null}
      <Pressable
        disabled={G.dex.eggs < 1}
        onPress={onHatch}
        style={[styles.play, { marginTop: 10, paddingVertical: 12, opacity: G.dex.eggs < 1 ? 0.4 : 1 }]}
      >
        <Text style={styles.playTxt}>{G.dex.eggs < 1 ? 'NO EGGS' : '🥚 HATCH EGG'}</Text>
      </Pressable>
      <Text style={[styles.hint, { marginTop: 6, fontSize: 11, textAlign: 'center', maxWidth: 300 }]}>
        Eggs come from new stars, bosses, the daily chest, streaks and achievements. Orblings are cosmetic companions.
      </Text>
      {[0, 1, 2, 3].map((r) => (
        <View key={r} style={{ alignItems: 'center', marginTop: 14 }}>
          <Text style={{ color: REALMS[r].accent, fontFamily: FONT, fontSize: 13, letterSpacing: 3 }}>{REALMS[r].name}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', marginTop: 6, maxWidth: 340 }}>
            {DEX.filter((d) => d.realm === r).map((d) => {
              const o = own[d.id];
              const R = RARITY[d.rar];
              const buddy = G.dex.companion === d.id;
              return (
                <Pressable
                  key={d.id}
                  disabled={!o}
                  onPress={() => onPick(d.id)}
                  style={{
                    width: 52, height: 68, margin: 3, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
                    borderWidth: buddy ? 3 : 2, borderColor: o ? (buddy ? '#2bff88' : R.col) : '#2a2a4a',
                    backgroundColor: 'rgba(0,0,0,0.35)', opacity: o ? 1 : 0.55,
                  }}
                >
                  <Text style={{ fontSize: 28 }}>{o ? d.icon : '❔'}</Text>
                  <Text style={{ color: o ? R.col : '#556', fontSize: 9, fontFamily: FONT }}>
                    {o ? (buddy ? 'BUDDY' : `Lv ${dexLv(o.n)}`) : R.name.slice(0, 3)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}
      <Text style={[styles.hint, { marginTop: 12, fontSize: 11 }]}>Tap an Orbling to make it your buddy on the map.</Text>
      <Pressable style={{ marginTop: 14 }} onPress={onBack}>
        <Text style={styles.hint}>BACK</Text>
      </Pressable>
    </ScrollView>
  );
}

function ProfileScreen({ G, onBack }) {
  const p = G.prof;
  const lv = rankLv(p.xp);
  const lo = rankXp(lv);
  const hi = rankXp(lv + 1);
  const pct = Math.max(0, Math.min(1, (p.xp - lo) / (hi - lo)));
  const done = ACH.filter((a) => p.ach[a.id]).length;
  const S = p.s;
  return (
    <ScrollView style={{ width: '100%' }} contentContainerStyle={{ alignItems: 'center', paddingVertical: 14 }}>
      <Text style={styles.title}>PROFILE</Text>
      <Text style={[styles.hint, { color: '#ffd23b', fontSize: 18 }]}>RANK {lv}  •  {rankName(lv).toUpperCase()}</Text>
      {p.title ? <Text style={[styles.hint, { color: '#d58bff' }]}>🏅 {p.title}</Text> : null}
      <View style={{ width: 260, height: 12, borderRadius: 6, backgroundColor: 'rgba(255,255,255,0.15)', marginTop: 6, overflow: 'hidden' }}>
        <View style={{ width: `${Math.round(pct * 100)}%`, height: 12, backgroundColor: '#2bff88' }} />
      </View>
      <Text style={[styles.hint, { fontSize: 11 }]}>{p.xp} XP  •  next rank at {hi}</Text>
      <View style={{ marginTop: 10, alignItems: 'center' }}>
        <Text style={styles.hint}>Orbs popped {S.pops}  •  Games {S.games}</Text>
        <Text style={styles.hint}>Levels cleared {S.wins}  •  Best chain x{S.bestChain}</Text>
        <Text style={styles.hint}>Perfects {S.perfects}  •  Clutches {S.clutches}  •  Fevers {S.fevers}</Text>
        <Text style={styles.hint}>Ghost races won {S.raceWins || 0}/{S.races || 0}</Text>
      </View>
      <Text style={[styles.hint, { marginTop: 14, color: '#fff' }]}>ACHIEVEMENTS {done}/{ACH.length}</Text>
      {ACH.map((a) => {
        const got = !!p.ach[a.id];
        const rw = [a.r.eggs ? `🥚${a.r.eggs}` : '', a.r.sh ? `◆${a.r.sh}` : ''].filter(Boolean).join(' ');
        return (
          <View key={a.id} style={{ width: 300, flexDirection: 'row', alignItems: 'center', marginTop: 6, opacity: got ? 1 : 0.5 }}>
            <Text style={{ fontSize: 22, width: 34 }}>{got ? '🏆' : '🔒'}</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ color: got ? '#ffd23b' : '#ddd', fontFamily: FONT, fontSize: 14 }}>{a.t}</Text>
              <Text style={{ color: '#aab', fontSize: 11 }}>{a.d}</Text>
            </View>
            <Text style={{ color: '#9fd0ff', fontSize: 11 }}>{rw}</Text>
          </View>
        );
      })}
      <Pressable style={{ marginTop: 16 }} onPress={onBack}>
        <Text style={styles.hint}>BACK</Text>
      </Pressable>
    </ScrollView>
  );
}

function SettingsScreen({ onToggleHaptics, onToggleLite, onToggleDock, onReplayStory, onBack }) {
  const row = (label, on, fn) => (
    <Pressable onPress={fn} style={[styles.modeBtn, { width: 260, marginTop: 10, borderColor: on ? '#2bff88' : '#2a2a4a' }]}>
      <Text style={styles.modeTxt}>{label}: {on ? 'ON' : 'OFF'}</Text>
    </Pressable>
  );
  return (
    <>
      <Text style={styles.title}>SETTINGS</Text>
      {row('🎮 DOCKED CONTROLS', DOCK, onToggleDock)}
      {row('📳 HAPTICS', HAPTICS, onToggleHaptics)}
      {row('🪶 LITE EFFECTS', LITE, onToggleLite)}
      <Text style={[styles.hint, { fontSize: 11, textAlign: 'center', maxWidth: 280, marginTop: 6 }]}>
        Docked controls give the pads their own strip under the board. Turn off to float and drag them. Lite effects reduces shake, flash and slow-motion.
      </Text>
      <Pressable onPress={onReplayStory} style={[styles.modeBtn, { width: 260, marginTop: 14 }]}>
        <Text style={styles.modeTxt}>📖 REPLAY STORY SCENES</Text>
      </Pressable>
      <Pressable onPress={() => { Linking.openURL(PRIVACY_URL).catch(() => {}); }} style={[styles.modeBtn, { width: 260, marginTop: 10 }]}>
        <Text style={styles.modeTxt}>🔒 PRIVACY POLICY</Text>
      </Pressable>
      <Text selectable style={[styles.hint, { fontSize: 11, textAlign: 'center', maxWidth: 280, marginTop: 8 }]}>
        Player ID: {PID}
      </Text>
      <Pressable style={{ marginTop: 18 }} onPress={onBack}>
        <Text style={styles.hint}>BACK</Text>
      </Pressable>
    </>
  );
}

function StoryScreen({ story, onNext, onSkip }) {
  const lines = STORY[story.key] || [];
  const ln = lines[Math.min(story.i, lines.length - 1)] || ['✨', '', ''];
  return (
    <Pressable onPress={onNext} style={{ flex: 1, width: '100%', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28 }}>
      <Text style={{ fontSize: 96 }}>{ln[0]}</Text>
      <Text style={[styles.title, { fontSize: 22, marginTop: 6 }]}>{ln[1]}</Text>
      <View style={{ marginTop: 14, padding: 16, borderRadius: 18, backgroundColor: 'rgba(0,0,0,0.45)', borderWidth: 2, borderColor: 'rgba(255,255,255,0.3)' }}>
        <Text style={{ color: '#fff', fontFamily: FONT, fontSize: 20, lineHeight: 28, textAlign: 'center' }}>{ln[2]}</Text>
      </View>
      <Text style={[styles.hint, { marginTop: 18 }]}>TAP TO CONTINUE  ({Math.min(story.i + 1, lines.length)}/{lines.length})</Text>
      <Pressable onPress={onSkip} hitSlop={12} style={{ marginTop: 12 }}>
        <Text style={styles.hint}>SKIP</Text>
      </Pressable>
    </Pressable>
  );
}


/* ============================== GHOST RACE (v22) ============================== */
// Headless port of the server's verify-daily engine. Replays a move log and records the score and
// board after every locked piece, so a ghost can be raced piece-for-piece on the same daily seed.
const gxSeeded = (a) => () => {
  a |= 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
function simGhost(day, log) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day)) || typeof log !== 'string' || !log.length || log.length > 30000 || !/^[LRcwdskh]+$/.test(log)) return null;
  const C = 6, R = 12, ROCK_ = 6, BOMB_ = 7, CRACK_ = 8, PRISM_ = 9;
  const OFFS = [[-1, 0], [0, 1], [1, 0], [0, -1]];
  const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const GOAL = 40, NCOL = 5, RAIN = 5;
  const rng = gxSeeded(Number(String(day).replace(/-/g, '')));
  const rnd = (n) => 1 + Math.floor(rng() * n);
  const newPair = (n) => { const a = rnd(n); return { a, b: rng() < 0 ? a : rnd(n) }; };
  const S = { board: Array.from({ length: R }, () => Array(C).fill(0)), score: 0, chain: 0, maxChain: 0, placed: 0, fever: 0, feverPcs: 0, prismNext: false, piece: null, next: null, next2: null, ended: false, won: false };
  const cellsOf = (p) => [[p.r, p.c, p.a], [p.r + OFFS[p.o][0], p.c + OFFS[p.o][1], p.b]];
  const valid = (b, p) => cellsOf(p).every(([r, c]) => c >= 0 && c < C && r >= 0 && r < R && b[r][c] === 0);
  const spawnP = (pair) => ({ r: 1, c: 2, o: 0, a: pair.a, b: pair.b });
  const tryRot = (b, p, dir) => {
    const o = (p.o + dir + 4) % 4;
    const p2 = { ...p, o };
    if (valid(b, p2)) return p2;
    const d = OFFS[o];
    const p3 = { ...p2, r: p.r - d[0], c: p.c - d[1] };
    return valid(b, p3) ? p3 : null;
  };
  const grav = (b) => {
    let moved = false;
    for (let c = 0; c < C; c++) {
      let w = R - 1;
      for (let r = R - 1; r >= 0; r--) {
        if (b[r][c]) {
          if (r !== w) { b[w][c] = b[r][c]; b[r][c] = 0; moved = true; }
          w--;
        }
      }
    }
    return moved;
  };
  const groupsOf = (b) => {
    const seen = Array.from({ length: R }, () => Array(C).fill(false));
    const out = [];
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        if (!b[r][c] || b[r][c] >= ROCK_ || seen[r][c]) continue;
        const col = b[r][c];
        const stack = [[r, c]];
        const g = [];
        seen[r][c] = true;
        while (stack.length) {
          const [y, x] = stack.pop();
          g.push([y, x]);
          for (const [dy, dx] of DIRS4) {
            const ny = y + dy, nx = x + dx;
            if (ny >= 0 && ny < R && nx >= 0 && nx < C && !seen[ny][nx] && b[ny][nx] === col) { seen[ny][nx] = true; stack.push([ny, nx]); }
          }
        }
        if (g.length >= 4) out.push(g);
      }
    }
    return out;
  };
  const np = () => {
    if (S.prismNext) { S.prismNext = false; return { a: PRISM_, b: rnd(NCOL) }; }
    return newPair(NCOL);
  };
  const shiftQ = () => {
    if (S.prismNext) { S.prismNext = false; S.next = { a: PRISM_, b: rnd(NCOL) }; }
    else S.next = S.next2;
    S.next2 = np();
  };
  const tl = [{ s: 0, c: 0, b: null }];
  S.next = np();
  S.next2 = np();
  grav(S.board);
  S.piece = spawnP(S.next);
  shiftQ();
  const resolve = () => {
    S.chain = 0;
    const wasDanger = S.board.slice(0, 4).some((row) => row.some(Boolean));
    const feverAtLock = S.feverPcs > 0;
    while (true) {
      grav(S.board);
      const groups = groupsOf(S.board);
      if (!groups.length) break;
      S.chain++;
      const flat = groups.flat();
      const big = groups.reduce((m, g) => (g.length > m.length ? g : m), []);
      const hit = new Set(flat.map(([r, c]) => r * C + c));
      for (const [r, c] of flat) {
        for (const [dy, dx] of DIRS4) {
          const y = r + dy, x = c + dx;
          if (y >= 0 && y < R && x >= 0 && x < C && S.board[y][x] >= ROCK_) hit.add(y * C + x);
        }
      }
      for (const k of [...hit]) {
        const br = Math.floor(k / C), bc = k % C;
        if (S.board[br][bc] !== BOMB_) continue;
        for (let y = br - 1; y <= br + 1; y++) for (let x = bc - 1; x <= bc + 1; x++) {
          if (y >= 0 && y < R && x >= 0 && x < C && S.board[y][x]) hit.add(y * C + x);
        }
      }
      const cells = [...hit].map((k) => [Math.floor(k / C), k % C]);
      if (S.chain >= 3) S.prismNext = true;
      S.score += flat.length * 10 * Math.pow(2, S.chain - 1) * (S.feverPcs > 0 ? 2 : 1);
      if (!(S.feverPcs > 0)) {
        S.fever += flat.length * 4;
        if (S.fever >= 100) { S.fever = 0; S.feverPcs = 3; }
      }
      for (const [r, c] of cells) S.board[r][c] = S.board[r][c] === CRACK_ ? ROCK_ : 0;
      if (big.length >= 6) {
        const [br, bc] = big.reduce((m, x) => (x[0] > m[0] ? x : m));
        S.board[br][bc] = BOMB_;
      }
    }
    if (feverAtLock && S.feverPcs > 0) S.feverPcs--;
    if (S.board.every((row) => row.every((v) => !v))) S.score += 500;
    else if (wasDanger && !S.board.slice(0, 4).some((row) => row.some(Boolean))) S.score += 200;
    S.maxChain = Math.max(S.maxChain, S.chain);
    if (S.placed >= GOAL) { S.ended = true; S.won = true; return; }
    if (S.placed % RAIN === 0) {
      const rc = Math.floor(rng() * C);
      if (!S.board[0][rc]) { S.board[0][rc] = ROCK_; grav(S.board); }
    }
    const p = spawnP(S.next);
    if (!valid(S.board, p)) { S.ended = true; return; }
    S.piece = p;
    shiftQ();
  };
  const lock = () => {
    for (const [r, c, col] of cellsOf(S.piece)) S.board[r][c] = col;
    const pr = cellsOf(S.piece).find((x) => x[2] === PRISM_);
    if (pr) {
      const [prR, prC] = pr;
      let tc = 0;
      const below = prR + 1 < R ? S.board[prR + 1][prC] : 0;
      if (below >= 1 && below <= 5) tc = below;
      else {
        for (const [dy, dx] of [[0, 1], [0, -1], [-1, 0]]) {
          const y = prR + dy, x = prC + dx;
          if (y >= 0 && y < R && x >= 0 && x < C && S.board[y][x] >= 1 && S.board[y][x] <= 5) { tc = S.board[y][x]; break; }
        }
      }
      S.board[prR][prC] = 0;
      if (tc) {
        S.score += S.board.flat().filter((v) => v === tc).length * 10;
        S.board = S.board.map((row) => row.map((v) => (v === tc ? 0 : v)));
      }
    }
    S.piece = null;
    S.placed++;
    resolve();
    tl.push({ s: S.score, c: S.maxChain, b: S.board.flat() });
  };
  for (let i = 0; i < log.length; i++) {
    if (S.ended || !S.piece) break;
    const t = log[i];
    const p = S.piece;
    if (t === 'L' || t === 'R') {
      const p2 = { ...p, c: p.c + (t === 'R' ? 1 : -1) };
      if (valid(S.board, p2)) S.piece = p2;
    } else if (t === 'c' || t === 'w') {
      const p2 = tryRot(S.board, p, t === 'c' ? 1 : -1);
      if (p2) S.piece = p2;
    } else if (t === 'd') {
      const p2 = { ...p, r: p.r + 1 };
      if (valid(S.board, p2)) S.piece = p2;
    } else if (t === 's') {
      const p2 = { ...p, r: p.r + 1 };
      if (valid(S.board, p2)) { S.piece = p2; S.score += 1; } else lock();
    } else if (t === 'k') {
      const p2 = { ...p, r: p.r + 1 };
      if (!valid(S.board, p2)) lock();
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
  return { tl, ended: S.ended, won: S.won };
}
const ghostCode = (g) => `CHAINORB1|${g.day}|${String(g.name || 'Ghost').replace(/[|\n]/g, '').slice(0, 20)}|${g.score}|${g.log}`;
const parseGhostCode = (t) => {
  const m = String(t || '').match(/CHAINORB1\|(\d{4}-\d{2}-\d{2})\|([^|\n]{0,24})\|(\d+)\|([LRcwdskh]+)/);
  return m ? { day: m[1], name: m[2] || 'Ghost', score: Number(m[3]), log: m[4] } : null;
};

function GhostPanel({ w, name, gScore, you, board, placed, goal }) {
  const cs = Math.max(8, Math.floor(w / COLS));
  const diff = you - gScore;
  return (
    <View style={{ width: w, alignItems: 'center', marginTop: 10 }}>
      <Text numberOfLines={1} style={{ color: '#d9c8ff', fontFamily: FONT, fontSize: 12 }}>👻 {name}</Text>
      <Text style={{ color: '#fff', fontFamily: FONT, fontSize: 15 }}>{gScore}</Text>
      <Text style={{ color: diff >= 0 ? '#2bff88' : '#ff8a8a', fontFamily: FONT, fontSize: 12 }}>
        {diff >= 0 ? `YOU +${diff}` : `YOU ${diff}`}
      </Text>
      <View style={{ marginTop: 4, padding: 1, borderRadius: 6, backgroundColor: 'rgba(160,120,255,0.18)', borderWidth: 1, borderColor: 'rgba(200,170,255,0.5)' }}>
        {Array.from({ length: ROWS }, (_, r) => (
          <View key={r} style={{ flexDirection: 'row' }}>
            {Array.from({ length: COLS }, (_, c) => {
              const v = board ? board[r * COLS + c] : 0;
              return <View key={c} style={{ width: cs, height: cs, borderRadius: cs / 3, backgroundColor: v ? COLORS[v] || '#888' : 'transparent', opacity: 0.85, transform: [{ scale: 0.86 }] }} />;
            })}
          </View>
        ))}
      </View>
      <Text style={{ color: '#aab', fontSize: 10, fontFamily: FONT, marginTop: 2 }}>{placed}/{goal}</Text>
    </View>
  );
}

function RaceScreen({ G, onTop, onLast, onShare, onCode, onBack }) {
  const [txt, setTxt] = useState('');
  const btn = (label, fn, col, dis) => (
    <Pressable disabled={dis} onPress={fn} style={[styles.modeBtn, { width: 280, marginTop: 10, borderColor: col, opacity: dis ? 0.45 : 1 }]}>
      <Text style={styles.modeTxt}>{label}</Text>
    </Pressable>
  );
  return (
    <ScrollView style={{ width: '100%' }} contentContainerStyle={{ alignItems: 'center', paddingVertical: 14 }}>
      <Text style={styles.title}>GHOST RACE</Text>
      <Text style={[styles.hint, { textAlign: 'center', maxWidth: 300 }]}>
        Race a recorded run on the same pieces. See its score and board live. Races never touch the daily leaderboard.
      </Text>
      {btn('🏆 TODAY\'S #1 RUN', onTop, '#ffd23b', !ONLINE || G.raceBusy)}
      {btn('🕑 MY LAST DAILY', onLast, '#7dffb0', !G.pb)}
      {btn('📨 SHARE MY GHOST CODE', onShare, '#9fd0ff', !G.pb)}
      <TextInput
        value={txt}
        onChangeText={setTxt}
        multiline
        placeholder="Paste a friend's ghost code here"
        placeholderTextColor="#778"
        autoCapitalize="none"
        autoCorrect={false}
        style={{ width: 280, minHeight: 70, borderWidth: 2, borderColor: '#8888aa', borderRadius: 12, color: '#fff', padding: 10, marginTop: 14, fontSize: 12 }}
      />
      {btn('👻 RACE THIS CODE', () => onCode(txt), '#d58bff', !txt.trim())}
      {G.raceMsg ? <Text style={[styles.hint, { marginTop: 10, color: '#ffd23b', textAlign: 'center', maxWidth: 280 }]}>{G.raceMsg}</Text> : null}
      <Text style={[styles.hint, { marginTop: 10, fontSize: 11 }]}>Races won {G.prof.s.raceWins || 0}/{G.prof.s.races || 0}  •  first win over each ghost gives 🥚</Text>
      <Pressable style={{ marginTop: 16 }} onPress={onBack}>
        <Text style={styles.hint}>BACK</Text>
      </Pressable>
    </ScrollView>
  );
}


function SeasonScreen({ G, onClaim, onBack }) {
  const p = G.prof;
  const st = seasonState(p);
  const tier = seasonTier(p);
  const claimable = tier - st.claimed;
  const now = Date.now();
  const day = Math.max(0, Math.min(42, Math.floor((now - SEASON.s) / 86400000) + 1));
  const into = tier >= SEASON.tiers ? SEASON.per : st.xp % SEASON.per;
  const pct = Math.round((into / SEASON.per) * 100);
  const sub = now < SEASON.s ? 'Starts soon' : now >= SEASON.e ? 'Season ended. Claim what you earned.' : `Day ${day}/42`;
  return (
    <ScrollView style={{ width: '100%' }} contentContainerStyle={{ alignItems: 'center', paddingVertical: 14 }}>
      <Text style={styles.title}>SEASON PATH</Text>
      <Text style={[styles.hint, { color: '#ffd23b', fontSize: 16 }]}>{SEASON.name}</Text>
      <Text style={styles.hint}>{sub}  •  Tier {tier}/{SEASON.tiers}</Text>
      <View style={{ width: 280, height: 12, borderRadius: 6, backgroundColor: 'rgba(255,255,255,0.15)', marginTop: 6, overflow: 'hidden' }}>
        <View style={{ width: `${pct}%`, height: 12, backgroundColor: '#ffd23b' }} />
      </View>
      <Text style={[styles.hint, { fontSize: 11 }]}>{into}/{SEASON.per} XP to next tier  •  every pop, win and chain counts</Text>
      <Pressable
        disabled={claimable < 1}
        onPress={onClaim}
        style={[styles.play, { marginTop: 10, paddingVertical: 12, opacity: claimable < 1 ? 0.4 : 1 }]}
      >
        <Text style={styles.playTxt}>{claimable < 1 ? 'NOTHING TO CLAIM' : `CLAIM ${claimable} TIER${claimable > 1 ? 'S' : ''}`}</Text>
      </Pressable>
      {G.seasonMsg ? <Text style={[styles.hint, { marginTop: 8, color: '#2bff88' }]}>{G.seasonMsg}</Text> : null}
      {Array.from({ length: SEASON.tiers }, (_, i) => i + 1).map((t) => {
        const r = tierReward(t);
        const got = t <= st.claimed;
        const ready = !got && t <= tier;
        return (
          <View key={t} style={{ width: 300, flexDirection: 'row', alignItems: 'center', marginTop: 5, opacity: got ? 0.55 : ready ? 1 : 0.7, borderWidth: ready ? 2 : 0, borderColor: '#ffd23b', borderRadius: 10, padding: ready ? 4 : 0 }}>
            <Text style={{ width: 34, color: '#fff', fontFamily: FONT, fontSize: 16 }}>{t}</Text>
            <Text style={{ flex: 1, color: r.title ? '#ffd23b' : '#dde', fontSize: 13 }}>
              {r.title ? `🏅 ${r.title}   ` : ''}◆{r.sh}{r.eggs ? `  🥚${r.eggs}` : ''}
            </Text>
            <Text style={{ fontSize: 16 }}>{got ? '✅' : ready ? '🎁' : '🔒'}</Text>
          </View>
        );
      })}
      <Pressable style={{ marginTop: 16 }} onPress={onBack}>
        <Text style={styles.hint}>BACK</Text>
      </Pressable>
    </ScrollView>
  );
}

function StarReveal({ filled, delay, size }) {
  const sc = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const t = setTimeout(() => {
      Animated.spring(sc, { toValue: 1, friction: 3, tension: 200, useNativeDriver: true }).start();
    }, delay);
    return () => clearTimeout(t);
  }, []);
  return (
    <Animated.Text
      style={{
        fontSize: size,
        color: filled ? '#ffd23b' : '#2a2a4a',
        textShadowColor: filled ? '#ff8a3b' : 'transparent',
        textShadowRadius: filled ? 10 : 0,
        transform: [{ scale: sc }],
        marginHorizontal: 4,
      }}
    >
      ★
    </Animated.Text>
  );
}

function ScorePopup({ r, c, pts, cell }) {
  const y = useRef(new Animated.Value(0)).current;
  const op = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.timing(y, { toValue: -cell * 1.8, duration: 900, useNativeDriver: true }),
      Animated.sequence([
        Animated.delay(300),
        Animated.timing(op, { toValue: 0, duration: 600, useNativeDriver: true }),
      ]),
    ]).start();
  }, []);
  return (
    <Animated.Text
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: 2 + c * cell,
        top: 2 + r * cell,
        width: cell * 1.6,
        textAlign: 'center',
        color: '#ffd23b',
        fontSize: cell * 0.42,
        fontFamily: FONT,
        textShadowColor: 'rgba(90,40,0,0.95)',
        textShadowOffset: { width: 0, height: 2 },
        textShadowRadius: 1,
        opacity: op,
        transform: [{ translateY: y }],
        zIndex: 99,
      }}
    >
      +{pts}
    </Animated.Text>
  );
}


// Android draws the nav bar over the app: keep controls clear of it
// real nav-bar / home-indicator inset (falls back to the old guess if the native module is missing)
let SAFE_BOTTOM = null;
try {
  const m = require('react-native-safe-area-context').initialWindowMetrics;
  if (m && m.insets) SAFE_BOTTOM = m.insets.bottom;
} catch (e) {}
// v27 immersive: system bars are hidden during play, so only a small gesture margin is reserved at the bottom.
// expo-navigation-bar is optional: if it is not installed the game falls back to the old inset and nothing breaks.
let NavBar = null;
try {
  NavBar = require('expo-navigation-bar');
} catch (e) {}
const goImmersive = () => {
  if (Platform.OS !== 'android' || !NavBar) return;
  try {
    const a = NavBar.setVisibilityAsync && NavBar.setVisibilityAsync('hidden');
    if (a && a.catch) a.catch(() => {});
  } catch (e) {}
  try {
    const b = NavBar.setBehaviorAsync && NavBar.setBehaviorAsync('overlay-swipe');
    if (b && b.catch) b.catch(() => {});
  } catch (e) {}
};
const BOTTOM_PAD = SAFE_BOTTOM != null ? (NavBar ? Math.min(SAFE_BOTTOM, 18) : SAFE_BOTTOM) + 14 : Platform.OS === 'android' ? (NavBar ? 32 : 52) : 24;
const BOARD_BOTTOM = Math.max(4, BOTTOM_PAD - 10); // keeps the last row clear of the system nav bar
const CONTROLS_H = 86;
const HUD_H = 62; // compact HUD band at the top of the one window
const STATUS_H = (StatusBar.currentHeight || 24) + 6; // same as styles.root paddingTop
const RAIL_W = 46; // left rail: NEXT + orblings
const DIM = 'rgba(14,9,42,0.06)'; // light tint over the scene art
const BOARD_BACK = 'rgba(10,6,34,0.12)'; // glass backing behind the columns so orbs stay readable on the art
const BOARD_BG = '#130e2e';

const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function skyBands(stops, n = 36) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(t));
    const f = t - k;
    const a = hex2rgb(stops[k]);
    const b = hex2rgb(stops[k + 1]);
    out.push(`rgb(${a.map((v, j) => Math.round(v + (b[j] - v) * f)).join(',')})`);
  }
  return out;
}

// Draggable floating pad: drag the grip anywhere, double-tap the grip to reset. Position is remembered.
function FloatPad({ id, anchor, bounds, locked, children }) {
  const pos = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const base = useRef({ x: 0, y: 0 });
  const lastTap = useRef(0);
  const [edit, setEdit] = useState(false);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const place = (x, y) => {
    const nx = clamp(x, bounds.minX, bounds.maxX);
    const ny = clamp(y, bounds.minY, bounds.maxY);
    pos.setValue({ x: nx, y: ny });
    return { x: nx, y: ny };
  };
  useEffect(() => {
    if (locked) {
      base.current = { x: 0, y: 0 };
      pos.setValue({ x: 0, y: 0 });
      setEdit(false);
      return;
    }
    AsyncStorage.getItem('pad3_' + id)
      .then((v) => {
        if (!v) return;
        const o = JSON.parse(v);
        base.current = place(o.x || 0, o.y || 0);
      })
      .catch(() => {});
  }, [locked]);
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderMove: (_, g) => {
        place(base.current.x + g.dx, base.current.y + g.dy);
      },
      onPanResponderRelease: (_, g) => {
        if (Math.abs(g.dx) < 6 && Math.abs(g.dy) < 6) {
          const now = Date.now();
          if (now - lastTap.current < 350) {
            base.current = place(0, 0);
            setEdit(false);
          } else {
            setEdit((e) => !e);
          }
          lastTap.current = now;
        } else {
          base.current = place(base.current.x + g.dx, base.current.y + g.dy);
        }
        AsyncStorage.setItem('pad3_' + id, JSON.stringify(base.current)).catch(() => {});
      },
    })
  ).current;
  return (
    <Animated.View
      pointerEvents="box-none"
      style={[anchor === 'left' ? styles.padL : styles.padR, { transform: pos.getTranslateTransform() }]}
    >
      {!locked && (
        <View {...pan.panHandlers} hitSlop={10} style={[styles.grip, edit && styles.gripOn]}>
          {edit ? (
            <Text style={[styles.gripTxt, { color: '#1a0f3a' }]}>✥ DRAG ME</Text>
          ) : (
            <View style={styles.gripDots}>
              {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                <View key={n} style={styles.gripDot} />
              ))}
            </View>
          )}
        </View>
      )}
      {children}
      {!locked && edit && <View {...pan.panHandlers} style={[ABS_FILL, styles.padEdit]} />}
    </Animated.View>
  );
}

// NEXTGEN_CONTROLS (v19): transparent hit area over Skia art, press feedback on the UI thread, tight hold-repeat
function HoldButton({ onPress, repeat, repeatMs = 62, delayMs = 150, style, dim, press, children }) {
  const t = useRef(null);
  const i = useRef(null);
  const clear = () => {
    clearTimeout(t.current);
    clearInterval(i.current);
  };
  useEffect(() => clear, []);
  return (
    <Pressable
      hitSlop={6}
      onPressIn={() => {
        if (press) press.value = withTiming(1, { duration: 50 });
        if (!dim) Haptics.selectionAsync().catch(() => {});
        onPress();
        if (repeat) {
          t.current = setTimeout(() => {
            i.current = setInterval(onPress, repeatMs);
          }, delayMs);
        }
      }}
      onPressOut={() => {
        clear();
        if (press) press.value = withTiming(0, { duration: 110 });
      }}
      style={style}
    >
      {children}
    </Pressable>
  );
}

// v26 INPUT: one raw-touch controller per pad. Raw onTouch* events are delivered for every finger independently
// of React Native's single-responder system, so (1) both thumbs work at once, (2) a thumb can roll from ► to ◄
// and the direction switches instantly, (3) no Pressable can steal or cancel another finger.
const actHit = (x, y) => {
  let best = null;
  let bd = 1;
  for (const k of ['undo']) {
    const [cx, cy, r] = ACT[k];
    const lim = k === 'drop' ? 1.0 : 1.2; // hard drop is destructive: no extra reach
    const d = Math.hypot(x - cx, y - cy) / (r * lim);
    if (d < bd) {
      bd = d;
      best = k;
    }
  }
  return best;
};
function TouchZone({ size, units, hit, zones, slide, style, children }) {
  const k = size / units;
  const live = useRef({});
  const zref = useRef(zones);
  zref.current = zones;
  const href = useRef(hit);
  href.current = hit;
  const leave = (s) => {
    clearTimeout(s.t);
    clearInterval(s.i);
    s.t = null;
    s.i = null;
    const z = s.key && zref.current[s.key];
    if (z && z.press) z.press.value = withTiming(0, { duration: 110 });
    s.key = null;
  };
  const enter = (s, key) => {
    leave(s);
    if (!key) return;
    s.key = key;
    const z = zref.current[key];
    if (z.press) z.press.value = withTiming(1, { duration: 50 });
    Haptics.selectionAsync().catch(() => {});
    z.fire(true);
    if (z.rep) {
      s.t = setTimeout(() => {
        s.i = setInterval(() => {
          const zz = zref.current[key];
          if (zz) zz.fire(false);
        }, z.rep);
      }, 150);
    }
  };
  const releaseAll = () => {
    for (const id of Object.keys(live.current)) leave(live.current[id]);
    live.current = {};
  };
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st !== 'active') releaseAll();
    });
    return () => {
      sub.remove();
      releaseAll();
    };
  }, []);
  const at = (t) => href.current(t.locationX / k, t.locationY / k);
  return (
    <View
      pointerEvents="box-only"
      style={style}
      onTouchStart={(e) => {
        for (const t of e.nativeEvent.changedTouches) {
          const s = (live.current[t.identifier] = { key: null, t: null, i: null, start: at(t), dead: false });
          enter(s, s.start);
        }
      }}
      onTouchMove={(e) => {
        for (const t of e.nativeEvent.changedTouches) {
          const s = live.current[t.identifier];
          if (!s) continue;
          const key = at(t);
          if (slide) {
            if (key !== s.key) enter(s, key);
          } else if (!s.dead && key !== s.start) {
            s.dead = true; // action buttons: sliding off cancels, never switches
            leave(s);
          }
        }
      }}
      onTouchEnd={(e) => {
        for (const t of e.nativeEvent.changedTouches) {
          const s = live.current[t.identifier];
          if (s) leave(s);
          delete live.current[t.identifier];
        }
      }}
      onTouchCancel={(e) => {
        for (const t of e.nativeEvent.changedTouches) {
          const s = live.current[t.identifier];
          if (s) leave(s);
          delete live.current[t.identifier];
        }
      }}
    >
      {children}
    </View>
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
    next2: newPair(),
    attempts: {},
    startedAt: 0,
    card: null,
    cardSnap: null,
    lb: null,
    chestDay: '',
    lvlBest: {},
    newBest: false,
    pausedAt: 0,
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
    popups: [],
    earned: 1,
    fails: {},
    shards: 0,
    owned: ['gel'],
    skin: 'gel',
    missions: null,
    streak: { last: '', n: 0 },
    fever: 0,
    feverPcs: 0,
    log: '',
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
    dex: { eggs: 1, own: {}, companion: '', last: null },
    prof: { xp: 0, s: { pops: 0, games: 0, wins: 0, bestChain: 0, perfects: 0, clutches: 0, fevers: 0 }, ach: {} },
    seen: {},
    seasonMsg: '',
    race: null,
    raceRes: null,
    raceMsg: '',
    raceBusy: false,
    racePassed: false,
    pb: null,
    story: null,
    back: 'menu',
    dexShow: false,
    nxGain: null,
    rankUp: 0,
    boss: false,
    lockAt: 0,
    gx: 0,
    cell: 40,
  }).current;

  const [, setT] = useState(0);
  const renderPending = useRef(false);
  const render = useCallback(() => {
    if (renderPending.current) return;
    renderPending.current = true;
    requestAnimationFrame(() => {
      renderPending.current = false;
      if (alive.current) setT((t) => t + 1);
    });
  }, []);
  const alive = useRef(true);
  const shake = useRef(new Animated.Value(0)).current;
  const burst = useRef(new Animated.Value(0)).current;
  const float = useRef(new Animated.Value(0)).current;
  const flash = useRef(new Animated.Value(0)).current;
  const punch = useRef(new Animated.Value(1)).current;
  const fallY = useRef(new Animated.Value(0)).current;
  // Skia twins of burst/float/flash/fallY, plus one ms clock for orb falls (UI thread, no JS per frame)
  const svFloat = useSharedValue(0);
  const svBurst = useSharedValue(0);
  const svFlash = useSharedValue(0);
  const svFallY = useSharedValue(0);
  const svFall = useSharedValue(1e6);
  // v19: piece pose lives on the UI thread. x,y = pivot cell top-left (px, board canvas space), r = child angle (rad, unwrapped)
  const svPX = useSharedValue(0);
  const svPY = useSharedValue(0);
  const svPR = useSharedValue(0);
  const svGX = useSharedValue(0);
  const svGY = useSharedValue(0);
  const svGR = useSharedValue(0);
  const svLand = useSharedValue(1e6);
  const svPulse = useSharedValue(0);
  const svClock = useSharedValue(0);
  const svCool = useSharedValue(0);
  const pU = useSharedValue(0);
  const pL = useSharedValue(0);
  const pR = useSharedValue(0);
  const pD = useSharedValue(0);
  const pTurn = useSharedValue(0);
  const pUndo = useSharedValue(0);
  const pDrop = useSharedValue(0);
  const pvObj = useMemo(() => ({ x: svPX, y: svPY, r: svPR, gx: svGX, gy: svGY, gr: svGR }), []);
  const menuScroll = useRef(null);
  const cheer = useRef(new Animated.Value(0)).current; // Orbling hop on big chains
  const menuViewH = useRef(0);
  // engine-side hooks go through G.fx so the extracted engine code (Harness.mjs) never sees Skia
  const SPR_X = { stiffness: 1400, damping: 75, mass: 1, overshootClamping: true }; // critically damped: glides, never wobbles
  const SPR_R = { stiffness: 900, damping: 42, mass: 1 }; // slight overshoot on turns: juicy but still clean
  const ghostTo = (p) => {
    const cell = G.cell || 30;
    let gp = p;
    while (valid(G.board, { ...gp, r: gp.r + 1 })) gp = { ...gp, r: gp.r + 1 };
    const e = { duration: 90, easing: REasing.out(REasing.cubic) };
    svGX.value = withTiming(2 + gp.c * cell, e);
    svGY.value = withTiming(2 + gp.r * cell, e);
  };
  G.fx = {
    burst() { svBurst.value = 0; svBurst.value = withTiming(1, { duration: 280 }); },
    cheer() { cheer.setValue(0); Animated.timing(cheer, { toValue: 1, duration: 800, easing: Easing.linear, useNativeDriver: true }).start(); },
    fall(max) { const T = fallMs(max) + 300; svFall.value = 0; svFall.value = withTiming(T, { duration: T, easing: REasing.linear }); },
    // new piece: jump straight to the spawn pose (no tween)
    snap(p) {
      const cell = G.cell || 30;
      G.ang = p.o * (Math.PI / 2);
      G.vx = 0;
      G.vy = 0;
      svPX.value = 2 + p.c * cell;
      svPY.value = 2 + p.r * cell;
      svPR.value = G.ang;
      let gp = p;
      while (valid(G.board, { ...gp, r: gp.r + 1 })) gp = { ...gp, r: gp.r + 1 };
      svGX.value = 2 + gp.c * cell;
      svGY.value = 2 + gp.r * cell;
      svGR.value = G.ang;
    },
    // engine moved the piece: animate the picture to match. kind: x | rot | fall | soft | hard
    pose(p, kind, arg) {
      const cell = G.cell || 30;
      const now = Date.now();
      const x = 2 + p.c * cell;
      const y = 2 + p.r * cell;
      if (kind === 'x' || kind === 'rot') {
        svPX.value = withSpring(x, SPR_X);
        G.vx = Math.max(G.vx || 0, now + 110);
      }
      if (kind === 'rot') {
        G.ang = (G.ang || 0) + arg * (Math.PI / 2);
        svPR.value = withSpring(G.ang, SPR_R);
        svGR.value = withSpring(G.ang, SPR_R);
        svPY.value = withSpring(y, SPR_X); // wall/floor kicks move the pivot
        G.vy = now + 110;
        G.vx = Math.max(G.vx || 0, now + 150);
      } else if (kind === 'fall') {
        const ms = Math.max(60, (arg || 300) * 0.96);
        svPY.value = withTiming(y, { duration: ms, easing: REasing.linear }); // one continuous glide per row
        G.vy = now + ms;
      } else if (kind === 'soft') {
        svPY.value = withTiming(y, { duration: 62, easing: REasing.linear });
        G.vy = now + 62;
      } else if (kind === 'hard') {
        const d = arg > 0 ? Math.min(150, 55 + 12 * arg) : 0;
        svPY.value = d ? withTiming(y, { duration: d, easing: REasing.in(REasing.quad) }) : y;
        G.vy = now + d;
      }
      if (kind === 'x' || kind === 'rot') ghostTo(p);
    },
    // called by lock(): decide what stays hidden on the board until the picture has landed
    preLock(p) {
      const cell = G.cell || 30;
      const now = Date.now();
      if ((G.vy || 0) - now > 130) {
        svPY.value = withTiming(2 + p.r * cell, { duration: 110, easing: REasing.in(REasing.quad) });
        G.vy = now + 110;
      }
      G.slam = new Set(cellsOf(p).map(([r, c]) => r * COLS + c));
      G.slamMs = Math.max(0, Math.max(G.vx || 0, G.vy || 0) - now);
    },
    land() {
      svLand.value = 0;
      svLand.value = withTiming(420, { duration: 420, easing: REasing.linear });
      const id = G.landId;
      setTimeout(() => {
        if (G.landId === id) {
          G.landKeys = null;
          render();
        }
      }, 480);
    },
    sync() {
      if (G.piece) ghostTo(G.piece);
    },
    // a tap made while the board was resolving is applied to the next piece (max 700ms old)
    flush() {
      const b = G.buf;
      G.buf = null;
      if (b && Date.now() - b.t < 700 && G.status === 'playing' && G.piece) b.fn();
    },
  };
  const bannerScale = useRef(new Animated.Value(0)).current;
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
  // 2-pair queue. A prism from a x3+ chain still lands in the very next pair.
  const shiftQueue = () => {
    if (G.prismNext) {
      G.prismNext = false;
      G.next = { a: PRISM, b: rnd(G.colors) };
    } else {
      G.next = G.next2;
    }
    G.next2 = np();
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
  const soClose = () => {
    if (G.t === 'endless' || G.t === 'daily') return null;
    const p = progress();
    if (p < 0.5) return null;
    const left =
      G.t === 'chain' ? `${Math.max(1, G.goal - G.maxChain)} more chain` :
      G.t === 'rocks' ? `${rocksLeft()} rocks left` :
      G.t === 'pairs' ? `${Math.max(1, G.goal - G.placed)} pairs to go` :
      `${Math.max(1, G.goal - G.score)} points away`;
    return { head: p >= 0.9 ? 'SO CLOSE!' : p >= 0.7 ? 'ALMOST THERE' : 'GOOD TRY', left };
  };
  const goalText = () =>
    G.t === 'endless' ? 'ENDLESS'
    : G.t === 'chain' ? `CHAIN x${G.goal}`
    : G.t === 'rocks' ? `ROCKS ${rocksLeft()}`
    : G.t === 'pairs' || G.t === 'daily' ? `SURVIVE ${Math.min(G.placed, G.goal)}/${G.goal}`
    : `GOAL ${G.goal}`;

  const buzz = (n) => {
    if (!HAPTICS) return;
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

  const doFlash = (power) => {
    if (LITE) power = power * 0.4;
    flash.setValue(power);
    Animated.timing(flash, { toValue: 0, duration: 520, useNativeDriver: true }).start();
    svFlash.value = power;
    svFlash.value = withTiming(0, { duration: 520 });
  };

  const doPunch = () => {
    Animated.sequence([
      Animated.timing(punch, { toValue: 1.045, duration: 70, useNativeDriver: true }),
      Animated.timing(punch, { toValue: 1, duration: 200, useNativeDriver: true }),
    ]).start();
  };

  const doShake = (p) => {
    if (LITE) p = p / 3;
    Animated.sequence([
      Animated.timing(shake, { toValue: p, duration: 40, useNativeDriver: true }),
      Animated.timing(shake, { toValue: -p, duration: 60, useNativeDriver: true }),
      Animated.timing(shake, { toValue: p / 2, duration: 50, useNativeDriver: true }),
      Animated.timing(shake, { toValue: 0, duration: 50, useNativeDriver: true }),
    ]).start();
  };

  const startReal = (L) => {
    if (G.race) {
      G.raceRes = null;
      G.racePassed = false;
    }
    G.day = G.race ? G.race.day : dateKey();
    RNG = L === DAILY_L ? seeded(Number(G.day.replace(/-/g, ''))) : Math.random;
    if (!G.replay) touchStreak();
    const cfg = cfgOf(L);
    G.level = L;
    if (!G.replay) G.attempts[L] = (G.attempts[L] || 0) + 1;
    G.startedAt = Date.now();
    G.card = null;
    G.cardSnap = null;
    G.lb = null;
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
    G.nxGain = null;
    G.rankUp = 0;
    G.boss = false;
    G.prismNext = false;
    G.fever = 0;
    G.feverPcs = 0;
    G.log = '';
    G.continued = false;
    G.starAd = false;
    G.seq = (cfg.seq || []).map((x) => x.slice());
    G.next = np();
    G.next2 = np();
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
    G.hint = cfg.hint ? { o: cfg.hint[0], col: cfg.hint[1] } : null;
    G.biome = { v: Math.floor(Math.random() * 4), seed: 1 + Math.floor(Math.random() * 999) }; // a new look every game
    G.piece = spawn(G.next);
    if (G.hint) G.piece = { ...G.piece, o: G.hint.o }; // hinted openers arrive already turned the right way
    if (G.fx) G.fx.snap(G.piece);
    shiftQueue();
    G.status = 'playing';
    render();
  };

  const saveNx = () => {
    AsyncStorage.setItem(
      'nextgen',
      JSON.stringify({ dex: G.dex, prof: G.prof, seen: G.seen, set: { haptics: HAPTICS, lite: LITE, dock2: DOCK } })
    ).catch(() => {});
  };
  const popBanner = (txt) => {
    G.banner = txt;
    bannerScale.setValue(0);
    Animated.spring(bannerScale, { toValue: 1, friction: 4, tension: 200, useNativeDriver: true }).start();
  };
  const checkAch = () => {
    if (G.replay) return;
    let last = null;
    ACH.forEach((a) => {
      if (G.prof.ach[a.id]) return;
      let ok = false;
      try { ok = a.ok(G.prof, G); } catch (e) {}
      if (!ok) return;
      G.prof.ach[a.id] = Date.now();
      G.shards += a.r.sh || 0;
      G.dex.eggs += a.r.eggs || 0;
      last = a;
    });
    if (last) {
      saveMeta();
      saveNx();
      popBanner(`🏆 ${last.t}`);
      jingle([4, 6, 9], 70);
    }
  };
  const addXp = (n) => {
    if (G.replay) return;
    const before = rankLv(G.prof.xp);
    G.prof.xp += n;
    if (seasonActive()) seasonState(G.prof).xp += n;
    const after = rankLv(G.prof.xp);
    if (after > before) {
      G.rankUp = after;
      if (after % 2 === 0) G.dex.eggs += 1;
    }
  };
  const nxWin = (starGain) => {
    if (G.replay) return;
    G.prof.s.wins++;
    let eggs = 0;
    if (starGain > 0) eggs += 1;
    if (starGain > 0 && G.boss) eggs += 2;
    if (G.level === EVENT_L) {
      const key = `ev:${G.eventId || ''}`;
      if (!G.seen[key]) {
        G.seen[key] = 1;
        eggs += 2;
        G.shards += 3;
        saveMeta();
      }
    }
    G.dex.eggs += eggs;
    const xp = 100 + G.earned * 40 + (G.boss ? 200 : 0);
    addXp(xp);
    G.nxGain = { xp, eggs };
    checkAch();
    saveNx();
  };
  const hatchEgg = () => {
    if (G.dex.eggs < 1) return;
    G.dex.eggs--;
    const maxRealm = G.unlocked > 20 ? 3 : realmOf(G.unlocked);
    const roll = Math.random();
    const rar = roll < 0.6 ? 'c' : roll < 0.88 ? 'r' : roll < 0.98 ? 'e' : 'l';
    let pool = DEX.filter((d) => d.realm <= maxRealm && d.rar === rar);
    if (!pool.length) pool = DEX.filter((d) => d.realm <= maxRealm);
    const pick = pool[Math.floor(Math.random() * pool.length)];
    const cur = G.dex.own[pick.id] || { n: 0 };
    G.dex.own[pick.id] = { n: cur.n + 1 };
    G.dex.last = { id: pick.id, isNew: cur.n === 0, at: Date.now() };
    G.dexShow = true;
    if (!G.dex.companion) G.dex.companion = pick.id;
    jingle(rar === 'l' ? [0, 2, 4, 6, 8, 9] : [4, 6, 9], 80);
    if (rar !== 'c') sfx('choir');
    buzz(4);
    checkAch();
    saveNx();
    render();
  };
  const claimSeason = () => {
    const st = seasonState(G.prof);
    const tier = seasonTier(G.prof);
    let sh = 0, eggs = 0, title = '';
    for (let t = st.claimed + 1; t <= tier; t++) {
      const r = tierReward(t);
      sh += r.sh;
      eggs += r.eggs;
      if (r.title) title = r.title;
    }
    if (tier <= st.claimed) return;
    st.claimed = tier;
    G.shards += sh;
    G.dex.eggs += eggs;
    if (title) G.prof.title = title;
    G.seasonMsg = `+${sh} ◆${eggs ? `  +${eggs} 🥚` : ''}${title ? `  🏅 ${title}` : ''}`;
    jingle([4, 6, 9], 70);
    buzz(3);
    saveMeta();
    saveNx();
    render();
  };
  const goStatus = (st, back) => {
    G.back = back || 'menu';
    G.status = st;
    if (st !== 'dex') G.dexShow = false;
    render();
  };
  const storyNext = () => {
    const st = G.story;
    if (!st) return;
    const n = (STORY[st.key] || []).length;
    if (st.i + 1 >= n) return storyDone();
    st.i++;
    render();
  };
  const storyDone = () => {
    const L = G.story ? G.story.L : 1;
    G.story = null;
    startReal(L);
  };
  const start = (L) => {
    if (G.race && MENUISH.includes(G.status)) G.race = null;
    if (!G.replay) G.prof.s.games++;
    const key = STORY_AT[L];
    if (key && STORY[key] && !G.seen[key] && !G.replay) {
      G.seen[key] = 1;
      saveNx();
      G.level = L;
      G.story = { key, i: 0, L };
      G.status = 'story';
      render();
      return;
    }
    startReal(L);
  };

  const startRace = (g) => {
    const sim = simGhost(g.day, g.log);
    if (!sim || sim.tl.length < 3) {
      G.raceMsg = 'That ghost is not valid.';
      render();
      return;
    }
    G.race = { day: g.day, name: g.name || 'Ghost', log: g.log, tl: sim.tl, score: sim.tl[sim.tl.length - 1].s };
    G.raceRes = null;
    G.raceMsg = '';
    G.racePassed = false;
    G.replay = null;
    startReal(DAILY_L);
  };
  const startEvent = () => {
    const ev = activeEvent();
    if (!ev) return;
    G.eventId = ev.id;
    start(EVENT_L);
  };
  const raceTop = async () => {
    if (G.raceBusy) return;
    G.raceBusy = true;
    G.raceMsg = 'Fetching the champion…';
    render();
    const top = await fetchTopRun(dateKey());
    G.raceBusy = false;
    if (!top) {
      G.raceMsg = 'No top run yet today (or you are offline).';
      render();
      return;
    }
    startRace({ day: dateKey(), name: top.name, log: top.log });
  };
  const raceFinish = () => {
    const tl = G.race.tl;
    const gFinal = tl[tl.length - 1].s;
    const won = G.score > gFinal;
    G.raceRes = { won, you: G.score, ghost: gFinal, egg: false };
    G.prof.s.races = (G.prof.s.races || 0) + 1;
    if (won) {
      G.prof.s.raceWins = (G.prof.s.raceWins || 0) + 1;
      const key = `race:${G.race.day}:${G.race.score}:${G.race.name}`;
      if (!G.seen[key]) {
        G.seen[key] = 1;
        G.dex.eggs += 1;
        G.raceRes.egg = true;
      }
      addXp(150);
    } else {
      addXp(40);
    }
    checkAch();
    saveNx();
  };
  const raceShare = () => {
    if (!G.pb) return;
    Share.share({
      message: `👻 Beat my ChainOrb ghost! ${G.pb.score} pts\n${ghostCode(G.pb)}\nPaste it in ChainOrb > GHOST RACE`,
    }).catch(() => {});
  };

  const endReplay = () => {
    G.replay = null;
    G.rp = false;
    G.piece = null;
    G.cd = 0;
    G.status = 'menu';
    render();
  };

  const gameOver = () => {
    if (G.replay) return endReplay();
    logEvent('loss');
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

  const logEvent = (result) => {
    if (!ONLINE || G.race) return;
    queueEvent({
      pid: PID,
      level: G.level,
      mode: G.t,
      result,
      attempt: G.attempts[G.level] || 1,
      secs: Math.round((Date.now() - G.startedAt) / 1000),
      score: G.score,
      max_chain: G.maxChain,
      placed: G.placed,
      v: VERSION,
      country: COUNTRY,
    });
  };
  const saveDaily = () => {
    if (G.race) {
      raceFinish();
      return;
    }
    if (G.log) {
      G.pb = { day: G.day, name: NICK, score: G.score, log: G.log };
      AsyncStorage.setItem('pbghost', JSON.stringify(G.pb)).catch(() => {});
    }
    G.daily = { d: G.day, s: G.score, c: G.maxChain };
    AsyncStorage.setItem('daily', JSON.stringify(G.daily)).catch(() => {});
    if (ONLINE) {
      const day = G.day;
      submitDaily({ day, pid: PID, name: NICK, country: COUNTRY, log: G.log, ms: Date.now() - G.startedAt, v: VERSION })
        .then((r) => {
          if (r && r.ok === false) logEvent('sv_reject');
          if (r && r.ok && r.score !== G.score) {
            logEvent('sv_mismatch'); // server is the source of truth for the daily score
            G.score = r.score;
            G.daily = { d: day, s: r.score, c: r.chain };
            AsyncStorage.setItem('daily', JSON.stringify(G.daily)).catch(() => {});
          }
          return fetchBoard(day);
        })
        .then((rows) => {
          G.lb = rows || [];
          render();
        });
    }
  };
  const EMO_ROWS = () => {
    const c = G.card;
    const rows = c.grid.map((r) => r.map((v) => EMO[v] || '⬜').join(''));
    const first = Math.max(0, c.grid.findIndex((r) => r.some(Boolean)));
    return rows.slice(first);
  };
  const shareChain = () => {
    if (!G.card) return;
    Share.share({
      message: `ChainOrb x${G.card.chain} CHAIN 🔥\n${EMO_ROWS().join('\n')}\nCan you beat it?`,
    }).catch(() => {});
  };
  const skipLevel = () =>
    showAd(() => {
      logEvent('skip');
      const nxt = G.level + 1;
      if (nxt > G.unlocked) {
        G.unlocked = nxt;
        AsyncStorage.setItem('unlocked', String(G.unlocked)).catch(() => {});
      }
      G.fails[G.level] = 0;
      start(nxt);
    });
  const shareDaily = () => {
    const d = G.daily || { d: dateKey(), s: G.score, c: G.maxChain };
    Share.share({
      message: `ChainOrb Daily ${d.d}\n${d.s} pts • best chain x${d.c}\nCan you beat me?`,
    }).catch(() => {});
  };

  const saveMeta = () => {
    AsyncStorage.setItem(
      'meta',
      JSON.stringify({ shards: G.shards, owned: G.owned, skin: G.skin, missions: G.missions, streak: G.streak })
    ).catch(() => {});
  };
  const touchStreak = () => {
    if (!G.missions || G.missions.d !== dateKey()) {
      G.missions = genMissions();
      saveMeta();
    }
    const t = dateKey();
    const st = G.streak;
    if (st.last === t) return;
    st.n = st.last === dateKey(new Date(Date.now() - 86400000)) ? st.n + 1 : 1;
    st.last = t;
    if (st.n === 3 || st.n === 7 || st.n % 14 === 0) { G.shards += 2; G.dex.eggs += 1; }
    saveMeta();
  };
  const track = (k, v) => {
    if (G.replay) return;
    const m = G.missions;
    if (!m || m.d !== dateKey()) return;
    m.items.forEach((it) => {
      if (it.k !== k || it.done) return;
      it.have = k === 'chain' ? Math.max(it.have, v) : it.have + v;
      if (it.have >= it.need) {
        it.done = true;
        G.shards += 1;
        G.banner = 'MISSION DONE +1 ◆';
      bannerScale.setValue(0);
      Animated.spring(bannerScale, { toValue: 1, friction: 4, tension: 200, useNativeDriver: true }).start();
        jingle([4, 6, 9], 70);
      }
    });
    saveMeta();
  };
  const pickSkin = (id) => {
    const sk = SKINS.find((x) => x.id === id);
    if (!G.owned.includes(id)) {
      if (G.shards < sk.cost) return;
      G.shards -= sk.cost;
      G.owned.push(id);
    }
    G.skin = id;
    SKIN = id;
    saveMeta();
    render();
  };

  const showAd = (cb, kind) => {
    // real ad first (rewarded for continue / bonus star, interstitial between levels); countdown only if none is ready
    if (presentAd(kind || 'interstitial', () => { lastAdAt = Date.now(); cb(); render(); }, () => render())) return;
    G.ad = { left: 3 };
    render();
    const tick = () => {
      if (!G.ad) return;
      G.ad.left--;
      if (G.ad.left <= 0) {
        G.ad = null;
        lastAdAt = Date.now();
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
      if (G.fx) G.fx.snap(G.piece);
      shiftQueue();
    }, 'rewarded');
  const adStar = () =>
    showAd(() => {
      const before = totalStars(G.stars);
      G.earned = Math.min(3, G.earned + 1);
      G.stars[G.level] = Math.max(G.stars[G.level] || 0, G.earned);
      AsyncStorage.setItem('stars', JSON.stringify(G.stars)).catch(() => {});
      const after = totalStars(G.stars);
      G.hatched = ORBLINGS.find((o) => before < o.need && after >= o.need) || G.hatched;
      track('stars', after - before);
      G.starAd = true;
    }, 'rewarded');
  const watchTop = async () => {
    if (G.replayBusy || G.replay) return;
    G.replayBusy = true;
    const top = await fetchTopRun(G.day || dateKey());
    G.replayBusy = false;
    if (!top) {
      G.banner = 'NO REPLAY YET';
      bannerScale.setValue(0);
      Animated.spring(bannerScale, { toValue: 1, friction: 4, tension: 200, useNativeDriver: true }).start();
      render();
      setTimeout(() => { G.banner = ''; render(); }, 1500);
      return;
    }
    const token = Date.now();
    G.replay = { token, name: top.name, score: top.score };
    start(DAILY_L);
    const live = () => alive.current && G.replay && G.replay.token === token;
    const wait = async () => {
      while (live() && (G.status === 'resolving' || G.status === 'paused')) await sleep(40);
    };
    await sleep(250);
    for (const ch of top.log) {
      if (!live()) return;
      await wait();
      if (!live() || G.status !== 'playing') break;
      G.rp = true;
      try {
        if (ch === 'L') move(-1);
        else if (ch === 'R') move(1);
        else if (ch === 'c') rotate(1);
        else if (ch === 'w') rotate(-1);
        else if (ch === 's') softDrop();
        else if (ch === 'h') hardDrop();
        else step(true); // 'd' and 'k': one cell down, or lock when blocked
      } finally {
        G.rp = false;
      }
      await sleep((ch === 'd' || ch === 'k' ? 110 : ch === 'h' ? 90 : 70) * (5 / (G.rpSpeed || 5)));
    }
    await wait();
    if (live()) endReplay();
  };

  const nextAction = () => {
    if (G.race) return startRace(G.race);
    if (G.t === 'daily') return shareDaily();
    const nxt = G.status === 'won' && G.level < MAX_LEVEL ? G.level + 1 : G.level;
    if (G.status === 'won' && adDue(G.level)) showAd(() => start(nxt));
    else start(nxt);
    return null;
  };

  const win = () => {
    if (G.replay) return endReplay();
    logEvent('win');
    if (G.t === 'daily') {
      saveDaily();
      if (!G.race) addXp(120);
      saveNx();
      G.status = 'over';
      G.piece = null;
      jingle([0, 2, 4, 6, 9]);
      sfx('choir');
      render();
      return;
    }
    G.status = 'won';
    G.fails[G.level] = 0;
    G.newBest = G.score > (G.lvlBest[G.level] || 0);
    if (G.newBest) {
      G.lvlBest[G.level] = G.score;
      AsyncStorage.setItem('lvlBest', JSON.stringify(G.lvlBest)).catch(() => {});
    }
    jingle([0, 2, 4, 6, 9]);
    sfx('choir');
    G.earned =
      1 + (G.maxChain >= 3 ? 1 : 0) + (G.placed <= 10 + G.level * 2 ? 1 : 0);
    const before = totalStars(G.stars);
    if (G.level < 900 && G.earned > (G.stars[G.level] || 0)) {
      G.stars[G.level] = G.earned;
      AsyncStorage.setItem('stars', JSON.stringify(G.stars)).catch(() => {});
    }
    const after = totalStars(G.stars);
    G.hatched = ORBLINGS.find((o) => before < o.need && after >= o.need) || null;
    track('levels', 1);
    track('stars', after - before);
    G.boss = G.level % 10 === 0;
    nxWin(after - before);
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
    G.buf = null;
    const wasDanger = G.board.slice(0, 4).some((row) => row.some(Boolean));
    const feverAtLock = G.feverPcs > 0;
    render();
    if (G.slam) {
      await sleep(G.slamMs || 0); // let the picture finish landing, then swap to board orbs
      G.landKeys = G.slam;
      G.landId = (G.landId || 0) + 1;
      G.slam = null;
      if (G.fx) G.fx.land();
      render();
    }
    while (alive.current) {
      const fm = fallMap(G.board);
      if (gravity(G.board)) {
        G.fall = fm.m;
        G.fallId = (G.fallId || 0) + 1;
        if (G.fx) G.fx.fall(fm.max);
        render();
        await sleep(Math.max(130, fallMs(fm.max) + 110));
        G.fall = null;
      }
      const groups = findGroups(G.board);
      if (!groups.length) break;
      G.chain++;
      if (G.chain === 1) G.cardSnap = G.board.map((row) => row.slice());
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
      for (const k of [...hit]) {
        const zr = Math.floor(k / COLS);
        const zc = k % COLS;
        if (G.board[zr][zc] !== ZAP) continue;
        for (let x = 0; x < COLS; x++) if (G.board[zr][x]) hit.add(zr * COLS + x);
      }
      const cells = [...hit].map((k) => [Math.floor(k / COLS), k % COLS]);
      G.rings = cells.map(([r, c]) => ({ r, c, col: G.board[r][c] }));
      G.popping = hit;
      if (G.chain >= 2) {
        G.banner = `x${G.chain} CHAIN`;
        bannerScale.setValue(0);
        Animated.spring(bannerScale, { toValue: 1, friction: 4, tension: 160, useNativeDriver: true }).start();
      }
      render();
      buzz(G.chain);
      playChain(G.chain, flat.length);
      if (G.chain >= 3) G.prismNext = true;
      track('pops', flat.length);
      track('chain', G.chain);
      if (!G.replay) {
        G.prof.s.pops += flat.length;
        G.prof.s.bestChain = Math.max(G.prof.s.bestChain, G.chain);
        addXp(flat.length + G.chain * 3);
      }
      if (G.chain >= 2) setTimeout(() => buzz(G.chain), 90);
      // hit-stop: the pop frame freezes for 60 ms on a pop of 6+
      if (big.length >= 6) await sleep(60);
      burst.setValue(0);
      Animated.timing(burst, { toValue: 1, duration: 280, useNativeDriver: true }).start();
      if (G.fx) G.fx.burst();
      if (G.fx && G.chain >= 3) G.fx.cheer();
      if (G.chain >= 3) {
        doShake(Math.min(4 + G.chain * 2, 16));
        // wave of light; at x7 and above the whole world flares
        doFlash(G.chain >= 7 ? 0.5 : Math.min(0.36, 0.14 + G.chain * 0.04));
      }
      if (G.chain >= 4) doPunch();
      // slow-mo: the cascade ripples out slower from chain 3 up
      await sleep(G.chain >= 3 && !LITE ? 520 : 260);
      const pts = flat.length * 10 * Math.pow(2, G.chain - 1) * (G.feverPcs > 0 ? 2 : 1);
      G.score += pts;
      const centR = flat.reduce((a,x)=>a+x[0],0)/flat.length;
      const centC = flat.reduce((a,x)=>a+x[1],0)/flat.length;
      G.popups = [...(G.popups||[]).slice(-5), { id: Date.now()+Math.random(), r: centR, c: centC, pts }];
      if (!(G.feverPcs > 0)) {
        G.fever += flat.length * 4;
        if (G.fever >= 100) {
          G.fever = 0;
          G.feverPcs = 3; // fever x2 lasts 3 pieces: deterministic, so the server can replay it
          G.banner = 'FEVER x2!';
      bannerScale.setValue(0);
      Animated.spring(bannerScale, { toValue: 1, friction: 4, tension: 200, useNativeDriver: true }).start();
          track('fever', 1);
          if (!G.replay) G.prof.s.fevers++;
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
      } else if (big.length === 5 && G.level !== DAILY_L) {
        const [br, bc] = big.reduce((m, x) => (x[0] > m[0] ? x : m));
        G.board[br][bc] = ZAP;
      }
      render();
      await sleep(110);
    }
    if (!alive.current) return;
    if (feverAtLock && G.feverPcs > 0) G.feverPcs--;
    if (G.cardSnap && G.chain >= 3 && G.chain > (G.card ? G.card.chain : 0)) {
      G.card = { chain: G.chain, grid: G.cardSnap };
    }
    G.cardSnap = null;
    if (G.board.every((row) => row.every((v) => !v))) {
      G.score += 500;
      G.banner = 'PERFECT!';
      if (!G.replay) { G.prof.s.perfects++; addXp(150); }
      bannerScale.setValue(0);
      Animated.spring(bannerScale, { toValue: 1, friction: 4, tension: 200, useNativeDriver: true }).start();
      jingle([0, 2, 4, 6, 8, 9], 70);
      sfx('choir');
      doShake(16);
    } else if (wasDanger && !G.board.slice(0, 4).some((row) => row.some(Boolean))) {
      G.score += 200;
      G.banner = 'CLUTCH!';
      if (!G.replay) { G.prof.s.clutches++; addXp(60); }
      bannerScale.setValue(0);
      Animated.spring(bannerScale, { toValue: 1, friction: 4, tension: 200, useNativeDriver: true }).start();
      jingle([4, 6, 9], 80);
      doShake(10);
    }
    G.maxChain = Math.max(G.maxChain, G.chain);
    if (G.race && !G.racePassed) {
      const ge = G.race.tl[Math.min(G.placed, G.race.tl.length - 1)];
      if (G.score > ge.s) {
        G.racePassed = true;
        popBanner('👻 AHEAD!');
        jingle([4, 6, 9], 70);
      }
    }
    checkAch();
    saveNx();
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
        const fm2 = fallMap(G.board);
        gravity(G.board);
        G.fall = fm2.m;
        G.fallId = (G.fallId || 0) + 1;
        if (G.fx) G.fx.fall(fm2.max);
        render();
        await sleep(Math.max(150, fallMs(fm2.max) + 110));
        G.fall = null;
      }
    }
    const p = spawn(G.next);
    if (!valid(G.board, p)) {
      gameOver();
      return;
    }
    G.piece = p;
    if (G.fx) G.fx.snap(G.piece);
    shiftQueue();
    G.status = 'playing';
    render();
    if (G.fx) G.fx.flush();
  };

  const lock = () => {
    G.lockAt = 0;
    G.hint = null;
    if (G.fx && G.piece) G.fx.preLock(G.piece);
    const landFx = () => {
      buzz(0);
      sfx('land');
      Animated.sequence([Animated.timing(punch,{toValue:0.972,duration:60,useNativeDriver:true}),Animated.spring(punch,{toValue:1,friction:3,useNativeDriver:true})]).start();
    };
    if (G.fx && G.slamMs > 0) setTimeout(landFx, G.slamMs);
    else landFx();
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

  const step = (force, glide) => {
    if (G.status !== 'playing' || !G.piece) return false;
    const p2 = { ...G.piece, r: G.piece.r + 1 };
    if (valid(G.board, p2)) {
      if (!force) G.log += 'd';
      G.piece = p2;
      G.lockAt = 0;
      if (G.fx) G.fx.pose(p2, force ? 'soft' : 'fall', glide);
      return true;
    }
    if (force || (G.lockAt && Date.now() - G.lockAt >= 350)) {
      if (!force) G.log += 'k';
      lock();
    }
    else if (!G.lockAt) G.lockAt = Date.now();
    return false;
  };

  const softDrop = () => {
    if (G.replay && !G.rp) return;
    if (G.status !== 'playing' || !G.piece) return;
    G.log += 's';
    if (step(true)) G.score += 1;
  };

  // sliding a resting piece buys a fresh lock window (max 6 per piece) so it cannot lock mid-slide
  const bumpLock = (p2) => {
    const n = G.piece.lr || 0;
    if (G.lockAt && n < 6) {
      G.lockAt = 0;
      p2.lr = n + 1;
    } else p2.lr = n;
    return p2;
  };

  const move = (dx) => {
    if (G.replay && !G.rp) return;
    if (G.status !== 'playing' || !G.piece) return;
    G.log += dx > 0 ? 'R' : 'L';
    const p2 = { ...G.piece, c: G.piece.c + dx };
    if (valid(G.board, p2)) {
      G.piece = bumpLock(p2);
      if (G.fx) G.fx.pose(G.piece, 'x');
    }
  };

  const rotate = (dir) => {
    if (G.replay && !G.rp) return;
    if (G.status !== 'playing' || !G.piece) return;
    G.log += dir > 0 ? 'c' : 'w';
    const p2 = tryRotate(G.board, G.piece, dir);
    if (p2) {
      G.piece = bumpLock(p2);
      if (G.fx) G.fx.pose(G.piece, 'rot', dir);
    }
  };

  const hardDrop = () => {
    if (G.replay && !G.rp) return;
    if (G.status !== 'playing' || !G.piece) return;
    G.log += 'h';
    let n = 0;
    while (true) {
      const p2 = { ...G.piece, r: G.piece.r + 1 };
      if (!valid(G.board, p2)) break;
      G.piece = p2;
      n++;
    }
    G.score += n * 2;
    if (G.fx) G.fx.pose(G.piece, 'hard', n);
    lock();
  };

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        G.gx = 0;
        measureBoard();
      },
      onPanResponderMove: (_, g) => {
        // wider dead band (0.65 cell) so a small wobble never reverses the piece; fast swipes can step several cells
        for (let n = 0; n < 3; n++) {
          const dx = g.dx - G.gx;
          if (Math.abs(dx) < G.cell * 0.65) break;
          move(dx > 0 ? 1 : -1);
          G.gx += dx > 0 ? G.cell : -G.cell;
        }
      },
      onPanResponderRelease: (_, g) => {
        if (g.dy > 70 && g.vy > 0.5 && Math.abs(g.dx) < 50) hardDrop();
        else if (Math.abs(g.dx) < 12 && Math.abs(g.dy) < 12) {
          // TAP: on the piece = turn it; on any other column = glide the piece there
          const col = G.bx != null && G.cell ? Math.floor((g.x0 - G.bx - 5) / G.cell) : -1;
          const onPiece = G.piece && cellsOf(G.piece).some(([, c]) => c === col);
          if (G.piece && col >= 0 && col < COLS && !onPiece) {
            let n = 0;
            while (G.piece && G.piece.c !== col && n++ < COLS) {
              const before = G.piece.c;
              move(col > G.piece.c ? 1 : -1);
              if (!G.piece || G.piece.c === before) break;
            }
          } else rotate(1);
        }
      },
    })
  ).current;

  const boardRef = useRef(null);
  const measureBoard = () => {
    if (boardRef.current && boardRef.current.measureInWindow) boardRef.current.measureInWindow((x) => { G.bx = x; });
  };
  const pause = () => {
    if (G.status !== 'playing' || !G.piece) return;
    G.status = 'paused';
    G.pausedAt = Date.now();
    render();
  };
  const resume = () => {
    if (G.status !== 'paused') return;
    const d = Date.now() - G.pausedAt;
    if (G.slowUntil > G.pausedAt) G.slowUntil += d;
    G.lockAt = 0;
    G.status = 'playing';
    render();
  };

  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st !== 'active') pause();
    });
    return () => sub.remove();
  }, []);
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const s = G.status;
      if (s === 'playing') { pause(); return true; }
      if (s === 'paused') { resume(); return true; }
      if (s === 'menu') return false; // on the map: let Android leave the app
      if (s === 'resolving' || s === 'story') return true;
      G.status = 'menu';
      render();
      return true;
    });
    return () => sub.remove();
  }, []);

  const usePower = (id) => {
    if (G.t === 'daily' || G.status !== 'playing' || !G.piece || G.used[id]) return;
    const isRock = (v) => v === ROCK || v === CRACK;
    if (id === 'crane') {
      G.slowUntil = Date.now() + 6000;
    } else if (id === 'kob') {
      if (!G.snap) return;
      G.board = G.snap.board.map((row) => row.slice());
      G.score = G.snap.score;
      G.placed = G.snap.placed;
      G.next2 = G.next;
      G.next = { a: G.piece.a, b: G.piece.b };
      G.piece = spawn({ a: G.snap.a, b: G.snap.b });
      if (G.fx) G.fx.snap(G.piece);
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
    if (G.fx) G.fx.sync();
    render();
  };

  const speed = () =>
    Math.max(110, G.base - Math.floor(G.placed / 8) * 30) * (Date.now() < G.slowUntil ? 2.5 : 1) * (G.feverPcs > 0 ? 1.8 : 1);

  useEffect(() => {
    alive.current = true;
    initSound();
    loadOnline();
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
    AsyncStorage.getItem('meta')
      .then((v) => {
        if (v) {
          const m = JSON.parse(v);
          G.shards = m.shards || 0;
          G.owned = m.owned || ['gel'];
          G.skin = m.skin || 'gel';
          SKIN = G.skin;
          G.missions = m.missions || null;
          G.streak = m.streak || { last: '', n: 0 };
          render();
        }
      })
      .catch(() => {});
    loadRemote().then(() => render());
    AsyncStorage.getItem('pbghost')
      .then((v) => {
        if (v) {
          G.pb = JSON.parse(v);
          render();
        }
      })
      .catch(() => {});
    AsyncStorage.getItem('nextgen')
      .then((v) => {
        if (!v) return;
        const j = JSON.parse(v);
        if (j.dex) G.dex = Object.assign({ eggs: 0, own: {}, companion: '', last: null }, j.dex);
        if (j.prof) {
          G.prof = {
            xp: j.prof.xp || 0,
            s: Object.assign({ pops: 0, games: 0, wins: 0, bestChain: 0, perfects: 0, clutches: 0, fevers: 0 }, j.prof.s || {}),
            ach: j.prof.ach || {},
            season: j.prof.season,
            title: j.prof.title,
          };
        }
        G.seen = j.seen || {};
        HAPTICS = !(j.set && j.set.haptics === false);
        LITE = !!(j.set && j.set.lite);
        DOCK = !!(j.set && j.set.dock2 === true);
        render();
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
    AsyncStorage.getItem('chestDay')
      .then((v) => {
        if (v) {
          G.chestDay = v;
          render();
        }
      })
      .catch(() => {});
    AsyncStorage.getItem('lvlBest')
      .then((v) => {
        if (v) {
          G.lvlBest = JSON.parse(v) || {};
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
    svFloat.value = withRepeat(withTiming(1, { duration: 2600, easing: REasing.inOut(REasing.ease) }), -1, true);
    svPulse.value = withRepeat(withTiming(1, { duration: 800, easing: REasing.inOut(REasing.ease) }), -1, true);
    svClock.value = withRepeat(withTiming(1, { duration: 24000, easing: REasing.linear }), -1, false);
    let t;
    const loop = () => {
      if (!G.replay) step(false, speed());
      t = setTimeout(loop, speed());
    };
    t = setTimeout(loop, 700);
    return () => {
      alive.current = false;
      clearTimeout(t);
    };
  }, []);

  /* ---------- draw ---------- */
  useEffect(() => {
    initAds();
  }, []);
  // v29: the world cools as you play: tint rises with goal progress (or pieces placed in endless/daily)
  const coolRaw = G.status === 'menu' ? 0 : Math.max(progress(), Math.min(1, G.placed / 40));
  const coolT = Number.isFinite(coolRaw) ? Math.max(0, Math.min(1, coolRaw)) : 0;
  useEffect(() => {
    svCool.value = withTiming(coolT, { duration: 1200 });
  }, [Math.round(coolT * 20), G.level, G.status === 'menu']);
  // v27: full-screen. Hide system bars on launch and every time the app returns to the foreground.
  useEffect(() => {
    goImmersive();
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') goImmersive();
    });
    return () => sub.remove();
  }, []);
  const hs = width / 768; // mockup scale
  const hudH = Math.round(hs * 168);
  const RAIL = Math.round(106 * hs);
  const dockH = DOCK ? Math.round(120 * hs) + (BOTTOM_PAD - BOARD_BOTTOM) + 4 : 0;
  const cell = Math.max(
    24,
    Math.min(Math.floor((width - RAIL - 12) / COLS), Math.floor((height - STATUS_H - hudH - BOARD_BOTTOM - dockH - 8) / ROWS))
  );
  const boardTop = height - BOARD_BOTTOM - dockH - (cell * ROWS + 8);
  const boardPadL = RAIL + Math.max(0, Math.floor((width - RAIL - (cell * COLS + 8)) / 2));

  G.cell = cell;
  const danger = G.board.slice(0, 4).some((row) => row.some(Boolean));
  const display = G.board.map((row) => row.slice());

  const realm = realmOf(['menu', 'dex', 'profile', 'settings', 'race', 'season'].includes(G.status) ? G.unlocked : G.level);
  const bio = G.biome || { v: (G.unlocked || 1) % 4, seed: 7 };
  useEffect(() => {
    setMusic(realm);
    setInstrument(realm);
  }, [realm, MUTED]);
  const tense = danger && (G.status === 'playing' || G.status === 'resolving');
  useEffect(() => {
    setMusicRate(tense ? 1.15 : 1);
  }, [tense]);
  const cdRef = useRef(0);
  useEffect(() => {
    if (G.replay || G.status !== 'playing' || G.placed !== 0 || G.log || cdRef.current === G.startedAt) return;
    const my = G.startedAt;
    cdRef.current = my;
    G.status = 'resolving';
    G.cd = 3;
    render();
    const iv = setInterval(() => {
      if (G.startedAt !== my || !alive.current || G.status !== 'resolving') { G.cd = 0; clearInterval(iv); render(); return; }
      G.cd--;
      if (G.cd <= 0) { G.cd = 0; G.status = 'playing'; clearInterval(iv); buzz(1); }
      render();
    }, 550);
  }, [G.startedAt, G.status]);
  const paused = G.status === 'paused';
  const showCtl = G.status === 'playing' || G.status === 'resolving';
  useEffect(() => {
    musHold = paused;
    applyMusic();
  }, [paused]);
  const T = REALMS[realm];

  // find cells in groups of 2+ (show chain potential to player)
  const glowSet = new Set();
  if (G.status === 'playing' || G.status === 'resolving') {
    const seen2 = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const v = display[r][c];
        if (!v || v >= ROCK || seen2[r][c]) continue;
        const grp = [];
        const stk = [[r, c]];
        while (stk.length) {
          const [y, x] = stk.pop();
          if (y < 0 || y >= ROWS || x < 0 || x >= COLS || seen2[y][x] || display[y][x] !== v) continue;
          seen2[y][x] = true;
          grp.push([y, x]);
          stk.push([y + 1, x], [y - 1, x], [y, x + 1], [y, x - 1]);
        }
        if (grp.length >= 2) grp.forEach(([y, x]) => glowSet.add(y * COLS + x));
      }
    }
  }

  const ghost = []; // legacy View renderer only; v19 ghost lives in PieceLayer
  if (G.piece) G.pvLast = { a: G.piece.a, b: G.piece.b };
  const pvPair = G.piece || G.slam ? G.pvLast : null;
  const crew = Object.keys(G.dex.own).map((id) => DEX.find((d) => d.id === id)).filter(Boolean).map((d) => d.icon);
  const buddyD = DEX.find((d) => d.id === G.dex.companion);
  const buddy = buddyD ? buddyD.icon : '';

  return (
    <View style={[styles.root, { backgroundColor: T.bg }]}>
      <StatusBar barStyle="light-content" hidden translucent backgroundColor="transparent" />
      <View pointerEvents="none" style={ABS_FILL}>
        <SceneGuard key={realm} fallback={<ForestScene W={width} H={height} clock={svClock} pal={PALS[0]} flip={false} seed={1} cool={svCool} realm={0} />}>
          <WorldScene realm={realm} bio={bio} W={width} H={height} clock={svClock} cool={svCool} />
        </SceneGuard>
        {false && skyBands(T.sky).map((c, i) => (
          <View key={i} style={{ flex: 1, backgroundColor: c }} />
        ))}
        {false && <Scene realm={realm} width={width} height={height} />}
        {false && [
          { l: '-10%', t: '8%', z: 180, o: 0.10 },
          { l: '60%', t: '30%', z: 140, o: 0.09 },
          { l: '15%', t: '62%', z: 220, o: 0.08 },
          { l: '70%', t: '80%', z: 120, o: 0.10 },
        ].map((d, i) => (
          <View
            key={i}
            style={{ position: 'absolute', left: d.l, top: d.t, width: d.z, height: d.z, borderRadius: d.z, backgroundColor: '#fff', opacity: d.o }}
          />
        ))}
      </View>

      <View pointerEvents="none" style={[ABS_FILL, { backgroundColor: T.dim || DIM }]} />
      <View pointerEvents="none" style={[ABS_FILL, { backgroundColor: T.glass || BOARD_BACK }]} />

      {!MENUISH.includes(G.status) && !!G.coach && !(G.placed > 0) && (
        <View pointerEvents="none" style={{ position: 'absolute', left: Math.round(150 * hs), right: 0, top: boardTop + cell * 1.7, alignItems: 'center' }}>
          <View style={{ width: width * 0.68, alignItems: 'center', justifyContent: 'center', paddingVertical: 10 }}>
            <Sparkles w={width * 0.68} h={Math.round(width * 0.055) * 3.4} tw={svFloat} />
            <Text style={[styles.coachFloat2, { fontSize: Math.round(width * 0.055), lineHeight: Math.round(width * 0.066), maxWidth: width * 0.64 }]}>{G.coach}</Text>
          </View>
        </View>
      )}

      <View style={{ flexDirection: 'row', alignItems: 'flex-start', width, paddingLeft: boardPadL }}>
        {!MENUISH.includes(G.status) && (
        <View style={{ position: 'absolute', left: Math.round(2 * hs), top: 6, width: Math.round(100 * hs), alignItems: 'center', zIndex: 5 }}>
          <View style={{ width: Math.round(100 * hs), height: Math.round(312 * hs), marginBottom: 4 }}>
            <NextArt s={hs} orbs={[G.next.b, G.next.a, G.next2.b]} skin={SKIN} />
            <Text pointerEvents="none" style={[styles.nextLbl2, { top: Math.round(34 * hs), fontSize: Math.round(22 * hs) }]}>NEXT</Text>
          </View>
          {ORBLINGS.map((o, i) => {
            const owned = totalStars(G.stars) >= o.need;
            if (!owned) return null;
            const spent = G.used[o.id];
            return (
              <Pressable
                key={o.id}
                disabled={!owned || !!spent || G.t === 'daily' || G.status !== 'playing'}
                onPress={() => usePower(o.id)}
                style={[
                  styles.chip,
                  { borderColor: owned ? T.accent : '#2a2a4a', opacity: owned && !spent ? 1 : 0.7 },
                ]}
              >
                <Animated.Text
                  style={{
                    fontSize: 20,
                    transform: owned
                      ? [
                          { translateY: cheer.interpolate({ inputRange: [0, 0.02 + i * 0.08, 0.22 + i * 0.08, 0.42 + i * 0.08, 1], outputRange: [0, 0, -14, 0, 0] }) },
                          { scale: cheer.interpolate({ inputRange: [0, 0.02 + i * 0.08, 0.22 + i * 0.08, 0.42 + i * 0.08, 1], outputRange: [1, 1, 1.3, 1, 1] }) },
                        ]
                      : [],
                  }}
                >
                  {owned ? o.icon : '🥚'}
                </Animated.Text>
              </Pressable>
            );
          })}
          {G.race ? (() => {
            const ge = G.race.tl[Math.min(G.placed, G.race.tl.length - 1)];
            return <GhostPanel w={Math.round(94 * hs)} name={G.race.name} gScore={ge.s} you={G.score} board={ge.b} placed={G.placed} goal={40} />;
          })() : null}
        </View>
        )}
      <Animated.View {...pan.panHandlers} style={{ transform: [{ translateX: shake }, { scale: punch }] }}>
        <View ref={boardRef} onLayout={measureBoard} style={[styles.board, { width: cell * COLS + 8, height: cell * ROWS + 8, backgroundColor: 'transparent', borderColor: G.feverPcs > 0 ? '#ffd23b' : 'transparent' }]}>
          {USE_SKIA && (
            <BoardCanvas
              board={display} cell={cell} skin={SKIN} popping={G.popping} fall={G.fall} fallId={G.fallId || 0}
              rings={G.rings} glow={glowSet} danger={danger} hide={G.slam} landKeys={G.landKeys} landId={G.landId || 0}
              playing={G.status === 'playing'} accent={T.accent}
              sv={{ float: svFloat, burst: svBurst, flash: svFlash, fall: svFall, land: svLand }}
            />
          )}
          {USE_SKIA && G.hint && G.status === 'playing' && (
            <HintBeam left={2 + (G.hint.o === 3 ? G.hint.col - 1 : G.hint.col) * cell} width={cell * (G.hint.o === 1 || G.hint.o === 3 ? 2 : 1)} cell={cell} H={cell * ROWS + 2} pulse={svPulse} />
          )}
          {USE_SKIA && (
            <PieceLayer a={pvPair ? pvPair.a : 0} b={pvPair ? pvPair.b : 0} cell={cell} W={cell * COLS + 2} H={cell * ROWS + 2} danger={danger} skin={SKIN} pv={pvObj} />
          )}
          {!USE_SKIA && (<>
          {display.map((row, r) => (
            <View key={r} style={{ flexDirection: 'row' }}>
              {row.map((col, c) => {
                const fd = G.fall && col ? G.fall.get(r * COLS + c) : 0;
                const orb = (
                  <Orb
                    color={col}
                    size={cell}
                    popping={G.popping.has(r * COLS + c)}
                    worry={danger}
                  />
                );
                return fd ? (
                  <Fall key={`f${c}-${G.fallId}`} dist={fd} cell={cell}>{orb}</Fall>
                ) : (
                  <Animated.View
                    key={c}
                    style={{ width: cell, height: cell, transform: col && !G.popping.has(r * COLS + c) ? [{ translateY: float.interpolate({ inputRange: [0, 1], outputRange: [0, cell * 0.02] }) }, { scaleY: float.interpolate({ inputRange: [0, 1], outputRange: [1, 0.97] }) }] : [] }}
                  >
                    {orb}
                  </Animated.View>
                );
              })}
            </View>
          ))}

          {Array.from({ length: ROWS - 1 }, (_, i) => (
            <View key={`hr${i}`} pointerEvents="none" style={{ position: 'absolute', left: 2, right: 2, top: 2 + (i + 1) * cell, height: 1, backgroundColor: 'rgba(255,255,255,0.04)' }} />
          ))}
          {Array.from({ length: COLS - 1 }, (_, i) => (
            <View key={`vc${i}`} pointerEvents="none" style={{ position: 'absolute', top: 2, bottom: 2, left: 2 + (i + 1) * cell, width: 1, backgroundColor: 'rgba(255,255,255,0.04)' }} />
          ))}

          {[...glowSet].map((k) => {
            const gr = Math.floor(k / COLS);
            const gc = k % COLS;
            const gcol = display[gr][gc];
            const isAlmost = !G.popping.has(k);
            return isAlmost ? (
              <Animated.View
                key={`gl${k}`}
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: 2 + gc * cell + cell * 0.08,
                  top: 2 + gr * cell + cell * 0.08,
                  width: cell * 0.84,
                  height: cell * 0.84,
                  borderRadius: cell,
                  backgroundColor: COLORS[gcol],
                  opacity: float.interpolate({ inputRange: [0, 1], outputRange: [0.1, 0.22] }),
                }}
              />
            ) : null;
          })}

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

          <Animated.View
            pointerEvents="none"
            style={[
              ABS_FILL,
              { borderRadius: 10, backgroundColor: T.accent, opacity: flash },
            ]}
          />

          {G.piece && (
            <Animated.View
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: cell * COLS + 4,
                height: cell * ROWS + 4,
                transform: [{ translateY: fallY }],
              }}
            >
              {cellsOf(G.piece).map(([r, c, col], k) =>
                r >= 0 && r < ROWS && c >= 0 && c < COLS ? (
                  <View key={k} style={{ position: 'absolute', left: 2 + c * cell, top: 2 + r * cell }}>
                    <Orb color={col} size={cell} worry={danger} active />
                  </View>
                ) : null
              )}
            </Animated.View>
          )}

          {danger && G.status === 'playing' && (
            <Animated.View
              pointerEvents="none"
              style={[
                ABS_FILL,
                {
                  borderRadius: 10,
                  borderWidth: 3,
                  borderColor: '#ff3b6b',
                  opacity: float.interpolate({ inputRange: [0, 1], outputRange: [0.15, 0.8] }),
                },
              ]}
            />
          )}

          </>)}

          {(G.popups || []).map((o) => (
            <ScorePopup key={o.id} r={o.r} c={o.c} pts={o.pts} cell={cell} color={COLORS[G.board[Math.round(o.r)] && G.board[Math.round(o.r)][Math.round(o.c)] || 1]} />
          ))}

          {G.replay && (
            <View style={{ position: 'absolute', top: 6, left: 0, right: 0, alignItems: 'center' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Pressable onPress={endReplay} style={{ backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 12, paddingVertical: 5, borderRadius: 14 }}>
                  <Text style={{ color: '#ffd23b', fontFamily: FONT, fontSize: 12, letterSpacing: 1 }}>▶ REPLAY {G.replay.name} {G.replay.score}  ✕ STOP</Text>
                </Pressable>
                <Pressable
                  hitSlop={6}
                  onPress={() => {
                    G.rpSpeed = (G.rpSpeed || 5) === 5 ? 1 : G.rpSpeed === 1 ? 2 : 5;
                    render();
                  }}
                  style={{ marginLeft: 6, backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14 }}
                >
                  <Text style={{ color: '#fff', fontFamily: FONT, fontSize: 12 }}>{G.rpSpeed || 5}x</Text>
                </Pressable>
              </View>
            </View>
          )}
          {G.cd > 0 && (
            <View pointerEvents="none" style={[ABS_FILL, { alignItems: 'center', justifyContent: 'center' }]}>
              <Text style={{ fontSize: 96, fontWeight: '900', color: '#fff', textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 12 }}>{G.cd}</Text>
            </View>
          )}

          {!USE_SKIA && (<>
          {G.rings.slice(0, 16).map((o) => [0, 1, 2, 3, 4].map((i) => {
            const a = (i / 5) * Math.PI * 2 + (o.r * 7 + o.c * 3) * 0.5;
            const d = cell * (0.9 + (i % 2) * 0.35);
            return (
              <Animated.View
                key={`pt${o.r}-${o.c}-${i}`}
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: 2 + o.c * cell + cell * 0.4,
                  top: 2 + o.r * cell + cell * 0.4,
                  width: cell * 0.2,
                  height: cell * 0.2,
                  borderRadius: cell,
                  backgroundColor: COLORS[o.col],
                  opacity: burst.interpolate({ inputRange: [0, 0.7, 1], outputRange: [1, 0.9, 0] }),
                  transform: [
                    { translateX: burst.interpolate({ inputRange: [0, 1], outputRange: [0, Math.cos(a) * d] }) },
                    { translateY: burst.interpolate({ inputRange: [0, 1], outputRange: [0, Math.sin(a) * d + cell * 0.3] }) },
                    { scale: burst.interpolate({ inputRange: [0, 1], outputRange: [1, 0.3] }) },
                  ],
                }}
              />
            );
          }))}

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

          {G.status === 'playing' && [0,1,2,3,4,5].map((i) => (
            <Animated.View
              key={`p${i}`}
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: `${12 + i * 15}%`,
                top: `${10 + ((i * 37) % 70)}%`,
                width: 3,
                height: 3,
                borderRadius: 3,
                backgroundColor: T.accent,
                opacity: float.interpolate({ inputRange: [0, 1], outputRange: [i % 2 === 0 ? 0.08 : 0.18, i % 2 === 0 ? 0.22 : 0.06] }),
                transform: [{ translateY: float.interpolate({ inputRange: [0, 1], outputRange: [0, i % 2 === 0 ? -18 : 14] }) }],
              }}
            />
          ))}

          </>)}

          {G.banner ? (
            <View style={[styles.bannerWrap, /^x\d+ CHAIN$/.test(G.banner) && { alignItems: 'flex-end', justifyContent: 'flex-start', paddingTop: 8, paddingRight: 8 }]} pointerEvents="none">
              {/^x\d+ CHAIN$/.test(G.banner) && <Text style={styles.comboLbl}>COMBO</Text>}
              <Animated.Text
                style={[
                  styles.banner,
                  {
                    fontSize: CHAIN_SIZES[Math.min(G.chain, CHAIN_SIZES.length - 1)] || 40,
                    color: CHAIN_COLORS[Math.min(G.chain, CHAIN_COLORS.length - 1)] || '#ffd23b',
                    textShadowColor: CHAIN_COLORS[Math.min(G.chain + 1, CHAIN_COLORS.length - 1)] || '#ff3b6b',
                    transform: [{ scale: bannerScale }],
                  },
                ]}
              >
                {/^x\d+ CHAIN$/.test(G.banner) ? G.banner.split(' ')[0] : G.banner}
              </Animated.Text>
            </View>
          ) : null}

        </View>
      </Animated.View>
      </View>

      {/* ONE WINDOW: overlay fills it, HUD and controls are drawn on top */}
      {G.status !== 'playing' && G.status !== 'resolving' && (
        <View style={styles.overlay}>
          {G.status === 'paused' ? (
            <>
              <Text style={styles.title}>PAUSED</Text>
              <Pressable style={styles.play} onPress={resume}>
                <Text style={styles.playTxt}>RESUME</Text>
              </Pressable>
              <Pressable
                style={{ marginTop: 18 }}
                onPress={() => {
                  logEvent('quit');
                  start(G.level);
                }}
              >
                <Text style={styles.hint}>RESTART LEVEL</Text>
              </Pressable>
              <Pressable style={{ marginTop: 18 }} onPress={() => goStatus('settings', 'paused')}>
                <Text style={styles.hint}>SETTINGS</Text>
              </Pressable>
              <Pressable
                style={{ marginTop: 18 }}
                onPress={() => {
                  logEvent('quit');
                  G.status = 'menu';
                  render();
                }}
              >
                <Text style={styles.hint}>QUIT TO LEVELS</Text>
              </Pressable>
            </>
          ) : G.status === 'menu' ? (
            <View style={{ flex: 1, width: '100%' }}>
<ScrollView ref={menuScroll} onLayout={(e) => { menuViewH.current = e.nativeEvent.layout.height; }} style={{ flex: 1, width: '100%' }} contentContainerStyle={{ alignItems: 'center', justifyContent: 'center', flexGrow: 1, paddingVertical: 12 }}>
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
              <Animated.View style={{ transform: [{ scale: float.interpolate({ inputRange: [0, 1], outputRange: [1, 1.07] }) }, { rotate: float.interpolate({ inputRange: [0, 1], outputRange: ['-1.5deg', '1.5deg'] }) }] }}>
                <Text style={[styles.title, { fontSize: 40, textShadowColor: T.accent }]}>CHAINORB</Text>
              </Animated.View>
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
              <Text style={styles.hint}>{orblingLine(G.stars)}  •  {VERSION}{G.streak.n ? `  •  🔥${G.streak.n}` : ''}</Text>
              <WorldMap
                unlocked={G.unlocked}
                stars={G.stars}
                float={float}
                crew={crew}
                buddy={buddy}
                onPlay={start}
                onReady={(mapTop) => {
                  // centre the current level node in the viewport (positions are exact: nodeY is fixed-pixel)
                  const y = mapTop + nodeY(Math.min(G.unlocked, MAX_LEVEL)) + NODE / 2 - (menuViewH.current || height * 0.6) / 2;
                  if (menuScroll.current) menuScroll.current.scrollTo({ y: Math.max(0, y), animated: false });
                }}
              />
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
            </ScrollView>
            <View style={styles.menuFooter}>
              {(() => {
                const ev = activeEvent();
                if (!ev) return null;
                return (
                  <Pressable onPress={startEvent} style={[styles.modeBtn, styles.modeBtnS, { borderColor: '#ff5ea8', marginTop: 8, width: 290 }]}>
                    <Text style={styles.modeTxt}>🎉 {ev.title}</Text>
                    <Text style={{ color: '#ffd1e6', fontSize: 10, textAlign: 'center' }}>
                      {ev.blurb ? `${ev.blurb} • ` : ''}ends in {evLeft(ev)}{G.seen[`ev:${ev.id}`] ? ' • cleared ✓' : ' • first clear: 🥚🥚 +3◆'}
                    </Text>
                  </Pressable>
                );
              })()}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', marginTop: 8 }}>
                <Pressable
                  onPress={() => (G.daily && G.daily.d === dateKey() ? shareDaily() : start(DAILY_L))}
                  style={[styles.modeBtn, styles.modeBtnS, { borderColor: '#ffd23b' }]}
                >
                  <Text style={styles.modeTxt}>
                    {G.daily && G.daily.d === dateKey() ? 'DAILY ✓ SHARE' : '🔥 DAILY'}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    if (G.chestDay === dateKey()) return;
                    G.chestDay = dateKey();
                    G.shards += CHEST_SHARDS;
                    G.dex.eggs += 1;
                    saveNx();
                    G.chestFlash = Date.now();
                    setTimeout(() => render(), 1700);
                    saveMeta();
                    AsyncStorage.setItem('chestDay', G.chestDay).catch(() => {});
                    jingle([4, 6, 9], 70);
                    render();
                  }}
                  style={[styles.modeBtn, styles.modeBtnS, { borderColor: '#ff8a3b', opacity: G.chestDay === dateKey() ? 0.5 : 1 }]}
                >
                  <Text style={styles.modeTxt}>{Date.now() - (G.chestFlash || 0) < 1600 ? `🎁 +${CHEST_SHARDS} ◆` : G.chestDay === dateKey() ? '🎁 OPENED ✓' : '🎁 DAILY CHEST'}</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    touchStreak();
                    G.status = 'shop';
                    render();
                  }}
                  style={[styles.modeBtn, styles.modeBtnS, { borderColor: '#ff3bd4' }]}
                >
                  <Text style={styles.modeTxt}>🎯 MISSIONS</Text>
                </Pressable>
                <Pressable onPress={() => goStatus('race')} style={[styles.modeBtn, styles.modeBtnS, { borderColor: '#d58bff' }]}>
                  <Text style={styles.modeTxt}>👻 GHOST RACE</Text>
                </Pressable>
                <Pressable onPress={() => goStatus('dex')} style={[styles.modeBtn, styles.modeBtnS, { borderColor: '#7dffb0' }]}>
                  <Text style={styles.modeTxt}>{`🥚 ORBDEX${G.dex.eggs ? ` (${G.dex.eggs})` : ''}`}</Text>
                </Pressable>
                <Pressable onPress={() => { G.seasonMsg = ''; goStatus('season'); }} style={[styles.modeBtn, styles.modeBtnS, { borderColor: '#ffd23b' }]}>
                  <Text style={styles.modeTxt}>{`🌟 SEASON ${seasonTier(G.prof)}/${SEASON.tiers}${seasonTier(G.prof) > seasonState(G.prof).claimed ? ' 🎁' : ''}`}</Text>
                </Pressable>
                <Pressable onPress={() => goStatus('profile')} style={[styles.modeBtn, styles.modeBtnS, { borderColor: '#9fd0ff' }]}>
                  <Text style={styles.modeTxt}>{`🏆 RANK ${rankLv(G.prof.xp)}`}</Text>
                </Pressable>
                <Pressable onPress={() => goStatus('settings', 'menu')} style={[styles.modeBtn, styles.modeBtnS, { borderColor: '#8888aa' }]}>
                  <Text style={styles.modeTxt}>⚙ SETTINGS</Text>
                </Pressable>
                {G.stars[20] ? (
                  <Pressable onPress={() => start(ENDLESS_L)} style={[styles.modeBtn, styles.modeBtnS, { borderColor: '#3be0c8' }]}>
                    <Text style={styles.modeTxt}>∞ ENDLESS</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
            </View>
          ) : G.status === 'season' ? (
            <SeasonScreen G={G} onClaim={claimSeason} onBack={() => goStatus('menu')} />
          ) : G.status === 'race' ? (
            <RaceScreen
              G={G}
              onTop={raceTop}
              onLast={() => G.pb && startRace(G.pb)}
              onShare={raceShare}
              onCode={(t) => {
                const g = parseGhostCode(t);
                if (!g) { G.raceMsg = 'No ghost code found in that text.'; render(); return; }
                startRace(g);
              }}
              onBack={() => { G.raceMsg = ''; goStatus('menu'); }}
            />
          ) : G.status === 'dex' ? (
            <OrbdexScreen
              G={G}
              onHatch={hatchEgg}
              onPick={(id) => { G.dex.companion = id; saveNx(); render(); }}
              onBack={() => goStatus('menu')}
            />
          ) : G.status === 'profile' ? (
            <ProfileScreen G={G} onBack={() => goStatus('menu')} />
          ) : G.status === 'settings' ? (
            <SettingsScreen
              onToggleHaptics={() => { HAPTICS = !HAPTICS; saveNx(); render(); }}
              onToggleLite={() => { LITE = !LITE; saveNx(); render(); }}
              onToggleDock={() => { DOCK = !DOCK; saveNx(); render(); }}
              onReplayStory={() => { G.seen = {}; saveNx(); render(); }}
              onBack={() => goStatus(G.back || 'menu')}
            />
          ) : G.status === 'story' && G.story ? (
            <StoryScreen story={G.story} onNext={storyNext} onSkip={storyDone} />
          ) : G.status === 'shop' ? (
            <>
              <Text style={styles.title}>MISSIONS</Text>
              <Text style={styles.hint}>
                🔥 {G.streak.n} day streak  •  ◆ {G.shards} shards
              </Text>
              {(G.missions ? G.missions.items : []).map((it) => (
                <Text
                  key={it.k}
                  style={[styles.hint, { color: it.done ? '#2bff88' : '#ddd', fontSize: 14, marginTop: 6 }]}
                >
                  {it.done ? '✓ ' : '○ '}
                  {it.text}  ({Math.min(it.have, it.need)}/{it.need})
                </Text>
              ))}
              <Text style={[styles.hint, { marginTop: 14 }]}>ORB SKINS (earned with shards)</Text>
              <View style={{ flexDirection: 'row', marginTop: 6 }}>
                {SKINS.map((sk) => (
                  <Pressable
                    key={sk.id}
                    onPress={() => pickSkin(sk.id)}
                    style={[
                      styles.modeBtn,
                      { marginHorizontal: 3, paddingHorizontal: 8, borderColor: G.skin === sk.id ? '#2bff88' : '#2a2a4a' },
                    ]}
                  >
                    <Text style={styles.modeTxt}>{sk.name}</Text>
                    <Text style={{ color: '#aaa', fontSize: 10, textAlign: 'center' }}>
                      {G.owned.includes(sk.id) ? (G.skin === sk.id ? 'USING' : 'OWNED') : `◆ ${sk.cost}`}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <Pressable
                style={{ marginTop: 18 }}
                onPress={() => {
                  G.status = 'menu';
                  render();
                }}
              >
                <Text style={styles.hint}>BACK</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={styles.title}>
                {G.status === 'won'
                  ? `${G.level === EVENT_L ? 'EVENT' : 'LEVEL ' + G.level} CLEAR`
                  : G.moves && G.placed >= G.moves
                  ? 'OUT OF MOVES'
                  : G.race && G.raceRes
                  ? (G.raceRes.won ? 'GHOST BEATEN!' : 'GHOST WINS')
                  : G.t === 'daily'
                  ? 'DAILY CHAIN'
                  : 'GAME OVER'}
              </Text>
              {G.status === 'won' && <Confetti w={width} h={height} />}
              {G.status === 'won' && (
                <View style={{ flexDirection: 'row', marginTop: 8 }}>
                  {[1, 2, 3].map((i) => (
                    <StarReveal key={i} filled={i <= G.earned} delay={i * 240} size={38} />
                  ))}
                </View>
              )}
              {G.status === 'over' && soClose() && (
                <Text style={[styles.hatch, { color: T.accent }]}>
                  {soClose().head}{'\n'}{soClose().left}
                </Text>
              )}
              {G.status === 'won' && G.boss && (
                <Text style={[styles.hatch, { color: '#ffd23b' }]}>BOSS DEFEATED!</Text>
              )}
              {G.status === 'won' && G.nxGain && (
                <Text style={[styles.hatch, { color: '#9fd0ff' }]}>
                  +{G.nxGain.xp} XP{G.nxGain.eggs ? `  •  🥚 +${G.nxGain.eggs} EGG` : ''}
                  {G.rankUp ? `\nRANK UP: ${rankName(G.rankUp)}` : ''}
                </Text>
              )}
              {G.status === 'won' && G.hatched && (
                <Text style={styles.hatch}>
                  {G.hatched.icon} NEW ORBLING{'\n'}
                  {G.hatched.name}{'\n'}
                  {G.hatched.power}
                </Text>
              )}
              <Text style={styles.overScore}>
                {G.status === 'won' && <CountUp to={G.score} style={styles.overScore} />}
                {G.status === 'won' || G.t === 'endless' || G.t === 'daily'
                  ? `${G.status === 'won' ? '' : G.score} pts${G.status === 'won' && G.t !== 'daily' ? (G.newBest ? ' • NEW BEST!' : ` • best ${G.lvlBest[G.level] || 0}`) : ''}`
                  : `${Math.min(99, Math.round(progress() * 100))}% there`}
                {'  •  '}best chain x{G.maxChain}
              </Text>
              {G.race && G.raceRes && (
                <Text style={[styles.hatch, { color: G.raceRes.won ? '#2bff88' : '#ff8a8a' }]}>
                  👻 {G.race.name} {G.raceRes.ghost}  vs  YOU {G.raceRes.you}{G.raceRes.egg ? '\n🥚 +1 EGG' : ''}
                </Text>
              )}
              <Pressable
                style={styles.play}
                onPress={nextAction}
              >
                <Text style={styles.playTxt}>
                  {G.race ? 'REMATCH' : G.t === 'daily' ? 'SHARE' : G.status === 'won' && G.level < MAX_LEVEL ? 'NEXT LEVEL' : 'RETRY'}
                </Text>
              </Pressable>
              {G.t === 'daily' && !G.race && ONLINE && (
                <View style={{ marginTop: 6, alignItems: 'center' }}>
                  <Text style={styles.small}>TODAY'S TOP</Text>
                  {G.lb === null ? (
                    <Text style={styles.hint}>loading…</Text>
                  ) : G.lb.length === 0 ? (
                    <Text style={styles.hint}>no scores yet (or offline)</Text>
                  ) : (
                    G.lb.slice(0, 5).map((r, i) => (
                      <Text key={r.pos} style={[styles.small, r.is_me && { color: T.accent }]}>
                        {r.pos}. {r.name} {r.country}  {r.score}  x{r.chain}
                      </Text>
                    ))
                  )}
                </View>
              )}
              {G.t === 'daily' && !G.race && ONLINE && G.lb && G.lb.length > 0 && (
                <Pressable style={styles.adBtn} onPress={watchTop}>
                  <Text style={styles.adBtnTxt}>▶ WATCH THE #1 RUN</Text>
                </Pressable>
              )}
              {G.card && G.card.chain >= 4 && (
                <Pressable style={styles.adBtn} onPress={shareChain}>
                  <Text style={styles.adBtnTxt}>📤 SHARE YOUR x{G.card.chain} CHAIN</Text>
                </Pressable>
              )}
              {G.status === 'over' && !G.continued && G.t !== 'daily' && (
                <Pressable style={styles.adBtn} onPress={continueAfterAd}>
                  <Text style={styles.adBtnTxt}>▶ WATCH AD: KEEP GOING</Text>
                </Pressable>
              )}
              {G.status === 'over' && (G.fails[G.level] || 0) >= 3 && G.t !== 'daily' && G.level < MAX_LEVEL && (
                <Pressable style={styles.adBtn} onPress={skipLevel}>
                  <Text style={styles.adBtnTxt}>▶ WATCH AD: SKIP THIS LEVEL</Text>
                </Pressable>
              )}
              {G.status === 'won' && G.earned < 3 && !G.starAd && (
                <Pressable style={styles.adBtn} onPress={adStar}>
                  <Text style={styles.adBtnTxt}>▶ WATCH AD: +1 ★</Text>
                </Pressable>
              )}
              {G.race && (
                <Pressable style={{ marginBottom: 10 }} onPress={() => goStatus('race')}>
                  <Text style={styles.hint}>GHOST MENU</Text>
                </Pressable>
              )}
              <Pressable onPress={() => { G.status = 'menu'; render(); }}>
                <Text style={styles.hint}>LEVELS</Text>
              </Pressable>
            </>
          )}
        </View>
      )}

      {!MENUISH.includes(G.status) && (() => {
        const at = (cx, cy, w, h) => ({ position: 'absolute', left: (cx - w / 2) * hs, top: (cy - h / 2) * hs, width: w * hs, height: h * hs, alignItems: 'center', justifyContent: 'center' });
        const feverLbl = G.moves ? `${Math.max(0, G.moves - G.placed)} MOVES` : G.feverPcs > 0 ? 'FEVER!' : 'FEVER';
        return (
          <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, top: STATUS_H - 2, height: hudH, zIndex: 20 }}>
            <HudArt w={width} h={hudH} goal={progress()} fever={G.fever / 100} feverOn={G.feverPcs > 0} muted={MUTED} />
            <View pointerEvents="none" style={at(70, 64, 70, 28)}><Text style={[styles.hudTxt, { color: '#ffd36b', fontSize: 23 * hs }]}>LV</Text></View>
            <View pointerEvents="none" style={at(70, 102, 80, 60)}><Text adjustsFontSizeToFit numberOfLines={1} style={[styles.hudTxt, { fontSize: 56 * hs }]}>{lvlName(G.level)}</Text></View>
            <View pointerEvents="none" style={at(236, 68, 130, 36)}><Text adjustsFontSizeToFit numberOfLines={1} style={[styles.hudTxt, { color: '#fff3d0', fontSize: 27 * hs }]}>{goalText()}</Text></View>
            <View pointerEvents="none" style={at(236, 128, 130, 36)}><Text adjustsFontSizeToFit numberOfLines={1} style={[styles.hudTxt, { color: '#ffffff', fontSize: 27 * hs, textShadowColor: 'rgba(160,70,0,0.95)', textShadowRadius: 4 }]}>{feverLbl}</Text></View>
            <View pointerEvents="none" style={at(684, 66, 138, 40)}>
              <Text adjustsFontSizeToFit numberOfLines={1} style={styles.hudTxt}>
                <Text style={{ color: '#ffe2a8', fontSize: 19 * hs }}>SCORE </Text>
                <Text style={{ fontSize: 31 * hs }}>{G.score}</Text>
              </Text>
            </View>
            <View pointerEvents="none" style={at(488, 129, 46, 36)}><Text adjustsFontSizeToFit numberOfLines={1} style={[styles.hudTxt, { fontSize: 29 * hs }]}>{G.shards}</Text></View>
            <View pointerEvents="none" style={at(586, 129, 46, 36)}><Text adjustsFontSizeToFit numberOfLines={1} style={[styles.hudTxt, { fontSize: 29 * hs }]}>{totalStars(G.stars)}</Text></View>
            <Pressable hitSlop={8} onPress={pause} style={at(651, 129, 64, 64)} />
            <Pressable
              hitSlop={8}
              style={at(722, 129, 64, 64)}
              onPress={() => {
                MUTED = !MUTED;
                AsyncStorage.setItem('muted', MUTED ? '1' : '0').catch(() => {});
                render();
              }}
            />
          </View>
        );
      })()}

      {showCtl && (
      <>
      {(() => {
        const actSz = Math.round(120 * hs);
        const on = G.status === 'playing';
        // taps made while the board resolves are remembered (moves/turns only) and replayed on the next piece
        const tap = (fn, buffer) => (first) => {
          if (G.status === 'resolving') {
            if (first && buffer) G.buf = { fn, t: Date.now() };
            return;
          }
          fn();
        };
        const actZones = {
          undo: { fire: tap(() => rotate(-1), true), press: pUndo },
        };
        return (
          <>
            <FloatPad id="R" anchor="right" locked={DOCK} bounds={{ minX: -(width - actSz - 24), maxX: 0, minY: -(height - actSz - 120), maxY: 0 }}>
              <TouchZone size={actSz} units={120} hit={actHit} zones={actZones} style={{ width: actSz, height: actSz, opacity: on ? 0.9 : 0.5 }}>
                <ActArt size={actSz} pUndo={pUndo} />
              </TouchZone>
            </FloatPad>
          </>
        );
      })()}
      </>
      )}
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
const ABS_FILL = { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 };
const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0a0a14',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: BOARD_BOTTOM,
    paddingTop: (StatusBar.currentHeight || 24) + 6,
  },
  hud: {
    width: '96%',
    height: 42,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  label: { color: 'rgba(255,255,255,0.95)', fontSize: 13, fontFamily: FONT, letterSpacing: 0.5, textShadowColor: 'rgba(20,10,60,0.85)', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 1 },
  score: { color: '#fff', fontSize: 32, fontFamily: FONT, textShadowColor: 'rgba(20,10,60,0.9)', textShadowOffset: { width: 0, height: 3 }, textShadowRadius: 1 },
  small: { color: 'rgba(255,255,255,0.95)', fontSize: 13, fontFamily: FONT, textShadowColor: 'rgba(20,10,60,0.85)', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 1 },
  board: {
    backgroundColor: 'rgba(15,10,50,0.5)',
    borderColor: '#ffffff',
    borderWidth: 3,
    borderRadius: 16,
    padding: 2,
  },
  overlay: {
    ...ABS_FILL,
    paddingTop: (StatusBar.currentHeight || 24) + 6,
    paddingBottom: BOARD_BOTTOM,
    backgroundColor: 'rgba(30,15,80,0.84)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { color: '#fff', textShadowColor: '#2bff88', textShadowRadius: 16, fontSize: 30, fontFamily: FONT, letterSpacing: 3 },
  overScore: { color: '#aaa', marginTop: 8, fontSize: 15, fontFamily: FONT },
  play: {
    marginTop: 22,
    backgroundColor: '#2bff88',
    paddingHorizontal: 44,
    paddingVertical: 14,
    borderRadius: 40,
  },
  playTxt: { color: '#04140b', fontSize: 21, fontFamily: FONT, letterSpacing: 2 },
  hint: { color: 'rgba(255,255,255,0.85)', marginTop: 16, fontSize: 12 },
  bannerWrap: {
    ...ABS_FILL,
    alignItems: 'center',
    justifyContent: 'center',
  },
  banner: {
    color: '#ffd23b',
    fontSize: 40,
    fontFamily: FONT,
    textShadowColor: '#ff3b6b',
    textShadowRadius: 14,
  },
  chip: { width: 38, height: 38, borderRadius: 19, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', marginBottom: 8, backgroundColor: 'rgba(0,0,0,0.35)' },
  hatch: { color: '#fff', fontSize: 15, fontWeight: '800', textAlign: 'center', marginTop: 8, letterSpacing: 1 },
  modeBtn: { paddingHorizontal: 16, paddingVertical: 11, borderRadius: 16, borderWidth: 2.5, marginHorizontal: 5, marginVertical: 3, backgroundColor: 'rgba(255,255,255,0.16)' },
  modeTxt: { color: '#fff', fontFamily: FONT, fontSize: 13, letterSpacing: 1 },
  modeBtnS: { paddingVertical: 8, paddingHorizontal: 12, marginHorizontal: 4, marginVertical: 2 },
  menuFooter: { width: '100%', paddingTop: 4, paddingBottom: 10, alignItems: 'center', backgroundColor: 'rgba(10,6,34,0.94)', borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.16)' },
  adBtn: { marginTop: 10, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 14, borderWidth: 1.5, borderColor: '#ffd23b', backgroundColor: '#1a1a30' },
  adBtnTxt: { color: '#ffd23b', fontWeight: '800', fontSize: 13, letterSpacing: 1 },
  adCover: { ...ABS_FILL, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center' },
  adTxt: { color: '#aaa', fontSize: 14, letterSpacing: 3 },
  adBig: { color: '#fff', fontSize: 64, fontFamily: FONT },
  coach: { fontSize: 13, fontFamily: FONT, letterSpacing: 0.5, height: 18, marginBottom: 2 },
  bar: { width: '90%', height: 6, backgroundColor: 'rgba(0,0,0,0.30)', borderRadius: 3, marginBottom: 8, overflow: 'hidden' },
  barFill: { height: 6, backgroundColor: '#2bff88' },
  badge: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#3a1d5c', borderWidth: 2.5, borderColor: '#ffe39a', alignItems: 'center', justifyContent: 'center' },
  badgeLbl: { color: '#ffd23b', fontFamily: FONT, fontSize: 9, lineHeight: 10 },
  badgeNum: { color: '#fff', fontFamily: FONT, fontSize: 21, lineHeight: 23, textShadowColor: 'rgba(20,10,60,0.9)', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 1 },
  stat: { height: 18, borderRadius: 9, backgroundColor: 'rgba(25,60,140,0.82)', borderWidth: 2, borderColor: 'rgba(210,230,255,0.9)', overflow: 'hidden', justifyContent: 'center' },
  statFill: { position: 'absolute', left: 0, top: 0, bottom: 0 },
  statTxt: { color: '#fff', fontFamily: FONT, fontSize: 10, textAlign: 'center', paddingHorizontal: 4, textShadowColor: 'rgba(20,10,60,0.9)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 1 },
  pill: { flexDirection: 'row', alignItems: 'center', height: 26, paddingHorizontal: 8, borderRadius: 14, backgroundColor: 'rgba(75,32,20,0.88)', borderWidth: 2, borderColor: '#e0b25c' },
  pillLbl: { color: 'rgba(255,255,255,0.75)', fontFamily: FONT, fontSize: 9, marginRight: 4 },
  pillIco: { fontSize: 14, marginRight: 4 },
  pillNum: { color: '#fff', fontFamily: FONT, fontSize: 15, textShadowColor: 'rgba(20,10,60,0.9)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 1 },
  comboLbl: { color: '#ffd23b', fontFamily: FONT, fontSize: 14, letterSpacing: 2, textShadowColor: 'rgba(20,10,60,0.9)', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 1 },
  hudBar: { position: 'absolute', left: 0, right: 0, height: HUD_H, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8, zIndex: 20 },
  hudL: { flexDirection: 'row', alignItems: 'center' },
  hudR: { alignItems: 'flex-end' },
  dpad: { width: 128, height: 128, borderRadius: 64, backgroundColor: 'rgba(205,225,255,0.14)', borderWidth: 2.5, borderColor: 'rgba(225,238,255,0.6)' },
  dArm: { position: 'absolute', flex: 0, width: 42, height: 42, borderRadius: 21, backgroundColor: 'rgba(78,58,195,0.94)', borderWidth: 2.5, borderColor: '#cdbbff', borderBottomWidth: 2.5, borderBottomColor: '#cdbbff' },
  acts: { width: 156, height: 130 },
  act: { position: 'absolute', flex: 0, backgroundColor: 'rgba(70,45,160,0.94)', borderWidth: 3, borderColor: '#e8b04a', borderBottomWidth: 3, borderBottomColor: '#e8b04a' },
  actDrop: { backgroundColor: '#ff3b8f', borderColor: '#f6cf74', borderBottomColor: '#f6cf74', shadowColor: '#ff3bd4', shadowOpacity: 1, shadowRadius: 14, elevation: 14 },
  actTxt: { fontFamily: FONT, fontWeight: 'normal', fontSize: 14, lineHeight: 17, textAlign: 'center', textShadowColor: 'rgba(20,10,60,0.9)', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 1 },
  railBtn: { width: 36, height: 36, marginBottom: 6, borderRadius: 18, backgroundColor: 'rgba(25,12,70,0.55)', borderWidth: 2, borderColor: 'rgba(255,255,255,0.45)', borderBottomWidth: 4, borderBottomColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center' },
  nextRail: { width: 46, alignItems: 'center', paddingVertical: 6, marginBottom: 8, borderRadius: 22, backgroundColor: 'rgba(175,205,255,0.16)', borderWidth: 2, borderColor: 'rgba(225,238,255,0.55)' },
  nextLbl: { color: 'rgba(255,255,255,0.8)', fontFamily: FONT, fontSize: 8, marginBottom: 2 },
  coachFloat: { position: 'absolute', left: 0, right: 0, textAlign: 'center', color: '#ffe7a8', fontFamily: FONT, fontSize: 22, lineHeight: 27, textShadowColor: '#7a4311', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 5 },
  nextBox: { flexDirection: 'row', alignItems: 'flex-start', padding: 6, borderRadius: 16, backgroundColor: 'rgba(0,0,0,0.32)', borderWidth: 2, borderColor: 'rgba(255,255,255,0.22)' },
  goalRow: { width: '90%', flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  goalTrack: { flex: 1, height: 16, borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.42)', borderWidth: 2, borderColor: 'rgba(255,255,255,0.35)', overflow: 'hidden' },
  goalFill: { height: '100%', borderRadius: 6 },
  goalGloss: { height: 4, marginTop: 1, marginHorizontal: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.38)' },
  goalStar: { marginLeft: 6, fontSize: 24, color: 'rgba(255,255,255,0.45)', textShadowColor: 'rgba(20,10,60,0.9)', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 1 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', width: '100%', marginTop: 10 },
  lvl: { width: 44, height: 50, margin: 3, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.18)', borderWidth: 2, borderColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  lvlLocked: { borderColor: 'rgba(255,255,255,0.25)', opacity: 0.7 },
  stars: { color: '#ffe14a', fontSize: 9, marginTop: 2 },
  bigStars: { color: '#ffd23b', fontSize: 34, marginTop: 8, letterSpacing: 4 },
  lvlTxt: { color: '#fff', fontSize: 19, fontFamily: FONT, textShadowColor: 'rgba(0,0,0,0.4)', textShadowRadius: 3 },
  controls: { width: '94%', marginTop: 10 },
  row: { flexDirection: 'row', marginVertical: 4 },
  btn: {
    flex: 1,
    height: 64,
    marginHorizontal: 5,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    borderTopColor: 'rgba(255,255,255,0.32)',
    borderBottomWidth: 5,
    borderBottomColor: 'rgba(0,0,0,0.38)',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
  btnDown: { backgroundColor: 'rgba(255,255,255,0.38)', borderBottomWidth: 2, transform: [{ translateY: 3 }] },
  btnDim: { opacity: 0.45 },
  btnTxt: { color: '#fff', fontSize: 24, fontWeight: '700', textShadowColor: 'rgba(0,0,0,0.35)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 1 },
  dropBtn: { backgroundColor: 'rgba(255,59,107,0.20)', borderColor: '#ff3b6b', borderTopColor: '#ff7a9a' },
  dropTxt: { fontSize: 17, fontFamily: FONT, letterSpacing: 1 },
  padL: { position: 'absolute', left: 8, bottom: BOTTOM_PAD, alignItems: 'flex-start' },
  padR: { position: 'absolute', right: 8, bottom: BOTTOM_PAD, alignItems: 'flex-end' },
  grip: { alignSelf: 'center', paddingHorizontal: 26, paddingVertical: 7, borderRadius: 14, backgroundColor: 'rgba(10,8,34,0.5)', marginBottom: 2 },
  gripOn: { backgroundColor: 'rgba(255,210,59,0.95)' },
  padEdit: { borderRadius: 18, borderWidth: 2, borderStyle: 'dashed', borderColor: 'rgba(255,255,255,0.8)', backgroundColor: 'rgba(255,255,255,0.10)' },
  gripTxt: { color: 'rgba(255,255,255,0.85)', fontSize: 12, letterSpacing: 2, fontWeight: '900' },
  ico: { width: 38, height: 38, marginLeft: 6, borderRadius: 19, backgroundColor: 'rgba(95,55,25,0.92)', borderWidth: 2.5, borderColor: '#e8b04a', alignItems: 'center', justifyContent: 'center' },
  icoTxt: { color: '#fff', fontSize: 17 },
  fbtn: { flex: 0, width: 48, height: 48, marginHorizontal: 3, borderRadius: 24, backgroundColor: 'rgba(25,12,70,0.55)', borderWidth: 2, borderColor: 'rgba(255,255,255,0.7)' },
  fdrop: { flex: 0, width: 66, height: 48, marginHorizontal: 3, borderRadius: 24, backgroundColor: '#ff3b6b', borderWidth: 2, borderColor: '#ffd0dc', borderBottomColor: '#a3123a' },
  // v19
  hudTxt: { fontFamily: FONT, color: '#ffffff', textAlign: 'center', textShadowColor: 'rgba(20,10,60,0.9)', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 1 },
  nextLbl2: { position: 'absolute', left: 0, right: 0, textAlign: 'center', color: '#f2fbff', fontFamily: FONT, letterSpacing: 1, textShadowColor: 'rgba(20,60,140,0.9)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3 },
  coachFloat2: { textAlign: 'center', color: '#fff0c8', fontFamily: FONT, textShadowColor: '#6b3a12', textShadowOffset: { width: 0, height: 3 }, textShadowRadius: 6 },
  actLbl2: { color: '#ffffff', fontFamily: FONT, letterSpacing: 0.5, textShadowColor: 'rgba(60,10,20,0.95)', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 2 },
  gripDots: { width: 17, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', height: 17, alignContent: 'space-between' },
  gripDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.8)' },
});


/* ============================== INTRO ============================== */
// Native splash is a plain dark screen; this draws the logo: it rolls in from the left,
// spinning clockwise, settles upright in the centre, then fades into the game.
let SplashScreen = null;
try {
  SplashScreen = require('expo-splash-screen');
  SplashScreen.preventAutoHideAsync().catch(() => {});
} catch (e) {
  SplashScreen = null; // older dev build without the native module: just skip it
}
function Intro({ onDone }) {
  const { width } = useWindowDimensions();
  const SIZE = Math.min(240, Math.round(width * 0.62));
  const t = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    try {
      if (SplashScreen) SplashScreen.hideAsync().catch(() => {});
    } catch (e) {}
    const anim = Animated.sequence([
      Animated.timing(t, { toValue: 1, duration: 1800, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.delay(450),
      Animated.timing(fade, { toValue: 0, duration: 350, useNativeDriver: true }),
    ]);
    anim.start(({ finished }) => {
      if (finished) onDone();
    });
    return () => anim.stop();
  }, []);
  const x = t.interpolate({ inputRange: [0, 1], outputRange: [-(width / 2 + SIZE), 0] });
  const rot = t.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '720deg'] }); // positive = clockwise
  return (
    <Animated.View
      style={{
        position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
        backgroundColor: '#05050c', alignItems: 'center', justifyContent: 'center',
        opacity: fade, zIndex: 999, elevation: 999,
      }}
    >
      <Animated.Image
        source={require('./assets/logo.png')}
        resizeMode="contain"
        style={{ width: SIZE, height: SIZE, transform: [{ translateX: x }, { rotate: rot }] }}
      />
    </Animated.View>
  );
}

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
  const [intro, setIntro] = useState(true);
  const [fontsReady, fontErr] = useFonts({ Fredoka_700Bold });
  if (!fontsReady && !fontErr) return <View style={{ flex: 1, backgroundColor: '#05050c' }} />;
  return (
    <Boundary>
      <View style={{ flex: 1, backgroundColor: '#05050c' }}>
        <Game />
        {intro ? <Intro onDone={() => setIntro(false)} /> : null}
      </View>
    </Boundary>
  );
}
