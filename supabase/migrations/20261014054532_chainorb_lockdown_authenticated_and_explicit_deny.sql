revoke execute on function public.submit_daily_score(text, text, text, int, int, text) from authenticated;
revoke execute on function public.get_daily_board(text, text, int) from authenticated;

create policy "no direct access" on public.daily_scores
  for all to anon, authenticated
  using (false) with check (false);
