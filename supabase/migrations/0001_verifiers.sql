-- Binchika verifier system (Supabase project YOUR-PROJECT-REF).
-- Rules enforced here, not just in the UI:
--   * Volunteers only: anyone answering "expects compensation" is ineligible.
--   * State of origin/residence is fixed at application. A verifier can only act in that state
--     (SZV) or in the states of their region (NRV). Lagos ≠ Bauchi.
--   * First-wave offers last 24 h; an unaccepted slot passes to the next most compatible applicant
--     from the SAME state with a 6 h window.
--   * Verifiers never write results. They raise flags. AI re-investigates. Only an admin decides.
--   * No raw ID numbers: PVC/VIN and NIN are stored only as salted hashes + last 4 characters.

create extension if not exists pgcrypto;

-- ---------- reference data ----------
create table if not exists public.ng_states (
  iso text primary key,               -- NG-LA
  inec_code text unique not null,     -- 24 (prefix of polling-unit codes)
  name text not null,
  zone text not null check (zone in ('NW','NE','NC','SW','SE','SS'))
);
create table if not exists public.verifier_regions (
  id text primary key,                -- R1..R8 (draft)
  name text not null
);
create table if not exists public.region_states (
  region_id text references public.verifier_regions(id) on delete cascade,
  state_iso text references public.ng_states(iso) on delete cascade,
  primary key (region_id, state_iso)
);

-- ---------- applications & offers (service role only; no client policies) ----------
create table if not exists public.verifier_applications (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  state_iso text not null references public.ng_states(iso),
  state_basis text not null check (state_basis in ('origin','residence')),
  role_sought text not null check (role_sought in ('szv','nrv')),
  answers jsonb not null,
  score int,
  ineligible_reasons text[] not null default '{}',
  email text not null,                          -- needed to deliver the one-time code; never public
  vin_hash text,                                 -- salted sha256 of PVC VIN
  vin_last4 text check (vin_last4 ~ '^[A-Z0-9]{4}$'),
  nin_hash text,
  status text not null default 'submitted' check (status in ('submitted','eligible','ineligible','offered','accepted','expired','declined','withdrawn')),
  unique (vin_hash)
);
create index if not exists idx_app_state_rank on public.verifier_applications (state_iso, status, score desc, created_at);

create table if not exists public.verifier_offers (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.verifier_applications(id) on delete cascade,
  state_iso text not null references public.ng_states(iso),
  wave int not null default 1,
  window_hours int not null check (window_hours in (24, 6)),
  code_hash text,                                -- sha256 of the one-time code (code itself is only emailed)
  offered_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  status text not null default 'pending_send' check (status in ('pending_send','sent','accepted','expired','declined')),
  replaces uuid references public.verifier_offers(id)
);
create index if not exists idx_offers_open on public.verifier_offers (status, expires_at);

-- ---------- verifiers (linked to Supabase Auth users) ----------
create table if not exists public.verifiers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  application_id uuid unique references public.verifier_applications(id),
  role text not null check (role in ('szv','nrv','admin')),
  state_iso text references public.ng_states(iso),
  region_id text references public.verifier_regions(id),
  display_name text not null default 'Verifier',
  avatar_url text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (role = 'admin' or (role = 'szv' and state_iso is not null) or (role = 'nrv' and region_id is not null))
);

-- State rule: an SZV's state must equal the state on their accepted application;
-- an NRV's region must contain that state.
create or replace function public.enforce_verifier_state() returns trigger language plpgsql as $$
declare app_state text;
begin
  if new.role = 'admin' then return new; end if;
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
drop trigger if exists trg_verifier_state on public.verifiers;
create trigger trg_verifier_state before insert or update on public.verifiers for each row execute function public.enforce_verifier_state();

-- ---------- helpers ----------
create or replace function public.pu_state(pu text) returns text language sql immutable as $$
  select iso from public.ng_states where inec_code = left(pu, 2)
$$;

create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.verifiers where user_id = auth.uid() and role = 'admin' and active)
$$;

-- states the current user may act in
create or replace function public.my_states() returns setof text language sql stable security definer set search_path = public as $$
  select v.state_iso from public.verifiers v where v.user_id = auth.uid() and v.active and v.role = 'szv'
  union
  select rs.state_iso from public.verifiers v join public.region_states rs on rs.region_id = v.region_id where v.user_id = auth.uid() and v.active and v.role = 'nrv'
  union
  select iso from public.ng_states where public.is_admin()
$$;

