-- 0009 (session 8): BinchikAdmin email lock, exactly three OpsAdmin seats, NRV / SZV / specific-seat invite codes,
-- seat emails locked for the whole tenure. Builds forward on 0003 (roles), 0004 (seats), 0007 (invites), 0008.
-- Display label: "BinchikAdmin" (role key stays 'superadmin'); OpsAdmin = role key 'admin'.

-- ---------- 1. the BinchikAdmin address lock ----------
-- Only the SHA-256 of the owner's lower-case address is stored, never the address itself. The lock row cannot be
-- edited or deleted, and only an account whose email hashes to it can ever hold the 'superadmin' role.
create table if not exists public.superadmin_lock (
  id boolean primary key default true check (id),
  email_sha256 text not null check (email_sha256 ~ '^[0-9a-f]{64}$'),
  locked_at timestamptz not null default now()
);
insert into public.superadmin_lock (id, email_sha256) values (true, '9387ed9432ec25ef93df84b8a0b9697ddef435a945e7f244670c4f79f88363e9')
on conflict (id) do nothing;
create or replace function public.superadmin_lock_ro() returns trigger language plpgsql as $$
begin raise exception 'the BinchikAdmin lock cannot be changed'; end $$;
drop trigger if exists trg_superadmin_lock_ro on public.superadmin_lock;
create trigger trg_superadmin_lock_ro before update or delete on public.superadmin_lock for each row execute function public.superadmin_lock_ro();
alter table public.superadmin_lock enable row level security;
revoke all on public.superadmin_lock from anon, authenticated;

create or replace function public.email_sha(p_email text) returns text language sql immutable as $$
  select encode(extensions.digest(lower(btrim(coalesce(p_email, ''))), 'sha256'), 'hex')
$$;
create or replace function public.is_locked_admin_email(p_email text) returns boolean language sql stable security definer set search_path = public as $$
  select p_email is not null and exists (select 1 from public.superadmin_lock l where l.email_sha256 = public.email_sha(p_email))
$$;

-- ---------- 2. exactly three OpsAdmin seats (appointed by the BinchikAdmin only; never by invite code) ----------
create table if not exists public.ops_seats (
  code text primary key check (code in ('OPS-1', 'OPS-2', 'OPS-3')),
  ordinal int not null unique check (ordinal between 1 and 3),
  label text not null
);
insert into public.ops_seats (code, ordinal, label) values ('OPS-1', 1, 'OpsAdmin seat 1'), ('OPS-2', 2, 'OpsAdmin seat 2'), ('OPS-3', 3, 'OpsAdmin seat 3')
on conflict (code) do nothing;
alter table public.ops_seats enable row level security;
drop policy if exists "read ops seats" on public.ops_seats;
create policy "read ops seats" on public.ops_seats for select using (true);
revoke insert, update, delete on public.ops_seats from anon, authenticated;
grant select on public.ops_seats to anon, authenticated;
alter table public.verifiers add column if not exists ops_seat text unique references public.ops_seats(code);
create unique index if not exists uq_one_superadmin on public.verifiers ((role)) where role = 'superadmin';

-- ---------- 3. identity guard: no role changes, no account swaps, the lock, OPS seats ----------
create or replace function public.guard_verifier_identity() returns trigger language plpgsql security definer set search_path = public, auth as $$
declare em text; locked boolean;
begin
  if tg_op = 'UPDATE' then
    if new.role is distinct from old.role then raise exception 'a verifier''s role can never change: release the seat and appoint again'; end if;
    if new.user_id is distinct from old.user_id then raise exception 'a seat''s account can never be swapped for another'; end if;
    if new.seat_code is not null and new.seat_code is distinct from old.seat_code then raise exception 'a seat is bound once, when it is claimed'; end if;
    if new.ops_seat is not null and new.ops_seat is distinct from old.ops_seat then raise exception 'an OpsAdmin seat is assigned once, at appointment'; end if;
  end if;
  select u.email into em from auth.users u where u.id = new.user_id;
  locked := public.is_locked_admin_email(em);
  if new.role = 'superadmin' and not locked then raise exception 'only the locked BinchikAdmin address can hold the BinchikAdmin seat'; end if;
  if new.role <> 'superadmin' and locked then raise exception 'the BinchikAdmin address cannot hold any other role or seat'; end if;
  if new.role = 'admin' and new.active and new.ops_seat is null then raise exception 'an active OpsAdmin must hold one of the three OPS seats'; end if;
  if new.ops_seat is not null and new.role <> 'admin' then raise exception 'OPS seats are for OpsAdmins only'; end if;
  return new;
