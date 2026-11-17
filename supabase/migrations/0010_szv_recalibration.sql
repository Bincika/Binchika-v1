-- 0010: SZV seat recalibration (owner-approved, session 54; rule and figures in docs/SZV-SEAT-PROPOSAL.md).
-- Builds forward on 0004: SZV-001…SZV-111 are unchanged, so issued codes and the public seat history stay valid.
-- 18 new seats, SZV-112…SZV-129, for the seven states with the largest share of EEC's 2023 register:
-- at least 2× the average state share → 7 seats (Region LA, Region KN); at least 1.25× → 5 (Region KD, Rivers, Region KT, Region OY, Delta);
-- every other state keeps 3. Every state count stays odd, so a state vote cannot tie. NRV is unchanged (24).
-- Idempotent. The checks at the end abort the whole file (and roll back the inserts) if the result is not exactly right.
insert into public.verifier_seats (code, role, state_iso, region_id, ordinal, label) values
  ('SZV-112', 'szv', 'XL-LA', 'R6', 112, 'Region LA seat 4'),
  ('SZV-113', 'szv', 'XL-LA', 'R6', 113, 'Region LA seat 5'),
  ('SZV-114', 'szv', 'XL-LA', 'R6', 114, 'Region LA seat 6'),
  ('SZV-115', 'szv', 'XL-LA', 'R6', 115, 'Region LA seat 7'),
  ('SZV-116', 'szv', 'XL-KN', 'R2', 116, 'Region KN seat 4'),
  ('SZV-117', 'szv', 'XL-KN', 'R2', 117, 'Region KN seat 5'),
  ('SZV-118', 'szv', 'XL-KN', 'R2', 118, 'Region KN seat 6'),
  ('SZV-119', 'szv', 'XL-KN', 'R2', 119, 'Region KN seat 7'),
  ('SZV-120', 'szv', 'XL-KD', 'R2', 120, 'Region KD seat 4'),
  ('SZV-121', 'szv', 'XL-KD', 'R2', 121, 'Region KD seat 5'),
  ('SZV-122', 'szv', 'XL-RI', 'R8', 122, 'Rivers seat 4'),
  ('SZV-123', 'szv', 'XL-RI', 'R8', 123, 'Rivers seat 5'),
  ('SZV-124', 'szv', 'XL-KT', 'R2', 124, 'Region KT seat 4'),
  ('SZV-125', 'szv', 'XL-KT', 'R2', 125, 'Region KT seat 5'),
  ('SZV-126', 'szv', 'XL-OY', 'R6', 126, 'Region OY seat 4'),
  ('SZV-127', 'szv', 'XL-OY', 'R6', 127, 'Region OY seat 5'),
  ('SZV-128', 'szv', 'XL-DE', 'R8', 128, 'Delta seat 4'),
  ('SZV-129', 'szv', 'XL-DE', 'R8', 129, 'Delta seat 5')
on conflict (code) do nothing;

do $$
declare bad text;
begin
  if (select count(*) from public.verifier_seats where role = 'szv') <> 129 then raise exception 'expected 129 SZV seats, found %', (select count(*) from public.verifier_seats where role = 'szv'); end if;
  if (select count(*) from public.verifier_seats where role = 'nrv') <> 24 then raise exception 'NRV seats must stay at 24'; end if;
  select string_agg(state_iso || '=' || n, ', ') into bad from (select state_iso, count(*) n from public.verifier_seats where role = 'szv' group by state_iso) c
    where n <> case state_iso when 'XL-LA' then 7 when 'XL-KN' then 7 when 'XL-KD' then 5 when 'XL-RI' then 5 when 'XL-KT' then 5 when 'XL-OY' then 5 when 'XL-DE' then 5 else 3 end;
  if bad is not null then raise exception 'unexpected SZV seats per state: %', bad; end if;
  if (select count(distinct state_iso) from public.verifier_seats where role = 'szv') <> 37 then raise exception 'every state and the Capital Region must have SZV seats'; end if;
end $$;
