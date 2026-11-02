-- Tests for 0003: public IDs, escalation chain, superadmin-only approval. All rolled back via the final exception.
do $$
declare seq_keep record; -- public-ID sequence is not transactional: restore it so tests never burn real IDs
 
  res jsonb := '[]'::jsonb;
  u_szv uuid := gen_random_uuid(); u_nrv uuid := gen_random_uuid(); u_nrv_other uuid := gen_random_uuid(); u_admin uuid := gen_random_uuid(); u_super uuid := gen_random_uuid();
  a1 uuid; a2 uuid; a3 uuid; f uuid; pid text; pid2 text; n int;
begin
  select last_value, is_called into seq_keep from public.verifier_public_seq;
  insert into auth.users (id, aud, role, email) values (u_szv,'authenticated','authenticated','s@t.invalid'),(u_nrv,'authenticated','authenticated','n@t.invalid'),(u_nrv_other,'authenticated','authenticated','o@t.invalid'),(u_admin,'authenticated','authenticated','a@t.invalid');
  -- since 0009 only the locked address can be BinchikAdmin: tests use the real record (rolled back)
  select user_id into u_super from public.verifiers where role = 'superadmin';
  insert into public.verifier_applications (state_iso,state_basis,role_sought,answers,score,email,status) values ('NG-LA','origin','szv','{}',80,'s@t.invalid','accepted') returning id into a1;
  insert into public.verifier_applications (state_iso,state_basis,role_sought,answers,score,email,status) values ('NG-OY','origin','nrv','{}',80,'n@t.invalid','accepted') returning id into a2;
  insert into public.verifier_applications (state_iso,state_basis,role_sought,answers,score,email,status) values ('NG-KN','origin','nrv','{}',80,'o@t.invalid','accepted') returning id into a3;
  insert into public.verifiers (user_id, application_id, role, state_iso) values (u_szv, a1, 'szv', 'NG-LA') returning public_id into pid;
  insert into public.verifiers (user_id, application_id, role, region_id) values (u_nrv, a2, 'nrv', 'R6') returning public_id into pid2;
  insert into public.verifiers (user_id, application_id, role, region_id) values (u_nrv_other, a3, 'nrv', 'R2');
  insert into public.verifiers (user_id, role, ops_seat) values (u_admin, 'admin', (select code from public.ops_seats o where not exists (select 1 from public.verifiers v where v.ops_seat = o.code) order by code limit 1));
  res := res || jsonb_build_object('t','public id is 5 chars, V-prefixed, sequential','pass', length(pid) = 5 and pid ~ '^V\d{4}$' and substr(pid2,2)::int = substr(pid,2)::int + 1);
  res := res || jsonb_build_object('t','base-36 continuation stays 5 chars','pass', length(public.to_public_id(10000)) = 5 and length(public.to_public_id(1500000)) = 5 and public.to_public_id(9999) = 'V9999');

  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', u_szv, 'role','authenticated')::text, true);
  insert into public.discrepancy_flags (pu_code, race, reason) values ('24-01-01-001','president','IReV total exceeds photo by 30 votes') returning id into f;
  select count(*) into n from public.verifier_flags_public where id = f and raised_by_public_id = pid;
  res := res || jsonb_build_object('t','flag stamped with raiser public id (no account id in public view)','pass', n = 1);
  begin update public.discrepancy_flags set status = 'escalated' where id = f; get diagnostics n = row_count; res := res || jsonb_build_object('t','szv cannot escalate own flag','pass', n = 0);
  exception when others then res := res || jsonb_build_object('t','szv cannot escalate own flag','pass', true); end;

  perform set_config('request.jwt.claims', json_build_object('sub', u_nrv_other, 'role','authenticated')::text, true);
  update public.discrepancy_flags set status = 'escalated' where id = f; get diagnostics n = row_count;
  res := res || jsonb_build_object('t','NRV of another region cannot touch Lagos flag','pass', n = 0);

  perform set_config('request.jwt.claims', json_build_object('sub', u_nrv, 'role','authenticated')::text, true);
  update public.discrepancy_flags set status = 'escalated', nrv_findings = '3 SZVs disagree; photos show 412 not 442' where id = f; get diagnostics n = row_count;
  res := res || jsonb_build_object('t','home-region NRV escalates with findings','pass', n = 1);
  begin update public.discrepancy_flags set status = 'approved' where id = f; res := res || jsonb_build_object('t','NRV cannot approve','pass', false);
  exception when others then res := res || jsonb_build_object('t','NRV cannot approve','pass', true); end;

  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  update public.discrepancy_flags set status = 'ai_done', ai_summary = 'test' where id = f; get diagnostics n = row_count;
  res := res || jsonb_build_object('t','admin moves to ai_done','pass', n = 1);
  begin update public.discrepancy_flags set status = 'approved' where id = f; res := res || jsonb_build_object('t','admin (not super) cannot approve','pass', false);
  exception when others then res := res || jsonb_build_object('t','admin (not super) cannot approve','pass', true); end;

  perform set_config('request.jwt.claims', json_build_object('sub', u_super, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  update public.discrepancy_flags set status = 'approved', decision_note = 'overwrite after AI re-check' where id = f; get diagnostics n = row_count;
  res := res || jsonb_build_object('t','superadmin approves','pass', n = 1);
  execute 'reset role';
  select count(*) into n from public.discrepancy_flags where id = f and decided_by = u_super and decided_at is not null and nrv_public_id = pid2;
  res := res || jsonb_build_object('t','decision and NRV reviewer recorded','pass', n = 1);

  perform setval('public.verifier_public_seq', seq_keep.last_value, seq_keep.is_called);
  raise exception 'RESULTS:%', res;
end $$;
