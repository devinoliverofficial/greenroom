-- Polls are the tour manager's: the creator, or the member whose tour role
-- is Tour Manager (money_lead). Everyone else, ALL ACCESS included, votes.
drop policy if exists day_polls_write on public.day_polls;
create policy day_polls_write on public.day_polls for all
  using (public.money_lead(tour_id))
  with check (public.money_lead(tour_id));

-- The card feed reads the bank's order fresh once, so every waiting charge
-- sits where the card's own app shows it (a charge whose date was corrected
-- after it arrived had lost its place). Set when that read is done.
alter table public.feed add column if not exists ordered_at timestamptz;
