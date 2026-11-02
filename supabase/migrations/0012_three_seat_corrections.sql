-- 0012: three separate seats for every correction (session 76; docs/QUORUM-CORRECTIONS-DESIGN.md). Builds forward on 0009.
-- PREPARED, NOT APPLIED: production needs the owner's explicit approval.
--
-- What it closes. Under 0009 an OpsAdmin or the BinchikAdmin could move a flag to 'escalated' themselves (or revive a
-- dismissed one), and an NRV could escalate a flag they raised. /api/admin/decide (session 76) already refuses to approve
-- unless the raiser, the NRV on the flag and the approver are three different public IDs. This makes the database say the
-- same about who may escalate:
--   * only a Regional Verifier (NRV) can move a flag to 'escalated', and never a flag they raised;
--   * a flag reaches 'investigating' or 'ai_done' only from 'escalated', 'investigating' or 'ai_done';
--   * approve/reject stays BinchikAdmin-only, and the BinchikAdmin address lock (0009) is untouched.
-- Everything else in guard_flag_update is copied unchanged from 0009.

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
  -- 0012: only an NRV escalates, and never their own flag.
  if new.status = 'escalated' and new.status is distinct from old.status then
    if me.role <> 'nrv' then raise exception 'only a Regional Verifier can escalate a flag'; end if;
    if old.raised_by_public_id = me.public_id then raise exception 'a Regional Verifier cannot escalate a flag they raised'; end if;
  end if;
  -- 0012: the AI re-check stages follow an escalation; they cannot skip it.
  if new.status in ('investigating','ai_done') and new.status is distinct from old.status
     and old.status not in ('escalated','investigating','ai_done') then
    raise exception 'a flag must be escalated by a Regional Verifier before the AI re-check';
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
