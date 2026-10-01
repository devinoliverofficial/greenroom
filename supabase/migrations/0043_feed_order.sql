-- Card charges keep the order the bank sent them in: newest first, and
-- within a day the order the card's own app shows. Lower seq comes first;
-- a later read from the bank sits above an earlier one.
alter table public.feed_items add column if not exists seq bigint;

-- Charges already here: the order each batch was saved in is the order the
-- bank sent it.
update public.feed_items f set seq = s.rank
from (
  select id,
    (4000000000000 - (extract(epoch from created_at) * 1000)::bigint) * 1000
      + row_number() over (partition by owner_id, created_at order by ctid) as rank
  from public.feed_items
) s
where f.id = s.id and f.seq is null;