-- ---------- flags: verifiers raise, AI investigates, admin decides ----------
create table if not exists public.discrepancy_flags (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid not null default auth.uid() references auth.users(id),
  pu_code text not null check (pu_code ~ '^\d{2}-\d{2}-\d{2}-\d{3}$'),
  race text not null check (race in ('president','senate','house','governor','state-assembly')),
  state_iso text generated always as (public.pu_state(pu_code)) stored,
  reason text not null check (length(reason) between 10 and 2000),
  evidence jsonb not null default '[]',
  status text not null default 'open' check (status in ('open','investigating','ai_done','approved','rejected')),
  ai_summary text,
  proposed_tally jsonb,
  decided_by uuid references auth.users(id),
  decided_at timestamptz,
  decision_note text
);
create index if not exists idx_flags_state on public.discrepancy_flags (state_iso, status);

-- Verifiers may only edit nothing after creation; status changes are admin-only.
create or replace function public.guard_flag_update() returns trigger language plpgsql as $$
begin
  if not public.is_admin() and current_user not in ('postgres','service_role') then
    raise exception 'only an admin can change a flag';
  end if;
  if new.status in ('approved','rejected') then new.decided_by := coalesce(new.decided_by, auth.uid()); new.decided_at := coalesce(new.decided_at, now()); end if;
  return new;
end $$;
drop trigger if exists trg_flag_guard on public.discrepancy_flags;
create trigger trg_flag_guard before update on public.discrepancy_flags for each row execute function public.guard_flag_update();

-- ---------- offers: expiry + same-state backfill with a 6 h window ----------
create or replace function public.expire_and_backfill() returns setof public.verifier_offers language plpgsql security definer set search_path = public as $$
declare o record; nxt uuid; created public.verifier_offers;
begin
  for o in select * from public.verifier_offers where status in ('pending_send','sent') and expires_at < now() for update skip locked loop
    update public.verifier_offers set status = 'expired' where id = o.id;
    update public.verifier_applications set status = 'expired' where id = o.application_id;
    select a.id into nxt from public.verifier_applications a
      where a.state_iso = o.state_iso and a.status = 'eligible'
      order by a.score desc nulls last, a.created_at asc limit 1;
    if nxt is not null then
      update public.verifier_applications set status = 'offered' where id = nxt;
      insert into public.verifier_offers (application_id, state_iso, wave, window_hours, expires_at, replaces)
        values (nxt, o.state_iso, o.wave + 1, 6, now() + interval '6 hours', o.id) returning * into created;
      return next created;
    end if;
  end loop;
end $$;

-- ---------- RLS ----------
alter table public.ng_states enable row level security;
alter table public.verifier_regions enable row level security;
alter table public.region_states enable row level security;
alter table public.verifier_applications enable row level security;
alter table public.verifier_offers enable row level security;
alter table public.verifiers enable row level security;
alter table public.discrepancy_flags enable row level security;

drop policy if exists "public read states" on public.ng_states;
create policy "public read states" on public.ng_states for select using (true);
drop policy if exists "public read regions" on public.verifier_regions;
create policy "public read regions" on public.verifier_regions for select using (true);
drop policy if exists "public read region_states" on public.region_states;
create policy "public read region_states" on public.region_states for select using (true);
-- verifier_applications / verifier_offers: no client policies at all (service role only).

drop policy if exists "verifier reads self" on public.verifiers;
create policy "verifier reads self" on public.verifiers for select to authenticated using (user_id = auth.uid() or public.is_admin());
drop policy if exists "verifier updates own profile" on public.verifiers;
create policy "verifier updates own profile" on public.verifiers for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
-- prevent self-promotion: only display_name/avatar may change for non-admins
revoke update on public.verifiers from authenticated;
grant update (display_name, avatar_url) on public.verifiers to authenticated;

drop policy if exists "flags read in my area" on public.discrepancy_flags;
create policy "flags read in my area" on public.discrepancy_flags for select to authenticated using (state_iso in (select public.my_states()));
drop policy if exists "flags insert in my area" on public.discrepancy_flags;
create policy "flags insert in my area" on public.discrepancy_flags for insert to authenticated
  with check (created_by = auth.uid() and public.pu_state(pu_code) in (select public.my_states()) and status = 'open');
drop policy if exists "flags admin decides" on public.discrepancy_flags;
create policy "flags admin decides" on public.discrepancy_flags for update to authenticated using (public.is_admin()) with check (public.is_admin());

revoke all on public.verifier_applications, public.verifier_offers from anon, authenticated;
revoke insert, update, delete on public.ng_states, public.verifier_regions, public.region_states from anon, authenticated;
grant select on public.ng_states, public.verifier_regions, public.region_states to anon, authenticated;
grant select, insert on public.discrepancy_flags to authenticated;
grant update (status, ai_summary, proposed_tally, decision_note) on public.discrepancy_flags to authenticated;
grant select on public.verifiers to authenticated;

-- anon gets nothing on verifier tables (not merely zero rows)
revoke all on public.verifiers, public.discrepancy_flags from anon;
