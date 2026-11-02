-- 0007 (session 6): seat invite codes, typed-name pledge, append-only seat history, MFA for admins.
-- Design: docs/protocol/INVITE-FLOW.md. Builds forward on 0001 (offers), 0003 (hierarchy), 0004 (seats).
-- Every state change runs through SECURITY DEFINER functions that only the service role may execute;
-- Pages Functions do the hashing, Auth admin calls and emails around them.
create extension if not exists unaccent with schema extensions;

-- ---------- MFA: admin powers need an aal2 (TOTP-verified) session ----------
create or replace function public.mfa_ok() returns boolean language sql stable as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
$$;
create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select public.mfa_ok() and exists (select 1 from public.verifiers where user_id = auth.uid() and role in ('admin','superadmin') and active)
$$;
create or replace function public.is_superadmin() returns boolean language sql stable security definer set search_path = public as $$
  select public.mfa_ok() and exists (select 1 from public.verifiers where user_id = auth.uid() and role = 'superadmin' and active)
$$;
create or replace function public.guard_flag_update() returns trigger language plpgsql security definer set search_path = public as $$
declare me record;
begin
  if auth.uid() is null then return new; end if;
  select role, public_id, region_id into me from public.verifiers where user_id = auth.uid() and active;
  if me.role is null then raise exception 'not a verifier'; end if;
  if me.role in ('admin','superadmin') and not public.mfa_ok() then raise exception 'MFA required for admin actions'; end if;
  if new.status in ('approved','rejected') and new.status is distinct from old.status and me.role <> 'superadmin' then
    raise exception 'only the BinchikaAdmin can approve or reject a correction';
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

-- ---------- applications: full name (private; only used to match the pledge) ----------
alter table public.verifier_applications add column if not exists full_name text;
alter table public.verifier_applications drop constraint if exists verifier_applications_full_name_check;
alter table public.verifier_applications add constraint verifier_applications_full_name_check
  check (full_name is null or length(btrim(full_name)) between 3 and 120);

-- ---------- offers become seat invites ----------
alter table public.verifier_offers alter column state_iso drop not null;
alter table public.verifier_offers add column if not exists seat_code text references public.verifier_seats(code);
alter table public.verifier_offers add column if not exists role text check (role in ('szv','nrv'));
alter table public.verifier_offers add column if not exists region_id text references public.verifier_regions(id);
alter table public.verifier_offers add column if not exists attempts int not null default 0;
alter table public.verifier_offers add column if not exists claimed_by uuid references auth.users(id) on delete set null;
alter table public.verifier_offers add column if not exists claimed_at timestamptz;
alter table public.verifier_offers add column if not exists confirm_hash text;
alter table public.verifier_offers add column if not exists confirm_expires_at timestamptz;
alter table public.verifier_offers add column if not exists created_by_public_id text;
alter table public.verifier_offers drop constraint if exists verifier_offers_status_check;
alter table public.verifier_offers add constraint verifier_offers_status_check
  check (status in ('pending_send','sent','claimed','accepted','expired','declined','revoked'));
create unique index if not exists uq_offer_code on public.verifier_offers (code_hash) where code_hash is not null;
create unique index if not exists uq_offer_confirm on public.verifier_offers (confirm_hash) where confirm_hash is not null;
create unique index if not exists uq_offer_live_seat on public.verifier_offers (seat_code) where status in ('pending_send','sent','claimed');

alter table public.verifiers add column if not exists pledged_at timestamptz;

