-- Drive metadata sync foundation.
-- This stores provider metadata only. File contents are not downloaded here.

create table if not exists public.provider_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.email_accounts(id) on delete cascade,
  provider text not null check (provider in ('drive', 'gmail', 'upload')),
  provider_file_id text not null,
  source_ref text not null,
  name text not null,
  mime_type text not null,
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  modified_at timestamptz,
  web_url text,
  classification text,
  extracted_data jsonb not null default '{}'::jsonb,
  status text not null default 'metadata' check (status in ('metadata', 'review_required', 'ignored', 'failed')),
  sensitivity text not null default 'restricted' check (sensitivity in ('normal', 'restricted', 'highly_restricted')),
  last_seen_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (account_id, provider_file_id)
);

create index if not exists provider_files_user_modified_idx on public.provider_files(user_id, modified_at desc nulls last);
create index if not exists provider_files_user_status_idx on public.provider_files(user_id, status, last_seen_at desc);
create index if not exists provider_files_account_seen_idx on public.provider_files(account_id, last_seen_at desc);

drop trigger if exists provider_files_updated_at on public.provider_files;
create trigger provider_files_updated_at before update on public.provider_files for each row execute procedure private.set_updated_at();

alter table public.provider_files enable row level security;

drop policy if exists "provider files own rows" on public.provider_files;
create policy "provider files own rows" on public.provider_files for select to authenticated using ((select auth.uid()) = user_id);

grant select on public.provider_files to authenticated;

do $$
declare
  already_scheduled boolean := false;
begin
  if to_regclass('cron.job') is null
     or to_regclass('vault.decrypted_secrets') is null
     or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise notice 'Skipping drive sync schedule: cron, net, or vault is unavailable in this environment.';
    return;
  end if;

  execute 'select exists (select 1 from cron.job where jobname = $1)'
    into already_scheduled
    using 'muh-agent-drive-sync';

  if already_scheduled then
    execute 'select cron.unschedule($1)' using 'muh-agent-drive-sync';
  end if;

  execute $schedule$
    select cron.schedule(
      'muh-agent-drive-sync',
      '17,47 * * * *',
      $job$
      select net.http_post(
        url := 'https://uthtozqbacqjtaqitrsk.supabase.co/functions/v1/drive-sync',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'muh_agent_worker_secret')
        ),
        body := '{}'::jsonb
      );
      $job$
    );
  $schedule$;
end;
$$;
