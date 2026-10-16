# SESSION_NOTES (ChainOrb)

## v19 (2026-10-16) — mockup match + smooth movement
Source of truth: v18/App.js -> v19src/build.py (asserted single-match patches) -> v19/App.js.
Harness (Harness.mjs + engine.ts): 300/300 games match server replay. Engine slices untouched; all new hooks guarded by `G.fx`.

### Root causes of choppy movement in v18
1. Piece snapped to whole cells on move/rotate (no horizontal/rotation tween).
2. Every input called render() -> full Game re-render (HUD, glow flood-fill, JSX) on JS thread.
3. Fall = snap then 90ms tween (stop-start); hard drop locked instantly (no slam).
4. Swipe needed a full cell of travel per step; repeat 75ms via JS interval.
5. Board "punch" on every lock shrank board to 0.88.

### v19 fixes
- PieceLayer (Skia): pose in shared values (x,y,r). x/rot = critically-damped springs, rotation unwrapped angle (arc sweep), falls = one linear glide per gravity step, soft = 62ms linear, hard = ease-in slam.
- No render() on move/rotate/step. Ghost also UI-thread.
- lock(): board hides landed cells (G.slam) until picture lands (resolve awaits G.slamMs), then LandCell squash.
- Hold repeat 64ms (L/R), 56ms (down); swipe triggers at 0.55 cell; punch 0.972.
- Art: gradient glossy orbs w/ aura + sparkle eyes, Skia HUD/NEXT capsule/D-pad/TURN/DROP/UNDO, forest scene (realm 0 only), coach sparkles.

### Not verified (no device here)
On-device look/perf; Skia API props (Line derived p1/p2, DashPathEffect, Group clip path). If a red-screen: check those first.
Realms 1-3 still use old Scene art. NEXT shows 3 orbs (next pair + first of the pair after) to match mockup.
Soft-drop +1 score no longer ticks live in HUD (updates at lock).
