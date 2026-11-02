-- 0011: the deletions the privacy notice promises (section 8), for the verifier database (session 63; docs/RETENTION.md).
-- Run every third day by the binchika-keepalive Worker through retention_purge(); service role only. Builds forward.

-- Flags must outlive the people who raised or decided them: they keep raised_by_public_id / nrv_public_id, and the link
-- to a deleted account becomes NULL instead of blocking the deletion.
alter table public.discrepancy_flags alter column created_by drop not null;
alter table public.discrepancy_flags drop constraint if exists discrepancy_flags_created_by_fkey;
alter table public.discrepancy_flags add constraint discrepancy_flags_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.discrepancy_flags drop constraint if exists discrepancy_flags_decided_by_fkey;
alter table public.discrepancy_flags add constraint discrepancy_flags_decided_by_fkey foreign key (decided_by) references auth.users(id) on delete set null;

-- retention_purge: dry run by default. It deletes
--  (a) applications that never became a seat, and accounts that claimed an invite but never pledged, once the
--      application period after INEC declares the final 2027 governorship results has passed (p_governorship_final;
--      NULL means "not declared yet", so nothing is deleted);
--  (b) former seat holders p_holder_months after their seat was released: pledge (typed name), application (name,
--      email, answers, voter-card hash) and the sign-in account (which removes the verifier row, MFA factors and
--      sessions). Their public ID stays only in the public seat history (seat_events) and on flags, as the notice says.
-- Never touched: active seats, the BinchikAdmin, the append-only seat history, flags (only their account link).
create or replace function public.retention_purge(
  p_now timestamptz default now(),
  p_governorship_final date default null,
  p_application_days int default 90,
  p_holder_months int default 12,
  p_dry_run boolean default true
) returns jsonb language plpgsql security definer set search_path = public, auth as $$
declare
  apps_due boolean;
  holder_cutoff timestamptz := p_now - make_interval(months => p_holder_months);
  app_ids uuid[] := '{}';
  v record;
  n_holders int := 0; n_unpledged int := 0; n_pledges int := 0; ids text[] := '{}';
begin
  if p_application_days is null or p_application_days < 30 then raise exception 'application retention must be at least 30 days'; end if;
  if p_holder_months is null or p_holder_months < 1 then raise exception 'seat-holder retention must be at least 1 month'; end if;
  apps_due := p_governorship_final is not null and p_now >= (p_governorship_final + make_interval(days => p_application_days));

  for v in
    select x.user_id, x.public_id, x.application_id, x.pledged_at,
           (select max(e.at) from public.seat_events e where e.public_id = x.public_id and e.event = 'released') as released_at
      from public.verifiers x
     where not x.active and x.role <> 'superadmin'
  loop
    if (v.released_at is not null and v.released_at <= holder_cutoff)
       or (v.released_at is null and v.pledged_at is null and apps_due) then
      if v.released_at is not null then n_holders := n_holders + 1; else n_unpledged := n_unpledged + 1; end if;
      ids := ids || v.public_id;
      n_pledges := n_pledges + (select count(*) from public.verifier_pledges p where p.public_id = v.public_id or p.user_id = v.user_id);
      if not p_dry_run then
        delete from public.verifier_pledges p where p.public_id = v.public_id or p.user_id = v.user_id;
        -- the account first (cascades to the verifier row, MFA factors and sessions), then the application it pointed at;
        -- the verifier row is never updated, so the state rules on it are not tripped
        delete from auth.users where id = v.user_id;
        if v.application_id is not null then delete from public.verifier_applications where id = v.application_id; end if;
      end if;
    end if;
  end loop;

  if apps_due then
    select coalesce(array_agg(a.id), '{}') into app_ids from public.verifier_applications a
     where not exists (select 1 from public.verifiers x where x.application_id = a.id);
    if not p_dry_run and cardinality(app_ids) > 0 then delete from public.verifier_applications where id = any(app_ids); end if;
  end if;

  return jsonb_build_object(
    'dry_run', p_dry_run, 'at', p_now, 'applications_due', apps_due,
    'applications', cardinality(app_ids), 'seat_holders', n_holders, 'unpledged_accounts', n_unpledged, 'pledges', n_pledges,
    'public_ids', to_jsonb(ids));
end $$;

revoke all on function public.retention_purge(timestamptz, date, int, int, boolean) from public, anon, authenticated;
grant execute on function public.retention_purge(timestamptz, date, int, int, boolean) to service_role;