-- ---------- pledge texts (versioned; the exact wording each person signed) ----------
create table if not exists public.pledge_texts (
  version text primary key,
  body text not null,
  sha256 text generated always as (encode(extensions.digest(body, 'sha256'), 'hex')) stored,
  published_at timestamptz not null default now()
);
insert into public.pledge_texts (version, body) values ('P-2026-1', $p$I accept seat {SEAT} as a volunteer verifier for {AREA}.

1. Neutrality. I am not a member, official, candidate, agent or employee of any political party or campaign, and I will not act for one while I hold this seat.
2. No reward. I will take no payment, gift or favour for this work, and I will report at once any offer, threat or pressure meant to influence it.
3. Flag, never edit. I will raise flags only with evidence that someone else can check. I will never try to alter a result, a photo or the ledger.
4. My area only. I will act only for the state or region of my seat.
5. Anonymity. I will use only my seat number and public ID in meetings and messages. I will not share any verifier's identity, including my own, and I will not share a phone number on Binchika channels.
6. Confidentiality. I will keep reporters' data, unpublished flags and internal discussions private, and use them only for verifying.
7. INEC declares. I will never present Binchika's work as an official result or declare a winner.
8. Stepping down. If I can no longer meet this pledge, I will tell Binchika and give up my seat. I accept that the BinchikaAdmin may release my seat if I break it.$p$)
on conflict (version) do nothing;   -- a published version is never edited; new wording = new version

create table if not exists public.verifier_pledges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  seat_code text not null,
  public_id text not null,
  pledge_version text not null references public.pledge_texts(version),
  pledge_sha256 text not null,
  typed_name text not null check (length(btrim(typed_name)) between 3 and 120),
  signed_at timestamptz not null default now()
);

-- ---------- seat history: append-only; the public view has no reasons ----------
create table if not exists public.seat_events (
  id bigserial primary key,
  at timestamptz not null default now(),
  seat_code text not null references public.verifier_seats(code),
  event text not null check (event in ('invited','claimed','pledged','released','invite_revoked','invite_expired')),
  public_id text,
  pledge_version text,
  actor_public_id text,
  reason text
);
create or replace function public.seat_events_append_only() returns trigger language plpgsql as $$
begin raise exception 'seat_events is append-only'; end $$;
drop trigger if exists trg_seat_events_ro on public.seat_events;
create trigger trg_seat_events_ro before update or delete on public.seat_events for each row execute function public.seat_events_append_only();
create or replace view public.seat_events_public with (security_invoker = false) as
  select at, seat_code, event, public_id, pledge_version from public.seat_events order by id;

-- ---------- per-IP failure log for code guessing (hashed IPs, pruned) ----------
create table if not exists public.join_failures (ip_hash text not null, at timestamptz not null default now());
create index if not exists idx_join_failures on public.join_failures (ip_hash, at);

alter table public.pledge_texts enable row level security;
alter table public.verifier_pledges enable row level security;
alter table public.seat_events enable row level security;
alter table public.join_failures enable row level security;
drop policy if exists "public read pledge texts" on public.pledge_texts;
create policy "public read pledge texts" on public.pledge_texts for select using (true);
revoke all on public.verifier_pledges, public.seat_events, public.join_failures from anon, authenticated;
revoke insert, update, delete on public.pledge_texts from anon, authenticated;
grant select on public.pledge_texts, public.seat_events_public to anon, authenticated;

-- A seat counts as "held" while anyone is bound to it (pledged or not) or a live invite exists.
create or replace view public.seat_board with (security_invoker = false) as
  select s.code, s.role, s.state_iso, s.region_id, s.ordinal, s.label,
         exists (select 1 from public.verifiers v where v.seat_code = s.code and v.active) as taken,
         (exists (select 1 from public.verifiers v where v.seat_code = s.code and not v.active)
          or exists (select 1 from public.verifier_offers o where o.seat_code = s.code and o.status in ('pending_send','sent','claimed'))) as pending
  from public.verifier_seats s;
grant select on public.seat_board to anon, authenticated;

create or replace function public.norm_name(t text) returns text language sql immutable as $$
  -- letters only, accents and spacing ignored: "Adébáyọ̀ Ọlá-Ojo" = "adebayo olaojo" = "Adebayo Ola Ojo"
  select regexp_replace(lower(extensions.unaccent(normalize(coalesce(t, ''), NFD))), '[^a-z]', '', 'g')
