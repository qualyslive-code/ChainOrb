create table if not exists public.level_events (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  pid text, level int, mode text, result text, attempt int, secs int,
  score int, max_chain int, placed int, v text, country text
);

create table if not exists public.daily_scores (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  day text not null, pid text not null, name text,
  score int, chain int, country text
);
create index if not exists daily_scores_day_score on public.daily_scores (day, score desc);

alter table public.level_events enable row level security;
alter table public.daily_scores enable row level security;

create policy "anon insert events" on public.level_events
  for insert to anon with check (true);
create policy "anon insert scores" on public.daily_scores
  for insert to anon with check (score between 0 and 10000000 and char_length(name) <= 20);
create policy "anon read scores" on public.daily_scores
  for select to anon using (true);

grant usage on schema public to anon;
grant insert on public.level_events to anon;
grant insert, select on public.daily_scores to anon;
