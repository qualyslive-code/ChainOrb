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
const NCOLORS = 4;
const MIN_GROUP = 4;
const COLORS = ['', '#ff3b6b', '#2bff88', '#3ba8ff', '#ffd23b'];
// child offset by orientation: 0 up, 1 right, 2 down, 3 left
const OFF = [[-1, 0], [0, 1], [1, 0], [0, -1]];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => 1 + Math.floor(Math.random() * NCOLORS);
const newPair = () => ({ a: rnd(), b: rnd() });
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
      if (!b[r][c] || seen[r][c]) continue;
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
  }).current;

  const [, setT] = useState(0);
  const render = useCallback(() => setT((t) => t + 1), []);
  const alive = useRef(true);
  const shake = useRef(new Animated.Value(0)).current;

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

  const start = () => {
    G.board = emptyBoard();
    G.score = 0;
    G.chain = 0;
    G.maxChain = 0;
    G.banner = '';
    G.popping = new Set();
    G.placed = 0;
    G.piece = spawn(G.next);
    G.next = newPair();
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
      G.popping = new Set(flat.map(([r, c]) => r * COLS + c));
      if (G.chain >= 2) G.banner = `x${G.chain} CHAIN`;
      render();
      buzz(G.chain);
      if (G.chain >= 3) doShake(Math.min(4 + G.chain * 2, 16));
      await sleep(260);
      G.score += flat.length * 10 * Math.pow(2, G.chain - 1);
      for (const [r, c] of flat) G.board[r][c] = 0;
      G.popping = new Set();
      render();
      await sleep(110);
    }
    if (!alive.current) return;
    G.maxChain = Math.max(G.maxChain, G.chain);
    setTimeout(() => {
      G.banner = '';
      render();
    }, 800);

    const p = spawn(G.next);
    if (!valid(G.board, p)) {
      gameOver();
      return;
    }
    G.piece = p;
    G.next = newPair();
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

  const speed = () => Math.max(110, 700 - Math.floor(G.placed / 8) * 45);

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
    Math.min(Math.floor((width - 24) / COLS), Math.floor((height - 330) / ROWS))
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
          <Text style={styles.small}>BEST {G.best}</Text>
        </View>
        <View style={{ alignItems: 'center' }}>
          <Text style={styles.label}>NEXT</Text>
          <Orb color={G.next.b} size={26} />
          <Orb color={G.next.a} size={26} />
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={styles.label}>BEST CHAIN</Text>
          <Text style={styles.score}>{G.maxChain}</Text>
        </View>
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

          {G.banner ? (
            <View style={styles.bannerWrap} pointerEvents="none">
              <Text style={styles.banner}>{G.banner}</Text>
            </View>
          ) : null}

          {(G.status === 'menu' || G.status === 'over') && (
            <View style={styles.overlay}>
              <Text style={styles.title}>
                {G.status === 'over' ? 'GAME OVER' : 'CHAINORB'}
              </Text>
              {G.status === 'over' && (
                <Text style={styles.overScore}>
                  {G.score} pts  •  best chain x{G.maxChain}
                </Text>
              )}
              <Pressable style={styles.play} onPress={start}>
                <Text style={styles.playTxt}>{G.status === 'over' ? 'RETRY' : 'PLAY'}</Text>
              </Pressable>
              <Text style={styles.hint}>Match 4+ to pop. Build chains.</Text>
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
  title: { color: '#fff', fontSize: 36, fontWeight: '900', letterSpacing: 4 },
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