$$;
create or replace function public.seat_area(p_seat text) returns text language sql stable set search_path = public as $$
  select case when s.role = 'szv' then st.name else r.name end
  from public.verifier_seats s left join public.ng_states st on st.iso = s.state_iso left join public.verifier_regions r on r.id = s.region_id
  where s.code = p_seat
$$;

-- ---------- expiry: lapsed codes and unpledged claims free their seat ----------
create or replace function public.invites_expire() returns int language plpgsql security definer set search_path = public as $$
declare o record; n int := 0;
begin
  for o in select * from public.verifier_offers
           where seat_code is not null and ((status = 'sent' and expires_at < now()) or (status = 'claimed' and confirm_expires_at < now()))
           for update skip locked loop
    update public.verifier_offers set status = 'expired' where id = o.id;
    if o.status = 'claimed' then   -- unbind first: the verifier trigger still needs the accepted application
      update public.verifiers set seat_code = null where user_id = o.claimed_by and not active;
    end if;
    update public.verifier_applications set status = 'expired' where id = o.application_id and status in ('offered','accepted');
    insert into public.seat_events (seat_code, event, reason) values (o.seat_code, 'invite_expired', case when o.status = 'claimed' then 'pledge not completed in time' else 'code not used in time' end);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------- 1. BinchikaAdmin creates an invite for an eligible application ----------
create or replace function public.invite_create(p_seat text, p_application uuid, p_code_hash text, p_actor uuid, p_hours int default 24)
returns table (offer_id uuid, email text, seat_code text, area text, expires_at timestamptz) language plpgsql security definer set search_path = public as $$
declare s record; a record; actor text; oid uuid; exp timestamptz;
begin
  perform public.invites_expire();
  select v.public_id into actor from public.verifiers v where v.user_id = p_actor and v.role = 'superadmin' and v.active;
  if actor is null then raise exception 'only the BinchikaAdmin can invite'; end if;
  if p_hours not in (24, 6) then raise exception 'window must be 24 or 6 hours'; end if;
  select * into s from public.verifier_seats where code = p_seat;
  if s.code is null then raise exception 'unknown seat'; end if;
  if exists (select 1 from public.verifiers v where v.seat_code = p_seat) then raise exception 'seat % is held', p_seat; end if;
  if exists (select 1 from public.verifier_offers o where o.seat_code = p_seat and o.status in ('pending_send','sent','claimed')) then raise exception 'seat % already has a live invite', p_seat; end if;
  select * into a from public.verifier_applications where id = p_application for update;
  if a.id is null or a.status <> 'eligible' then raise exception 'application is not eligible'; end if;
  if a.full_name is null then raise exception 'application has no full name'; end if;
  if a.role_sought <> s.role then raise exception 'application is for %, seat is for %', a.role_sought, s.role; end if;
  if s.role = 'szv' and a.state_iso <> s.state_iso then raise exception 'applicant state does not match seat'; end if;
  if s.role = 'nrv' and not exists (select 1 from public.region_states rs where rs.region_id = s.region_id and rs.state_iso = a.state_iso) then raise exception 'applicant state is not in the seat''s region'; end if;
  exp := now() + make_interval(hours => p_hours);
  insert into public.verifier_offers (application_id, state_iso, seat_code, role, region_id, wave, window_hours, code_hash, expires_at, status, created_by_public_id)
    values (a.id, a.state_iso, s.code, s.role, s.region_id, case when p_hours = 6 then 2 else 1 end, p_hours, p_code_hash, exp, 'sent', actor)
    returning id into oid;
  update public.verifier_applications set status = 'offered' where id = a.id;
  insert into public.seat_events (seat_code, event, actor_public_id) values (s.code, 'invited', actor);
  return query select oid, a.email, s.code, public.seat_area(s.code), exp;
end $$;

