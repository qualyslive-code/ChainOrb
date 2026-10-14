alter table public.daily_scores
  alter column name set default 'Orb',
  alter column name set not null,
  alter column score set default 0,
  alter column score set not null,
  alter column chain set default 0,
  alter column chain set not null,
  alter column country set default 'XX',
  alter column country set not null;

alter table public.daily_scores
  add constraint daily_scores_day_fmt   check (day ~ '^\d{4}-\d{2}-\d{2}$'),
  add constraint daily_scores_pid_len   check (char_length(pid) between 4 and 40),
  add constraint daily_scores_name_len  check (char_length(name) between 1 and 20),
  add constraint daily_scores_score_rng check (score between 0 and 10000000),
  add constraint daily_scores_chain_rng check (chain between 0 and 100),
  add constraint daily_scores_cc_fmt    check (country ~ '^[A-Z]{2}$'),
  add constraint daily_scores_day_pid_uq unique (day, pid);

alter table public.level_events
  alter column pid set not null;

alter table public.level_events
  add constraint level_events_pid_len    check (char_length(pid) between 4 and 40),
  add constraint level_events_level_rng  check (level between 0 and 10000),
  add constraint level_events_mode_len   check (char_length(mode) <= 16),
  add constraint level_events_result_len check (char_length(result) <= 16),
  add constraint level_events_attempt_rng check (attempt between 0 and 10000),
  add constraint level_events_secs_rng   check (secs between 0 and 86400),
  add constraint level_events_score_rng  check (score between 0 and 10000000),
  add constraint level_events_chain_rng  check (max_chain between 0 and 100),
  add constraint level_events_placed_rng check (placed between 0 and 100000),
  add constraint level_events_v_len      check (char_length(v) <= 16),
  add constraint level_events_cc_len     check (char_length(country) <= 2);

create index if not exists level_events_ts_idx on public.level_events (ts desc);

alter table public.daily_scores enable row level security;
alter table public.level_events enable row level security;

drop policy if exists "anon read scores"   on public.daily_scores;
drop policy if exists "anon insert scores" on public.daily_scores;

drop policy if exists "anon insert events" on public.level_events;
create policy "anon insert events" on public.level_events
  for insert to anon
  with check (pid is not null and char_length(pid) between 4 and 40);

revoke all on public.daily_scores from anon, authenticated;
revoke all on public.level_events from anon, authenticated;
grant insert on public.level_events to anon;

create or replace function public.submit_daily_score(
  p_day text, p_pid text, p_name text, p_score int, p_chain int, p_country text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
  v_cc   text;
begin
  if p_day is null or p_day !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'invalid day';
  end if;
  if abs(p_day::date - (now() at time zone 'utc')::date) > 1 then
    raise exception 'invalid day';
  end if;
  if p_pid is null or char_length(p_pid) not between 4 and 40 then
    raise exception 'invalid pid';
  end if;
  if p_score is null or p_score < 0 or p_score > 10000000 then
    raise exception 'invalid score';
  end if;

  v_name := left(btrim(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]', '', 'g')), 20);
  if v_name = '' then v_name := 'Orb'; end if;
  v_cc := upper(coalesce(p_country, 'XX'));
  if v_cc !~ '^[A-Z]{2}$' then v_cc := 'XX'; end if;

  insert into public.daily_scores as d (day, pid, name, score, chain, country)
  values (p_day, p_pid, v_name, p_score, least(greatest(coalesce(p_chain, 0), 0), 100), v_cc)
  on conflict (day, pid) do update
    set name    = excluded.name,
        score   = greatest(d.score, excluded.score),
        chain   = greatest(d.chain, excluded.chain),
        country = excluded.country,
        ts      = now();
end;
$$;

create or replace function public.get_daily_board(
  p_day text, p_pid text default null, p_limit int default 40
) returns table (pos int, name text, score int, chain int, country text, is_me boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select (row_number() over (order by d.score desc, d.ts asc))::int as pos,
         d.name, d.score, d.chain, d.country,
         coalesce(d.pid = p_pid, false) as is_me
  from public.daily_scores d
  where d.day = p_day
  order by d.score desc, d.ts asc
  limit least(greatest(coalesce(p_limit, 40), 1), 100);
$$;

revoke all on function public.submit_daily_score(text, text, text, int, int, text) from public;
revoke all on function public.get_daily_board(text, text, int) from public;
grant execute on function public.submit_daily_score(text, text, text, int, int, text) to anon, authenticated;
grant execute on function public.get_daily_board(text, text, int) to anon, authenticated;
