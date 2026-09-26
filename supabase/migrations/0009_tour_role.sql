-- What someone does on the run (Guitar Tech, Merch, Family Member...). A
-- self-described job title on the contact card — NOT an access level; GA /
-- ALL ACCESS stay in members.role, set only by the tour manager.
alter table public.profiles add column if not exists tour_role text not null default '';
alter table public.profiles add column if not exists first_name text not null default '';
alter table public.profiles add column if not exists last_name text not null default '';
