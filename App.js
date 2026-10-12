import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  View, Text, Pressable, StyleSheet, Animated,
  useWindowDimensions, StatusBar,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';

/* ============================== ENGINE ============================== */
const COLS = 6;
const ROWS = 12;
const MAX_LEVEL = 20;
const MIN_GROUP = 4;
const COLORS = ['', '#ff3b6b', '#2bff88', '#3ba8ff', '#ffd23b', '#b46bff', '#6b6b8a'];
const ROCK = 6;
// child offset by orientation: 0 up, 1 right, 2 down, 3 left
const OFF = [[-1, 0], [0, 1], [1, 0], [0, -1]];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (n) => 1 + Math.floor(Math.random() * n);
const newPair = (n = 3) => ({ a: rnd(n), b: rnd(n) });
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
      if (!b[r][c] || b[r][c] === ROCK || seen[r][c]) continue;
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

/* ============================== UI PARTS ============================== */
function Orb({ color, size, popping }) {
  if (!color) return <View style={{ width: size, height: size }} />;
  return (
    <View style={{ width: size, height: size, padding: size * 0.06 }}>
      <View
        style={{
          flex: 1,
          borderRadius: size,
          backgroundColor: popping ? '#ffffff' : COLORS[color],
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
export default function App() {
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
  }).current;

  const [, setT] = useState(0);
  const render = useCallback(() => setT((t) => t + 1), []);
  const alive = useRef(true);
  const shake = useRef(new Animated.Value(0)).current;
  const burst = useRef(new Animated.Value(0)).current;
  const float = useRef(new Animated.Value(0)).current;

  const buzz = (n) => {
    try {
      const style =
        n >= 4 ? Haptics.ImpactFeedbackStyle.Heavy : Haptics.ImpactFeedbackStyle.Medium;
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
    const cfg = levelCfg(L);
    G.level = L;
    G.goal = cfg.goal;
    G.colors = cfg.colors;
    G.base = cfg.speed;
    G.moves = cfg.moves;
    G.next = newPair(cfg.colors);
    G.board = emptyBoard();
    for (let i = 0; i < cfg.rocks; i++) {
      const r = ROWS - 1 - Math.floor(Math.random() * 4);
      const c = Math.floor(Math.random() * COLS);
      G.board[r][c] = ROCK;
    }
    gravity(G.board);
    G.score = 0;
    G.chain = 0;
    G.maxChain = 0;
    G.banner = '';
    G.popping = new Set();
    G.placed = 0;
    G.piece = spawn(G.next);
    G.next = newPair(G.colors);
    G.status = 'playing';
    render();
  };

  const gameOver = () => {
    G.status = 'over';
    G.piece = null;
    if (G.score > G.best) {
      G.best = G.score;
      AsyncStorage.setItem('best', String(G.best)).catch(() => {});
    }
    buzz(4);
    render();
  };

  const win = () => {
    G.status = 'won';
    G.earned =
      1 + (G.maxChain >= 3 ? 1 : 0) + (G.placed <= Math.ceil(G.goal / 30) + 2 ? 1 : 0);
    if (G.earned > (G.stars[G.level] || 0)) {
      G.stars[G.level] = G.earned;
      AsyncStorage.setItem('stars', JSON.stringify(G.stars)).catch(() => {});
    }
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
      const hit = new Set(flat.map(([r, c]) => r * COLS + c));
      for (const [r, c] of flat) {
        for (const [dy, dx] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const y = r + dy;
          const x = c + dx;
          if (y >= 0 && y < ROWS && x >= 0 && x < COLS && G.board[y][x] === ROCK) {
            hit.add(y * COLS + x);
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
      if (G.chain >= 3) doShake(Math.min(4 + G.chain * 2, 16));
      await sleep(260);
      G.score += flat.length * 10 * Math.pow(2, G.chain - 1);
      for (const [r, c] of cells) G.board[r][c] = 0;
      G.popping = new Set();
      G.rings = [];
      render();
      await sleep(110);
    }
    if (!alive.current) return;
    G.maxChain = Math.max(G.maxChain, G.chain);
    setTimeout(() => {
      G.banner = '';
      render();
    }, 800);

    if (G.score >= G.goal) {
      win();
      return;
    }
    if (G.moves && G.placed >= G.moves) {
      gameOver();
      return;
    }
    const p = spawn(G.next);
    if (!valid(G.board, p)) {
      gameOver();
      return;
    }
    G.piece = p;
    G.next = newPair(G.colors);
    G.status = 'playing';
    render();
  };

  const lock = () => {
    for (const [r, c, col] of cellsOf(G.piece)) G.board[r][c] = col;
    G.piece = null;
    G.placed++;
    resolve();
  };

  const step = () => {
    if (G.status !== 'playing' || !G.piece) return false;
    const p2 = { ...G.piece, r: G.piece.r + 1 };
    if (valid(G.board, p2)) {
      G.piece = p2;
      render();
      return true;
    }
    lock();
    return false;
  };

  const softDrop = () => {
    if (step()) G.score += 1;
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

  const speed = () => Math.max(110, G.base - Math.floor(G.placed / 8) * 30);

  useEffect(() => {
    alive.current = true;
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
    Math.min(Math.floor((width - 24) / COLS), Math.floor((height - 360) / ROWS))
  );

  const display = G.board.map((row) => row.slice());
  if (G.piece) {
    for (const [r, c, col] of cellsOf(G.piece)) {
      if (r >= 0 && r < ROWS && c >= 0 && c < COLS) display[r][c] = col;
    }
  }

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" />

      <View style={styles.hud}>
        <View>
          <Text style={styles.label}>SCORE</Text>
          <Text style={styles.score}>{G.score}</Text>
          <Text style={styles.small}>GOAL {G.goal}</Text>
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
        </View>
      </View>

      <View style={styles.bar}>
        <View style={[styles.barFill, { width: `${Math.min(100, (G.score / G.goal) * 100)}%` }]} />
      </View>

      <Animated.View style={{ transform: [{ translateX: shake }] }}>
        <View style={[styles.board, { width: cell * COLS + 8, height: cell * ROWS + 8 }]}>
          {display.map((row, r) => (
            <View key={r} style={{ flexDirection: 'row' }}>
              {row.map((col, c) => (
                <Orb
                  key={c}
                  color={col}
                  size={cell}
                  popping={G.popping.has(r * COLS + c)}
                />
              ))}
            </View>
          ))}

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
                  <Text style={styles.title}>CHAINORB</Text>
                  <Text style={styles.hint}>Hit the goal to unlock the next level</Text>
                  <View style={styles.grid}>
                    {Array.from({ length: MAX_LEVEL }, (_, i) => i + 1).map((L) => {
                      const open = L <= G.unlocked;
                      return (
                        <Pressable
                          key={L}
                          disabled={!open}
                          onPress={() => start(L)}
                          style={[styles.lvl, !open && styles.lvlLocked]}
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
                </>
              ) : (
                <>
                  <Text style={styles.title}>
                    {G.status === 'won'
                      ? `LEVEL ${G.level} CLEAR`
                      : G.moves && G.placed >= G.moves
                      ? 'OUT OF MOVES'
                      : 'GAME OVER'}
                  </Text>
                  {G.status === 'won' && (
                    <Text style={styles.bigStars}>
                      {'★'.repeat(G.earned) + '☆'.repeat(3 - G.earned)}
                    </Text>
                  )}
                  <Text style={styles.overScore}>
                    {G.score} / {G.goal} pts  •  best chain x{G.maxChain}
                  </Text>
                  <Pressable
                    style={styles.play}
                    onPress={() => start(G.status === 'won' && G.level < MAX_LEVEL ? G.level + 1 : G.level)}
                  >
                    <Text style={styles.playTxt}>
                      {G.status === 'won' && G.level < MAX_LEVEL ? 'NEXT LEVEL' : 'RETRY'}
                    </Text>
                  </Pressable>
                  <Pressable onPress={() => { G.status = 'menu'; render(); }}>
                    <Text style={styles.hint}>LEVELS</Text>
                  </Pressable>
                </>
              )}
            </View>
          )}
        </View>
      </Animated.View>

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
  bar: { width: '90%', height: 6, backgroundColor: '#1a1a30', borderRadius: 3, marginBottom: 8, overflow: 'hidden' },
  barFill: { height: 6, backgroundColor: '#2bff88' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', width: '92%', marginTop: 14 },
  lvl: { width: 48, height: 56, margin: 4, borderRadius: 12, backgroundColor: '#1a1a30', borderWidth: 1, borderColor: '#2bff88', alignItems: 'center', justifyContent: 'center' },
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
