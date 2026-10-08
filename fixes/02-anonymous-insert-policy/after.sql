-- AFTER: booking_leads insert policies (supabase-schema.sql).
-- Public form submissions may only create a fresh, untouched inquiry: no admin-only fields,
-- no back-dating, no "already notified" flag, and a size cap so the table can't be stuffed.

grant insert on public.booking_leads to anon, authenticated;

drop policy if exists "Public can create booking leads" on public.booking_leads;
create policy "Public can create booking leads"
on public.booking_leads
for insert
to anon
with check (
  status = 'New inquiry'
  and admin_notes = ''
  and quote_estimate = ''
  and last_contacted is null
  and next_follow_up is null
  and created_at > now() - interval '5 minutes'
  and created_at < now() + interval '5 minutes'
  and jsonb_typeof(lead_data) = 'object'
  and not (lead_data ? 'notifiedAt')
  and pg_column_size(lead_data) < 16384
);

-- The admin can still add leads manually from the CRM with any status.
-- (Admin email replaced with a placeholder for this public repo.)
drop policy if exists "Admin can create booking leads" on public.booking_leads;
create policy "Admin can create booking leads"
on public.booking_leads
for insert
to authenticated
with check ((auth.jwt() ->> 'email') = 'admin@example.com');
