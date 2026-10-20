#!/usr/bin/env python3
# ChainOrb v33 patch: 4 new realms (meadow/day, desert, storm/rain, dawn), realm-coloured world map,
# new music + instruments, Android back button, version label.
# Run inside ~/chainorb:   python v33_patch.py        (makes App.js.bak.v33 first; every edit is asserted)
import sys, shutil, os

SRC = 'App.js'
BLOCK = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'v33_block.js')
src = open(SRC, encoding='utf-8').read()
if "const VERSION = 'v33'" in src:
    sys.exit('already patched')
shutil.copy(SRC, 'App.js.bak.v33')


def rep(old, new, what):
    global src
    n = src.count(old)
    if n != 1:
        sys.exit(f'PATCH FAILED ({what}): expected 1 match, found {n}')
    src = src.replace(old, new)


# ---- imports / version ----
rep("useWindowDimensions, StatusBar, PanResponder, Share, Platform, AppState, TextInput, Linking,",
    "useWindowDimensions, StatusBar, PanResponder, Share, Platform, AppState, TextInput, Linking, BackHandler,", 'import BackHandler')
rep("const VERSION = 'v30';", "const VERSION = 'v33';", 'version')

# ---- realms 4-7 ----
rep("accent: '#ff9bec' },\n];",
"""accent: '#ff9bec' },
  { name: 'SUNNY MEADOW', bg: '#2f77d8', sky: ['#1d4fb0', '#2f77d8', '#f2d9a0'], board: 'rgba(8,24,80,0.42)', border: '#fff2a8', accent: '#ffe27a', glass: 'rgba(6,18,60,0.30)', dim: 'rgba(6,18,60,0.14)' },
  { name: 'DUSTY DUNES', bg: '#6a1a5a', sky: ['#1a0b45', '#b02a7a', '#ffb050'], board: 'rgba(40,8,40,0.5)', border: '#ffc27a', accent: '#ffc27a', glass: 'rgba(24,6,30,0.26)', dim: 'rgba(24,6,30,0.10)' },
  { name: 'STORM JUNGLE', bg: '#10242e', sky: ['#0a1a22', '#183a46', '#2a5a62'], board: 'rgba(4,16,26,0.55)', border: '#9fd8ff', accent: '#9fd8ff', glass: 'rgba(4,14,24,0.26)', dim: 'rgba(4,14,24,0.12)' },
  { name: 'GOLDEN DAWN', bg: '#7a3a8a', sky: ['#2a2a6e', '#ff7a8a', '#ffe0a0'], board: 'rgba(50,14,60,0.46)', border: '#ffe0a0', accent: '#ffd08a', glass: 'rgba(40,10,50,0.28)', dim: 'rgba(40,10,50,0.12)' },
];""", 'REALMS')

# levels 1-20 keep their 4 realms; 21-100 run through all 8 (10 levels each); the Daily picks a realm by date
rep("const realmOf = (L) => (L <= 20 ? Math.min(3, Math.floor((L - 1) / 5)) : L >= 900 ? 3 : Math.floor((L - 21) / 10) % 4);",
"""const ACT2 = [4, 5, 6, 1, 7, 2, 0, 3]; // levels 21-100: meadow, desert, storm, lake, dawn, frost, grove, neon
const realmOf = (L) => (L <= 20 ? Math.min(3, Math.floor((L - 1) / 5)) : L === DAILY_L ? ACT2[dateSeed() % 8] : L >= 900 ? 3 : ACT2[Math.floor((L - 21) / 10) % 8]);""", 'realmOf')

# ---- instruments (realms 4-7) ----
rep("const INSTR = [kalimba, adungu, glassBell, conga];",
"""function pluckBright(f) { // meadow: bright music-box pluck
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
const INSTR = [kalimba, adungu, glassBell, conga, pluckBright, handpan, marimba, harp];""", 'INSTR')

# ---- music tracks 4-7 (+ rain / wind bed) ----
rep("""    pat: [0, 2, 1, 2, 3, 2, 1, 2, 0, 2, 1, 4, 3, 2, 4, 2],
  },
];""",
"""    pat: [0, 2, 1, 2, 3, 2, 1, 2, 0, 2, 1, 4, 3, 2, 4, 2],
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
];""", 'TRACKS')

