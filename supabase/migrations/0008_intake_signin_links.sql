-- 0008 (session 7): verifier application intake + Binchika-sent sign-in links.
-- Builds forward on 0001 (applications) and 0007 (invites). Service-role functions only.

-- ---------- applications: consent + abuse limits ----------
alter table public.verifier_applications add column if not exists privacy_version text;
alter table public.verifier_applications add column if not exists consent_at timestamptz;
alter table public.verifier_applications add column if not exists ip_hash text;
create unique index if not exists uq_app_email on public.verifier_applications (lower(email));

-- Only eligible (or "needs review") applications are stored; ineligible answers are shown to the
-- applicant and never saved (data minimisation). One application per email and per voter card.
create or replace function public.application_submit(
  p_full_name text, p_email text, p_state text, p_basis text, p_role text, p_answers jsonb,
  p_status text, p_score int, p_vin_hash text, p_vin_last4 text, p_privacy text, p_ip_hash text)
returns table (result text, application_id uuid) language plpgsql security definer set search_path = public as $$
declare aid uuid;
begin
  if p_status not in ('eligible', 'submitted') then raise exception 'only eligible or review applications are stored'; end if;
  if p_privacy is null or length(p_privacy) = 0 then raise exception 'consent to a published privacy notice is required'; end if;
  if (select count(*) from public.verifier_applications a where a.ip_hash = p_ip_hash and a.created_at > now() - interval '1 day') >= 5 then
    return query select 'rate_limited'::text, null::uuid; return;
  end if;
  if exists (select 1 from public.verifier_applications a where lower(a.email) = lower(btrim(p_email))) then
    return query select 'duplicate_email'::text, null::uuid; return;
  end if;
  if p_vin_hash is not null and exists (select 1 from public.verifier_applications a where a.vin_hash = p_vin_hash) then
    return query select 'duplicate_card'::text, null::uuid; return;
  end if;
  insert into public.verifier_applications (state_iso, state_basis, role_sought, answers, score, email, vin_hash, vin_last4, status, full_name, privacy_version, consent_at, ip_hash)
    values (p_state, p_basis, p_role, p_answers, p_score, lower(btrim(p_email)), p_vin_hash, p_vin_last4, p_status, btrim(p_full_name), p_privacy, now(), p_ip_hash)
    returning id into aid;
  return query select 'ok'::text, aid;
end $$;

-- ---------- sign-in links sent by Binchika (token-hash; no Site URL / redirect dependency) ----------
create table if not exists public.auth_link_requests (email_hash text not null, ip_hash text not null, at timestamptz not null default now());
create index if not exists idx_auth_link_req on public.auth_link_requests (at);
alter table public.auth_link_requests enable row level security;
revoke all on public.auth_link_requests from anon, authenticated;

-- 'ok' only for an active, unbanned verifier account; 'none' otherwise (the API answers the same either way).
-- Limits: 3 links per email and 10 per IP in 15 minutes.
create or replace function public.auth_link_check(p_email text, p_email_hash text, p_ip_hash text)
returns text language plpgsql security definer set search_path = public, auth as $$
begin
  delete from public.auth_link_requests where at < now() - interval '1 day';
  if (select count(*) from public.auth_link_requests where ip_hash = p_ip_hash and at > now() - interval '15 minutes') >= 10
     or (select count(*) from public.auth_link_requests where email_hash = p_email_hash and at > now() - interval '15 minutes') >= 3 then
    return 'rate_limited';
  end if;
  insert into public.auth_link_requests (email_hash, ip_hash) values (p_email_hash, p_ip_hash);
  if exists (select 1 from auth.users u join public.verifiers v on v.user_id = u.id
             where lower(u.email) = lower(btrim(p_email)) and v.active and (u.banned_until is null or u.banned_until < now())) then
    return 'ok';
  end if;
  return 'none';
end $$;

revoke all on function public.application_submit(text, text, text, text, text, jsonb, text, int, text, text, text, text), public.auth_link_check(text, text, text) from public, anon, authenticated;
grant execute on function public.application_submit(text, text, text, text, text, jsonb, text, int, text, text, text, text), public.auth_link_check(text, text, text) to service_role;