-- ---------- 2. invitee checks a code (rate limited per hashed IP) ----------
create or replace function public.invite_check(p_code_hash text, p_ip_hash text)
returns table (result text, seat_code text, role text, area text, expires_at timestamptz) language plpgsql security definer set search_path = public as $$
declare o record;
begin
  perform public.invites_expire();
  delete from public.join_failures where at < now() - interval '1 day';
  if (select count(*) from public.join_failures f where f.ip_hash = p_ip_hash and f.at > now() - interval '15 minutes') >= 10 then
    return query select 'rate_limited'::text, null::text, null::text, null::text, null::timestamptz; return;
  end if;
  select * into o from public.verifier_offers where code_hash = p_code_hash and status = 'sent' and verifier_offers.expires_at > now();
  if o.id is null then
    insert into public.join_failures (ip_hash) values (p_ip_hash);
    return query select 'invalid'::text, null::text, null::text, null::text, null::timestamptz; return;
  end if;
  return query select 'ok'::text, o.seat_code, o.role, public.seat_area(o.seat_code), o.expires_at;
end $$;

-- ---------- 3a. claim: email and area must match; 5 wrong tries revoke the code ----------
create or replace function public.invite_claim_check(p_code_hash text, p_email text, p_area text, p_ip_hash text)
returns table (result text, offer_id uuid, full_name text) language plpgsql security definer set search_path = public as $$
declare o record; a record; area_ok boolean;
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
      insert into public.seat_events (seat_code, event, reason) values (o.seat_code, 'invite_revoked', 'too many wrong attempts');
      update public.verifier_applications set status = 'eligible' where id = o.application_id and status = 'offered';
    end if;
    insert into public.join_failures (ip_hash) values (p_ip_hash);
    return query select (case when not area_ok then 'area_mismatch' else 'email_mismatch' end)::text, null::uuid, null::text; return;
  end if;
  return query select 'ok'::text, o.id, a.full_name;
end $$;

-- ---------- 3b. claim: after the Auth user exists, bind the seat (inactive until the pledge) ----------
create or replace function public.invite_claim_finish(p_offer uuid, p_user uuid, p_confirm_hash text)
returns table (public_id text, seat_code text, area text) language plpgsql security definer set search_path = public as $$
declare o record; pid text;
begin
  update public.verifier_offers set status = 'claimed', claimed_by = p_user, claimed_at = now(), confirm_hash = p_confirm_hash,
         confirm_expires_at = now() + interval '24 hours'
   where id = p_offer and status = 'sent' and expires_at > now() returning * into o;
  if o.id is null then raise exception 'code already used or expired'; end if;
  update public.verifier_applications set status = 'accepted' where id = o.application_id;
  insert into public.verifiers (user_id, application_id, role, state_iso, region_id, seat_code, display_name, active)
    values (p_user, o.application_id, o.role, case when o.role = 'szv' then o.state_iso end, case when o.role = 'nrv' then o.region_id end, o.seat_code, o.seat_code, false)
    returning verifiers.public_id into pid;
  insert into public.seat_events (seat_code, event, public_id) values (o.seat_code, 'claimed', pid);
  return query select pid, o.seat_code, public.seat_area(o.seat_code);
end $$;

-- ---------- 4. pledge preview for the confirmation link ----------
create or replace function public.pledge_preview(p_confirm_hash text)
returns table (seat_code text, public_id text, area text, version text, body text, sha256 text) language sql stable security definer set search_path = public as $$
  select o.seat_code, v.public_id, public.seat_area(o.seat_code), t.version,
         replace(replace(t.body, '{SEAT}', o.seat_code), '{AREA}', public.seat_area(o.seat_code)), t.sha256
  from public.verifier_offers o
  join public.verifiers v on v.user_id = o.claimed_by
  cross join lateral (select * from public.pledge_texts order by published_at desc limit 1) t
  where o.confirm_hash = p_confirm_hash and o.status = 'claimed' and o.confirm_expires_at > now()
