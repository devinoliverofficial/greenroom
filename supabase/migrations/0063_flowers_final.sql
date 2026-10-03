-- Giving flowers is final. Devin: "i dont think you should be able to take
-- back giving someone there flowers. when you give someone flowers it is
-- final." So the giver can't delete them any more. The person they went to
-- can still take them off their own page, as with endorsements.
drop policy if exists flowers_delete on public.flowers;
create policy flowers_delete on public.flowers for delete using (to_id = auth.uid());

notify pgrst, 'reload schema';