end $$;
drop trigger if exists trg_verifier_identity on public.verifiers;
create trigger trg_verifier_identity before insert or update on public.verifiers for each row execute function public.guard_verifier_identity();

-- The email of any account bound to a seat (or the BinchikAdmin / an OpsAdmin) can never be changed, so no second
-- email is ever linked to a seat during its tenure. A released seat goes to a new person only by a fresh invite.
create or replace function public.guard_auth_email_change() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.email is distinct from old.email and (exists (select 1 from public.verifiers v where v.user_id = old.id) or public.is_locked_admin_email(old.email)) then
    raise exception 'this account''s email is locked to its seat and cannot be changed';
  end if;
  return new;
end $$;
drop trigger if exists trg_lock_seat_email on auth.users;
create trigger trg_lock_seat_email before update of email on auth.users for each row execute function public.guard_auth_email_change();

-- BinchikAdmin powers also need the locked address (defence in depth on top of the trigger).
create or replace function public.is_superadmin() returns boolean language sql stable security definer set search_path = public, auth as $$
  select public.mfa_ok() and exists (select 1 from public.verifiers v join auth.users u on u.id = v.user_id
    where v.user_id = auth.uid() and v.role = 'superadmin' and v.active and public.is_locked_admin_email(u.email))
$$;
create or replace function public.superadmin_actor(p_actor uuid) returns text language sql stable security definer set search_path = public, auth as $$
  select v.public_id from public.verifiers v join auth.users u on u.id = v.user_id
  where v.user_id = p_actor and v.role = 'superadmin' and v.active and public.is_locked_admin_email(u.email)
$$;

create or replace function public.guard_flag_update() returns trigger language plpgsql security definer set search_path = public as $$
declare me record;
begin
  if auth.uid() is null then return new; end if;
  select role, public_id, region_id into me from public.verifiers where user_id = auth.uid() and active;
  if me.role is null then raise exception 'not a verifier'; end if;
  if me.role in ('admin','superadmin') and not public.mfa_ok() then raise exception 'MFA required for admin actions'; end if;
  if new.status in ('approved','rejected') and new.status is distinct from old.status and not public.is_superadmin() then
    raise exception 'only the BinchikAdmin can approve or reject a correction';
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

-- ---------- 4. seat history covers OPS seats and appointments ----------
alter table public.seat_events drop constraint if exists seat_events_seat_code_fkey;
alter table public.seat_events drop constraint if exists seat_events_seat_code_check;
alter table public.seat_events add constraint seat_events_seat_code_check check (seat_code ~ '^(SZV-\d{3}|NRV-\d{2}|OPS-[1-3])$');
alter table public.seat_events drop constraint if exists seat_events_event_check;
alter table public.seat_events add constraint seat_events_event_check
  check (event in ('invited','claimed','pledged','released','invite_revoked','invite_expired','appointed'));

-- ---------- 5. pledge wording with the new label (a published version is never edited) ----------
insert into public.pledge_texts (version, body)
select 'P-2026-2', replace(body, 'the BinchikaAdmin may release', 'the BinchikAdmin may release') from public.pledge_texts where version = 'P-2026-1'
on conflict (version) do nothing;

-- ---------- 6. flexible invite codes ----------
-- kind 'seat': one exact seat (as before). kind 'szv' / 'nrv': the invitee picks any open seat of that type in the
-- area they applied for (an SZV only in their state, an NRV only in their state's region: constitution §4a).
alter table public.verifier_offers add column if not exists kind text not null default 'seat';
alter table public.verifier_offers drop constraint if exists verifier_offers_kind_check;
alter table public.verifier_offers add constraint verifier_offers_kind_check check (kind in ('seat','szv','nrv'));

create or replace function public.seat_is_open(p_seat text) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.verifier_seats s where s.code = p_seat)
     and not exists (select 1 from public.verifiers v where v.seat_code = p_seat)
     and not exists (select 1 from public.verifier_offers o where o.seat_code = p_seat and o.status in ('pending_send','sent','claimed'))
$$;
create or replace function public.area_name(p_role text, p_state text, p_region text) returns text language sql stable set search_path = public as $$
  select case when p_role = 'szv' then (select name from public.ng_states where iso = p_state) else (select name from public.verifier_regions where id = p_region) end