rep("""  let peak = 0;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(buf[i]));""",
"""  if (d.noise) {
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
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(buf[i]));""", 'makeTrack noise')

rep("const order = [first, ...[0, 1, 2, 3].filter((x) => x !== first)];",
    "const order = [first, ...[0, 1, 2, 3, 4, 5, 6, 7].filter((x) => x !== first)];", 'loadAllMusic')

# ---- palettes 8-15 ----
rep("tint: '0,170,255' },\n];",
"""tint: '0,170,255' },
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
];""", 'PALS')

# ---- new scene code goes just before ForestScene ----
block = open(BLOCK, encoding='utf-8').read()
rep("const ForestScene = React.memo(function ForestScene({ W, H, clock, pal, flip, seed, cool, realm }) {",
    block + "const ForestScene = React.memo(function ForestScene({ W, H, clock, pal, flip, seed, cool, realm }) {", 'insert block')

# ---- storm tweaks inside ForestScene (realm 6): no stars or shooting stars, dark clouds, rain ----
rep("{r === 1 && <Moon W={W} H={H} clock={clock} />}",
    "{r === 1 && <Moon W={W} H={H} clock={clock} />}\n        {r === 6 && <StormClouds W={W} H={H} clock={clock} />}", 'storm clouds')
rep("{stars.map((g, i) => (", "{r !== 6 && stars.map((g, i) => (", 'storm stars')
rep("{sparks.map(([fx, fy, sz], i) => (", "{r !== 6 && sparks.map(([fx, fy, sz], i) => (", 'storm sparks')
rep("<ShootingStar x0={W * 0.26}", "{r !== 6 && (<>\n        <ShootingStar x0={W * 0.26}", 'storm shooting start')
rep("<ShootingStar x0={W * 0.1} y0={H * 0.1} dx={W * 0.2} dy={-H * 0.04} K={3} ph={0.8} clock={clock} />",
    "<ShootingStar x0={W * 0.1} y0={H * 0.1} dx={W * 0.2} dy={-H * 0.04} K={3} ph={0.8} clock={clock} />\n        </>)}", 'storm shooting end')
rep("{r === 2 && <Snow W={W} H={H} clock={clock} />}",
    "{r === 2 && <Snow W={W} H={H} clock={clock} />}\n        {r === 6 && <StormFX W={W} H={H} clock={clock} />}", 'storm fx')

# ---- map: crests, teasers, props, bridges, names ----
rep("const REALM_CREST = ['🍄', '🌊', '🏔️', '🌆'];", "const REALM_CREST = ['🍄', '🌊', '🏔️', '🌆', '🌻', '🌵', '⛈️', '🌅'];", 'crest')
rep("  'Five colors. One final boss.',\n];",
    "  'Five colors. One final boss.',\n  'Sunlit hills. A breeze full of butterflies.',\n  'Hot sand. Long shadows. Hidden rocks.',\n  'Thunder rolls. The rain never stops.',\n  'First light on the peaks. Everything glows.',\n];", 'tease')
rep("  ['🏙️', '🤖', '📡', '🛸', '⚡', '🔌', '💿', '🧪', '👾'],\n];",
    "  ['🏙️', '🤖', '📡', '🛸', '⚡', '🔌', '💿', '🧪', '👾'],\n  ['🌻', '🦋', '🐝', '🌼', '🐞', '🌳', '🐇', '🌷', '☁️'],\n  ['🌵', '🐪', '🦂', '🏜️', '🦎', '🪨', '🌴', '☀️', '🦴'],\n  ['🌧️', '☔', '🐸', '⚡', '🍃', '🌿', '🦆', '🪵', '🌫️'],\n  ['🌅', '🐓', '🦌', '🌾', '🕊️', '🌸', '🦉', '🌄', '🍃'],\n];", 'props')
