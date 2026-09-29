-- MODEL5: YNAB is gone; the card feed is Plaid's. Greenroom's stored YNAB
-- keys and sign-in tickets go with it (Devin also revokes Greenroom inside
-- YNAB). ynab_allowed stays: it is the list of accounts allowed to connect
-- cards, whatever the service.
delete from public.ynab_links;
delete from public.ynab_states;
drop table if exists public.ynab_links;
drop table if exists public.ynab_states;
