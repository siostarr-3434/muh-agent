-- Give scheduled worker calls enough time to return useful status.
-- pg_net defaults to 5 seconds; source refresh and multi-account sync can exceed
-- that even when the Edge Function completes successfully.

do $$
begin
  if to_regclass('cron.job') is null
     or to_regclass('vault.decrypted_secrets') is null
     or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise notice 'Skipping worker cron timeout update: cron, net, or vault is unavailable in this environment.';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'muh-agent-gmail-sync') then
    perform cron.unschedule('muh-agent-gmail-sync');
  end if;
  perform cron.schedule(
    'muh-agent-gmail-sync',
    '*/15 * * * *',
    $job$
    select net.http_post(
      url := 'https://uthtozqbacqjtaqitrsk.supabase.co/functions/v1/gmail-sync',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'muh_agent_worker_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
    $job$
  );

  if exists (select 1 from cron.job where jobname = 'muh-agent-drive-sync') then
    perform cron.unschedule('muh-agent-drive-sync');
  end if;
  perform cron.schedule(
    'muh-agent-drive-sync',
    '17,47 * * * *',
    $job$
    select net.http_post(
      url := 'https://uthtozqbacqjtaqitrsk.supabase.co/functions/v1/drive-sync',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'muh_agent_worker_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
    $job$
  );

  if exists (select 1 from cron.job where jobname = 'muh-agent-source-refresh') then
    perform cron.unschedule('muh-agent-source-refresh');
  end if;
  perform cron.schedule(
    'muh-agent-source-refresh',
    '7 */6 * * *',
    $job$
    select net.http_post(
      url := 'https://uthtozqbacqjtaqitrsk.supabase.co/functions/v1/source-refresh',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'muh_agent_worker_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
    $job$
  );

  if exists (select 1 from cron.job where jobname = 'muh-agent-life-watchdog') then
    perform cron.unschedule('muh-agent-life-watchdog');
  end if;
  perform cron.schedule(
    'muh-agent-life-watchdog',
    '11 */3 * * *',
    $job$
    select net.http_post(
      url := 'https://uthtozqbacqjtaqitrsk.supabase.co/functions/v1/life-watchdog',
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
