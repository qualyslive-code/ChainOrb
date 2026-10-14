drop function if exists public.submit_daily_score(text, text, text, int, int, text);

alter table public.daily_scores add column if not exists placed int;
alter table public.daily_scores add constraint daily_scores_placed_rng check (placed between 0 and 40);

create or replace function public.submit_verified_score(
  p_day text, p_pid text, p_name text, p_score int, p_chain int, p_placed int, p_country text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
  v_cc   text;
begin
  if p_day is null or p_day !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'invalid day'; end if;
  if abs(p_day::date - (now() at time zone 'utc')::date) > 1 then raise exception 'invalid day'; end if;
  if p_pid is null or char_length(p_pid) not between 4 and 40 then raise exception 'invalid pid'; end if;
  if p_score is null or p_score < 0 or p_score > 10000000 then raise exception 'invalid score'; end if;

  if exists (select 1 from public.daily_scores where day = p_day and pid = p_pid and ts > now() - interval '5 seconds') then
    raise exception 'too fast';
  end if;

  v_name := left(btrim(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]', '', 'g')), 20);
  if v_name = '' then v_name := 'Orb'; end if;
  v_cc := upper(coalesce(p_country, 'XX'));
  if v_cc !~ '^[A-Z]{2}$' then v_cc := 'XX'; end if;

  insert into public.daily_scores as d (day, pid, name, score, chain, placed, country)
  values (p_day, p_pid, v_name, p_score, least(greatest(coalesce(p_chain, 0), 0), 100), p_placed, v_cc)
  on conflict (day, pid) do update
    set name    = excluded.name,
        score   = greatest(d.score, excluded.score),
        chain   = case when excluded.score > d.score then excluded.chain else d.chain end,
        placed  = case when excluded.score > d.score then excluded.placed else d.placed end,
        country = excluded.country,
        ts      = now();
end;
$$;

revoke all on function public.submit_verified_score(text, text, text, int, int, int, text) from public, anon, authenticated;
grant execute on function public.submit_verified_score(text, text, text, int, int, int, text) to service_role;
