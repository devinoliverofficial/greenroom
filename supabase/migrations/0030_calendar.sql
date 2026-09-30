-- The calendar (Overview → View calendar). Days off get polls, show days get
-- special requests. Everyone on the tour sees all of it: every poll, every
-- vote with its name, every request.
--   * Polls: the tour manager and ALL ACCESS create, change or remove them.
--   * Votes: one per person per poll, changeable until the poll closes (noon
--     the day before the day off); the database refuses anything later.
--   * Requests: anyone on the tour asks; the tour manager and ALL ACCESS mark
--     them done; the asker (or they) can remove one.
-- Names are filled in by the database from the person's own card, so nobody
-- can vote or ask as someone else.

create table if not exists public.day_polls (
  tour_id text not null references public.tours (id) on delete cascade,
  date date not null,
  options jsonb not null default '[]'::jsonb,        -- [{ "id": "o1", "label": "Bowling" }]
  closes_at timestamptz not null,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (tour_id, date),
  check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) between 2 and 8)
);
alter table public.day_polls enable row level security;
drop policy if exists day_polls_select on public.day_polls;
drop policy if exists day_polls_write on public.day_polls;
create policy day_polls_select on public.day_polls for select using (public.my_role(tour_id) is not null);
create policy day_polls_write on public.day_polls for all
  using (public.my_role(tour_id) in ('owner', 'editor'))
  with check (public.my_role(tour_id) in ('owner', 'editor'));

create table if not exists public.day_votes (
  tour_id text not null,
  date date not null,
  user_id uuid not null default auth.uid(),
  choice text not null,
  name text not null default '',
  updated_at timestamptz not null default now(),
  primary key (tour_id, date, user_id),
  foreign key (tour_id, date) references public.day_polls (tour_id, date) on delete cascade
);
alter table public.day_votes enable row level security;

-- Open, and the choice is one of the poll's options.
create or replace function public.poll_takes(t_id text, d date, pick text)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from day_polls p
    where p.tour_id = t_id and p.date = d and now() < p.closes_at
      and p.options @> jsonb_build_array(jsonb_build_object('id', pick)))
$$;

drop policy if exists day_votes_select on public.day_votes;
drop policy if exists day_votes_insert on public.day_votes;
drop policy if exists day_votes_update on public.day_votes;
drop policy if exists day_votes_delete on public.day_votes;
create policy day_votes_select on public.day_votes for select using (public.my_role(tour_id) is not null);
create policy day_votes_insert on public.day_votes for insert
  with check (user_id = auth.uid() and public.my_role(tour_id) is not null and public.poll_takes(tour_id, date, choice));
create policy day_votes_update on public.day_votes for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.my_role(tour_id) is not null and public.poll_takes(tour_id, date, choice));
create policy day_votes_delete on public.day_votes for delete
  using (user_id = auth.uid() and public.poll_takes(tour_id, date, choice));

create table if not exists public.day_requests (
  id text primary key default gen_random_uuid()::text,
  tour_id text not null references public.tours (id) on delete cascade,
  date date not null,
  body text not null check (length(trim(body)) between 1 and 300),
  author text not null default '',
  added_by uuid not null default auth.uid(),
  done boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.day_requests enable row level security;
drop policy if exists day_requests_select on public.day_requests;
drop policy if exists day_requests_insert on public.day_requests;
drop policy if exists day_requests_update on public.day_requests;
drop policy if exists day_requests_delete on public.day_requests;
create policy day_requests_select on public.day_requests for select using (public.my_role(tour_id) is not null);
create policy day_requests_insert on public.day_requests for insert
  with check (added_by = auth.uid() and done = false and public.my_role(tour_id) is not null);
create policy day_requests_update on public.day_requests for update
  using (public.my_role(tour_id) in ('owner', 'editor'))
  with check (public.my_role(tour_id) in ('owner', 'editor'));
create policy day_requests_delete on public.day_requests for delete
  using (added_by = auth.uid() or public.my_role(tour_id) in ('owner', 'editor'));

-- The name on a vote or a request is the person's own, never typed in.
create or replace function public.stamp_name()
returns trigger
language plpgsql security definer set search_path = public as $$
declare who text;
begin
  select coalesce(nullif(trim(p.full_name), ''), nullif(trim(p.username), ''))
    into who from profiles p where p.user_id = auth.uid();
  who := coalesce(who, split_part(coalesce(auth.jwt() ->> 'email', ''), '@', 1), 'Someone');
  if tg_table_name = 'day_votes' then
    new.name := who; new.updated_at := now();
  else
    if tg_op = 'INSERT' then new.author := who; end if;
    if tg_op = 'UPDATE' then
      new.author := old.author; new.body := old.body; new.added_by := old.added_by;
      new.tour_id := old.tour_id; new.date := old.date; new.created_at := old.created_at;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists day_votes_name on public.day_votes;
create trigger day_votes_name before insert or update on public.day_votes
  for each row execute function public.stamp_name();
drop trigger if exists day_requests_name on public.day_requests;
create trigger day_requests_name before insert or update on public.day_requests
  for each row execute function public.stamp_name();

do $$ begin
  alter publication supabase_realtime add table public.day_polls;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.day_votes;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.day_requests;
exception when duplicate_object then null; end $$;
