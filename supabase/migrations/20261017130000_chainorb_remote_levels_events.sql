-- ChainOrb v23: server-controlled level overrides and live events.
-- Read-only for players (anon). Only the service role / SQL editor can write.
-- The client clamps every field, so a bad row can never crash the game; it is simply ignored.

create table if not exists public.chainorb_levels (
  n int primary key check (n between 1 and 100),
  cfg jsonb not null,
  note text,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.chainorb_events (
  id text primary key check (char_length(id) <= 40),
  title text not null check (char_length(title) <= 40),
  blurb text check (char_length(blurb) <= 80),
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  cfg jsonb not null,
  active boolean not null default true
);
create index if not exists chainorb_events_window on public.chainorb_events (starts_at, ends_at);

alter table public.chainorb_levels enable row level security;
alter table public.chainorb_events enable row level security;

create policy "anon read active levels" on public.chainorb_levels
  for select to anon using (active);
create policy "anon read active events" on public.chainorb_events
  for select to anon using (active and ends_at > now() - interval '1 day');

revoke all on public.chainorb_levels from anon, authenticated;
revoke all on public.chainorb_events from anon, authenticated;
grant select on public.chainorb_levels to anon;
grant select on public.chainorb_events to anon;

-- ---------------------------------------------------------------------------
-- cfg fields (same as the LEVELS table in App.js):
--   t: 'score' | 'chain' | 'rocks' | 'pairs'      g: goal (not used by 'rocks')
--   c: colors 3-5    s: speed ms per step 250-1500 (lower = faster)
--   m: move limit    rocks: random rocks 0-16     rain: a rock falls every N pairs
--   pre: preset rows, 6 chars each, '.'=empty 1-5=colors 6=rock 8=cracked rock
--   seq: scripted first pairs [[a,b],...]         coach: short hint text
--
-- Examples (uncomment and edit):
--
-- Rebalance level 14 without shipping an APK:
-- insert into public.chainorb_levels (n, cfg, note) values
--   (14, '{"t":"chain","g":3,"c":4,"s":640,"coach":"Reach a x3 chain"}', 'was too hard: x4 -> x3')
-- on conflict (n) do update set cfg = excluded.cfg, note = excluded.note, updated_at = now();
--
-- Weekend event (shows on the home screen while live; first clear = 2 eggs + 3 shards):
-- insert into public.chainorb_events (id, title, blurb, starts_at, ends_at, cfg) values
--   ('rockrain-2026-w43', 'ROCK RAIN WEEKEND', 'Survive the storm',
--    '2026-10-23 00:00+00', '2026-10-26 00:00+00',
--    '{"t":"pairs","g":34,"c":4,"s":600,"rain":2,"rocks":3,"coach":"Rocks everywhere. Stay calm"}');
--
-- Turn something off instantly:  update public.chainorb_levels set active = false where n = 14;
