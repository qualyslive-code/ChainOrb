import { replay } from './engine.ts';

// Public by design: players have no accounts and the game uses a publishable (non-JWT) key.
// Nothing is trusted from the request: the move log is replayed server-side and the score is computed here.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'apikey, content-type, authorization, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
  if (Number(req.headers.get('content-length') || 0) > 40000) return json({ ok: false, error: 'too large' }, 413);

  let b: any;
  try {
    b = await req.json();
  } catch {
    return json({ ok: false, error: 'bad json' }, 400);
  }
  const { day, pid, name, country, log, ms } = b || {};
  if (typeof day !== 'string' || typeof pid !== 'string' || typeof log !== 'string') {
    return json({ ok: false, error: 'bad request' }, 400);
  }
  if (pid.length < 4 || pid.length > 40) return json({ ok: false, error: 'bad pid' }, 422);

  const r = replay(day, log);
  if (!r.ok) return json({ ok: false, error: r.error }, 422);
  // a human needs time to place pieces: reject logs that claim an impossible pace
  if (typeof ms !== 'number' || !isFinite(ms) || ms < r.placed * 250) return json({ ok: false, error: 'too fast' }, 422);

  const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/rest/v1/rpc/submit_verified_score`, {
    method: 'POST',
    headers: {
      apikey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_day: day,
      p_pid: pid,
      p_name: typeof name === 'string' ? name : '',
      p_score: r.score,
      p_chain: r.chain,
      p_placed: r.placed,
      p_country: typeof country === 'string' ? country : 'XX',
    }),
  });
  if (res.status >= 500) return json({ ok: false, error: 'db unavailable' }, 502);
  if (!res.ok) {
    const t = await res.text();
    let msg = 'rejected';
    try { msg = JSON.parse(t).message || msg; } catch { /* keep default */ }
    return json({ ok: false, error: String(msg).slice(0, 60) }, 422);
  }
  return json({ ok: true, score: r.score, chain: r.chain, placed: r.placed, won: r.won });
});
