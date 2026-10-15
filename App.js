import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, Pressable, StyleSheet, Animated, ScrollView,
  useWindowDimensions, StatusBar, PanResponder, Share, Platform,
} from 'react-native';
import { Image, Easing } from 'react-native';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import { useFonts, Fredoka_700Bold } from '@expo-google-fonts/fredoka';
import { Canvas, Group, Path, Circle, Rect, RoundedRect, Points, Shadow, Skia } from '@shopify/react-native-skia';
import { useSharedValue, useDerivedValue, withTiming, withRepeat, interpolate, Easing as REasing } from 'react-native-reanimated';

const FONT = 'Fredoka_700Bold';

/* ============================== ENGINE ============================== */
const COLS = 6;
const ROWS = 12;
const MAX_LEVEL = 20;
const MIN_GROUP = 4;
const COLORS = ['', '#ff3355', '#2ee86b', '#2e9bff', '#ffd21a', '#c64dff', '#6b6b8a', '#ff8a3b', '#9a9ac0', '#ffffff'];
const GLYPHS = ['', '●', '▲', '■', '◆', '★'];
const CHAIN_COLORS = ['','#ffd23b','#ff8a3b','#ff3b6b','#cc44ff','#ffffff','#00ffff','#00ff88'];
const CHAIN_SIZES  = [0, 38, 44, 52, 60, 68, 76, 84]; // shapes keep colors readable for color-blind players
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
  { name: 'SUNRISE MEADOW', bg: '#ff6f91', sky: ['#ffb36b', '#ff6f91', '#7b4bd6'], board: 'rgba(40,10,60,0.50)', border: '#ffd36b', accent: '#ffd36b' },
  { name: 'MOONLIT LAKE', bg: '#2a7fd4', sky: ['#35d0c4', '#2a7fd4', '#3b3fb5'], board: 'rgba(5,20,70,0.50)', border: '#7ff3e0', accent: '#7ff3e0' },
  { name: 'FROST PEAKS', bg: '#5aa2f0', sky: ['#a8e0ff', '#5aa2f0', '#4a5fd0'], board: 'rgba(10,25,80,0.45)', border: '#e6f6ff', accent: '#ffffff' },
  { name: 'NEON CITY', bg: '#8a3bff', sky: ['#ff4fd8', '#8a3bff', '#2a1a7a'], board: 'rgba(15,5,50,0.55)', border: '#ff9bec', accent: '#ff9bec' },
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
const VERSION = 'v18';
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
const adDue = (L) => (L === 6 || L === 9 || (L >= 12 && L % 2 === 0)) && Date.now() - lastAdAt > 120000;

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
const INSTR = [kalimba, adungu, glassBell, conga];
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
  const order = [first, ...[0, 1, 2, 3].filter((x) => x !== first)];
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

