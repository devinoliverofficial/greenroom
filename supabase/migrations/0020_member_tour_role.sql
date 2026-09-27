-- The invite remembers the role the tour manager picked, so the crew list
-- can show it (green, beside the name) before the person has signed up.
alter table public.members add column if not exists tour_role text not null default '';
