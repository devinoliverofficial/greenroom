-- A settled night can also carry its country (a Windsor, Ontario show that an
-- announcement filed under the United States).
alter table public.artist_night_overrides add column if not exists country_code text;
alter table public.artist_night_overrides add column if not exists country text;

create or replace function public.artist_night_overrides_apply(a_id uuid)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare n int := 0; k int;
begin
  delete from artist_history_shows h using artist_night_overrides o
   where h.artist_id = a_id and o.artist_id = a_id and o.gone and h.date = o.date;
  get diagnostics k = row_count; n := n + k;
  update artist_history_shows h
     set tour = coalesce(o.tour, h.tour), festival = coalesce(o.festival, h.festival),
         venue = coalesce(o.venue, h.venue), city = coalesce(o.city, h.city), state = coalesce(o.state, h.state),
         country_code = coalesce(o.country_code, h.country_code), country = coalesce(o.country, h.country),
         named_by = case when o.tour is not null and o.tour <> h.tour then null else h.named_by end
    from artist_night_overrides o
   where h.artist_id = a_id and o.artist_id = a_id and not o.gone and h.date = o.date
     and (coalesce(o.tour, h.tour), coalesce(o.festival, h.festival), coalesce(o.venue, h.venue), coalesce(o.city, h.city), coalesce(o.state, h.state),
          coalesce(o.country_code, h.country_code), coalesce(o.country, h.country))
         is distinct from (h.tour, h.festival, h.venue, h.city, h.state, h.country_code, h.country);
  get diagnostics k = row_count; n := n + k;
  return n;
end $$;
revoke all on function public.artist_night_overrides_apply(uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
