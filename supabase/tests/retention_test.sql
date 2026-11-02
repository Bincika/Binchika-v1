-- Retention deletions (0011 retention_purge), rolled back via the final exception. Session 63; docs/RETENTION.md.
do $$
declare seq_keep record;
  res jsonb := '[]'::jsonb; r jsonb; n int;
  u_old uuid := gen_random_uuid(); u_new uuid := gen_random_uuid(); u_live uuid := gen_random_uuid(); u_claim uuid := gen_random_uuid();
  a_old uuid; a_new uuid; a_live uuid; a_claim uuid; a_none uuid; a_none2 uuid;
  pid_old text; pid_new text; pid_live text; pid_claim text; s1 text; s2 text; s3 text; s4 text; f uuid;
  boss text := (select public_id from public.verifiers where role = 'superadmin' limit 1);
begin
  select last_value, is_called into seq_keep from public.verifier_public_seq;
  select code into s1 from public.seat_board where role = 'szv' and state_iso = 'NG-LA' and not taken order by ordinal limit 1;
  select code into s2 from public.seat_board where role = 'szv' and state_iso = 'NG-LA' and not taken and code <> s1 order by ordinal limit 1;
  select code into s3 from public.seat_board where role = 'szv' and state_iso = 'NG-LA' and not taken and code not in (s1, s2) order by ordinal limit 1;
  select code into s4 from public.seat_board where role = 'szv' and state_iso = 'NG-LA' and not taken and code not in (s1, s2, s3) order by ordinal limit 1;

  insert into auth.users (id, aud, role, email) values (u_old,'authenticated','authenticated','old@t.invalid'), (u_new,'authenticated','authenticated','new@t.invalid'),
    (u_live,'authenticated','authenticated','live@t.invalid'), (u_claim,'authenticated','authenticated','claim@t.invalid');
  insert into public.verifier_applications (state_iso,state_basis,role_sought,answers,score,email,status,full_name) values ('NG-LA','origin','szv','{}',80,'old@t.invalid','accepted','Old Holder') returning id into a_old;
  insert into public.verifier_applications (state_iso,state_basis,role_sought,answers,score,email,status,full_name) values ('NG-LA','origin','szv','{}',80,'new@t.invalid','accepted','New Holder') returning id into a_new;
  insert into public.verifier_applications (state_iso,state_basis,role_sought,answers,score,email,status,full_name) values ('NG-LA','origin','szv','{}',80,'live@t.invalid','accepted','Live Holder') returning id into a_live;
  insert into public.verifier_applications (state_iso,state_basis,role_sought,answers,score,email,status,full_name) values ('NG-LA','origin','szv','{}',80,'claim@t.invalid','accepted','Never Pledged') returning id into a_claim;
  insert into public.verifier_applications (state_iso,state_basis,role_sought,answers,score,email,status) values ('NG-LA','origin','szv','{}',70,'none@t.invalid','eligible') returning id into a_none;
  insert into public.verifier_applications (state_iso,state_basis,role_sought,answers,score,email,status) values ('NG-KN','residence','nrv','{}',60,'none2@t.invalid','expired') returning id into a_none2;
  insert into public.verifiers (user_id, application_id, role, state_iso, seat_code, pledged_at) values (u_old, a_old, 'szv', 'NG-LA', s1, now() - interval '20 months') returning public_id into pid_old;
  insert into public.verifiers (user_id, application_id, role, state_iso, seat_code, pledged_at) values (u_new, a_new, 'szv', 'NG-LA', s2, now() - interval '3 months') returning public_id into pid_new;
  insert into public.verifiers (user_id, application_id, role, state_iso, seat_code, pledged_at) values (u_live, a_live, 'szv', 'NG-LA', s3, now() - interval '20 months') returning public_id into pid_live;
  insert into public.verifiers (user_id, application_id, role, state_iso, seat_code) values (u_claim, a_claim, 'szv', 'NG-LA', s4) returning public_id into pid_claim;
  insert into public.verifier_pledges (user_id, seat_code, public_id, pledge_version, pledge_sha256, typed_name)
    select u, s, p, t.version, t.sha256, nm from (values (u_old, s1, pid_old, 'Old Holder'), (u_new, s2, pid_new, 'New Holder'), (u_live, s3, pid_live, 'Live Holder')) x(u, s, p, nm),
    (select version, sha256 from public.pledge_texts order by version desc limit 1) t;
  insert into public.discrepancy_flags (pu_code, race, reason, created_by) values ('24-01-01-001','president','IReV total exceeds photo by 30 votes', u_old) returning id into f;
  -- release two seats: one 13 months ago, one 1 month ago; the never-pledged claim is deactivated without a release
  update public.verifiers set active = false, seat_code = null where user_id in (u_old, u_new, u_claim);
  insert into public.seat_events (seat_code, event, public_id, actor_public_id, reason, at) values
    (s1, 'released', pid_old, boss, 'test release long ago', now() - interval '13 months'),
    (s2, 'released', pid_new, boss, 'test release recently', now() - interval '1 month');

  -- dry run (the default): reports, deletes nothing
  r := public.retention_purge();
  res := res || jsonb_build_object('t','dry run is the default and deletes nothing','pass', (r->>'dry_run')::boolean and (r->>'seat_holders')::int = 1
    and exists (select 1 from public.verifiers where user_id = u_old) and exists (select 1 from public.verifier_pledges where public_id = pid_old));
  res := res || jsonb_build_object('t','without the governorship date no application is due','pass', not (r->>'applications_due')::boolean and (r->>'applications')::int = 0 and (r->>'unpledged_accounts')::int = 0);
  begin perform public.retention_purge(now(), null, 7, 12, true); res := res || jsonb_build_object('t','refuses an application period under 30 days','pass', false);
  exception when others then res := res || jsonb_build_object('t','refuses an application period under 30 days','pass', true); end;
  begin perform public.retention_purge(now(), null, 90, 0, true); res := res || jsonb_build_object('t','refuses a seat-holder period under 1 month','pass', false);
  exception when others then res := res || jsonb_build_object('t','refuses a seat-holder period under 1 month','pass', true); end;

  -- real run, before the governorship date: only the seat released 13 months ago
  r := public.retention_purge(now(), null, 90, 12, false);
  res := res || jsonb_build_object('t','deletes the account, application and pledge of a seat released over 12 months ago','pass',
    (r->>'seat_holders')::int = 1 and (r->'public_ids') ? pid_old
    and not exists (select 1 from auth.users where id = u_old) and not exists (select 1 from public.verifiers where user_id = u_old)
    and not exists (select 1 from public.verifier_applications where id = a_old) and not exists (select 1 from public.verifier_pledges where public_id = pid_old));
  res := res || jsonb_build_object('t','keeps the public ID in the public seat history and on the flag','pass',
    exists (select 1 from public.seat_events_public where public_id = pid_old)
    and exists (select 1 from public.discrepancy_flags where id = f and raised_by_public_id = pid_old and created_by is null));
  res := res || jsonb_build_object('t','keeps a seat released 1 month ago, an active holder and the BinchikAdmin','pass',
    exists (select 1 from public.verifier_pledges where public_id = pid_new) and exists (select 1 from auth.users where id = u_new)
    and exists (select 1 from public.verifiers where user_id = u_live and active) and exists (select 1 from public.verifier_pledges where public_id = pid_live)
    and exists (select 1 from public.verifiers where role = 'superadmin' and active));
  res := res || jsonb_build_object('t','applications are kept until the governorship period has passed','pass',
    exists (select 1 from public.verifier_applications where id = a_none) and exists (select 1 from auth.users where id = u_claim));

  -- governorship results declared 100 days ago: applications that never became a seat, and the never-pledged claim, go
  r := public.retention_purge(now(), (now() - interval '100 days')::date, 90, 12, false);
  res := res || jsonb_build_object('t','90 days after the final governorship results, applications without a seat are deleted','pass',
    (r->>'applications_due')::boolean and not exists (select 1 from public.verifier_applications where id in (a_none, a_none2)));
  res := res || jsonb_build_object('t','an account that claimed but never pledged is deleted then too','pass',
    (r->>'unpledged_accounts')::int = 1 and not exists (select 1 from auth.users where id = u_claim) and not exists (select 1 from public.verifier_applications where id = a_claim));
  res := res || jsonb_build_object('t','applications of current and recent seat holders survive','pass',
    exists (select 1 from public.verifier_applications where id = a_live) and exists (select 1 from public.verifier_applications where id = a_new));
  r := public.retention_purge(now(), (now() - interval '10 days')::date, 90, 12, true);
  res := res || jsonb_build_object('t','10 days after the results nothing is due yet','pass', not (r->>'applications_due')::boolean);

  execute 'set local role anon';
  begin perform public.retention_purge(); res := res || jsonb_build_object('t','anon cannot run it','pass', false);
  exception when others then res := res || jsonb_build_object('t','anon cannot run it','pass', true); end;
  execute 'reset role';
  execute 'set local role authenticated';
  begin perform public.retention_purge(); res := res || jsonb_build_object('t','signed-in users cannot run it','pass', false);
  exception when others then res := res || jsonb_build_object('t','signed-in users cannot run it','pass', true); end;
  execute 'reset role';
  perform setval('public.verifier_public_seq', seq_keep.last_value, seq_keep.is_called);
  raise exception 'RESULTS:%', res;
end $$;
