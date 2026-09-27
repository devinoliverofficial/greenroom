-- Invites to someone who already has an account link to it straight away,
-- so the crew list stops calling them Pending. Only a real account counts
-- (it has a password or has signed in); an invite's own placeholder account
-- waits until the person actually signs up.
create or replace function public.link_invite(t_id text, addr text)
returns void language sql security definer set search_path = public, auth as $$
  update public.members m
     set user_id = u.id
    from auth.users u
   where m.tour_id = t_id
     and m.user_id is null
     and lower(m.invited_email) = lower(addr)
     and lower(u.email) = lower(addr)
     and (coalesce(u.encrypted_password, '') <> '' or u.last_sign_in_at is not null);
$$;
revoke all on function public.link_invite(text, text) from public, anon, authenticated;
grant execute on function public.link_invite(text, text) to service_role;

-- The same, once, for invites already sitting unlinked.
update public.members m
   set user_id = u.id
  from auth.users u
 where m.user_id is null
   and lower(u.email) = lower(m.invited_email)
   and (coalesce(u.encrypted_password, '') <> '' or u.last_sign_in_at is not null);

-- Past crew remember their role on the tour, for the next tour's invite.
alter table public.past_crew add column if not exists tour_role text not null default '';
