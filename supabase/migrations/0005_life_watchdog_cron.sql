-- Schedule the preventive life/watchdog radar.
-- The worker creates deduplicated daily notifications for stale syncs,
-- upcoming deadlines, overdue obligations, and review-required records.

do $$
declare
  already_scheduled boolean := false;
begin
  if to_regclass('cron.job') is null
     or to_regclass('vault.decrypted_secrets') is null
     or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise notice 'Skipping life watchdog schedule: cron, net, or vault is unavailable in this environment.';
    return;
  end if;

  execute 'select exists (select 1 from cron.job where jobname = $1)'
    into already_scheduled
    using 'muh-agent-life-watchdog';

  if already_scheduled then
    execute 'select cron.unschedule($1)' using 'muh-agent-life-watchdog';
  end if;

  execute $schedule$
    select cron.schedule(
      'muh-agent-life-watchdog',
      '11 */3 * * *',
      $job$
      select net.http_post(
        url := 'https://uthtozqbacqjtaqitrsk.supabase.co/functions/v1/life-watchdog',
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
