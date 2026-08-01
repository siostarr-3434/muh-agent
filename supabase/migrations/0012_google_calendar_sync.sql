-- Direct Google Calendar integration for verified obligations and deadlines.
-- OAuth tokens remain in public.email_tokens; this migration stores only
-- connection preferences and provider event identifiers.

alter table public.oauth_states
  add column if not exists account_id uuid references public.email_accounts(id) on delete cascade;

create index if not exists oauth_states_account_idx
  on public.oauth_states(account_id)
  where account_id is not null;

create table if not exists public.calendar_connections (
  account_id uuid primary key references public.email_accounts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  calendar_id text not null default 'primary' check (calendar_id = 'primary'),
  auto_sync boolean not null default true,
  reminder_minutes integer not null default 2880 check (reminder_minutes between 0 and 40320),
  status text not null default 'connected' check (status in ('connected', 'reauth_required', 'paused', 'error')),
  last_sync_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (account_id, user_id)
);

create table if not exists public.calendar_event_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null,
  source_type text not null check (source_type in ('obligation', 'deadline')),
  source_id uuid not null,
  provider_event_id text not null,
  event_url text,
  payload_hash text not null,
  status text not null default 'active' check (status in ('active', 'error')),
  last_synced_at timestamptz not null default timezone('utc', now()),
  last_error_code text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint calendar_event_links_connection_fkey
    foreign key (account_id, user_id)
    references public.calendar_connections(account_id, user_id)
    on delete cascade,
  unique (account_id, source_type, source_id)
);

create index if not exists calendar_connections_user_auto_idx
  on public.calendar_connections(user_id, auto_sync)
  where auto_sync = true;
create unique index if not exists calendar_connections_one_auto_per_user_idx
  on public.calendar_connections(user_id)
  where auto_sync = true;
create index if not exists calendar_event_links_user_source_idx
  on public.calendar_event_links(user_id, source_type, source_id);

drop trigger if exists calendar_connections_updated_at on public.calendar_connections;
create trigger calendar_connections_updated_at
before update on public.calendar_connections
for each row execute procedure private.set_updated_at();

drop trigger if exists calendar_event_links_updated_at on public.calendar_event_links;
create trigger calendar_event_links_updated_at
before update on public.calendar_event_links
for each row execute procedure private.set_updated_at();

alter table public.calendar_connections enable row level security;
alter table public.calendar_event_links enable row level security;

drop policy if exists "calendar connections own rows" on public.calendar_connections;
drop policy if exists "calendar event links own rows" on public.calendar_event_links;

create policy "calendar connections own rows"
  on public.calendar_connections for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "calendar event links own rows"
  on public.calendar_event_links for select to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.calendar_connections, public.calendar_event_links from anon, authenticated;
grant select on public.calendar_connections, public.calendar_event_links to authenticated;

create or replace function public.connect_calendar_account(
  p_user_id uuid,
  p_account_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  calendar_scopes constant text[] := array[
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.events.owned'
  ];
begin
  if not exists (
    select 1
    from public.email_accounts
    where id = p_account_id
      and user_id = p_user_id
      and provider = 'gmail'
      and status = 'connected'
      and scopes && calendar_scopes
  ) then
    raise exception 'calendar scope missing';
  end if;

  update public.calendar_connections
  set auto_sync = false
  where user_id = p_user_id
    and account_id <> p_account_id
    and auto_sync = true;

  insert into public.calendar_connections (
    account_id,
    user_id,
    calendar_id,
    auto_sync,
    reminder_minutes,
    status,
    last_error_code
  )
  values (p_account_id, p_user_id, 'primary', true, 2880, 'connected', null)
  on conflict (account_id) do update
  set user_id = excluded.user_id,
      calendar_id = 'primary',
      auto_sync = true,
      reminder_minutes = excluded.reminder_minutes,
      status = 'connected',
      last_error_code = null;

  insert into public.audit_events (user_id, actor, event_type, object_type, object_id, metadata)
  values (
    p_user_id,
    'user',
    'calendar_account_connected',
    'email_account',
    p_account_id::text,
    jsonb_build_object('calendar_id', 'primary', 'auto_sync', true, 'reminder_minutes', 2880)
  );

  return p_account_id;
end;
$$;

revoke all on function public.connect_calendar_account(uuid, uuid) from public, anon, authenticated;
grant execute on function public.connect_calendar_account(uuid, uuid) to service_role;

do $$
begin
  if to_regclass('cron.job') is null
     or to_regclass('vault.decrypted_secrets') is null
     or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise notice 'Skipping calendar sync schedule: cron, net, or vault is unavailable in this environment.';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'muh-agent-calendar-sync') then
    perform cron.unschedule('muh-agent-calendar-sync');
  end if;

  perform cron.schedule(
    'muh-agent-calendar-sync',
    '5,20,35,50 * * * *',
    $job$
    select net.http_post(
      url := 'https://uthtozqbacqjtaqitrsk.supabase.co/functions/v1/calendar-sync',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'muh_agent_worker_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
    $job$
  );
end;
$$;
