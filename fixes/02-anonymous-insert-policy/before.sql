-- BEFORE: booking_leads insert policy (supabase-schema.sql).
-- Any visitor (anon) or any signed-in user could insert a row with ANY column values:
-- a fake status, admin notes, back-dated created_at, a pre-set notifiedAt flag
-- (which silently suppresses the owner's notification email), or a multi-megabyte payload.

grant insert on public.booking_leads to anon, authenticated;

drop policy if exists "Public can create booking leads" on public.booking_leads;
create policy "Public can create booking leads"
on public.booking_leads
for insert
to anon, authenticated
with check (true);
