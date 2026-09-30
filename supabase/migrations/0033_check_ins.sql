-- Check In: at the top of the day sheet, each person confirms they've seen
-- that day's sheet. Once per person per day, only ever for yourself, and it
-- counts in Crew Stats as "Check In's".
alter table public.crew_stats add column if not exists day date;
alter table public.crew_stats drop constraint if exists crew_stats_stat_check;
alter table public.crew_stats add constraint crew_stats_stat_check
  check (stat in ('laminate', 'beer', 'late', 'bus', 'joint', 'checkin'));
create unique index if not exists crew_stats_checkin_once on public.crew_stats (tour_id, person, day) where stat = 'checkin';

-- Who you are on a tour: 'owner', or 'e:' + your invite email.
create or replace function public.my_person(t_id text)
returns text
language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from tours where id = t_id and owner_id = auth.uid()) then 'owner'
    else (select 'e:' || lower(m.invited_email) from members m
          where m.tour_id = t_id
            and (m.user_id = auth.uid() or lower(m.invited_email) = lower(coalesce(auth.jwt() ->> 'email', '')))
          limit 1)
  end
$$;

-- Adding stats: beers and joints by anyone, a check-in only for yourself,
-- the rest by the tour manager.
drop policy if exists crew_stats_insert on public.crew_stats;
create policy crew_stats_insert on public.crew_stats for insert with check (
  added_by = auth.uid() and public.tour_person_ok(tour_id, person) and (
    (stat in ('beer', 'joint') and public.my_role(tour_id) is not null)
    or (stat = 'checkin' and day is not null and person = public.my_person(tour_id))
    or (stat in ('laminate', 'late', 'bus') and public.my_role(tour_id) = 'owner')));

-- One tap: check yourself in for a day (a second tap changes nothing).
create or replace function public.check_in(t_id text, d date)
returns void
language plpgsql security definer set search_path = public as $$
declare me text := my_person(t_id);
begin
  if me is null then raise exception 'not_on_tour'; end if;
  insert into crew_stats (tour_id, person, stat, day, added_by) values (t_id, me, 'checkin', d, auth.uid())
  on conflict (tour_id, person, day) where stat = 'checkin' do nothing;
end $$;
revoke all on function public.check_in(text, date) from public, anon;
grant execute on function public.check_in(text, date) to authenticated;
