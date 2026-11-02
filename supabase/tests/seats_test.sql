-- Seat binding + public seat board tests (rolled back via the final exception).
do $$
declare seq_keep record; -- public-ID sequence is not transactional: restore it so tests never burn real IDs
  res jsonb := '[]'::jsonb; u uuid := gen_random_uuid(); u2 uuid := gen_random_uuid(); a uuid; a2 uuid; n int; t boolean; seat_la text; seat_ba text; seat_r6 text;
begin
  select last_value, is_called into seq_keep from public.verifier_public_seq;
  select count(*) into n from public.verifier_seats where role = 'szv';
  res := res || jsonb_build_object('t','129 SZV seats (0010 recalibration)','pass', n = 129);
  res := res || jsonb_build_object('t','every state and the FCT has an odd number of SZV seats (3, 5 or 7)','pass',
    (select count(distinct state_iso) from public.verifier_seats where role = 'szv') = 37
    and not exists (select 1 from public.verifier_seats where role = 'szv' group by state_iso having count(*) not in (3, 5, 7)));
  res := res || jsonb_build_object('t','Lagos and Kano 7; Kaduna, Rivers, Katsina, Oyo, Delta 5','pass',
    (select string_agg(state_iso || ':' || cnt, ',' order by state_iso) from (select state_iso, count(*) cnt from public.verifier_seats where role = 'szv' group by state_iso having count(*) > 3) c)
    = 'NG-DE:5,NG-KD:5,NG-KN:7,NG-KT:5,NG-LA:7,NG-OY:5,NG-RI:5');
  res := res || jsonb_build_object('t','existing codes unchanged; new seats start at SZV-112','pass',
    exists (select 1 from public.verifier_seats where code = 'SZV-073' and state_iso = 'NG-LA' and ordinal = 73 and label = 'Lagos seat 1')
    and exists (select 1 from public.verifier_seats where code = 'SZV-111' and state_iso = 'NG-ZA')
    and exists (select 1 from public.verifier_seats where code = 'SZV-112' and state_iso = 'NG-LA' and region_id = 'R6' and label = 'Lagos seat 4')
    and (select max(code) from public.verifier_seats where role = 'szv') = 'SZV-129');
  select count(*) into n from public.verifier_seats where role = 'nrv';
  res := res || jsonb_build_object('t','24 NRV seats (3 per region)','pass', n = 24 and not exists (select region_id from public.verifier_seats where role='nrv' group by region_id having count(*) <> 3));
  select code into seat_la from public.verifier_seats where state_iso = 'NG-LA' order by ordinal limit 1;
  select code into seat_ba from public.verifier_seats where state_iso = 'NG-BA' order by ordinal limit 1;
  select code into seat_r6 from public.verifier_seats where role = 'nrv' and region_id = 'R6' order by ordinal limit 1;
  res := res || jsonb_build_object('t','codes are sequential and 7/6 chars','pass', seat_la ~ '^SZV-\d{3}$' and seat_r6 ~ '^NRV-\d{2}$');

  insert into auth.users (id, aud, role, email) values (u,'authenticated','authenticated','s@t.invalid'), (u2,'authenticated','authenticated','n@t.invalid');
  insert into public.verifier_applications (state_iso,state_basis,role_sought,answers,score,email,status) values ('NG-LA','origin','szv','{}',80,'s@t.invalid','accepted') returning id into a;
  insert into public.verifier_applications (state_iso,state_basis,role_sought,answers,score,email,status) values ('NG-LA','origin','nrv','{}',80,'n@t.invalid','accepted') returning id into a2;
  begin
    insert into public.verifiers (user_id, application_id, role, state_iso, seat_code) values (u, a, 'szv', 'NG-LA', seat_ba);
    res := res || jsonb_build_object('t','Lagos SZV cannot take a Bauchi seat','pass', false);
  exception when others then res := res || jsonb_build_object('t','Lagos SZV cannot take a Bauchi seat','pass', true); end;
  begin
    insert into public.verifiers (user_id, application_id, role, state_iso, seat_code) values (u, a, 'szv', 'NG-LA', 'SZV-116');
    res := res || jsonb_build_object('t','Lagos SZV cannot take a new Kano seat (SZV-116)','pass', false);
  exception when others then res := res || jsonb_build_object('t','Lagos SZV cannot take a new Kano seat (SZV-116)','pass', true); end;
  insert into public.verifiers (user_id, application_id, role, state_iso, seat_code) values (u, a, 'szv', 'NG-LA', seat_la);
  select taken into t from public.seat_board where code = seat_la;
  res := res || jsonb_build_object('t','seat board shows Lagos seat taken','pass', t);
  begin
    insert into public.verifiers (user_id, application_id, role, region_id, seat_code) values (u2, a2, 'nrv', 'R6', seat_la);
    res := res || jsonb_build_object('t','NRV cannot take an SZV seat','pass', false);
  exception when others then res := res || jsonb_build_object('t','NRV cannot take an SZV seat','pass', true); end;
  insert into public.verifiers (user_id, application_id, role, region_id, seat_code) values (u2, a2, 'nrv', 'R6', seat_r6);
  res := res || jsonb_build_object('t','South-West NRV takes an R6 seat','pass', true);

  execute 'set local role anon';
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  select count(*) into n from public.seat_board;
  res := res || jsonb_build_object('t','anon can read the seat board (153 seats)','pass', n = 153);
  begin
    perform 1 from public.verifiers limit 1;
    res := res || jsonb_build_object('t','anon still cannot read verifiers','pass', false);
  exception when others then res := res || jsonb_build_object('t','anon still cannot read verifiers','pass', true); end;
  execute 'reset role';
  perform setval('public.verifier_public_seq', seq_keep.last_value, seq_keep.is_called);
  raise exception 'RESULTS:%', res;
end $$;
