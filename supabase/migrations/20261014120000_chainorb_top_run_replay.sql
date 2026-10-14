-- Stores each player's best verified move log so the #1 run can be replayed.
-- Logs never leave the DB except through top_run(); direct table access stays denied.
create table if not exists public.daily_runs (
  day   text not null,
  pid   text not null,
  score int  not null,
  log   text not null,
  ts    timestamptz not null default now(),
  primary key (day, pid),
  constraint daily_runs_log_len check (char_length(log) between 1 and 30000)
);
alter table public.daily_runs enable row level security;
create policy "no direct access" on public.daily_runs
  for all to anon, authenticated using (false) with check (false);
revoke all on public.daily_runs from anon, authenticated;

create or replace function public.store_run(p_day text, p_pid text, p_score int, p_log text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_log is null or p_log !~ '^[LRcwdskh]+$' or char_length(p_log) > 30000 then raise exception 'invalid log'; end if;
  insert into public.daily_runs as r (day, pid, score, log)
  values (p_day, p_pid, p_score, p_log)
  on conflict (day, pid) do update
    set score = excluded.score, log = excluded.log, ts = now()
    where excluded.score > r.score;
end;
$$;
revoke all on function public.store_run(text, text, int, text) from public, anon, authenticated;
grant execute on function public.store_run(text, text, int, text) to service_role;

create or replace function public.top_run(p_day text)
returns table (name text, score int, chain int, log text)
language sql
stable
security definer
set search_path = ''
as $$
  select d.name, r.score, d.chain, r.log
  from public.daily_runs r
  join public.daily_scores d on d.day = r.day and d.pid = r.pid
  where r.day = p_day
  order by r.score desc
  limit 1;
$$;
revoke all on function public.top_run(text) from public;
grant execute on function public.top_run(text) to anon, authenticated;
