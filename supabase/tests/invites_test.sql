-- Tests for 0007: invite codes, claim, typed-name pledge, release, seat history, MFA for admins.
-- Everything is rolled back by the final exception; the public-ID sequence is restored.
do $$
declare seq_keep record;
  res jsonb := '[]'::jsonb;
  u_boss uuid := gen_random_uuid(); u_ops uuid := gen_random_uuid(); u_new uuid := gen_random_uuid(); u_new2 uuid := gen_random_uuid();
  app uuid; app_ba uuid; app2 uuid; r record; n int; ok boolean; pid text; pid2 text; f uuid; seat text;
begin
  select last_value, is_called into seq_keep from public.verifier_public_seq;
  insert into auth.users (id, aud, role, email) values (u_ops,'authenticated','authenticated','ops@t.invalid'),
    (u_new,'authenticated','authenticated','ade@t.invalid'),(u_new2,'authenticated','authenticated','bo@t.invalid');
  -- since 0009 only the locked address can be BinchikAdmin: tests use the real record (rolled back)
  select user_id into u_boss from public.verifiers where role = 'superadmin';
  insert into public.verifiers (user_id, role, ops_seat) values (u_ops, 'admin', (select code from public.ops_seats o where not exists (select 1 from public.verifiers v where v.ops_seat = o.code) order by code limit 1));
  -- a free Lagos seat (tests must not depend on live data)
  select s.code into seat from public.verifier_seats s where s.state_iso = 'NG-LA' and not exists (select 1 from public.verifiers v where v.seat_code = s.code)
    and not exists (select 1 from public.verifier_offers o where o.seat_code = s.code and o.status in ('pending_send','sent','claimed')) order by s.code limit 1;
  insert into public.verifier_applications (state_iso,state_basis,role_sought,answers,score,email,status,full_name)
    values ('NG-LA','origin','szv','{}',90,'Ade@T.invalid','eligible','Adébáyọ̀ Ọlá-Ojo') returning id into app;
  insert into public.verifier_applications (state_iso,state_basis,role_sought,answers,score,email,status,full_name)
    values ('NG-BA','origin','szv','{}',90,'ba@t.invalid','eligible','Bauchi Person') returning id into app_ba;

  -- invite creation
  begin perform public.invite_create(seat, app, 'h1', u_ops, 24); res := res || jsonb_build_object('t','OpsAdmin cannot invite','pass', false);
  exception when others then res := res || jsonb_build_object('t','OpsAdmin cannot invite','pass', sqlerrm like '%only the BinchikAdmin%'); end;
  begin perform public.invite_create(seat, app_ba, 'h1', u_boss, 24); res := res || jsonb_build_object('t','applicant from another state refused','pass', false);
  exception when others then res := res || jsonb_build_object('t','applicant from another state refused','pass', true); end;
  select * into r from public.invite_create(seat, app, 'h1', u_boss, 24);
  res := res || jsonb_build_object('t','BinchikAdmin invites eligible applicant to a free seat','pass', r.seat_code = seat and r.email = 'Ade@T.invalid' and r.area = 'Lagos');
  select count(*) into n from public.verifier_applications where id = app and status = 'offered';
  res := res || jsonb_build_object('t','application moves to offered','pass', n = 1);
  begin perform public.invite_create(seat, app, 'h2', u_boss, 24); res := res || jsonb_build_object('t','second live invite on same seat refused','pass', false);
  exception when others then res := res || jsonb_build_object('t','second live invite on same seat refused','pass', true); end;
  select count(*) into n from public.seat_board where code = seat and pending and not taken;
  res := res || jsonb_build_object('t','seat board shows pending, not taken','pass', n = 1);

  -- code check + rate limit
  select * into r from public.invite_check('h1', 'ip-a');
  res := res || jsonb_build_object('t','valid code shows seat and area only','pass', r.result = 'ok' and r.seat_code = seat and r.area = 'Lagos');
  for i in 1..10 loop perform public.invite_check('wrong' || i, 'ip-b'); end loop;
  select * into r from public.invite_check('h1', 'ip-b');
  res := res || jsonb_build_object('t','10 wrong codes from one IP: even a valid code is rate limited','pass', r.result = 'rate_limited');

  -- claim checks
  select * into r from public.invite_claim_check('h1', 'someone@else.invalid', 'NG-LA', 'ip-c');
  res := res || jsonb_build_object('t','wrong email refused','pass', r.result = 'email_mismatch');
  select * into r from public.invite_claim_check('h1', 'ade@t.invalid', 'NG-OG', 'ip-c');
  res := res || jsonb_build_object('t','wrong state refused','pass', r.result = 'area_mismatch');
  select * into r from public.invite_claim_check('h1', '  ADE@t.invalid ', 'NG-LA', 'ip-c');
  res := res || jsonb_build_object('t','matching email (any case) and state accepted','pass', r.result = 'ok' and r.offer_id is not null);
  select * into r from public.invite_claim_finish(r.offer_id, u_new, 'c1');
  pid := r.public_id;
  select count(*) into n from public.verifiers where user_id = u_new and seat_code = seat and not active and state_iso = 'NG-LA' and public_id = pid;
  res := res || jsonb_build_object('t','claim binds seat, issues public ID, stays inactive','pass', n = 1);
  begin perform public.invite_claim_finish((select id from public.verifier_offers where code_hash = 'h1'), u_new2, 'c2'); res := res || jsonb_build_object('t','code works once','pass', false);
  exception when others then res := res || jsonb_build_object('t','code works once','pass', true); end;

  -- unpledged verifier cannot act
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', u_new, 'role','authenticated')::text, true);
  begin insert into public.discrepancy_flags (pu_code, race, reason) values ('24-01-01-001','president','test flag before pledge'); res := res || jsonb_build_object('t','unpledged verifier cannot raise flags','pass', false);
  exception when others then res := res || jsonb_build_object('t','unpledged verifier cannot raise flags','pass', true); end;
  begin select count(*) into n from public.verifier_pledges; res := res || jsonb_build_object('t','verifiers cannot read pledges','pass', false);
  exception when others then res := res || jsonb_build_object('t','verifiers cannot read pledges','pass', true); end;
  execute 'reset role';

  -- pledge
  select * into r from public.pledge_preview('c1');
  res := res || jsonb_build_object('t','pledge preview renders seat and area','pass', r.version = 'P-2026-2' and r.body like 'I accept seat ' || seat || ' as a volunteer verifier for Lagos.%' and length(r.sha256) = 64);
  select * into r from public.pledge_sign('c1', 'Somebody Else', 'P-2026-2');
  res := res || jsonb_build_object('t','typed name must match the application','pass', r.result = 'name_mismatch');
  select * into r from public.pledge_sign('c1', 'adebayo ola ojo', 'P-2026-2');
  res := res || jsonb_build_object('t','name matches ignoring accents, case, hyphens','pass', r.result = 'ok' and r.seat_code = seat and r.public_id = pid);
  select count(*) into n from public.verifiers where user_id = u_new and active and pledged_at is not null;
  select exists (select 1 from public.verifier_pledges where public_id = pid and typed_name = 'adebayo ola ojo' and pledge_sha256 = (select sha256 from public.pledge_texts where version = 'P-2026-2')) into ok;
  res := res || jsonb_build_object('t','pledge activates seat and stores typed name + text hash','pass', n = 1 and ok);
  select * into r from public.pledge_sign('c1', 'adebayo ola ojo', 'P-2026-2');
  res := res || jsonb_build_object('t','confirmation link works once','pass', r.result = 'invalid');
  select count(*) into n from public.seat_board where code = seat and taken and not pending;
  res := res || jsonb_build_object('t','seat board shows taken','pass', n = 1);
  select count(*) into n from public.seat_events_public where seat_code = seat and event in ('invited','claimed','pledged');
  res := res || jsonb_build_object('t','public seat history: invited, claimed, pledged','pass', n = 3);

  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', u_new, 'role','authenticated')::text, true);
  insert into public.discrepancy_flags (pu_code, race, reason) values ('24-01-01-001','president','pledged SZV raises a flag') returning id into f;
  res := res || jsonb_build_object('t','pledged SZV can raise flags in own state','pass', f is not null);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';
  select count(*) into n from public.seat_events_public;
  res := res || jsonb_build_object('t','anon reads public seat history','pass', n >= 3);
  begin select count(*) into n from public.seat_events; res := res || jsonb_build_object('t','anon cannot read reasons table','pass', false);
  exception when others then res := res || jsonb_build_object('t','anon cannot read reasons table','pass', true); end;

  -- MFA for admins
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', u_boss, 'role','authenticated','aal','aal1')::text, true);
  select count(*) into n from public.discrepancy_flags where id = f;
  res := res || jsonb_build_object('t','BinchikAdmin without MFA sees no flags','pass', n = 0);
  select count(*) into n from public.pledge_record(pid);
  res := res || jsonb_build_object('t','BinchikAdmin without MFA cannot read pledge','pass', n = 0);
  perform set_config('request.jwt.claims', json_build_object('sub', u_ops, 'role','authenticated','aal','aal2')::text, true);
  select count(*) into n from public.pledge_record(pid);
  res := res || jsonb_build_object('t','OpsAdmin (even with MFA) cannot read pledge','pass', n = 0);
  perform set_config('request.jwt.claims', json_build_object('sub', u_boss, 'role','authenticated','aal','aal2')::text, true);
  select count(*) into n from public.discrepancy_flags where id = f;
  select exists (select 1 from public.pledge_record(pid) where typed_name = 'adebayo ola ojo') into ok;
  res := res || jsonb_build_object('t','BinchikAdmin with MFA sees flags and pledge','pass', n = 1 and ok);
  execute 'reset role';

  -- release + reassign
  begin perform public.seat_release(seat, 'broke the neutrality rule', u_ops); res := res || jsonb_build_object('t','OpsAdmin cannot release','pass', false);
  exception when others then res := res || jsonb_build_object('t','OpsAdmin cannot release','pass', true); end;
  begin perform public.seat_release(seat, 'short', u_boss); res := res || jsonb_build_object('t','release needs a reason','pass', false);
  exception when others then res := res || jsonb_build_object('t','release needs a reason','pass', true); end;
  select * into r from public.seat_release(seat, 'broke the neutrality rule (test)', u_boss);
  res := res || jsonb_build_object('t','BinchikAdmin releases seat','pass', r.released_user = u_new and r.public_id = pid);
  select count(*) into n from public.verifiers where user_id = u_new and not active and seat_code is null;
  res := res || jsonb_build_object('t','released verifier is inactive and unbound','pass', n = 1);
  select count(*) into n from public.seat_board where code = seat and not taken and not pending;
  res := res || jsonb_build_object('t','seat is open again','pass', n = 1);
  insert into public.verifier_applications (state_iso,state_basis,role_sought,answers,score,email,status,full_name)
    values ('NG-LA','residence','szv','{}',70,'bo@t.invalid','eligible','Bo Second') returning id into app2;
  perform public.invite_create(seat, app2, 'h3', u_boss, 6);
  select * into r from public.invite_claim_check('h3', 'bo@t.invalid', 'NG-LA', 'ip-d');
  select * into r from public.invite_claim_finish(r.offer_id, u_new2, 'c3');
  pid2 := r.public_id;
  res := res || jsonb_build_object('t','reassigned seat gets a new public ID (old one retired)','pass', pid2 <> pid);
  select count(*) into n from public.verifier_offers where code_hash = 'h3' and window_hours = 6 and wave = 2;
  res := res || jsonb_build_object('t','backfill invite has a 6 h window','pass', n = 1);

  -- expiry + attempts
  update public.verifier_offers set confirm_expires_at = now() - interval '1 minute' where code_hash = 'h3';
  perform public.invites_expire();
  select count(*) into n from public.verifiers where user_id = u_new2 and seat_code is null and not active;
  res := res || jsonb_build_object('t','unpledged claim expires and frees the seat','pass', n = 1);
  update public.verifier_applications set status = 'eligible' where id = app2;
  perform public.invite_create(seat, app2, 'h4', u_boss, 24);
  for i in 1..5 loop perform public.invite_claim_check('h4', 'wrong@t.invalid', 'NG-LA', 'ip-e' || i); end loop;
  select count(*) into n from public.verifier_offers where code_hash = 'h4' and status = 'revoked' and attempts = 5;
  res := res || jsonb_build_object('t','5 wrong claim attempts revoke the code','pass', n = 1);
  update public.verifier_offers set expires_at = now() - interval '1 second' where code_hash = 'h1';
  select * into r from public.invite_check('h4', 'ip-f');
  res := res || jsonb_build_object('t','revoked code is invalid','pass', r.result = 'invalid');

  -- append-only history
  begin update public.seat_events set reason = 'x' where seat_code = seat; res := res || jsonb_build_object('t','seat history cannot be edited','pass', false);
  exception when others then res := res || jsonb_build_object('t','seat history cannot be edited','pass', true); end;
  begin delete from public.seat_events where seat_code = seat; res := res || jsonb_build_object('t','seat history cannot be deleted','pass', false);
  exception when others then res := res || jsonb_build_object('t','seat history cannot be deleted','pass', true); end;

  perform setval('public.verifier_public_seq', seq_keep.last_value, seq_keep.is_called);
  raise exception 'RESULTS:%', res;
end $$;
