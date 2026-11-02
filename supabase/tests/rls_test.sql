-- Positive + negative RLS / rule tests. Everything runs inside one DO block that ends by raising
-- an exception carrying the results, so ALL test data is rolled back. Expect "RESULTS:" in the error.
do $$
declare seq_keep record; -- public-ID sequence is not transactional: restore it so tests never burn real IDs
 
  res jsonb := '[]'::jsonb;
  u_la uuid := gen_random_uuid(); u_ba uuid := gen_random_uuid(); u_nrv uuid := gen_random_uuid(); u_admin uuid := gen_random_uuid();
  a_la uuid; a_ba uuid; a_nrv uuid; a_wait1 uuid; a_wait2 uuid; a_wait_ba uuid; o1 uuid;
  n int; f_la uuid; ok boolean; newo record;
begin
  select last_value, is_called into seq_keep from public.verifier_public_seq;
  -- fixtures (as postgres)
  insert into auth.users (id, aud, role, email) values
    (u_la, 'authenticated', 'authenticated', 'la@test.invalid'), (u_ba, 'authenticated', 'authenticated', 'ba@test.invalid'),
    (u_nrv, 'authenticated', 'authenticated', 'nrv@test.invalid');
  -- since 0009 only the locked address can be BinchikAdmin: tests use the real record (rolled back)
  select user_id into u_admin from public.verifiers where role = 'superadmin';
  insert into public.verifier_applications (state_iso, state_basis, role_sought, answers, score, email, status) values ('NG-LA','origin','szv','{}',80,'la@test.invalid','accepted') returning id into a_la;
  insert into public.verifier_applications (state_iso, state_basis, role_sought, answers, score, email, status) values ('NG-BA','residence','szv','{}',80,'ba@test.invalid','accepted') returning id into a_ba;
  insert into public.verifier_applications (state_iso, state_basis, role_sought, answers, score, email, status) values ('NG-LA','origin','nrv','{}',80,'nrv@test.invalid','accepted') returning id into a_nrv;

  -- 1 positive: SZV in own state
  insert into public.verifiers (user_id, application_id, role, state_iso) values (u_la, a_la, 'szv', 'NG-LA');
  res := res || jsonb_build_object('t','szv own state allowed','pass',true);
  -- 2 negative: Lagos applicant cannot be SZV for Bauchi
  begin
    insert into public.verifiers (user_id, application_id, role, state_iso) values (u_ba, a_la, 'szv', 'NG-BA');
    res := res || jsonb_build_object('t','lagos applicant as bauchi szv rejected','pass',false);
  exception when others then res := res || jsonb_build_object('t','lagos applicant as bauchi szv rejected','pass',true); end;
  insert into public.verifiers (user_id, application_id, role, state_iso) values (u_ba, a_ba, 'szv', 'NG-BA');
  -- 3 negative: NRV region must contain application state
  begin
    insert into public.verifiers (user_id, application_id, role, region_id) values (u_nrv, a_nrv, 'nrv', 'R3');
    res := res || jsonb_build_object('t','nrv outside home region rejected','pass',false);
  exception when others then res := res || jsonb_build_object('t','nrv outside home region rejected','pass',true); end;
  -- 4 positive: NRV in home region (R6 South West contains Lagos)
  insert into public.verifiers (user_id, application_id, role, region_id) values (u_nrv, a_nrv, 'nrv', 'R6');
  res := res || jsonb_build_object('t','nrv home region allowed','pass',true);

  -- as Lagos SZV
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', u_la, 'role', 'authenticated')::text, true);
  -- 5 positive: flag a Lagos polling unit
  insert into public.discrepancy_flags (pu_code, race, reason) values ('24-09-05-012','president','Photo total differs from IReV upload by 40 votes') returning id into f_la;
  res := res || jsonb_build_object('t','szv flags own-state unit','pass',f_la is not null);
  -- 6 negative: flag a Bauchi unit
  begin
    insert into public.discrepancy_flags (pu_code, race, reason) values ('05-01-01-001','president','Trying to flag outside my state');
    res := res || jsonb_build_object('t','szv flag other state rejected','pass',false);
  exception when others then res := res || jsonb_build_object('t','szv flag other state rejected','pass',true); end;
  -- 7 negative: SZV cannot approve a flag
  begin
    update public.discrepancy_flags set status = 'approved' where id = f_la;
    get diagnostics n = row_count;
    res := res || jsonb_build_object('t','szv cannot approve','pass', n = 0);
  exception when others then res := res || jsonb_build_object('t','szv cannot approve','pass',true); end;
  -- 8 negative: SZV cannot read applications (PII)
  begin
    perform 1 from public.verifier_applications limit 1;
    res := res || jsonb_build_object('t','szv cannot read applications','pass',false);
  exception when others then res := res || jsonb_build_object('t','szv cannot read applications','pass',true); end;
  -- 9 negative: SZV cannot promote self to admin
  begin
    update public.verifiers set role = 'admin' where user_id = u_la;
    res := res || jsonb_build_object('t','szv cannot self-promote','pass',false);
  exception when others then res := res || jsonb_build_object('t','szv cannot self-promote','pass',true); end;

  -- as Bauchi SZV: 10 negative — cannot see the Lagos flag
  perform set_config('request.jwt.claims', json_build_object('sub', u_ba, 'role', 'authenticated')::text, true);
  select count(*) into n from public.discrepancy_flags where id = f_la;
  res := res || jsonb_build_object('t','bauchi szv cannot see lagos flag','pass', n = 0);

  -- as South-West NRV: 11 positive — can see the Lagos flag
  perform set_config('request.jwt.claims', json_build_object('sub', u_nrv, 'role', 'authenticated')::text, true);
  select count(*) into n from public.discrepancy_flags where id = f_la;
  res := res || jsonb_build_object('t','sw nrv sees lagos flag','pass', n = 1);

  -- as superadmin: 12 positive — approve
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  update public.discrepancy_flags set status = 'approved', decision_note = 'test' where id = f_la;
  get diagnostics n = row_count;
  res := res || jsonb_build_object('t','superadmin approves flag','pass', n = 1);

  -- as anon: 13 negative — no applications, no verifiers
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';
  begin
    perform 1 from public.verifier_applications limit 1;
    res := res || jsonb_build_object('t','anon cannot read applications','pass',false);
  exception when others then res := res || jsonb_build_object('t','anon cannot read applications','pass',true); end;
  begin
    select count(*) into n from public.verifiers;
    res := res || jsonb_build_object('t','anon cannot read verifiers','pass', false);
  exception when others then res := res || jsonb_build_object('t','anon cannot read verifiers','pass',true); end;
  execute 'reset role';

  -- 14/15 backfill: expired Lagos offer passes to best LAGOS applicant (6 h), never to a higher-scoring Bauchi one
  insert into public.verifier_applications (state_iso, state_basis, role_sought, answers, score, email, status) values ('NG-LA','origin','szv','{}',70,'w1@test.invalid','offered') returning id into a_wait1;
  insert into public.verifier_applications (state_iso, state_basis, role_sought, answers, score, email, status) values ('NG-LA','residence','szv','{}',90,'w2@test.invalid','eligible') returning id into a_wait2;
  insert into public.verifier_applications (state_iso, state_basis, role_sought, answers, score, email, status) values ('NG-BA','origin','szv','{}',99,'w3@test.invalid','eligible') returning id into a_wait_ba;
  insert into public.verifier_offers (application_id, state_iso, window_hours, expires_at, status) values (a_wait1, 'NG-LA', 24, now() - interval '1 minute', 'sent') returning id into o1;
  select * into newo from public.expire_and_backfill() limit 1;
  res := res || jsonb_build_object('t','backfill same state, best score','pass', newo.application_id = a_wait2 and newo.state_iso = 'NG-LA');
  res := res || jsonb_build_object('t','backfill window is 6h','pass', newo.window_hours = 6 and newo.expires_at between now() + interval '5 hours 59 minutes' and now() + interval '6 hours 1 minute');

  perform setval('public.verifier_public_seq', seq_keep.last_value, seq_keep.is_called);
  raise exception 'RESULTS:%', res;
end $$;
