-- Keep-alive for the free Supabase plan (paused after 7 days of inactivity).
-- Creates a throwaway table, writes a row, drops it, and returns the time. Callable only with the service role.
create or replace function public.keepalive_ping() returns timestamptz
language plpgsql security definer set search_path = public as $$
declare t timestamptz := now();
begin
  create table if not exists public._keepalive_ping (at timestamptz not null);
  insert into public._keepalive_ping (at) values (t);
  drop table public._keepalive_ping;
  return t;
end $$;
revoke all on function public.keepalive_ping() from public, anon, authenticated;
grant execute on function public.keepalive_ping() to service_role;
