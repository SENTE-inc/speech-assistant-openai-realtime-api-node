-- =====================================================================
-- OPTIONAL hardening for /kick-call per-tenant concurrency (review finding #3)
-- =====================================================================
-- The application code in index.js already claims contacts race-safely with a
-- conditional UPDATE (未架電 -> 架電中 ... RETURNING). This RPC is a tighter,
-- single-round-trip alternative that uses FOR UPDATE SKIP LOCKED so concurrent
-- kicks never even contend on the same rows.
--
-- It is NOT required for the fix to be correct — apply it only if you want to
-- switch index.js over to a single atomic claim+order in the database.
--
-- To use from index.js (replacing the select-candidates + conditional-update
-- block in /kick-call):
--
--   const { data: claimed, error } = await supabase.rpc('claim_contacts', {
--       p_tenant_id: tenant_id,
--       p_limit: want,
--   });
--
-- Apply with: psql "$SUPABASE_DB_URL" -f scripts/sql/claim_contacts.sql
-- (or paste into the Supabase SQL editor).
-- =====================================================================

create or replace function public.claim_contacts(
    p_tenant_id uuid,
    p_limit integer
)
returns setof public.contacts
language plpgsql
security definer
set search_path = public
as $$
begin
    return query
    with picked as (
        select c.id
        from public.contacts c
        where c.tenant_id = p_tenant_id
          and c.status = '未架電'
          and c.phone_number is not null
          and c.phone_number <> ''
        order by c.priority asc nulls last, c.created_at asc
        limit greatest(p_limit, 0)
        for update skip locked
    )
    update public.contacts u
    set status = '架電中',
        last_called_at = now(),
        updated_at = now()
    from picked
    where u.id = picked.id
    returning u.*;
end;
$$;

-- Lock down: the service role calls this; revoke the broad default.
revoke all on function public.claim_contacts(uuid, integer) from public;
revoke all on function public.claim_contacts(uuid, integer) from anon;
revoke all on function public.claim_contacts(uuid, integer) from authenticated;
grant execute on function public.claim_contacts(uuid, integer) to service_role;
