-- Hierarchy SZV → NRV → Admin → Superadmin, sequential 5-character public IDs, escalation workflow.
-- Builds forward on 0001 (no data removed).

-- ---------- roles ----------
alter table public.verifiers drop constraint if exists verifiers_role_check;
alter table public.verifiers add constraint verifiers_role_check check (role in ('szv','nrv','admin','superadmin'));
alter table public.verifiers drop constraint if exists verifiers_check;
alter table public.verifiers add constraint verifiers_check check (role in ('admin','superadmin') or (role = 'szv' and state_iso is not null) or (role = 'nrv' and region_id is not null));

create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.verifiers where user_id = auth.uid() and role in ('admin','superadmin') and active)
$$;
create or replace function public.is_superadmin() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.verifiers where user_id = auth.uid() and role = 'superadmin' and active)
$$;
create or replace function public.enforce_verifier_state() returns trigger language plpgsql as $$
declare app_state text;
begin
  if new.role in ('admin','superadmin') then return new; end if;
  select state_iso into app_state from public.verifier_applications where id = new.application_id and status = 'accepted';
  if app_state is null then raise exception 'verifier needs an accepted application'; end if;
  if new.role = 'szv' and new.state_iso is distinct from app_state then
    raise exception 'SZV state (%) must match application state (%)', new.state_iso, app_state;
  end if;
  if new.role = 'nrv' and not exists (select 1 from public.region_states where region_id = new.region_id and state_iso = app_state) then
    raise exception 'NRV region % does not contain application state %', new.region_id, app_state;
  end if;
  return new;
end $$;

-- ---------- sequential 5-character public IDs: V0001…V9999, then base-36 (VA000…) ----------
create sequence if not exists public.verifier_public_seq start 1;
create or replace function public.to_public_id(n bigint) returns text language plpgsql immutable as $$
declare digits text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'; s text := ''; m bigint := n;
begin
  if n < 10000 then return 'V' || lpad(n::text, 4, '0'); end if;
  m := n - 10000 + 16796160;         -- 36^4 * 10 = 'A0000': continue in base 36 so IDs stay 5 chars (capacity ≈ 43.7M)
  while m > 0 loop s := substr(digits, (m % 36)::int + 1, 1) || s; m := m / 36; end loop;
  return s;
end $$;
alter table public.verifiers add column if not exists public_id text unique;
create or replace function public.assign_public_id() returns trigger language plpgsql as $$
begin
  if new.public_id is null then new.public_id := public.to_public_id(nextval('public.verifier_public_seq')); end if;
  return new;
end $$;
drop trigger if exists trg_public_id on public.verifiers;
create trigger trg_public_id before insert on public.verifiers for each row execute function public.assign_public_id();
update public.verifiers set public_id = public.to_public_id(nextval('public.verifier_public_seq')) where public_id is null;
alter table public.verifiers alter column public_id set not null;

-- who an SZV reports to: the NRVs of the region containing their state
create or replace view public.verifier_directory with (security_invoker = false) as
  select v.public_id, v.role, v.state_iso, coalesce(v.region_id, rs.region_id) as region_id, v.active
  from public.verifiers v left join public.region_states rs on rs.state_iso = v.state_iso;
revoke all on public.verifier_directory from anon;
grant select on public.verifier_directory to authenticated;

-- ---------- flags: escalation workflow ----------
alter table public.discrepancy_flags drop constraint if exists discrepancy_flags_status_check;
alter table public.discrepancy_flags add constraint discrepancy_flags_status_check
  check (status in ('open','nrv_review','escalated','investigating','ai_done','approved','rejected','dismissed'));
alter table public.discrepancy_flags add column if not exists raised_by_public_id text;
alter table public.discrepancy_flags add column if not exists nrv_findings text;
alter table public.discrepancy_flags add column if not exists nrv_public_id text;
create or replace function public.stamp_flag_raiser() returns trigger language plpgsql security definer set search_path = public as $$
begin
  select public_id into new.raised_by_public_id from public.verifiers where user_id = new.created_by;
  return new;
end $$;
drop trigger if exists trg_flag_raiser on public.discrepancy_flags;
create trigger trg_flag_raiser before insert on public.discrepancy_flags for each row execute function public.stamp_flag_raiser();

-- NRV may move open → nrv_review → escalated/dismissed and add findings for flags in their region;
-- admin may move to investigating/ai_done; ONLY superadmin may approve or reject (approval overwrites ledger data).
create or replace function public.guard_flag_update() returns trigger language plpgsql security definer set search_path = public as $$
declare me record;
begin
  -- server-side jobs (service role, migrations) carry no user JWT; every signed-in user is checked.
  -- (current_user is useless here: this function is SECURITY DEFINER.)
  if auth.uid() is null then return new; end if;
  select role, public_id, region_id into me from public.verifiers where user_id = auth.uid() and active;
  if me.role is null then raise exception 'not a verifier'; end if;
  if new.status in ('approved','rejected') and new.status is distinct from old.status and me.role <> 'superadmin' then
    raise exception 'only a superadmin can approve or reject a correction';
  end if;
  if me.role = 'nrv' then
    if new.status not in ('open','nrv_review','escalated','dismissed') then raise exception 'NRV can review, escalate or dismiss only'; end if;
    if not exists (select 1 from public.region_states where region_id = me.region_id and state_iso = old.state_iso) then raise exception 'flag outside NRV region'; end if;
    new.nrv_public_id := me.public_id;
  elsif me.role = 'szv' then
    raise exception 'SZV cannot change a flag after raising it';
  end if;
  if new.status in ('approved','rejected') and new.status is distinct from old.status then new.decided_by := auth.uid(); new.decided_at := now(); end if;
  return new;
end $$;

drop policy if exists "flags admin decides" on public.discrepancy_flags;
drop policy if exists "flags update by chain" on public.discrepancy_flags;
create policy "flags update by chain" on public.discrepancy_flags for update to authenticated
  using (state_iso in (select public.my_states()) and exists (select 1 from public.verifiers where user_id = auth.uid() and role in ('nrv','admin','superadmin')))
  with check (state_iso in (select public.my_states()));
grant update (status, ai_summary, proposed_tally, decision_note, nrv_findings) on public.discrepancy_flags to authenticated;

-- public-safe view: no account ids
create or replace view public.verifier_flags_public with (security_invoker = true) as
  select id, created_at, pu_code, race, state_iso, reason, status, raised_by_public_id, nrv_public_id, nrv_findings, ai_summary, decided_at
  from public.discrepancy_flags;
grant select on public.verifier_flags_public to authenticated;
revoke all on public.verifier_flags_public from anon;