$$;
-- The seats an offer may claim: its one seat, or every seat of its type in the applicant's area (open or not).
create or replace function public.offer_seat_options(p_offer uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('code', s.code, 'label', s.label, 'open', public.seat_is_open(s.code) or coalesce(s.code = o.seat_code, false)) order by s.ordinal), '[]'::jsonb)
  from public.verifier_offers o
  join public.verifier_seats s on (o.kind = 'seat' and s.code = o.seat_code)
    or (o.kind <> 'seat' and s.role = o.kind and ((o.kind = 'szv' and s.state_iso = o.state_iso) or (o.kind = 'nrv' and s.region_id = o.region_id)))
  where o.id = p_offer
$$;

create or replace function public.invites_expire() returns int language plpgsql security definer set search_path = public as $$
declare o record; n int := 0;
begin
  for o in select * from public.verifier_offers
           where (seat_code is not null or kind <> 'seat') and ((status = 'sent' and expires_at < now()) or (status = 'claimed' and confirm_expires_at < now()))
           for update skip locked loop
    update public.verifier_offers set status = 'expired' where id = o.id;
    if o.status = 'claimed' then   -- unbind first: the verifier trigger still needs the accepted application
      update public.verifiers set seat_code = null where user_id = o.claimed_by and not active;
    end if;
    update public.verifier_applications set status = 'expired' where id = o.application_id and status in ('offered','accepted');
    if o.seat_code is not null then
      insert into public.seat_events (seat_code, event, reason) values (o.seat_code, 'invite_expired', case when o.status = 'claimed' then 'pledge not completed in time' else 'code not used in time' end);
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

drop function if exists public.invite_create(text, uuid, text, uuid, int);
create or replace function public.invite_create(p_seat text, p_application uuid, p_code_hash text, p_actor uuid, p_hours int default 24, p_kind text default 'seat')
returns table (offer_id uuid, email text, seat_code text, area text, expires_at timestamptz, kind text, open_seats int)
language plpgsql security definer set search_path = public as $$
declare s record; a record; actor text; oid uuid; exp timestamptz; reg text; nopen int;
begin
  perform public.invites_expire();
  actor := public.superadmin_actor(p_actor);
  if actor is null then raise exception 'only the BinchikAdmin can invite'; end if;
  if p_hours not in (24, 6) then raise exception 'window must be 24 or 6 hours'; end if;
  if p_kind not in ('seat','szv','nrv') then raise exception 'code type must be seat, szv or nrv'; end if;
  if coalesce(p_seat, '') like 'OPS-%' then raise exception 'OpsAdmin seats are appointed by the BinchikAdmin, never by invite code'; end if;
  select * into a from public.verifier_applications where id = p_application for update;
  if a.id is null or a.status <> 'eligible' then raise exception 'application is not eligible'; end if;
  if a.full_name is null then raise exception 'application has no full name'; end if;
  if public.is_locked_admin_email(a.email) then raise exception 'the BinchikAdmin address cannot be invited to a seat'; end if;
  exp := now() + make_interval(hours => p_hours);
  if p_kind = 'seat' then
    select * into s from public.verifier_seats where code = p_seat;
    if s.code is null then raise exception 'unknown seat'; end if;
    if exists (select 1 from public.verifiers v where v.seat_code = p_seat) then raise exception 'seat % is held', p_seat; end if;
    if exists (select 1 from public.verifier_offers o where o.seat_code = p_seat and o.status in ('pending_send','sent','claimed')) then raise exception 'seat % already has a live invite', p_seat; end if;
    if a.role_sought <> s.role then raise exception 'application is for %, seat is for %', a.role_sought, s.role; end if;
    if s.role = 'szv' and a.state_iso <> s.state_iso then raise exception 'applicant state does not match seat'; end if;
    if s.role = 'nrv' and not exists (select 1 from public.region_states rs where rs.region_id = s.region_id and rs.state_iso = a.state_iso) then raise exception 'applicant state is not in the seat''s region'; end if;
    insert into public.verifier_offers (application_id, state_iso, seat_code, role, region_id, wave, window_hours, code_hash, expires_at, status, created_by_public_id, kind)
      values (a.id, a.state_iso, s.code, s.role, s.region_id, case when p_hours = 6 then 2 else 1 end, p_hours, p_code_hash, exp, 'sent', actor, 'seat')
      returning id into oid;
    insert into public.seat_events (seat_code, event, actor_public_id) values (s.code, 'invited', actor);
    update public.verifier_applications set status = 'offered' where id = a.id;
    return query select oid, a.email, s.code, public.seat_area(s.code), exp, 'seat'::text, 1;
    return;
  end if;
  if a.role_sought <> p_kind then raise exception 'application is for %, the code type is %', a.role_sought, p_kind; end if;
  select rs.region_id into reg from public.region_states rs where rs.state_iso = a.state_iso limit 1;
  select count(*) into nopen from public.verifier_seats x
   where x.role = p_kind and ((p_kind = 'szv' and x.state_iso = a.state_iso) or (p_kind = 'nrv' and x.region_id = reg)) and public.seat_is_open(x.code);
  if nopen = 0 then raise exception 'no open % seats in the applicant''s area', upper(p_kind); end if;
  insert into public.verifier_offers (application_id, state_iso, seat_code, role, region_id, wave, window_hours, code_hash, expires_at, status, created_by_public_id, kind)
    values (a.id, a.state_iso, null, p_kind, reg, case when p_hours = 6 then 2 else 1 end, p_hours, p_code_hash, exp, 'sent', actor, p_kind)
    returning id into oid;
  update public.verifier_applications set status = 'offered' where id = a.id;
  return query select oid, a.email, null::text, public.area_name(p_kind, a.state_iso, reg), exp, p_kind, nopen;