$$;

-- ---------- 5. typed-name pledge: activates the seat ----------
create or replace function public.pledge_sign(p_confirm_hash text, p_typed_name text, p_version text)
returns table (result text, user_id uuid, email text, seat_code text, public_id text, role text, area text) language plpgsql security definer set search_path = public as $$
declare o record; a record; v record; t record;
begin
  select * into o from public.verifier_offers where confirm_hash = p_confirm_hash and status = 'claimed' and confirm_expires_at > now() for update;
  if o.id is null then return query select 'invalid'::text, null::uuid, null::text, null::text, null::text, null::text, null::text; return; end if;
  select * into t from public.pledge_texts where pledge_texts.version = p_version;
  if t.version is null then return query select 'unknown_version'::text, null::uuid, null::text, null::text, null::text, null::text, null::text; return; end if;
  select * into a from public.verifier_applications where id = o.application_id;
  if public.norm_name(p_typed_name) = '' or public.norm_name(p_typed_name) <> public.norm_name(a.full_name) then
    return query select 'name_mismatch'::text, null::uuid, null::text, null::text, null::text, null::text, null::text; return;
  end if;
  update public.verifiers set active = true, pledged_at = now() where verifiers.user_id = o.claimed_by and verifiers.seat_code = o.seat_code returning * into v;
  if v.user_id is null then raise exception 'seat binding missing'; end if;
  insert into public.verifier_pledges (user_id, seat_code, public_id, pledge_version, pledge_sha256, typed_name)
    values (v.user_id, o.seat_code, v.public_id, t.version, t.sha256, btrim(p_typed_name));
  update public.verifier_offers set status = 'accepted', accepted_at = now(), confirm_hash = null where id = o.id;
  insert into public.seat_events (seat_code, event, public_id, pledge_version) values (o.seat_code, 'pledged', v.public_id, t.version);
  return query select 'ok'::text, v.user_id, a.email, o.seat_code, v.public_id, v.role, public.seat_area(o.seat_code);
end $$;

-- ---------- 6. BinchikaAdmin releases a seat (public ID retired, never reused) ----------
create or replace function public.seat_release(p_seat text, p_reason text, p_actor uuid)
returns table (released_user uuid, public_id text) language plpgsql security definer set search_path = public as $$
declare actor text; v record; revoked int;
begin
  select x.public_id into actor from public.verifiers x where x.user_id = p_actor and x.role = 'superadmin' and x.active;
  if actor is null then raise exception 'only the BinchikaAdmin can release a seat'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 10 then raise exception 'a reason of at least 10 characters is required'; end if;
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

-- BinchikaAdmin-only read of a pledge (typed name is private)
create or replace function public.pledge_record(p_public_id text)
returns table (seat_code text, pledge_version text, pledge_sha256 text, typed_name text, signed_at timestamptz) language sql stable security definer set search_path = public as $$
  select p.seat_code, p.pledge_version, p.pledge_sha256, p.typed_name, p.signed_at from public.verifier_pledges p
  where p.public_id = p_public_id and public.is_superadmin()
$$;

revoke all on function public.invites_expire(), public.invite_create(text, uuid, text, uuid, int), public.invite_check(text, text),
  public.invite_claim_check(text, text, text, text), public.invite_claim_finish(uuid, uuid, text), public.pledge_preview(text),
  public.pledge_sign(text, text, text), public.seat_release(text, text, uuid) from public, anon, authenticated;
grant execute on function public.invites_expire(), public.invite_create(text, uuid, text, uuid, int), public.invite_check(text, text),
  public.invite_claim_check(text, text, text, text), public.invite_claim_finish(uuid, uuid, text), public.pledge_preview(text),
  public.pledge_sign(text, text, text), public.seat_release(text, text, uuid) to service_role;
revoke all on function public.pledge_record(text) from public, anon;
grant execute on function public.pledge_record(text) to authenticated;
