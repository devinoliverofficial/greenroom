-- The name the inviter typed: shown in the crew list before (and after)
-- the invitee ever signs in, and used as their starting username.
alter table public.members add column if not exists display_name text not null default '';