end $$;

drop function if exists public.invite_check(text, text);
create or replace function public.invite_check(p_code_hash text, p_ip_hash text)
returns table (result text, seat_code text, role text, area text, expires_at timestamptz, kind text, seats jsonb) language plpgsql security definer set search_path = public as $$
declare o record;
begin
  perform public.invites_expire();
  delete from public.join_failures where at < now() - interval '1 day';
  if (select count(*) from public.join_failures f where f.ip_hash = p_ip_hash and f.at > now() - interval '15 minutes') >= 10 then
    return query select 'rate_limited'::text, null::text, null::text, null::text, null::timestamptz, null::text, null::jsonb; return;
  end if;
  select * into o from public.verifier_offers where code_hash = p_code_hash and status = 'sent' and verifier_offers.expires_at > now();
  if o.id is null then
    insert into public.join_failures (ip_hash) values (p_ip_hash);
    return query select 'invalid'::text, null::text, null::text, null::text, null::timestamptz, null::text, null::jsonb; return;
  end if;
  return query select 'ok'::text, o.seat_code, o.role,
    case when o.kind = 'seat' then public.seat_area(o.seat_code) else public.area_name(o.role, o.state_iso, o.region_id) end,
    o.expires_at, o.kind, public.offer_seat_options(o.id);
end $$;

drop function if exists public.invite_claim_check(text, text, text, text);
create or replace function public.invite_claim_check(p_code_hash text, p_email text, p_area text, p_ip_hash text, p_seat text default null)
returns table (result text, offer_id uuid, full_name text) language plpgsql security definer set search_path = public as $$
declare o record; a record; area_ok boolean; opt jsonb;
begin
  if (select count(*) from public.join_failures f where f.ip_hash = p_ip_hash and f.at > now() - interval '15 minutes') >= 10 then
    return query select 'rate_limited'::text, null::uuid, null::text; return;
  end if;
  select * into o from public.verifier_offers where code_hash = p_code_hash and status = 'sent' and expires_at > now() for update;
  if o.id is null then
    insert into public.join_failures (ip_hash) values (p_ip_hash);
    return query select 'invalid'::text, null::uuid, null::text; return;
  end if;
  select * into a from public.verifier_applications where id = o.application_id;
  area_ok := (o.role = 'szv' and p_area = o.state_iso) or (o.role = 'nrv' and p_area = o.region_id);
  if lower(btrim(p_email)) <> lower(btrim(a.email)) or not area_ok then
    update public.verifier_offers set attempts = attempts + 1, status = case when attempts + 1 >= 5 then 'revoked' else status end where id = o.id;
    if o.attempts + 1 >= 5 then
      if o.seat_code is not null then insert into public.seat_events (seat_code, event, reason) values (o.seat_code, 'invite_revoked', 'too many wrong attempts'); end if;
      update public.verifier_applications set status = 'eligible' where id = o.application_id and status = 'offered';
    end if;
    insert into public.join_failures (ip_hash) values (p_ip_hash);
    return query select (case when not area_ok then 'area_mismatch' else 'email_mismatch' end)::text, null::uuid, null::text; return;
  end if;
  if o.kind <> 'seat' then
    if p_seat is null then return query select 'seat_required'::text, null::uuid, null::text; return; end if;
    opt := public.offer_seat_options(o.id);
    if not exists (select 1 from jsonb_array_elements(opt) e where e ->> 'code' = p_seat and (e ->> 'open')::boolean) then
      return query select 'seat_unavailable'::text, null::uuid, null::text; return;
    end if;
  end if;
  return query select 'ok'::text, o.id, a.full_name;
