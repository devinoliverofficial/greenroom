-- Off Tour: each band's book of expenses between tours. It rides the tours
-- table as a tour of its own (doc.kind = 'offtour', doc.artist = the band),
-- so it gets the same expense screens, card feed and money rules. The
-- tour's owner runs it; ALL ACCESS on any of that band's live tours can see
-- it (as 'editor'); GA never does.
create or replace function public.my_role(t_id text)
returns text
language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from tours where id = t_id and owner_id = auth.uid())
      then 'owner'
    else coalesce(
      (select m.role from members m
        where m.tour_id = t_id
          and (m.user_id = auth.uid()
               or lower(m.invited_email) = lower(coalesce(auth.jwt() ->> 'email', '')))
        limit 1),
      (select 'editor' from tours o
        where o.id = t_id and o.doc ->> 'kind' = 'offtour'
          and exists (
            select 1 from tours t join members m on m.tour_id = t.id
             where t.owner_id = o.owner_id and t.id <> o.id
               and not (t.doc ? 'deletedAt')
               and lower(trim(coalesce(t.doc ->> 'artist', ''))) = lower(trim(coalesce(o.doc ->> 'artist', '')))
               and m.role = 'editor'
               and (m.user_id = auth.uid()
                    or lower(m.invited_email) = lower(coalesce(auth.jwt() ->> 'email', ''))))
        limit 1)
    )
  end
$$;

-- The tour manager (ALL ACCESS + Tour Manager) of any of the band's tours is a
-- money lead on its Off Tour book too, so they can answer Ari and sort charges.
create or replace function public.money_lead(t_id text)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from tours where id = t_id and owner_id = auth.uid())
      or exists (
        select 1 from tours x
          join tours t on t.owner_id = x.owner_id
           and (t.id = x.id or (x.doc ->> 'kind' = 'offtour' and not (t.doc ? 'deletedAt')
             and lower(trim(coalesce(t.doc ->> 'artist', ''))) = lower(trim(coalesce(x.doc ->> 'artist', '')))))
          join members m on m.tour_id = t.id
          left join profiles p on p.user_id = m.user_id
         where x.id = t_id and m.user_id = auth.uid() and m.role = 'editor'
           and lower(trim(coalesce(nullif(m.overrides ->> 'tourRole', ''), nullif(p.tour_role, ''), m.tour_role, ''))) = 'tour manager')
$$;
