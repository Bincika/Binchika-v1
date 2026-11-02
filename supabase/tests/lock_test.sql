-- Tests for 0009: BinchikAdmin email lock, three OpsAdmin seats, NRV / SZV type codes, seat emails locked.
-- Everything is rolled back by the final exception; the public-ID sequence is restored.
do $$
declare seq_keep record;
  res jsonb := '[]'::jsonb;
  u_boss uuid; u_x uuid := gen_random_uuid(); u_ops uuid := gen_random_uuid(); u_ops2 uuid := gen_random_uuid();
  u_s uuid := gen_random_uuid(); u_n uuid := gen_random_uuid(); u_s2 uuid := gen_random_uuid();
  app_s uuid; app_n uuid; app_s2 uuid; r record; n int; ok boolean; pid text; seats jsonb; la_open text; la_taken text; ops text;
begin
  select last_value, is_called into seq_keep from public.verifier_public_seq;
  select user_id into u_boss from public.verifiers where role = 'superadmin';
  res := res || jsonb_build_object('t','exactly one BinchikAdmin, bound to the locked address','pass',
    (select count(*) from public.verifiers v join auth.users u on u.id = v.user_id where v.role = 'superadmin' and public.is_locked_admin_email(u.email)) = 1
    and (select count(*) from public.verifiers where role = 'superadmin') = 1);
  insert into auth.users (id, aud, role, email) values (u_x,'authenticated','authenticated','x@t.invalid'),(u_ops,'authenticated','authenticated','ops@t.invalid'),
    (u_ops2,'authenticated','authenticated','ops2@t.invalid'),(u_s,'authenticated','authenticated','s@t.invalid'),(u_n,'authenticated','authenticated','n@t.invalid'),
    (u_s2,'authenticated','authenticated','s2@t.invalid');

  -- the lock
  begin update public.superadmin_lock set email_sha256 = repeat('0', 64); res := res || jsonb_build_object('t','lock cannot be edited','pass', false);
  exception when others then res := res || jsonb_build_object('t','lock cannot be edited','pass', sqlerrm like '%cannot be changed%'); end;
  begin delete from public.superadmin_lock; res := res || jsonb_build_object('t','lock cannot be deleted','pass', false);
  exception when others then res := res || jsonb_build_object('t','lock cannot be deleted','pass', true); end;
  begin insert into public.verifiers (user_id, role) values (u_x, 'superadmin'); res := res || jsonb_build_object('t','any other email refused as BinchikAdmin','pass', false);
  exception when others then res := res || jsonb_build_object('t','any other email refused as BinchikAdmin','pass', sqlerrm like '%locked BinchikAdmin address%'); end;
  begin update public.verifiers set role = 'admin' where user_id = u_boss; res := res || jsonb_build_object('t','BinchikAdmin role cannot change','pass', false);
  exception when others then res := res || jsonb_build_object('t','BinchikAdmin role cannot change','pass', true); end;
  begin update auth.users set email = 'other@t.invalid' where id = u_boss; res := res || jsonb_build_object('t','BinchikAdmin email cannot change','pass', false);
  exception when others then res := res || jsonb_build_object('t','BinchikAdmin email cannot change','pass', sqlerrm like '%locked to its seat%'); end;

  -- OpsAdmin seats
  select count(*) into n from public.ops_seats;
  res := res || jsonb_build_object('t','exactly three OPS seats','pass', n = 3);
  begin insert into public.ops_seats (code, ordinal, label) values ('OPS-4', 4, 'x'); res := res || jsonb_build_object('t','a fourth OPS seat cannot be added','pass', false);
  exception when others then res := res || jsonb_build_object('t','a fourth OPS seat cannot be added','pass', true); end;
  begin insert into public.verifiers (user_id, role) values (u_ops, 'admin'); res := res || jsonb_build_object('t','active OpsAdmin without an OPS seat refused','pass', false);
  exception when others then res := res || jsonb_build_object('t','active OpsAdmin without an OPS seat refused','pass', sqlerrm like '%three OPS seats%'); end;
  select code into ops from public.ops_seats o where not exists (select 1 from public.verifiers v where v.ops_seat = o.code) order by code limit 1;
  begin perform public.ops_assign(ops, u_ops, u_x); res := res || jsonb_build_object('t','only the BinchikAdmin appoints OpsAdmins','pass', false);
  exception when others then res := res || jsonb_build_object('t','only the BinchikAdmin appoints OpsAdmins','pass', sqlerrm like '%only the BinchikAdmin%'); end;
  begin perform public.ops_assign('OPS-9', u_ops, u_boss); res := res || jsonb_build_object('t','no seat beyond OPS-3','pass', false);
  exception when others then res := res || jsonb_build_object('t','no seat beyond OPS-3','pass', true); end;
  begin perform public.ops_assign(ops, u_boss, u_boss); res := res || jsonb_build_object('t','BinchikAdmin cannot also be OpsAdmin','pass', false);
  exception when others then res := res || jsonb_build_object('t','BinchikAdmin cannot also be OpsAdmin','pass', true); end;
  select * into r from public.ops_assign(ops, u_ops, u_boss);
  res := res || jsonb_build_object('t','BinchikAdmin appoints an OpsAdmin to a free OPS seat','pass', r.seat_code = ops and r.public_id ~ '^V');
  select count(*) into n from public.seat_events where seat_code = ops and event = 'appointed';
  res := res || jsonb_build_object('t','appointment recorded in seat history','pass', n = 1);
  begin perform public.ops_assign(ops, u_ops2, u_boss); res := res || jsonb_build_object('t','a held OPS seat cannot be given twice','pass', false);
  exception when others then res := res || jsonb_build_object('t','a held OPS seat cannot be given twice','pass', true); end;
  begin update public.verifiers set role = 'superadmin' where user_id = u_ops; res := res || jsonb_build_object('t','OpsAdmin cannot be raised to BinchikAdmin (as postgres)','pass', false);
  exception when others then res := res || jsonb_build_object('t','OpsAdmin cannot be raised to BinchikAdmin (as postgres)','pass', true); end;
  begin update auth.users set email = 'new@t.invalid' where id = u_ops; res := res || jsonb_build_object('t','OpsAdmin email locked','pass', false);
  exception when others then res := res || jsonb_build_object('t','OpsAdmin email locked','pass', true); end;
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', u_ops, 'role','authenticated','aal','aal2')::text, true);
  begin update public.verifiers set role = 'superadmin' where user_id = u_ops; get diagnostics n = row_count; res := res || jsonb_build_object('t','OpsAdmin cannot self-escalate (API role)','pass', n = 0);
  exception when others then res := res || jsonb_build_object('t','OpsAdmin cannot self-escalate (API role)','pass', true); end;
  select public.is_admin() and not public.is_superadmin() into ok;
  res := res || jsonb_build_object('t','OpsAdmin with MFA is admin, never superadmin','pass', ok);
  execute 'reset role';
  begin perform public.seat_release(ops, 'not allowed to do this', u_ops); res := res || jsonb_build_object('t','OpsAdmin cannot release an OPS seat','pass', false);
  exception when others then res := res || jsonb_build_object('t','OpsAdmin cannot release an OPS seat','pass', true); end;
  select * into r from public.seat_release(ops, 'test: stepping down from OPS', u_boss);
  select count(*) into n from public.verifiers where user_id = u_ops and not active and ops_seat is null;
  res := res || jsonb_build_object('t','BinchikAdmin releases an OPS seat','pass', r.released_user = u_ops and n = 1);
  begin perform public.ops_assign(ops, u_ops, u_boss); res := res || jsonb_build_object('t','a released account cannot be re-appointed','pass', false);
  exception when others then res := res || jsonb_build_object('t','a released account cannot be re-appointed','pass', true); end;

  -- invite codes: OPS seats never; SZV / NRV type codes let the invitee pick an open seat in their area
  insert into public.verifier_applications (state_iso,state_basis,role_sought,answers,score,email,status,full_name)
    values ('NG-LA','origin','szv','{}',100,'s@t.invalid','eligible','Sade Lagos') returning id into app_s;
  insert into public.verifier_applications (state_iso,state_basis,role_sought,answers,score,email,status,full_name)
    values ('NG-OY','origin','nrv','{}',100,'n@t.invalid','eligible','Niyi Oyo') returning id into app_n;
  insert into public.verifier_applications (state_iso,state_basis,role_sought,answers,score,email,status,full_name)
    values ('NG-LA','origin','szv','{}',100,'s2@t.invalid','eligible','Second Lagos') returning id into app_s2;
  begin perform public.invite_create('OPS-1', app_s, 'k0', u_boss, 24, 'seat'); res := res || jsonb_build_object('t','OPS seats can never be offered by code','pass', false);
  exception when others then res := res || jsonb_build_object('t','OPS seats can never be offered by code','pass', sqlerrm like '%never by invite code%'); end;
  begin perform public.invite_create(null, app_s, 'k0', u_boss, 24, 'nrv'); res := res || jsonb_build_object('t','code type must match the application','pass', false);
  exception when others then res := res || jsonb_build_object('t','code type must match the application','pass', true); end;
  select * into r from public.invite_create(null, app_s, 'k1', u_boss, 24, 'szv');
  res := res || jsonb_build_object('t','SZV code created without a seat','pass', r.seat_code is null and r.kind = 'szv' and r.area = 'Lagos' and r.open_seats between 1 and (select count(*) from public.verifier_seats where role = 'szv' and state_iso = 'NG-LA'));
  select * into r from public.invite_check('k1', 'ip-l1');
  seats := r.seats;
  res := res || jsonb_build_object('t','SZV code shows only the Lagos SZV seats','pass', r.result = 'ok' and r.kind = 'szv' and jsonb_array_length(seats) = (select count(*) from public.verifier_seats where role = 'szv' and state_iso = 'NG-LA')
    and not exists (select 1 from jsonb_array_elements(seats) e join public.verifier_seats s on s.code = e ->> 'code' where s.role <> 'szv' or s.state_iso <> 'NG-LA'));
  select e ->> 'code' into la_open from jsonb_array_elements(seats) e where (e ->> 'open')::boolean order by 1 limit 1;
  -- take another Lagos seat with a specific-seat code so it shows as taken (greyed)
  select e ->> 'code' into la_taken from jsonb_array_elements(seats) e where (e ->> 'open')::boolean and e ->> 'code' <> la_open order by 1 limit 1;
  perform public.invite_create(la_taken, app_s2, 'k2', u_boss, 24, 'seat');
  select * into r from public.invite_check('k1', 'ip-l1');
  res := res || jsonb_build_object('t','a seat with a live invite shows as not open','pass', exists (select 1 from jsonb_array_elements(r.seats) e where e ->> 'code' = la_taken and not (e ->> 'open')::boolean));
  select * into r from public.invite_claim_check('k1', 's@t.invalid', 'NG-LA', 'ip-l2');
  res := res || jsonb_build_object('t','type code needs a chosen seat','pass', r.result = 'seat_required');
  select * into r from public.invite_claim_check('k1', 's@t.invalid', 'NG-LA', 'ip-l2', la_taken);
  res := res || jsonb_build_object('t','a taken seat cannot be picked','pass', r.result = 'seat_unavailable');
  select * into r from public.invite_claim_check('k1', 's@t.invalid', 'NG-LA', 'ip-l2', 'SZV-058');
  res := res || jsonb_build_object('t','a seat outside the applicant''s state cannot be picked','pass', r.result = 'seat_unavailable');
  select * into r from public.invite_claim_check('k1', 's@t.invalid', 'NG-LA', 'ip-l2', la_open);
  res := res || jsonb_build_object('t','an open seat in the area can be picked','pass', r.result = 'ok');
  select * into r from public.invite_claim_finish(r.offer_id, u_s, 'cs', la_open);
  pid := r.public_id;
  select count(*) into n from public.verifiers where user_id = u_s and seat_code = la_open and role = 'szv' and state_iso = 'NG-LA' and not active;
  res := res || jsonb_build_object('t','claim binds the picked seat (inactive until the pledge)','pass', n = 1 and r.seat_code = la_open);
  begin update public.verifiers set seat_code = la_taken where user_id = u_s; res := res || jsonb_build_object('t','a bound seat cannot be swapped','pass', false);
  exception when others then res := res || jsonb_build_object('t','a bound seat cannot be swapped','pass', true); end;
  begin update auth.users set email = 'swap@t.invalid' where id = u_s; res := res || jsonb_build_object('t','seat holder email locked to the seat','pass', false);
  exception when others then res := res || jsonb_build_object('t','seat holder email locked to the seat','pass', sqlerrm like '%locked to its seat%'); end;

  select * into r from public.invite_create(null, app_n, 'k3', u_boss, 24, 'nrv');
  res := res || jsonb_build_object('t','NRV code covers the applicant''s region','pass', r.kind = 'nrv' and r.area = (select name from public.verifier_regions where id = 'R6'));
  select * into r from public.invite_check('k3', 'ip-n1');
  res := res || jsonb_build_object('t','NRV code shows only the region''s NRV seats','pass', jsonb_array_length(r.seats) = 3
    and not exists (select 1 from jsonb_array_elements(r.seats) e join public.verifier_seats s on s.code = e ->> 'code' where s.role <> 'nrv' or s.region_id <> 'R6'));
  select * into r from public.invite_claim_check('k3', 'n@t.invalid', 'R6', 'ip-n2', la_open);
  res := res || jsonb_build_object('t','an NRV code cannot claim an SZV seat','pass', r.result = 'seat_unavailable');
  begin perform public.invite_revoke((select id from public.verifier_offers where code_hash = 'k3'), u_ops); res := res || jsonb_build_object('t','OpsAdmin cannot revoke a code','pass', false);
  exception when others then res := res || jsonb_build_object('t','OpsAdmin cannot revoke a code','pass', sqlerrm like '%only the BinchikAdmin can revoke%'); end;
  select * into r from public.invite_revoke((select id from public.verifier_offers where code_hash = 'k3'), u_boss);
  select count(*) into n from public.verifier_offers o join public.verifier_applications a on a.id = o.application_id where o.code_hash = 'k3' and o.status = 'revoked' and a.status = 'eligible';
  res := res || jsonb_build_object('t','BinchikAdmin revokes an unclaimed NRV code; applicant eligible again','pass', r.kind = 'nrv' and n = 1);
  perform public.invite_create(null, app_n, 'k4', u_boss, 6, 'nrv');
  update public.verifier_offers set expires_at = now() - interval '1 second' where code_hash = 'k4';
  perform public.invites_expire();
  select count(*) into n from public.verifier_offers where code_hash = 'k4' and status = 'expired';
  res := res || jsonb_build_object('t','unused type code expires cleanly','pass', n = 1);
  perform setval('public.verifier_public_seq', seq_keep.last_value, seq_keep.is_called);
  raise exception 'RESULTS:%', res::text;
end $$;