end $$;

drop function if exists public.invite_claim_finish(uuid, uuid, text);
create or replace function public.invite_claim_finish(p_offer uuid, p_user uuid, p_confirm_hash text, p_seat text default null)
returns table (public_id text, seat_code text, area text) language plpgsql security definer set search_path = public as $$
declare o record; pid text; chosen text;
begin
  select * into o from public.verifier_offers where id = p_offer and status = 'sent' and expires_at > now() for update;
  if o.id is null then raise exception 'code already used or expired'; end if;
  if o.kind = 'seat' then chosen := o.seat_code;
  else
    perform 1 from public.verifier_seats where code = p_seat for update;   -- serialise two invitees picking one seat
    if p_seat is null or not exists (select 1 from jsonb_array_elements(public.offer_seat_options(o.id)) e where e ->> 'code' = p_seat and (e ->> 'open')::boolean) then
      raise exception 'seat_unavailable: that seat has just been taken';
    end if;
    chosen := p_seat;
  end if;
  update public.verifier_offers set status = 'claimed', seat_code = chosen, claimed_by = p_user, claimed_at = now(), confirm_hash = p_confirm_hash,
         confirm_expires_at = now() + interval '24 hours'
   where id = o.id;
  update public.verifier_applications set status = 'accepted' where id = o.application_id;
  insert into public.verifiers (user_id, application_id, role, state_iso, region_id, seat_code, display_name, active)
    values (p_user, o.application_id, o.role, case when o.role = 'szv' then o.state_iso end,
            case when o.role = 'nrv' then (select s.region_id from public.verifier_seats s where s.code = chosen) end, chosen, chosen, false)
    returning verifiers.public_id into pid;
  insert into public.seat_events (seat_code, event, public_id) values (chosen, 'claimed', pid);
  return query select pid, chosen, public.seat_area(chosen);
end $$;

-- BinchikAdmin revokes an unclaimed code (any kind). Claimed seats are released with seat_release instead.
create or replace function public.invite_revoke(p_offer uuid, p_actor uuid)
returns table (seat_code text, kind text) language plpgsql security definer set search_path = public as $$
declare actor text; o record;
begin
  actor := public.superadmin_actor(p_actor);
  if actor is null then raise exception 'only the BinchikAdmin can revoke a code'; end if;
  update public.verifier_offers set status = 'revoked' where id = p_offer and status = 'sent' returning * into o;
  if o.id is null then raise exception 'no unclaimed code with that id'; end if;
  update public.verifier_applications set status = 'eligible' where id = o.application_id and status = 'offered';
  if o.seat_code is not null then insert into public.seat_events (seat_code, event, actor_public_id, reason) values (o.seat_code, 'invite_revoked', actor, 'revoked by the BinchikAdmin'); end if;
  return query select o.seat_code, o.kind;
end $$;

