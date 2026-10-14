import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  View, Text, Pressable, StyleSheet, Animated, ScrollView,
  useWindowDimensions, StatusBar, PanResponder, Share, Platform,
} from 'react-native';
import { Image, Easing } from 'react-native';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { File, Paths } from 'expo-file-system';

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
        fontSize: cell * 0.36,
        fontWeight: '900',
        textShadowColor: '#ff8a3b',
        textShadowRadius: 6,
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
const BOTTOM_PAD = Platform.OS === 'android' ? 52 : 24;

const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function skyBands(stops, n = 18) {
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
    AsyncStorage.getItem('pad_' + id)
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
        AsyncStorage.setItem('pad_' + id, JSON.stringify(base.current)).catch(() => {});
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
    touchStreak();
    const cfg = LEVELS[L - 1];
    G.level = L;
    G.attempts[L] = (G.attempts[L] || 0) + 1;
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

  const gameOver = () => {
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
  const nextAction = () => {
    if (G.t === 'daily') return shareDaily();
    const nxt = G.status === 'won' && G.level < MAX_LEVEL ? G.level + 1 : G.level;
    if (G.status === 'won' && adDue(G.level)) showAd(() => start(nxt));
    else start(nxt);
    return null;
  };

  const win = () => {
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
    if (G.status !== 'playing' || !G.piece) return;
    G.log += 's';
    if (step(true)) G.score += 1;
  };

  const move = (dx) => {
    if (G.status !== 'playing' || !G.piece) return;
    G.log += dx > 0 ? 'R' : 'L';
    const p2 = { ...G.piece, c: G.piece.c + dx };
    if (valid(G.board, p2)) {
      G.piece = p2;
      render();
    }
  };

  const rotate = (dir) => {
    if (G.status !== 'playing' || !G.piece) return;
    G.log += dir > 0 ? 'c' : 'w';
    const p2 = tryRotate(G.board, G.piece, dir);
    if (p2) {
      G.piece = p2;
      render();
    }
  };

  const hardDrop = () => {
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
    Math.min(Math.floor((width - 66) / COLS), Math.floor((height - 190 - BOTTOM_PAD) / ROWS))
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
    if (G.status !== 'playing' || G.placed !== 0 || G.log || cdRef.current === G.startedAt) return;
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
          <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
            <View>
              <Orb color={G.next.b} size={26} />
              <Orb color={G.next.a} size={26} />
            </View>
            <View style={{ marginLeft: 4, marginTop: 6, opacity: 0.55 }}>
              <Orb color={G.next2.b} size={20} />
              <Orb color={G.next2.a} size={20} />
            </View>
          </View>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={styles.label}>LEVEL</Text>
          <Text style={styles.score}>{G.level}</Text>
          <View style={{ flexDirection: 'row', marginTop: 2 }}>
            <Pressable
              hitSlop={8}
              style={styles.ico}
              onPress={() => {
                if (G.status === 'playing') {
                  logEvent('quit');
                  G.status = 'menu';
                  render();
                }
              }}
            >
              <Text style={styles.icoTxt}>☰</Text>
            </Pressable>
            <Pressable hitSlop={8} style={styles.ico} onPress={pause}>
              <Text style={styles.icoTxt}>⏸</Text>
            </Pressable>
            {(G.status === 'playing' || G.status === 'paused') && (
              <Pressable
                hitSlop={8}
                style={styles.ico}
                onPress={() => {
                  if (G.status !== 'playing' && G.status !== 'paused') return;
                  if (Date.now() - (G.restartArm || 0) < 2500) {
                    G.restartArm = 0;
                    logEvent('quit');
                    start(G.level);
                  } else {
                    G.restartArm = Date.now();
                    render();
                    setTimeout(() => render(), 2600);
                  }
                }}
              >
                <Text style={styles.icoTxt}>{Date.now() - (G.restartArm || 0) < 2500 ? '↻?' : '↻'}</Text>
              </Pressable>
            )}
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
      </View>

      <View style={styles.bar}>
        <View style={[styles.barFill, { width: `${Math.min(100, Math.max(0, progress() * 100))}%`, backgroundColor: T.accent }]} />
      </View>

      <View style={[styles.bar, { height: 4, marginTop: -4, marginBottom: 4 }]}>
        <View
          style={{
            height: 4,
            width: `${G.feverPcs > 0 ? 100 : Math.min(100, G.fever)}%`,
            backgroundColor: '#ffd23b',
          }}
        />
      </View>

      <Text style={[styles.coach, { color: '#fff', textShadowColor: 'rgba(0,0,0,0.55)', textShadowRadius: 4 }]}>
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
                disabled={!owned || !!spent || G.t === 'daily' || G.status !== 'playing'}
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
      <Animated.View {...pan.panHandlers} style={{ transform: [{ translateX: shake }, { scale: punch }] }}>
        <View style={[styles.board, { width: cell * COLS + 8, height: cell * ROWS + 8, backgroundColor: T.board, borderColor: G.feverPcs > 0 ? '#ffd23b' : T.border }]}>
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

          {(G.popups || []).map((o) => (
            <ScorePopup key={o.id} r={o.r} c={o.c} pts={o.pts} cell={cell} color={COLORS[G.board[Math.round(o.r)] && G.board[Math.round(o.r)][Math.round(o.c)] || 1]} />
          ))}

          {G.cd > 0 && (
            <View pointerEvents="none" style={[ABS_FILL, { alignItems: 'center', justifyContent: 'center' }]}>
              <Text style={{ fontSize: 96, fontWeight: '900', color: '#fff', textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 12 }}>{G.cd}</Text>
            </View>
          )}

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

          {G.banner ? (
            <View style={styles.bannerWrap} pointerEvents="none">
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
                {G.banner}
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
                      G.status = 'menu';
                      render();
                    }}
                  >
                    <Text style={styles.hint}>QUIT TO LEVELS</Text>
                  </Pressable>
                </>
              ) : G.status === 'menu' ? (
                <ScrollView style={{ width: '100%' }} contentContainerStyle={{ alignItems: 'center', justifyContent: 'center', flexGrow: 1, paddingVertical: 12 }}>
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
                  <Text style={styles.hint}>{orblingLine(G.stars)}  •  {VERSION}{G.streak.n ? `  •  🔥${G.streak.n}` : ''}</Text>
                  <View style={styles.grid}>
                    {Array.from({ length: MAX_LEVEL }, (_, i) => i + 1).map((L) => {
                      const open = L <= G.unlocked;
                      return (
                        <Pressable
                          key={L}
                          disabled={!open}
                          onPress={() => start(L)}
                          style={[styles.lvl, open && { borderColor: '#fff', backgroundColor: REALMS[realmOf(L)].sky[1] }, !open && styles.lvlLocked]}
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
        <View style={{ width: 46 }} />
      </View>

      <FloatPad id="L" anchor="left" bounds={{ minX: 0, maxX: width - 190, minY: -(height - 230), maxY: 0 }}>
        <View style={{ flexDirection: 'row' }}>
          <HoldButton dim={G.status !== 'playing'} label="◀" onPress={() => move(-1)} repeat style={styles.fbtn} />
          <HoldButton dim={G.status !== 'playing'} label="▼" onPress={softDrop} repeat style={styles.fbtn} />
          <HoldButton dim={G.status !== 'playing'} label="▶" onPress={() => move(1)} repeat style={styles.fbtn} />
        </View>
      </FloatPad>
      <FloatPad id="R" anchor="right" bounds={{ minX: -(width - 170), maxX: 0, minY: -(height - 260), maxY: 0 }}>
        <View style={{ flexDirection: 'row' }}>
          <HoldButton dim={G.status !== 'playing'} label="⟲" onPress={() => rotate(-1)} style={styles.fbtn} />
          <HoldButton dim={G.status !== 'playing'} label="⟳" onPress={() => rotate(1)} style={styles.fbtn} />
        </View>
        <HoldButton dim={G.status !== 'playing'} label="DROP" onPress={hardDrop} style={styles.fdrop} textStyle={styles.dropTxt} />
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
    paddingTop: (StatusBar.currentHeight || 24) + 6,
  },
  hud: {
    width: '90%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  label: { color: 'rgba(255,255,255,0.9)', fontSize: 11, letterSpacing: 2, fontWeight: '700', textShadowColor: 'rgba(0,0,0,0.45)', textShadowRadius: 3 },
  score: { color: '#fff', fontSize: 30, fontWeight: '900', textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 5 },
  small: { color: 'rgba(255,255,255,0.92)', fontSize: 12, fontWeight: '700', textShadowColor: 'rgba(0,0,0,0.45)', textShadowRadius: 3 },
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
  hint: { color: 'rgba(255,255,255,0.85)', marginTop: 16, fontSize: 12 },
  bannerWrap: {
    ...ABS_FILL,
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
  chip: { width: 38, height: 38, borderRadius: 19, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', marginBottom: 8, backgroundColor: 'rgba(0,0,0,0.35)' },
  hatch: { color: '#fff', fontSize: 15, fontWeight: '800', textAlign: 'center', marginTop: 8, letterSpacing: 1 },
  modeBtn: { paddingHorizontal: 16, paddingVertical: 11, borderRadius: 16, borderWidth: 2.5, marginHorizontal: 5, marginVertical: 3, backgroundColor: 'rgba(255,255,255,0.16)' },
  modeTxt: { color: '#fff', fontWeight: '800', fontSize: 12, letterSpacing: 1 },
  adBtn: { marginTop: 10, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 14, borderWidth: 1.5, borderColor: '#ffd23b', backgroundColor: '#1a1a30' },
  adBtnTxt: { color: '#ffd23b', fontWeight: '800', fontSize: 13, letterSpacing: 1 },
  adCover: { ...ABS_FILL, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center' },
  adTxt: { color: '#aaa', fontSize: 14, letterSpacing: 3 },
  adBig: { color: '#fff', fontSize: 64, fontWeight: '900' },
  coach: { fontSize: 11, letterSpacing: 2, height: 16, marginBottom: 2 },
  bar: { width: '90%', height: 6, backgroundColor: 'rgba(0,0,0,0.30)', borderRadius: 3, marginBottom: 8, overflow: 'hidden' },
  barFill: { height: 6, backgroundColor: '#2bff88' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', width: '100%', marginTop: 10 },
  lvl: { width: 44, height: 50, margin: 3, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.18)', borderWidth: 2, borderColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  lvlLocked: { borderColor: 'rgba(255,255,255,0.25)', opacity: 0.7 },
  stars: { color: '#ffe14a', fontSize: 9, marginTop: 2 },
  bigStars: { color: '#ffd23b', fontSize: 34, marginTop: 8, letterSpacing: 4 },
  lvlTxt: { color: '#fff', fontSize: 17, fontWeight: '900', textShadowColor: 'rgba(0,0,0,0.4)', textShadowRadius: 3 },
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
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
  btnDown: { backgroundColor: 'rgba(255,255,255,0.20)', transform: [{ scale: 0.94 }] },
  btnDim: { opacity: 0.32 },
  btnTxt: { color: '#fff', fontSize: 26, fontWeight: '700' },
  dropBtn: { backgroundColor: 'rgba(255,59,107,0.20)', borderColor: '#ff3b6b', borderTopColor: '#ff7a9a' },
  dropTxt: { fontSize: 20, fontWeight: '900', letterSpacing: 2 },
  padL: { position: 'absolute', left: 8, bottom: BOTTOM_PAD + 6, alignItems: 'flex-start' },
  padR: { position: 'absolute', right: 8, bottom: BOTTOM_PAD + 6, alignItems: 'flex-end' },
  grip: { alignSelf: 'center', paddingHorizontal: 22, paddingVertical: 4, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.28)', marginBottom: 2 },
  gripTxt: { color: 'rgba(255,255,255,0.85)', fontSize: 12, letterSpacing: 2, fontWeight: '900' },
  ico: { minWidth: 30, height: 28, marginLeft: 4, borderRadius: 14, backgroundColor: 'rgba(0,0,0,0.25)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  icoTxt: { color: '#fff', fontSize: 15, fontWeight: '900' },
  fbtn: { flex: 0, width: 50, height: 50, marginHorizontal: 3, borderRadius: 25, backgroundColor: 'rgba(255,255,255,0.24)', borderWidth: 2, borderColor: 'rgba(255,255,255,0.55)' },
  fdrop: { flex: 0, width: 76, height: 76, marginHorizontal: 3, marginTop: 6, borderRadius: 38, backgroundColor: 'rgba(255,59,107,0.65)', borderWidth: 2, borderColor: '#ffd0dc' },
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
  return (
    <Boundary>
      <View style={{ flex: 1, backgroundColor: '#05050c' }}>
        <Game />
        {intro ? <Intro onDone={() => setIntro(false)} /> : null}
      </View>
    </Boundary>
  );
}
