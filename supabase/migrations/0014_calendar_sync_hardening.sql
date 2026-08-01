-- Harden Calendar synchronization after production review.

alter table public.calendar_event_links
  drop constraint if exists calendar_event_links_status_check;
alter table public.calendar_event_links
  add constraint calendar_event_links_status_check
  check (status in ('active', 'deleted', 'error'));

alter table public.calendar_connections
  add column if not exists sync_lease_until timestamptz,
  add column if not exists sync_lease_token uuid;

create index if not exists calendar_connections_user_idx
  on public.calendar_connections(user_id);
create index if not exists calendar_connections_worker_due_idx
  on public.calendar_connections(status, last_sync_at, created_at)
  where auto_sync = true;
create index if not exists calendar_event_links_active_account_idx
  on public.calendar_event_links(account_id, status)
  where status = 'active';

create or replace function public.claim_calendar_connection(
  p_user_id uuid,
  p_account_id uuid,
  p_lease_token uuid,
  p_lease_seconds integer default 120
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed boolean := false;
begin
  if p_lease_seconds < 15 or p_lease_seconds > 600 then
    raise exception 'invalid calendar lease';
  end if;

  update public.calendar_connections
  set sync_lease_token = p_lease_token,
      sync_lease_until = timezone('utc', now()) + make_interval(secs => p_lease_seconds)
  where user_id = p_user_id
    and account_id = p_account_id
    and (
      sync_lease_until is null
      or sync_lease_until < timezone('utc', now())
      or sync_lease_token = p_lease_token
    )
  returning true into claimed;

  return coalesce(claimed, false);
end;
$$;

revoke all on function public.claim_calendar_connection(uuid, uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_calendar_connection(uuid, uuid, uuid, integer) to service_role;

create or replace function public.connect_google_account(
  p_user_id uuid,
  p_email text,
  p_scopes text[],
  p_refresh_token_ciphertext text,
  p_calendar_account_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  connected_account_id uuid;
begin
  connected_account_id := public.connect_gmail_account(
    p_user_id,
    p_email,
    p_scopes,
    p_refresh_token_ciphertext
  );

  if p_calendar_account_id is not null then
    if connected_account_id <> p_calendar_account_id then
      raise exception 'google account mismatch';
    end if;
    perform public.connect_calendar_account(p_user_id, connected_account_id);
  end if;

  return connected_account_id;
end;
$$;

revoke all on function public.connect_google_account(uuid, text, text[], text, uuid) from public, anon, authenticated;
grant execute on function public.connect_google_account(uuid, text, text[], text, uuid) to service_role;

create or replace function public.consume_audit_rate_limit(
  p_user_id uuid,
  p_event_type text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  recent_count integer;
begin
  if p_limit < 1 or p_limit > 100 or p_window_seconds < 1 or p_window_seconds > 3600 then
    raise exception 'invalid rate limit';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_event_type, 0));
  select count(*) into recent_count
  from public.audit_events
  where user_id = p_user_id
    and event_type = p_event_type
    and created_at >= timezone('utc', now()) - make_interval(secs => p_window_seconds);

  if recent_count >= p_limit then
    return false;
  end if;

  insert into public.audit_events (user_id, actor, event_type, object_type)
  values (p_user_id, 'user', p_event_type, 'rate_limit');
  return true;
end;
$$;

revoke all on function public.consume_audit_rate_limit(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_audit_rate_limit(uuid, text, integer, integer) to service_role;

do $$
declare
  function_base_url text;
  worker_secret text;
begin
  if to_regclass('cron.job') is null
     or to_regclass('vault.decrypted_secrets') is null
     or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise notice 'Skipping calendar sync schedule: cron, net, or vault is unavailable in this environment.';
    return;
  end if;

  select decrypted_secret into function_base_url
  from vault.decrypted_secrets
  where name = 'muh_agent_supabase_url';
  select decrypted_secret into worker_secret
  from vault.decrypted_secrets
  where name = 'muh_agent_worker_secret';

  if function_base_url is null or worker_secret is null then
    raise exception 'Calendar cron requires muh_agent_supabase_url and muh_agent_worker_secret vault entries';
  end if;

  if exists (select 1 from cron.job where jobname = 'muh-agent-calendar-sync') then
    perform cron.unschedule('muh-agent-calendar-sync');
  end if;

  perform cron.schedule(
    'muh-agent-calendar-sync',
    '5,20,35,50 * * * *',
    format(
      $job$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'muh_agent_worker_secret')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 30000
      );
      $job$,
      rtrim(function_base_url, '/') || '/functions/v1/calendar-sync'
    )
  );
end;
$$;