create or replace function public.seat_release(p_seat text, p_reason text, p_actor uuid)
returns table (released_user uuid, public_id text) language plpgsql security definer set search_path = public as $$
declare actor text; v record; revoked int;
begin
  actor := public.superadmin_actor(p_actor);
  if actor is null then raise exception 'only the BinchikAdmin can release a seat'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 10 then raise exception 'a reason of at least 10 characters is required'; end if;
  if p_seat like 'OPS-%' then
    update public.verifiers set active = false, ops_seat = null where ops_seat = p_seat returning * into v;
    if v.user_id is null then raise exception 'seat % is not held', p_seat; end if;
    insert into public.seat_events (seat_code, event, public_id, actor_public_id, reason) values (p_seat, 'released', v.public_id, actor, btrim(p_reason));
    return query select v.user_id, v.public_id; return;
  end if;
  update public.verifier_offers set status = 'revoked' where verifier_offers.seat_code = p_seat and status in ('pending_send','sent','claimed');
  get diagnostics revoked = row_count;
  update public.verifiers set active = false, seat_code = null where verifiers.seat_code = p_seat returning * into v;
  if v.user_id is null and revoked = 0 then raise exception 'seat % is not held and has no live invite', p_seat; end if;
  if v.user_id is null then
    update public.verifier_applications set status = 'eligible' where id in (select application_id from public.verifier_offers where verifier_offers.seat_code = p_seat and status = 'revoked') and status = 'offered';
  else
    update public.verifier_applications set status = 'withdrawn' where id = v.application_id;
  end if;
  insert into public.seat_events (seat_code, event, public_id, actor_public_id, reason)
    values (p_seat, case when v.user_id is null then 'invite_revoked' else 'released' end, v.public_id, actor, btrim(p_reason));
  return query select v.user_id, v.public_id;
end $$;

-- ---------- 7. OpsAdmin appointment (BinchikAdmin only; the account is created by the API first) ----------
create or replace function public.ops_assign(p_seat text, p_user uuid, p_actor uuid)
returns table (public_id text, seat_code text) language plpgsql security definer set search_path = public, auth as $$
declare actor text; em text; pid text;
begin
  actor := public.superadmin_actor(p_actor);
  if actor is null then raise exception 'only the BinchikAdmin can appoint an OpsAdmin'; end if;
  perform 1 from public.ops_seats where code = p_seat for update;
  if not found then raise exception 'there are only three OpsAdmin seats: OPS-1, OPS-2 and OPS-3'; end if;
  if exists (select 1 from public.verifiers v where v.ops_seat = p_seat) then raise exception 'seat % is held', p_seat; end if;
  select u.email into em from auth.users u where u.id = p_user;
  if em is null then raise exception 'no such account'; end if;
  if public.is_locked_admin_email(em) then raise exception 'the BinchikAdmin cannot also be an OpsAdmin'; end if;
  if exists (select 1 from public.verifiers v where v.user_id = p_user) then raise exception 'that account already has (or had) a seat; use a new address'; end if;
  insert into public.verifiers (user_id, role, ops_seat, display_name, active) values (p_user, 'admin', p_seat, p_seat, true) returning verifiers.public_id into pid;
  insert into public.seat_events (seat_code, event, public_id, actor_public_id) values (p_seat, 'appointed', pid, actor);
  return query select pid, p_seat;
end $$;

revoke all on function public.invites_expire(), public.invite_create(text, uuid, text, uuid, int, text), public.invite_check(text, text),
  public.invite_claim_check(text, text, text, text, text), public.invite_claim_finish(uuid, uuid, text, text), public.invite_revoke(uuid, uuid),
  public.seat_release(text, text, uuid), public.ops_assign(text, uuid, uuid), public.superadmin_actor(uuid), public.offer_seat_options(uuid)
  from public, anon, authenticated;
grant execute on function public.invites_expire(), public.invite_create(text, uuid, text, uuid, int, text), public.invite_check(text, text),
  public.invite_claim_check(text, text, text, text, text), public.invite_claim_finish(uuid, uuid, text, text), public.invite_revoke(uuid, uuid),
  public.seat_release(text, text, uuid), public.ops_assign(text, uuid, uuid), public.superadmin_actor(uuid), public.offer_seat_options(uuid)
  to service_role;

-- ---------- 8. wipe the previous BinchikAdmin record and re-issue it to the locked address only ----------
-- Keeps the owner's Auth account (password and authenticator survive); only the seat record is replaced.
-- Runs once: skipped when the re-issued 'BinchikAdmin' record already exists.
do $$
declare uid uuid;
begin
  if exists (select 1 from public.verifiers where role = 'superadmin' and display_name = 'BinchikAdmin') then
    raise notice 'BinchikAdmin already re-issued: nothing to do'; return;
  end if;
  select u.id into uid from auth.users u where public.is_locked_admin_email(u.email);
  if uid is null then raise exception 'the locked BinchikAdmin account does not exist in Auth'; end if;
  delete from public.verifiers where role = 'superadmin';
  if not exists (select 1 from public.verifiers) then perform setval('public.verifier_public_seq', 1, false); end if;
  insert into public.verifiers (user_id, role, display_name, active) values (uid, 'superadmin', 'BinchikAdmin', true);
end $$;
