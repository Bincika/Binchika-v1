-- Tests for 0012: three separate seats. Only an NRV escalates, never their own flag; the AI stages cannot skip escalation.
-- All rolled back via the final exception.
do $$
declare seq_keep record;
  res jsonb := '[]'::jsonb;
  u_szv uuid := gen_random_uuid(); u_nrv uuid := gen_random_uuid(); u_nrv2 uuid := gen_random_uuid(); u_admin uuid := gen_random_uuid(); u_super uuid;
  a1 uuid; a2 uuid; a3 uuid; f uuid; f2 uuid; f3 uuid; n int; ok boolean;
begin
  select last_value, is_called into seq_keep from public.verifier_public_seq;
  insert into auth.users (id, aud, role, email) values (u_szv,'authenticated','authenticated','cs@t.invalid'),(u_nrv,'authenticated','authenticated','cn@t.invalid'),(u_nrv2,'authenticated','authenticated','cn2@t.invalid'),(u_admin,'authenticated','authenticated','ca@t.invalid');
  select user_id into u_super from public.verifiers where role = 'superadmin';
  insert into public.verifier_applications (state_iso,state_basis,role_sought,answers,score,email,status) values ('NG-LA','origin','szv','{}',80,'cs@t.invalid','accepted') returning id into a1;
  insert into public.verifier_applications (state_iso,state_basis,role_sought,answers,score,email,status) values ('NG-OY','origin','nrv','{}',80,'cn@t.invalid','accepted') returning id into a2;
  insert into public.verifier_applications (state_iso,state_basis,role_sought,answers,score,email,status) values ('NG-OG','origin','nrv','{}',80,'cn2@t.invalid','accepted') returning id into a3;
  insert into public.verifiers (user_id, application_id, role, state_iso) values (u_szv, a1, 'szv', 'NG-LA');
  insert into public.verifiers (user_id, application_id, role, region_id) values (u_nrv, a2, 'nrv', 'R6');
  insert into public.verifiers (user_id, application_id, role, region_id) values (u_nrv2, a3, 'nrv', 'R6');
  insert into public.verifiers (user_id, role, ops_seat) values (u_admin, 'admin', (select code from public.ops_seats o where not exists (select 1 from public.verifiers v where v.ops_seat = o.code) order by code limit 1));

  execute 'set local role authenticated';
  -- f: raised by the SZV. f2: raised by the BinchikAdmin. f3: raised by NRV 1.
  perform set_config('request.jwt.claims', json_build_object('sub', u_szv, 'role','authenticated')::text, true);
  insert into public.discrepancy_flags (pu_code, race, reason) values ('24-01-01-001','president','test flag for 0012 one') returning id into f;
  perform set_config('request.jwt.claims', json_build_object('sub', u_super, 'role','authenticated','aal','aal2')::text, true);
  insert into public.discrepancy_flags (pu_code, race, reason) values ('24-01-01-001','president','test flag for 0012 two') returning id into f2;
  perform set_config('request.jwt.claims', json_build_object('sub', u_nrv, 'role','authenticated')::text, true);
  insert into public.discrepancy_flags (pu_code, race, reason) values ('24-01-01-001','president','test flag for 0012 three') returning id into f3;

  -- The BinchikAdmin cannot escalate (not its own flag, not anyone's).
  perform set_config('request.jwt.claims', json_build_object('sub', u_super, 'role','authenticated','aal','aal2')::text, true);
  ok := false; begin update public.discrepancy_flags set status = 'escalated' where id = f2; exception when others then ok := true; end;
  res := res || jsonb_build_object('t','BinchikAdmin cannot escalate its own flag','pass', ok);
  ok := false; begin update public.discrepancy_flags set status = 'escalated' where id = f; exception when others then ok := true; end;
  res := res || jsonb_build_object('t','BinchikAdmin cannot escalate a verifier''s flag','pass', ok);
  ok := false; begin update public.discrepancy_flags set status = 'investigating' where id = f; exception when others then ok := true; end;
  res := res || jsonb_build_object('t','BinchikAdmin cannot skip escalation to the AI re-check','pass', ok);

  -- An OpsAdmin cannot escalate either.
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role','authenticated','aal','aal2')::text, true);
  ok := false; begin update public.discrepancy_flags set status = 'escalated' where id = f; exception when others then ok := true; end;
  res := res || jsonb_build_object('t','OpsAdmin cannot escalate','pass', ok);

  -- NRV 1 cannot escalate its own flag; NRV 2 (same region) can.
  perform set_config('request.jwt.claims', json_build_object('sub', u_nrv, 'role','authenticated')::text, true);
  ok := false; begin update public.discrepancy_flags set status = 'escalated' where id = f3; exception when others then ok := true; end;
  res := res || jsonb_build_object('t','NRV cannot escalate a flag they raised','pass', ok);
  perform set_config('request.jwt.claims', json_build_object('sub', u_nrv2, 'role','authenticated')::text, true);
  update public.discrepancy_flags set status = 'escalated' where id = f3; get diagnostics n = row_count;
  res := res || jsonb_build_object('t','a different NRV escalates it','pass', n = 1);

  -- The normal chain still works: NRV escalates the SZV's flag, OpsAdmin runs the re-check, BinchikAdmin approves.
  perform set_config('request.jwt.claims', json_build_object('sub', u_nrv, 'role','authenticated')::text, true);
  update public.discrepancy_flags set status = 'escalated', nrv_findings = 'photos disagree' where id = f; get diagnostics n = row_count;
  res := res || jsonb_build_object('t','NRV escalates an SZV flag','pass', n = 1);
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role','authenticated','aal','aal2')::text, true);
  update public.discrepancy_flags set status = 'ai_done', ai_summary = 'test' where id = f; get diagnostics n = row_count;
  res := res || jsonb_build_object('t','OpsAdmin moves an escalated flag to ai_done','pass', n = 1);
  perform set_config('request.jwt.claims', json_build_object('sub', u_super, 'role','authenticated','aal','aal2')::text, true);
  update public.discrepancy_flags set status = 'approved', decision_note = 'three seats' where id = f; get diagnostics n = row_count;
  res := res || jsonb_build_object('t','BinchikAdmin approves after the chain','pass', n = 1);
  execute 'reset role';

  perform setval('public.verifier_public_seq', seq_keep.last_value, seq_keep.is_called);
  raise exception 'RESULTS:%', res;
end $$;
