-- MODEL5: every card feed is Plaid's now. New feed rows say so from the start.
alter table public.feed alter column source set default 'plaid';
