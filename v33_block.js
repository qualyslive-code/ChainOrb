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

