-- 0010: SZV seat recalibration (owner-approved, session 54; rule and figures in docs/SZV-SEAT-PROPOSAL.md).
-- Builds forward on 0004: SZV-001…SZV-111 are unchanged, so issued codes and the public seat history stay valid.
-- 18 new seats, SZV-112…SZV-129, for the seven states with the largest share of INEC's 2023 register:
-- at least 2× the average state share → 7 seats (Lagos, Kano); at least 1.25× → 5 (Kaduna, Rivers, Katsina, Oyo, Delta);
-- every other state keeps 3. Every state count stays odd, so a state vote cannot tie. NRV is unchanged (24).
-- Idempotent. The checks at the end abort the whole file (and roll back the inserts) if the result is not exactly right.
insert into public.verifier_seats (code, role, state_iso, region_id, ordinal, label) values
  ('SZV-112', 'szv', 'NG-LA', 'R6', 112, 'Lagos seat 4'),
  ('SZV-113', 'szv', 'NG-LA', 'R6', 113, 'Lagos seat 5'),
  ('SZV-114', 'szv', 'NG-LA', 'R6', 114, 'Lagos seat 6'),
  ('SZV-115', 'szv', 'NG-LA', 'R6', 115, 'Lagos seat 7'),
  ('SZV-116', 'szv', 'NG-KN', 'R2', 116, 'Kano seat 4'),
  ('SZV-117', 'szv', 'NG-KN', 'R2', 117, 'Kano seat 5'),
  ('SZV-118', 'szv', 'NG-KN', 'R2', 118, 'Kano seat 6'),
  ('SZV-119', 'szv', 'NG-KN', 'R2', 119, 'Kano seat 7'),
  ('SZV-120', 'szv', 'NG-KD', 'R2', 120, 'Kaduna seat 4'),
  ('SZV-121', 'szv', 'NG-KD', 'R2', 121, 'Kaduna seat 5'),
  ('SZV-122', 'szv', 'NG-RI', 'R8', 122, 'Rivers seat 4'),
  ('SZV-123', 'szv', 'NG-RI', 'R8', 123, 'Rivers seat 5'),
  ('SZV-124', 'szv', 'NG-KT', 'R2', 124, 'Katsina seat 4'),
  ('SZV-125', 'szv', 'NG-KT', 'R2', 125, 'Katsina seat 5'),
  ('SZV-126', 'szv', 'NG-OY', 'R6', 126, 'Oyo seat 4'),
  ('SZV-127', 'szv', 'NG-OY', 'R6', 127, 'Oyo seat 5'),
  ('SZV-128', 'szv', 'NG-DE', 'R8', 128, 'Delta seat 4'),
  ('SZV-129', 'szv', 'NG-DE', 'R8', 129, 'Delta seat 5')
on conflict (code) do nothing;

do $$
declare bad text;
begin
  if (select count(*) from public.verifier_seats where role = 'szv') <> 129 then raise exception 'expected 129 SZV seats, found %', (select count(*) from public.verifier_seats where role = 'szv'); end if;
  if (select count(*) from public.verifier_seats where role = 'nrv') <> 24 then raise exception 'NRV seats must stay at 24'; end if;
  select string_agg(state_iso || '=' || n, ', ') into bad from (select state_iso, count(*) n from public.verifier_seats where role = 'szv' group by state_iso) c
    where n <> case state_iso when 'NG-LA' then 7 when 'NG-KN' then 7 when 'NG-KD' then 5 when 'NG-RI' then 5 when 'NG-KT' then 5 when 'NG-OY' then 5 when 'NG-DE' then 5 else 3 end;
  if bad is not null then raise exception 'unexpected SZV seats per state: %', bad; end if;
  if (select count(distinct state_iso) from public.verifier_seats where role = 'szv') <> 37 then raise exception 'every state and the FCT must have SZV seats'; end if;
end $$;