rep("deco: ['⚡', '📡', '⚡', '🔌', '⚡'], neon: true },\n];",
"""deco: ['⚡', '📡', '⚡', '🔌', '⚡'], neon: true },
  { plank: '#9a7a4a', plank2: '#c29a5a', rail: '#fff6d0', post: '🌻', band: 'rgba(90,190,255,0.5)', edge: '#ffffff', deco: ['🌼', '🦋', '🌼', '🐝', '🌼'] },
  { plank: '#a8683a', plank2: '#d08a4a', rail: '#ffd9a0', post: '🌵', band: 'rgba(200,90,40,0.5)', edge: '#ffc080', deco: ['🌵', '🐪', '🌵', '🦂', '🌵'] },
  { plank: '#3a4a4a', plank2: '#5a6e6e', rail: '#9fd0ff', post: '🪵', band: 'rgba(30,60,80,0.62)', edge: '#9fd0ff', deco: ['🌧️', '🐸', '🌿', '🌧️', '🍃'] },
  { plank: '#b0707a', plank2: '#e09a8a', rail: '#ffe0b0', post: '🌸', band: 'rgba(255,140,110,0.5)', edge: '#ffe0b0', deco: ['🌸', '🕊️', '🌸', '🌾', '🌸'] },
];""", 'bridges')
rep("const secName = (L) => REALMS[realmOf(L)].name + (L > 20 ? ' ' + ['II', 'III', 'IV', 'V'][Math.min(3, Math.floor((L - 21) / 40))] : '');",
    "const secName = (L) => REALMS[realmOf(L)].name + (L > 20 && realmOf(L) < 4 ? ' II' : '');", 'secName')

# world map: one band of sky per realm
rep("  const done = useRef(false); // fresh per mount, so it scrolls once each time the menu opens\n  const items = [];",
"""  const done = useRef(false); // fresh per mount, so it scrolls once each time the menu opens
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
  }""", 'map bands setup')
rep("      {tint ? <View pointerEvents=\"none\" style={{ position: 'absolute', left: -40, right: -40, top: 0, bottom: 0, backgroundColor: tint }} /> : null}\n      {items}",
    "      {bands}\n      {tint ? <View pointerEvents=\"none\" style={{ position: 'absolute', left: -40, right: -40, top: 0, bottom: 0, backgroundColor: tint }} /> : null}\n      {items}", 'map bands render')

# ---- story beats for the new realms ----
rep("const STORY_AT = { 1: 'intro', 6: 'realm2', 10: 'boss10', 11: 'realm3', 16: 'realm4', 20: 'boss20' };",
    "const STORY_AT = { 1: 'intro', 6: 'realm2', 10: 'boss10', 11: 'realm3', 16: 'realm4', 20: 'boss20', 21: 'realm5', 31: 'realm6', 41: 'realm7', 61: 'realm8' };", 'STORY_AT')
rep("    ['👑', 'Neon King', 'Every realm hangs on this board. Make it a legend.'],\n  ],\n};",
"""    ['👑', 'Neon King', 'Every realm hangs on this board. Make it a legend.'],
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
};""", 'STORY')

# ---- in-game: pick the scene, bright realms get darker glass so orbs stay readable ----
rep("<ForestScene W={width} H={height} clock={svClock} pal={PALS[Math.min(7, realm * 2 + (bio.v & 1))]} flip={!!(bio.v & 2)} seed={bio.seed} cool={svCool} realm={realm} />",
"""<SceneGuard key={realm} fallback={<ForestScene W={width} H={height} clock={svClock} pal={PALS[0]} flip={false} seed={1} cool={svCool} realm={0} />}>
          <WorldScene realm={realm} bio={bio} W={width} H={height} clock={svClock} cool={svCool} />
        </SceneGuard>""", 'game scene')
rep("<View pointerEvents=\"none\" style={[ABS_FILL, { backgroundColor: DIM }]} />",
    "<View pointerEvents=\"none\" style={[ABS_FILL, { backgroundColor: T.dim || DIM }]} />", 'dim')
rep("<View pointerEvents=\"none\" style={[ABS_FILL, { backgroundColor: BOARD_BACK }]} />",
    "<View pointerEvents=\"none\" style={[ABS_FILL, { backgroundColor: T.glass || BOARD_BACK }]} />", 'glass')

# ---- Android back button: pause / resume / back to the map; on the map it leaves the app as normal ----
rep("""      if (st !== 'active') pause();
    });
    return () => sub.remove();
  }, []);""",
"""      if (st !== 'active') pause();
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
  }, []);""", 'back button')

open(SRC, 'w', encoding='utf-8').write(src)

# keep old build snapshots out of git
try:
    gi = open('.gitignore').read()
    if 'App.v*.js' not in gi:
        open('.gitignore', 'a').write('\n# old build snapshots\nApp.v*.js\n')
except Exception:
    pass
print('v33 applied. backup: App.js.bak.v33')
