-- Tests for 0008: application intake + sign-in link checks. Rolled back by the final exception.
do $$
declare seq_keep record; res jsonb := '[]'::jsonb; r record; t text; n int;
  u_ok uuid := gen_random_uuid(); u_off uuid := gen_random_uuid(); a uuid;
begin
  select last_value, is_called into seq_keep from public.verifier_public_seq;
  select * into r from public.application_submit('Ada Test', 'Ada@T.invalid', 'NG-LA', 'origin', 'szv', '{"q1":"no"}', 'eligible', 100, 'vh1', '1234', 'PN-TEST', 'ip1');
  res := res || jsonb_build_object('t','eligible application stored','pass', r.result = 'ok' and r.application_id is not null);
  select count(*) into n from public.verifier_applications where id = r.application_id and email = 'ada@t.invalid' and consent_at is not null and privacy_version = 'PN-TEST' and status = 'eligible';
  res := res || jsonb_build_object('t','email normalised, consent and notice version recorded','pass', n = 1);
  select * into r from public.application_submit('Ada Again', ' ada@t.INVALID ', 'NG-LA', 'origin', 'szv', '{}', 'eligible', 100, 'vh2', '5678', 'PN-TEST', 'ip2');
  res := res || jsonb_build_object('t','one application per email','pass', r.result = 'duplicate_email');
  select * into r from public.application_submit('Other Person', 'other@t.invalid', 'NG-LA', 'origin', 'szv', '{}', 'eligible', 100, 'vh1', '1234', 'PN-TEST', 'ip3');
  res := res || jsonb_build_object('t','one application per voter card','pass', r.result = 'duplicate_card');
  begin perform public.application_submit('No Consent', 'nc@t.invalid', 'NG-LA', 'origin', 'szv', '{}', 'eligible', 100, null, null, null, 'ip4'); res := res || jsonb_build_object('t','consent required','pass', false);
  exception when others then res := res || jsonb_build_object('t','consent required','pass', true); end;
  begin perform public.application_submit('Not Eligible', 'ne@t.invalid', 'NG-LA', 'origin', 'szv', '{}', 'ineligible', 0, null, null, 'PN-TEST', 'ip4'); res := res || jsonb_build_object('t','ineligible answers are never stored','pass', false);
  exception when others then res := res || jsonb_build_object('t','ineligible answers are never stored','pass', true); end;
  for i in 1..5 loop perform public.application_submit('Rate ' || i, 'rate' || i || '@t.invalid', 'NG-OY', 'residence', 'nrv', '{}', 'submitted', 50, null, null, 'PN-TEST', 'ip-flood'); end loop;
  select * into r from public.application_submit('Rate Six', 'rate6@t.invalid', 'NG-OY', 'residence', 'nrv', '{}', 'eligible', 100, null, null, 'PN-TEST', 'ip-flood');
  res := res || jsonb_build_object('t','5 applications per IP per day','pass', r.result = 'rate_limited');
  begin select count(*) into n from public.verifier_applications; execute 'set local role anon'; select count(*) into n from public.verifier_applications; res := res || jsonb_build_object('t','anon cannot read applications','pass', false);
  exception when others then res := res || jsonb_build_object('t','anon cannot read applications','pass', true); end;
  execute 'reset role';

  -- sign-in links
  insert into auth.users (id, aud, role, email) values (u_ok,'authenticated','authenticated','ok@t.invalid'),(u_off,'authenticated','authenticated','off@t.invalid');
  insert into public.verifier_applications (state_iso,state_basis,role_sought,answers,score,email,status,full_name) values ('NG-LA','origin','szv','{}',1,'ok@t.invalid','accepted','Ok Person') returning id into a;
  insert into public.verifiers (user_id, application_id, role, state_iso, active) values (u_ok, a, 'szv', 'NG-LA', true);
  insert into public.verifiers (user_id, role, active) values (u_off, 'admin', false);
  t := public.auth_link_check('OK@t.invalid', 'e-ok', 'ip-l');
  res := res || jsonb_build_object('t','active verifier gets a link (any case)','pass', t = 'ok');
  t := public.auth_link_check('off@t.invalid', 'e-off', 'ip-l');
  res := res || jsonb_build_object('t','inactive account gets none','pass', t = 'none');
  t := public.auth_link_check('nobody@t.invalid', 'e-no', 'ip-l');
  res := res || jsonb_build_object('t','unknown email gets none','pass', t = 'none');
  update auth.users set banned_until = now() + interval '100 years' where id = u_ok;
  t := public.auth_link_check('ok@t.invalid', 'e-ok', 'ip-m');
  res := res || jsonb_build_object('t','banned (released) account gets none','pass', t = 'none');
  t := public.auth_link_check('ok@t.invalid', 'e-ok', 'ip-n');   -- third request for this email: still allowed
  t := public.auth_link_check('ok@t.invalid', 'e-ok', 'ip-o');   -- fourth: refused
  res := res || jsonb_build_object('t','3 links per email per 15 min (4th refused)','pass', t = 'rate_limited');

  perform setval('public.verifier_public_seq', seq_keep.last_value, seq_keep.is_called);
  raise exception 'RESULTS:%', res;
end $$;
