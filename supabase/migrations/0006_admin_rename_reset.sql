-- 0006 (session 5): display rename SUPERADMIN → BinchikaAdmin, ADMIN → OpsAdmin. Role keys stay
-- 'superadmin' / 'admin', so RLS, guards and tests are unchanged.
--
-- One-off clean-up: earlier SQL test runs consumed public IDs V0001–V0059 (sequences are not transactional),
-- so the first real BinchikaAdmin was issued V0060. This clears V0060 and any legacy 'admin' rows, resets
-- the sequence, and re-issues the BinchikaAdmin to the same sign-in account as V0001.
-- The tests now restore the sequence themselves. Re-running this is a no-op once V0060 is gone.
do $$
declare uid uuid;
begin
  select user_id into uid from public.verifiers where public_id = 'V0060' and role = 'superadmin';
  if uid is null then raise notice 'V0060 not present: nothing to do'; return; end if;
  if exists (select 1 from public.discrepancy_flags where raised_by_public_id = 'V0060' or nrv_public_id = 'V0060') then
    raise exception 'V0060 is referenced by flags; refusing to clear it';
  end if;
  delete from public.verifiers where public_id = 'V0060';
  delete from public.verifiers where role = 'admin';            -- legacy ADMIN records (none expected before go-live)
  if exists (select 1 from public.verifiers) then
    raise exception 'other verifiers exist; refusing to reset the public-ID sequence';
  end if;
  perform setval('public.verifier_public_seq', 1, false);       -- next ID issued is V0001
  insert into public.verifiers (user_id, role, display_name, active) values (uid, 'superadmin', 'BinchikaAdmin', true);
end $$;

update public.verifiers set display_name = 'BinchikaAdmin' where role = 'superadmin' and display_name = 'Superadmin';
update public.verifiers set display_name = 'OpsAdmin' where role = 'admin' and display_name in ('Admin', 'Verifier');
