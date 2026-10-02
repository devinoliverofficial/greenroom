-- Search rows read like a social app's: under the username, the person's
-- name and either "Following" or how many followers they have. So people
-- found by search now carry those two facts as well.
create or replace function public.find_people(q text)
returns jsonb
language sql stable security definer set search_path = public as $$
  with term as (select replace(replace(lower(trim(both '@ ' from coalesce(q, ''))), '%', ''), '_', '\_') as t)
  select coalesce(jsonb_agg(jsonb_build_object(
      'userId', x.user_id, 'name', x.name, 'handle', coalesce(x.handle, ''), 'avatar', coalesce(x.avatar, ''),
      'roles', to_jsonb(coalesce(x.roles, '{}'::text[])), 'tourRole', coalesce(x.tour_role, ''),
      'canOpen', public.can_see_profile(x.user_id),
      'iFollow', exists (select 1 from follows f where f.follower_id = auth.uid() and f.followee_id = x.user_id),
      'followers', (select count(*) from follows f where f.followee_id = x.user_id),
      'verified', exists (select 1 from verified_users v where v.user_id = x.user_id))
    order by x.rank, x.name), '[]'::jsonb)
  from (
    select p.user_id, p.handle, p.avatar, p.tour_role, p.roles,
           coalesce(nullif(trim(p.full_name), ''), nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), '') as name,
           case when p.handle = term.t then 0 when p.handle like term.t || '%' then 1 else 2 end as rank
      from profiles p, term
     where auth.uid() is not null and char_length(term.t) >= 2
       and (p.handle like term.t || '%'
            or (public.can_see_profile(p.user_id) and lower(p.full_name) like '%' || term.t || '%'))
     order by rank, name limit 12
  ) x
$$;
