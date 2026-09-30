-- Crew Stats: the fun side of the tour. Everyone on the tour sees it all.
--   * Beers and joints: anyone on the tour adds one (and can take back their own).
--   * Laminates lost, late to soundcheck, bus cleans: the tour manager only.
--   * The game ball: voted on after the first show, then once a week. Ari
--     opens each round and closes it at noon the next day; the winner holds
--     the ball until the next one. A tie goes to the tour manager to call.
-- A person is 'owner' (the tour manager) or 'e:' + their invite email.

create or replace function public.tour_person_ok(t_id text, p text)
returns boolean
language sql stable security definer set search_path = public as $$
  select p = 'owner' or exists (select 1 from members m where m.tour_id = t_id and 'e:' || lower(m.invited_email) = p)
$$;

create table if not exists public.crew_stats (
  id text primary key default gen_random_uuid()::text,
  tour_id text not null references public.tours (id) on delete cascade,
  person text not null,
  stat text not null check (stat in ('laminate', 'beer', 'late', 'bus', 'joint')),
  added_by uuid not null default auth.uid(),
  created_at timestamptz not null default now()
);
alter table public.crew_stats enable row level security;
drop policy if exists crew_stats_select on public.crew_stats;
drop policy if exists crew_stats_insert on public.crew_stats;
drop policy if exists crew_stats_delete on public.crew_stats;
create policy crew_stats_select on public.crew_stats for select using (public.my_role(tour_id) is not null);
create policy crew_stats_insert on public.crew_stats for insert with check (
  added_by = auth.uid() and public.tour_person_ok(tour_id, person) and (
    (stat in ('beer', 'joint') and public.my_role(tour_id) is not null) or public.my_role(tour_id) = 'owner'));
create policy crew_stats_delete on public.crew_stats for delete using (
  public.my_role(tour_id) = 'owner' or (added_by = auth.uid() and stat in ('beer', 'joint')));

create table if not exists public.game_ball_rounds (
  tour_id text not null references public.tours (id) on delete cascade,
  round date not null,
  opens_at timestamptz not null default now(),
  closes_at timestamptz not null,
  status text not null default 'open' check (status in ('open', 'won', 'tie')),
  winner text,
  winner_reason text,
  primary key (tour_id, round)
);
alter table public.game_ball_rounds enable row level security;
drop policy if exists game_ball_rounds_select on public.game_ball_rounds;
drop policy if exists game_ball_rounds_update on public.game_ball_rounds;
create policy game_ball_rounds_select on public.game_ball_rounds for select using (public.my_role(tour_id) is not null);
-- Rounds are opened and closed by Ari; the tour manager only ever calls a tie.
create policy game_ball_rounds_update on public.game_ball_rounds for update
  using (public.my_role(tour_id) = 'owner' and status = 'tie')
  with check (public.my_role(tour_id) = 'owner' and status = 'won' and public.tour_person_ok(tour_id, winner));

create table if not exists public.game_ball_votes (
  tour_id text not null,
  round date not null,
  voter uuid not null default auth.uid(),
  person text not null,
  reason text not null check (length(trim(reason)) between 1 and 200),
  voter_name text not null default '',
  updated_at timestamptz not null default now(),
  primary key (tour_id, round, voter),
  foreign key (tour_id, round) references public.game_ball_rounds (tour_id, round) on delete cascade
);
alter table public.game_ball_votes enable row level security;

create or replace function public.game_ball_open(t_id text, r date)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from game_ball_rounds g
    where g.tour_id = t_id and g.round = r and g.status = 'open' and now() >= g.opens_at and now() < g.closes_at)
$$;

drop policy if exists game_ball_votes_select on public.game_ball_votes;
drop policy if exists game_ball_votes_insert on public.game_ball_votes;
drop policy if exists game_ball_votes_update on public.game_ball_votes;
create policy game_ball_votes_select on public.game_ball_votes for select using (public.my_role(tour_id) is not null);
create policy game_ball_votes_insert on public.game_ball_votes for insert with check (
  voter = auth.uid() and public.my_role(tour_id) is not null
  and public.game_ball_open(tour_id, round) and public.tour_person_ok(tour_id, person));
create policy game_ball_votes_update on public.game_ball_votes for update using (voter = auth.uid()) with check (
  voter = auth.uid() and public.my_role(tour_id) is not null
  and public.game_ball_open(tour_id, round) and public.tour_person_ok(tour_id, person));

-- The voter's own name, never typed in.
create or replace function public.stamp_voter()
returns trigger
language plpgsql security definer set search_path = public as $$
declare who text;
begin
  select coalesce(nullif(trim(p.full_name), ''), nullif(trim(p.username), ''))
    into who from profiles p where p.user_id = auth.uid();
  new.voter_name := coalesce(who, split_part(coalesce(auth.jwt() ->> 'email', ''), '@', 1), 'Someone');
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists game_ball_votes_name on public.game_ball_votes;
create trigger game_ball_votes_name before insert or update on public.game_ball_votes
  for each row execute function public.stamp_voter();

do $$ begin alter publication supabase_realtime add table public.crew_stats;
exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.game_ball_rounds;
exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.game_ball_votes;
exception when duplicate_object then null; end $$;
