-- atVenu, read the way atVenu actually pays. A Settlement is one show; a Tour
-- Progress report is the tour so far and never belongs to a single night.
-- The card money lands on its own: atVenu Register deposits card sales less
-- processing fees two business days after each show, one deposit per show,
-- named "AV..." on the bank statement.
alter table public.merch_reports add column report_type text not null default 'unknown';  -- settlement | unknown
alter table public.merch_reports add column card_receipts numeric;
alter table public.merch_reports add column card_fee numeric;
alter table public.merch_deposits add column atvenu boolean not null default false;