// one orb, drawn in its own 0..size box at (x, y). same look as the old Orb view.
const OrbSk = React.memo(function OrbSk({ color, size, x, y, popping, worry, active, sk }) {
  const s = size;
  const shape = sk === 'gel' && color >= 1 && color <= 5 ? color : 0;
  const gemLike = sk === 'gem' || shape === 4;
  const pad = s * 0.06;
  const bw = color === BOMB || color === PRISM ? 3 : color === CRACK ? 2 : sk === 'ring' ? s * 0.14 : sk === 'candy' ? 3 : s * 0.06;
  const w = s - pad * 2;
  const rad =
    gemLike ? [s * 0.2, s * 0.2, s * 0.2, s * 0.2]
    : shape === 2 ? [s * 0.3, s * 0.3, s * 0.3, s * 0.3]
    : shape === 3 ? [s * 0.5, s * 0.12, s * 0.5, s * 0.12]
    : shape === 5 ? [s * 0.5, s * 0.5, s * 0.2, s * 0.2]
    : [s, s, s, s];
  const fill = popping ? '#ffffff' : sk === 'ring' ? 'rgba(10,10,20,0.6)' : color === BOMB ? '#2a1408' : COLORS[color];
  const edge =
    color === CRACK ? '#e0e0ff' : color === PRISM ? '#ff3bd4' : sk === 'ring' ? COLORS[color]
    : sk === 'candy' ? 'rgba(255,255,255,0.75)' : color === BOMB ? '#ff8a3b' : 'rgba(0,0,0,0.5)';
  const body = rrPath(pad, pad, w, w, rad);
  const ring = rrPath(pad + bw / 2, pad + bw / 2, w - bw, w - bw, rad.map((r) => Math.max(0, r - bw / 2)));
  const ox = pad + bw;
  const iw = s - 2 * pad - 2 * bw;
  const face = color >= 1 && color <= 5 && !gemLike;
  const ew = s * (worry ? 0.2 : 0.13);
  const eh = s * (popping ? 0.04 : worry ? 0.2 : 0.13);
  const rowW = 2 * (ew + s * 0.12);
  const ex = ox + (iw - rowW) / 2 + s * 0.06;
  const ey = ox + s * 0.4;
  const mw = s * 0.3;
  const mh = s * 0.16;
  const mx = ox + (iw - mw) / 2;
  const my = ox + s * 0.5;
  const gy = ox + (gemLike ? s * 0.3 : s * 0.62) + s * 0.13;
  const gs = s * 0.26;
  const gcol = sk === 'ring' ? COLORS[color] : 'rgba(20,20,42,0.78)';
  const tf = [{ scale: popping ? 1.2 : 1 }, ...(gemLike ? [{ rotate: Math.PI / 4 }, { scale: 0.78 }] : [])];
  return (
    <Group transform={[{ translateX: x }, { translateY: y }]}>
      <Group transform={tf} origin={{ x: s / 2, y: s / 2 }}>
        <Path path={body} color={fill}>
          <Shadow dx={0} dy={2} blur={active ? 7 : 2} color={active ? COLORS[color] : 'rgba(0,0,0,0.5)'} />
        </Path>
        <Path path={ring} style="stroke" strokeWidth={bw} color={edge} />
        <RoundedRect x={ox + s * 0.12} y={ox + iw - s * 0.07 - s * 0.3} width={iw - s * 0.24} height={s * 0.3} r={s * 0.15} color="rgba(0,0,0,0.14)" />
        <Group transform={[{ rotate: -Math.PI / 9 }]} origin={{ x: ox + s * 0.16 + s * 0.19, y: ox + s * 0.08 + s * 0.09 }}>
          <RoundedRect x={ox + s * 0.16} y={ox + s * 0.08} width={s * 0.38} height={s * 0.18} r={s * 0.09} color="rgba(255,255,255,0.85)" />
        </Group>
        <Group transform={[{ rotate: -Math.PI / 9 }]} origin={{ x: ox + iw - s * 0.16 - s * 0.07, y: ox + iw - s * 0.14 - s * 0.04 }}>
          <RoundedRect x={ox + iw - s * 0.16 - s * 0.14} y={ox + iw - s * 0.14 - s * 0.08} width={s * 0.14} height={s * 0.08} r={s * 0.04} color="rgba(255,255,255,0.28)" />
        </Group>
        <Path path={rrPath(ox + s * 0.065, ox + s * 0.065, iw - s * 0.13, iw - s * 0.13, [s, s, s, s])} style="stroke" strokeWidth={s * 0.07} color="rgba(0,0,0,0.12)" />
        {face && (
          <>
            <RoundedRect x={ex} y={ey} width={ew} height={eh} r={Math.min(ew, eh) / 2} color="#14142a" />
            <RoundedRect x={ex + ew + s * 0.12} y={ey} width={ew} height={eh} r={Math.min(ew, eh) / 2} color="#14142a" />
          </>
        )}
        {face && popping && (
          <>
            <Path path={svgPath(`M${mx} ${my}L${mx + mw} ${my}A${mw / 2} ${mh} 0 0 1 ${mx} ${my}Z`)} color="rgba(255,120,140,0.9)" />
            <Path path={svgPath(`M${mx} ${my}A${mw / 2} ${mh} 0 0 0 ${mx + mw} ${my}`)} style="stroke" strokeWidth={s * 0.04} color="#14142a" />
          </>
        )}
        {color >= 1 && color <= 5 && (
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

function BoardCanvas({ board, cell, skin, popping, fall, fallId, rings, ghost, glow, piece, danger, playing, accent, sv }) {
  const W = cell * COLS + 2;
  const H = cell * ROWS + 2;
  const { float, burst, flash, fallY, fall: fallClock } = sv;
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
  const pieceT = useDerivedValue(() => {
    'worklet';
    return [{ translateY: fallY.value }];
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
            return (
              <Group key={k} transform={wob} origin={{ x: x + cell / 2, y: y + cell / 2 }}>
                {orb}
              </Group>
            );
          })
        )}
      </Group>

      {Array.from({ length: ROWS - 1 }, (_, i) => (
        <Rect key={`hr${i}`} x={2} y={2 + (i + 1) * cell} width={W - 4} height={1} color="rgba(255,255,255,0.08)" />
      ))}
      {Array.from({ length: COLS - 1 }, (_, i) => (
        <Rect key={`vc${i}`} x={2 + (i + 1) * cell} y={2} width={1} height={H - 4} color="rgba(255,255,255,0.08)" />
      ))}
      <Rect x={1.5} y={2} width={1.5} height={H - 4} color="rgba(255,255,255,0.16)" />
      <Rect x={W - 3} y={2} width={1.5} height={H - 4} color="rgba(255,255,255,0.16)" />
      <Rect x={2} y={H - 3} width={W - 4} height={1.5} color="rgba(255,255,255,0.16)" />

      <Group opacity={glowOp}>
        {[...glow].map((k) => {
          const gr = Math.floor(k / COLS);
          const gc = k % COLS;
          if (popping.has(k) || !board[gr][gc]) return null;
          return <Circle key={`gl${k}`} cx={2 + gc * cell + cell / 2} cy={2 + gr * cell + cell / 2} r={cell * 0.42} color={COLORS[board[gr][gc]]} />;
        })}
      </Group>

      {ghost.map(([r, c, col]) => (
        <Circle key={`g${r}-${c}`} cx={2 + c * cell + cell / 2} cy={2 + r * cell + cell / 2} r={cell * 0.38 - 1} style="stroke" strokeWidth={2} color={COLORS[col]} opacity={0.4} />
      ))}

      <RoundedRect x={0} y={0} width={W} height={H} r={10} color={accent} opacity={flash} />

      {piece && (
        <Group transform={pieceT}>
          {cellsOf(piece).map(([r, c, col], i) =>
            r >= 0 && r < ROWS && c >= 0 && c < COLS ? (
              <OrbSk key={i} color={col} size={cell} x={2 + c * cell} y={2 + r * cell} worry={danger} active sk={col >= 1 && col <= 5 ? skin : 'gel'} />
            ) : null
          )}
        </Group>
      )}

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

function Scene({ realm, width, height }) {
  const W = width;
  const tri = (left, base, h, color, bottom = 0) => ({
    position: 'absolute', left, bottom, width: 0, height: 0,
    borderLeftWidth: base, borderRightWidth: base, borderBottomWidth: h,
    borderLeftColor: 'transparent', borderRightColor: 'transparent', borderBottomColor: color,
  });
  if (realm === 0) {
    return (
      <>
        <View style={{ position: 'absolute', right: 26, top: 64, width: 84, height: 84, borderRadius: 84, backgroundColor: '#fff3b0', opacity: 0.92 }} />
        <View style={{ position: 'absolute', left: -W * 0.15, bottom: -150, width: W * 1.1, height: 260, borderRadius: 260, backgroundColor: '#8fe05a' }} />
        <View style={{ position: 'absolute', left: W * 0.35, bottom: -170, width: W * 1.1, height: 260, borderRadius: 260, backgroundColor: '#4fbf5a' }} />
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

const MAP_W = 300, NODE = 58, NODE_H = 78, HEAD_H = 40;
const nodeX = (L) => MAP_W / 2 + Math.sin((L - 1) * 0.95) * 86;
const nodeY = (L) => 46 + (L - 1) * NODE_H + realmOf(L) * HEAD_H;
function WorldMap({ unlocked, stars, float, onPlay, onReady }) {
  const H = nodeY(MAX_LEVEL) + NODE_H;
  const done = useRef(false); // fresh per mount, so it scrolls once each time the menu opens
  const items = [];
  for (let L = 1; L <= MAX_LEVEL; L++) {
    const x = nodeX(L), y = nodeY(L);
    if (L === 1 || realmOf(L) !== realmOf(L - 1)) {
      items.push(
        <Text key={`h${L}`} style={{ position: 'absolute', left: 0, right: 0, top: y - 44, textAlign: 'center', color: REALMS[realmOf(L)].accent, fontFamily: FONT, fontSize: 14, letterSpacing: 3, textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 4 }}>
          {REALMS[realmOf(L)].name}
        </Text>
      );
    }
    if (L > 1) {
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
    if (cur) {
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
      {items}
    </View>
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
const BOTTOM_PAD = SAFE_BOTTOM != null ? SAFE_BOTTOM + 14 : Platform.OS === 'android' ? 52 : 24;
const CONTROLS_H = 86; // strip under the board that holds the buttons (grip + one row)
const STATUS_H = (StatusBar.currentHeight || 24) + 6; // same as styles.root paddingTop
const RAIL_W = 46; // left rail: NEXT + orblings
const DIM = 'rgba(14,9,42,0.22)'; // light tint over the scene art
const BOARD_BACK = 'rgba(10,6,34,0.30)'; // glass backing behind the columns so orbs stay readable on the art
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
function FloatPad({ id, anchor, bounds, children }) {
  const pos = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const base = useRef({ x: 0, y: 0 });
  const lastTap = useRef(0);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const place = (x, y) => {
    const nx = clamp(x, bounds.minX, bounds.maxX);
    const ny = clamp(y, bounds.minY, bounds.maxY);
    pos.setValue({ x: nx, y: ny });
    return { x: nx, y: ny };
  };
  useEffect(() => {
    AsyncStorage.getItem('pad3_' + id)
      .then((v) => {
        if (!v) return;
        const o = JSON.parse(v);
        base.current = place(o.x || 0, o.y || 0);
      })
      .catch(() => {});
  }, []);
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
      <View {...pan.panHandlers} style={styles.grip}>
        <Text style={styles.gripTxt}>⋮⋮⋮</Text>
      </View>
      {children}
    </Animated.View>
  );
}

// NEXTGEN_CONTROLS
function HoldButton({ label, onPress, repeat, style, textStyle, dim }) {
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
        if (!dim) Haptics.selectionAsync().catch(() => {});
        onPress();
        if (repeat) {
          t.current = setTimeout(() => {
            i.current = setInterval(onPress, 75);
          }, 170);
        }
      }}
      onPressOut={stop}
      style={({ pressed }) => [styles.btn, style, dim && styles.btnDim, pressed && !dim && styles.btnDown]}
    >
      <Text style={[styles.btnTxt, textStyle]}>{label}</Text>
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
  const flash = useRef(new Animated.Value(0)).current;
  const punch = useRef(new Animated.Value(1)).current;
  const fallY = useRef(new Animated.Value(0)).current;
  // Skia twins of burst/float/flash/fallY, plus one ms clock for orb falls (UI thread, no JS per frame)
  const svFloat = useSharedValue(0);
  const svBurst = useSharedValue(0);
  const svFlash = useSharedValue(0);
  const svFallY = useSharedValue(0);
  const svFall = useSharedValue(1e6);
  const menuScroll = useRef(null);
  const cheer = useRef(new Animated.Value(0)).current; // Orbling hop on big chains
  const menuViewH = useRef(0);
  // engine-side hooks go through G.fx so the extracted engine code (Harness.mjs) never sees Skia
  G.fx = {
    burst() { svBurst.value = 0; svBurst.value = withTiming(1, { duration: 280 }); },
    cheer() { cheer.setValue(0); Animated.timing(cheer, { toValue: 1, duration: 800, easing: Easing.linear, useNativeDriver: true }).start(); },
    fallY(px) { svFallY.value = -px; svFallY.value = withTiming(0, { duration: 90 }); },
    fall(max) { const T = fallMs(max) + 300; svFall.value = 0; svFall.value = withTiming(T, { duration: T, easing: REasing.linear }); },
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
    Animated.sequence([
      Animated.timing(shake, { toValue: p, duration: 40, useNativeDriver: true }),
      Animated.timing(shake, { toValue: -p, duration: 60, useNativeDriver: true }),
      Animated.timing(shake, { toValue: p / 2, duration: 50, useNativeDriver: true }),
      Animated.timing(shake, { toValue: 0, duration: 50, useNativeDriver: true }),
    ]).start();
  };

  const start = (L) => {
    G.day = dateKey();
    RNG = L === 22 ? seeded(Number(G.day.replace(/-/g, ''))) : Math.random;
    if (!G.replay) touchStreak();
    const cfg = LEVELS[L - 1];
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
    G.piece = spawn(G.next);
    shiftQueue();
    G.status = 'playing';
    render();
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
    if (!ONLINE) return;
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
    if (st.n === 3 || st.n === 7 || st.n % 14 === 0) G.shards += 2;
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

  const showAd = (cb) => {
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
      shiftQueue();
    });
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
    });
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
    start(22);
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
    if (G.earned > (G.stars[G.level] || 0)) {
      G.stars[G.level] = G.earned;
      AsyncStorage.setItem('stars', JSON.stringify(G.stars)).catch(() => {});
    }
    const after = totalStars(G.stars);
    G.hatched = ORBLINGS.find((o) => before < o.need && after >= o.need) || null;
    track('levels', 1);
    track('stars', after - before);
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
    const feverAtLock = G.feverPcs > 0;
    render();
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
      await sleep(G.chain >= 3 ? 520 : 260);
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
    if (feverAtLock && G.feverPcs > 0) G.feverPcs--;
    if (G.cardSnap && G.chain >= 3 && G.chain > (G.card ? G.card.chain : 0)) {
      G.card = { chain: G.chain, grid: G.cardSnap };
    }
    G.cardSnap = null;
    if (G.board.every((row) => row.every((v) => !v))) {
      G.score += 500;
      G.banner = 'PERFECT!';
      bannerScale.setValue(0);
      Animated.spring(bannerScale, { toValue: 1, friction: 4, tension: 200, useNativeDriver: true }).start();
      jingle([0, 2, 4, 6, 8, 9], 70);
      sfx('choir');
      doShake(16);
    } else if (wasDanger && !G.board.slice(0, 4).some((row) => row.some(Boolean))) {
      G.score += 200;
      G.banner = 'CLUTCH!';
      bannerScale.setValue(0);
      Animated.spring(bannerScale, { toValue: 1, friction: 4, tension: 200, useNativeDriver: true }).start();
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
    shiftQueue();
    G.status = 'playing';
    render();
  };

  const lock = () => {
    G.lockAt = 0;
    buzz(0);
    sfx('land');
    Animated.sequence([Animated.timing(punch,{toValue:0.88,duration:60,useNativeDriver:true}),Animated.spring(punch,{toValue:1,friction:3,useNativeDriver:true})]).start();
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
      if (!force) G.log += 'd';
      G.piece = p2;
      G.lockAt = 0;
      fallY.setValue(-(G.cell || 30));
      Animated.timing(fallY, { toValue: 0, duration: 90, useNativeDriver: true }).start();
      if (G.fx) G.fx.fallY(G.cell || 30);
      render();
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

  const move = (dx) => {
    if (G.replay && !G.rp) return;
    if (G.status !== 'playing' || !G.piece) return;
    G.log += dx > 0 ? 'R' : 'L';
    const p2 = { ...G.piece, c: G.piece.c + dx };
    if (valid(G.board, p2)) {
      G.piece = p2;
      render();
    }
  };

  const rotate = (dir) => {
    if (G.replay && !G.rp) return;
    if (G.status !== 'playing' || !G.piece) return;
    G.log += dir > 0 ? 'c' : 'w';
    const p2 = tryRotate(G.board, G.piece, dir);
    if (p2) {
      G.piece = p2;
      render();
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
    let t;
    const loop = () => {
      if (!G.replay) step();
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
    Math.min(Math.floor((width - 8) / COLS), Math.floor((height - STATUS_H - 8) / ROWS))
  );

  G.cell = cell;
  const danger = G.board.slice(0, 4).some((row) => row.some(Boolean));
  const display = G.board.map((row) => row.slice());

  const realm = realmOf(G.status === 'menu' ? G.unlocked : G.level);
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

  let ghost = [];
  if (G.piece) {
    let gp = G.piece;
    while (valid(G.board, { ...gp, r: gp.r + 1 })) gp = { ...gp, r: gp.r + 1 };
    if (gp.r !== G.piece.r) ghost = cellsOf(gp);
  }

  return (
    <View style={[styles.root, { backgroundColor: T.bg }]}>
      <StatusBar barStyle="light-content" />
      <View pointerEvents="none" style={ABS_FILL}>
        {skyBands(T.sky).map((c, i) => (
          <View key={i} style={{ flex: 1, backgroundColor: c }} />
        ))}
        <Scene realm={realm} width={width} height={height} />
        {[
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

      <View pointerEvents="none" style={[ABS_FILL, { backgroundColor: DIM }]} />

      <View style={[styles.hudL, { top: STATUS_H - 2 }]}>
        <View style={styles.badge}>
          <Text style={styles.badgeLbl}>LV</Text>
          <Text style={styles.badgeNum}>{G.level}</Text>
        </View>
        <View style={{ width: 78, marginLeft: 5 }}>
          <View style={styles.stat}>
            <View style={[styles.statFill, { width: `${Math.min(100, Math.max(0, progress() * 100))}%`, backgroundColor: T.accent }]} />
            <Text numberOfLines={1} adjustsFontSizeToFit style={styles.statTxt}>{goalText()}</Text>
          </View>
          <View style={[styles.stat, { marginTop: 4 }]}>
            <View style={[styles.statFill, { width: `${G.feverPcs > 0 ? 100 : Math.min(100, G.fever)}%`, backgroundColor: '#ffb020' }]} />
            <Text numberOfLines={1} adjustsFontSizeToFit style={styles.statTxt}>
              {G.moves ? `${Math.max(0, G.moves - G.placed)} MOVES` : G.feverPcs > 0 ? 'FEVER!' : 'FEVER'}
            </Text>
          </View>
        </View>
      </View>

      <View style={[styles.hudR, { top: STATUS_H - 2 }]}>
        <View style={styles.pill}>
          <Text style={styles.pillLbl}>SCORE</Text>
          <Text style={styles.pillNum}>{G.score}</Text>
        </View>
        <View style={{ flexDirection: 'row', marginTop: 4 }}>
          <View style={[styles.pill, { marginRight: 4 }]}>
            <Text style={[styles.pillIco, { color: '#5be0ff' }]}>◆</Text>
            <Text style={styles.pillNum}>{G.shards}</Text>
          </View>
          <View style={styles.pill}>
            <Text style={[styles.pillIco, { color: '#ffd23b' }]}>★</Text>
            <Text style={styles.pillNum}>{totalStars(G.stars)}</Text>
          </View>
        </View>
        <View style={{ flexDirection: 'row', marginTop: 6 }}>
          <Pressable hitSlop={8} style={styles.ico} onPress={pause}>
            <Text style={styles.icoTxt}>⏸</Text>
          </Pressable>
          <Pressable
            hitSlop={8}
            style={styles.ico}
            onPress={() => {
              MUTED = !MUTED;
              AsyncStorage.setItem('muted', MUTED ? '1' : '0').catch(() => {});
              render();
            }}
          >
            <Text style={styles.icoTxt}>{MUTED ? '🔇' : '🔊'}</Text>
          </Pressable>
        </View>
      </View>

      {G.status !== 'menu' && !!G.coach && (
        <Text pointerEvents="none" style={[styles.coachFloat, { top: STATUS_H + 120 + cell * 2 }]}>
          {G.coach}
        </Text>
      )}

      <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
        <View style={{ position: 'absolute', left: 6, top: 52, width: RAIL_W, alignItems: 'center', zIndex: 5 }}>
          <View style={styles.nextRail}>
            <Text style={styles.nextLbl}>NEXT</Text>
            <Orb color={G.next.b} size={28} />
            <Orb color={G.next.a} size={28} />
            <View style={{ marginTop: 4, opacity: 0.55 }}>
              <Orb color={G.next2.b} size={20} />
              <Orb color={G.next2.a} size={20} />
            </View>
          </View>
          {ORBLINGS.map((o, i) => {
            const owned = totalStars(G.stars) >= o.need;
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
        </View>
      <Animated.View {...pan.panHandlers} style={{ transform: [{ translateX: shake }, { scale: punch }] }}>
        <View style={[styles.board, { width: cell * COLS + 8, height: cell * ROWS + 8, backgroundColor: BOARD_BACK, borderColor: G.feverPcs > 0 ? '#ffd23b' : 'transparent' }]}>
          {USE_SKIA && (
            <BoardCanvas
              board={display} cell={cell} skin={SKIN} popping={G.popping} fall={G.fall} fallId={G.fallId || 0}
              rings={G.rings} ghost={ghost} glow={glowSet} piece={G.piece} danger={danger}
              playing={G.status === 'playing'} accent={T.accent}
              sv={{ float: svFloat, burst: svBurst, flash: svFlash, fallY: svFallY, fall: svFall }}
            />
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
                <ScrollView ref={menuScroll} onLayout={(e) => { menuViewH.current = e.nativeEvent.layout.height; }} style={{ width: '100%' }} contentContainerStyle={{ alignItems: 'center', justifyContent: 'center', flexGrow: 1, paddingVertical: 12 }}>
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
                    onPlay={start}
                    onReady={(mapTop) => {
                      // centre the current level node in the viewport (positions are exact: nodeY is fixed-pixel)
                      const y = mapTop + nodeY(Math.min(G.unlocked, MAX_LEVEL)) + NODE / 2 - (menuViewH.current || height * 0.6) / 2;
                      if (menuScroll.current) menuScroll.current.scrollTo({ y: Math.max(0, y), animated: false });
                    }}
                  />
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', marginTop: 8 }}>
                    <Pressable
                      onPress={() => (G.daily && G.daily.d === dateKey() ? shareDaily() : start(22))}
                      style={[styles.modeBtn, { borderColor: '#ffd23b' }]}
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
                        G.chestFlash = Date.now();
                        setTimeout(() => render(), 1700);
                        saveMeta();
                        AsyncStorage.setItem('chestDay', G.chestDay).catch(() => {});
                        jingle([4, 6, 9], 70);
                        render();
                      }}
                      style={[styles.modeBtn, { borderColor: '#ff8a3b', opacity: G.chestDay === dateKey() ? 0.5 : 1 }]}
                    >
                      <Text style={styles.modeTxt}>{Date.now() - (G.chestFlash || 0) < 1600 ? `🎁 +${CHEST_SHARDS} ◆` : G.chestDay === dateKey() ? '🎁 OPENED ✓' : '🎁 DAILY CHEST'}</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => {
                        touchStreak();
                        G.status = 'shop';
                        render();
                      }}
                      style={[styles.modeBtn, { borderColor: '#ff3bd4' }]}
                    >
                      <Text style={styles.modeTxt}>🎯 MISSIONS</Text>
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
                </ScrollView>
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
                      ? `LEVEL ${G.level} CLEAR`
                      : G.moves && G.placed >= G.moves
                      ? 'OUT OF MOVES'
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
                  <Pressable
                    style={styles.play}
                    onPress={nextAction}
                  >
                    <Text style={styles.playTxt}>
                      {G.t === 'daily' ? 'SHARE' : G.status === 'won' && G.level < MAX_LEVEL ? 'NEXT LEVEL' : 'RETRY'}
                    </Text>
                  </Pressable>
                  {G.t === 'daily' && ONLINE && (
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
                  {G.t === 'daily' && ONLINE && G.lb && G.lb.length > 0 && (
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
                  <Pressable onPress={() => { G.status = 'menu'; render(); }}>
                    <Text style={styles.hint}>LEVELS</Text>
                  </Pressable>
                </>
              )}
            </View>
          )}
        </View>
      </Animated.View>
      </View>

      <FloatPad id="L" anchor="left" bounds={{ minX: 0, maxX: width - 150, minY: -(height - 230), maxY: 0 }}>
        <View style={styles.dpad}>
          <HoldButton dim={G.status !== 'playing'} label="◀" onPress={() => move(-1)} repeat style={[styles.dArm, { left: 6, top: 43 }]} />
          <HoldButton dim={G.status !== 'playing'} label="▶" onPress={() => move(1)} repeat style={[styles.dArm, { right: 6, top: 43 }]} />
          <HoldButton dim={G.status !== 'playing'} label="▼" onPress={softDrop} repeat style={[styles.dArm, { left: 43, bottom: 6 }]} />
        </View>
      </FloatPad>
      <FloatPad id="R" anchor="right" bounds={{ minX: -(width - 170), maxX: 0, minY: -(height - 260), maxY: 0 }}>
        <View style={styles.acts}>
          <HoldButton dim={G.status !== 'playing'} label="⟲" onPress={() => rotate(-1)} style={[styles.act, { left: 0, bottom: 4, width: 52, height: 52, borderRadius: 26 }]} textStyle={{ fontSize: 24 }} />
          <HoldButton dim={G.status !== 'playing'} label={'⟳\nTURN'} onPress={() => rotate(1)} style={[styles.act, { right: 8, top: 0, width: 60, height: 60, borderRadius: 30 }]} textStyle={styles.actTxt} />
          <HoldButton dim={G.status !== 'playing'} label={'▼\nDROP'} onPress={hardDrop} style={[styles.act, styles.actDrop, { right: 0, bottom: 0, width: 76, height: 76, borderRadius: 38 }]} textStyle={styles.actTxt} />
        </View>
      </FloatPad>
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
    paddingBottom: 4,
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
    backgroundColor: 'rgba(30,15,80,0.84)',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
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
  adBtn: { marginTop: 10, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 14, borderWidth: 1.5, borderColor: '#ffd23b', backgroundColor: '#1a1a30' },
  adBtnTxt: { color: '#ffd23b', fontWeight: '800', fontSize: 13, letterSpacing: 1 },
  adCover: { ...ABS_FILL, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center' },
  adTxt: { color: '#aaa', fontSize: 14, letterSpacing: 3 },
  adBig: { color: '#fff', fontSize: 64, fontFamily: FONT },
  coach: { fontSize: 13, fontFamily: FONT, letterSpacing: 0.5, height: 18, marginBottom: 2 },
  bar: { width: '90%', height: 6, backgroundColor: 'rgba(0,0,0,0.30)', borderRadius: 3, marginBottom: 8, overflow: 'hidden' },
  barFill: { height: 6, backgroundColor: '#2bff88' },
  badge: { width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(20,10,60,0.6)', borderWidth: 3, borderColor: '#ffd23b', alignItems: 'center', justifyContent: 'center' },
  badgeLbl: { color: '#ffd23b', fontFamily: FONT, fontSize: 9, lineHeight: 10 },
  badgeNum: { color: '#fff', fontFamily: FONT, fontSize: 21, lineHeight: 23, textShadowColor: 'rgba(20,10,60,0.9)', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 1 },
  stat: { height: 18, borderRadius: 9, backgroundColor: 'rgba(0,0,0,0.5)', borderWidth: 2, borderColor: 'rgba(255,255,255,0.35)', overflow: 'hidden', justifyContent: 'center' },
  statFill: { position: 'absolute', left: 0, top: 0, bottom: 0 },
  statTxt: { color: '#fff', fontFamily: FONT, fontSize: 10, textAlign: 'center', paddingHorizontal: 4, textShadowColor: 'rgba(20,10,60,0.9)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 1 },
  pill: { flexDirection: 'row', alignItems: 'center', height: 26, paddingHorizontal: 8, borderRadius: 14, backgroundColor: 'rgba(20,10,60,0.55)', borderWidth: 2, borderColor: 'rgba(255,255,255,0.3)' },
  pillLbl: { color: 'rgba(255,255,255,0.75)', fontFamily: FONT, fontSize: 9, marginRight: 4 },
  pillIco: { fontSize: 14, marginRight: 4 },
  pillNum: { color: '#fff', fontFamily: FONT, fontSize: 15, textShadowColor: 'rgba(20,10,60,0.9)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 1 },
  comboLbl: { color: '#ffd23b', fontFamily: FONT, fontSize: 14, letterSpacing: 2, textShadowColor: 'rgba(20,10,60,0.9)', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 1 },
  hudL: { position: 'absolute', left: 8, flexDirection: 'row', alignItems: 'center' },
  hudR: { position: 'absolute', right: 8, alignItems: 'flex-end' },
  dpad: { width: 128, height: 128, borderRadius: 64, backgroundColor: 'rgba(255,255,255,0.10)', borderWidth: 2, borderColor: 'rgba(255,255,255,0.38)' },
  dArm: { position: 'absolute', flex: 0, width: 42, height: 42, borderRadius: 21, backgroundColor: 'rgba(255,255,255,0.16)', borderWidth: 2, borderColor: 'rgba(255,255,255,0.55)', borderBottomWidth: 2, borderBottomColor: 'rgba(255,255,255,0.55)' },
  acts: { width: 156, height: 130 },
  act: { position: 'absolute', flex: 0, backgroundColor: 'rgba(255,255,255,0.16)', borderWidth: 2.5, borderColor: 'rgba(255,255,255,0.6)', borderBottomWidth: 2.5, borderBottomColor: 'rgba(255,255,255,0.6)' },
  actDrop: { backgroundColor: 'rgba(255,59,107,0.45)', borderColor: 'rgba(255,208,220,0.9)', borderBottomColor: 'rgba(255,208,220,0.9)' },
  actTxt: { fontFamily: FONT, fontWeight: 'normal', fontSize: 14, lineHeight: 17, textAlign: 'center', textShadowColor: 'rgba(20,10,60,0.9)', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 1 },
  railBtn: { width: 36, height: 36, marginBottom: 6, borderRadius: 18, backgroundColor: 'rgba(25,12,70,0.55)', borderWidth: 2, borderColor: 'rgba(255,255,255,0.45)', borderBottomWidth: 4, borderBottomColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center' },
  nextRail: { width: 42, alignItems: 'center', paddingVertical: 4, marginBottom: 8, borderRadius: 14, backgroundColor: 'rgba(0,0,0,0.32)', borderWidth: 2, borderColor: 'rgba(255,255,255,0.22)' },
  nextLbl: { color: 'rgba(255,255,255,0.8)', fontFamily: FONT, fontSize: 8, marginBottom: 2 },
  coachFloat: { position: 'absolute', left: 0, right: 0, textAlign: 'center', color: '#fff', fontFamily: FONT, fontSize: 14, textShadowColor: 'rgba(0,0,0,0.6)', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 2 },
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
  grip: { alignSelf: 'center', paddingHorizontal: 22, paddingVertical: 4, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.28)', marginBottom: 2 },
  gripTxt: { color: 'rgba(255,255,255,0.85)', fontSize: 12, letterSpacing: 2, fontWeight: '900' },
  ico: { width: 38, height: 38, marginLeft: 6, borderRadius: 19, backgroundColor: 'rgba(0,0,0,0.38)', borderWidth: 2, borderColor: 'rgba(255,255,255,0.4)', borderBottomWidth: 4, borderBottomColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center' },
  icoTxt: { color: '#fff', fontSize: 17 },
  fbtn: { flex: 0, width: 48, height: 48, marginHorizontal: 3, borderRadius: 24, backgroundColor: 'rgba(25,12,70,0.55)', borderWidth: 2, borderColor: 'rgba(255,255,255,0.7)' },
  fdrop: { flex: 0, width: 66, height: 48, marginHorizontal: 3, borderRadius: 24, backgroundColor: '#ff3b6b', borderWidth: 2, borderColor: '#ffd0dc', borderBottomColor: '#a3123a' },
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
