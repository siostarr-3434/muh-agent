-- Schedule public official-source refreshes.
-- This uses the existing worker secret from Supabase Vault; no secret value is stored here.
-- Local migration verification skips scheduling when cron/net/vault are unavailable.

do $$
declare
  already_scheduled boolean := false;
begin
  if to_regclass('cron.job') is null
     or to_regclass('vault.decrypted_secrets') is null
     or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise notice 'Skipping source refresh schedule: cron, net, or vault is unavailable in this environment.';
    return;
  end if;

  execute 'select exists (select 1 from cron.job where jobname = $1)'
    into already_scheduled
    using 'muh-agent-source-refresh';

  if already_scheduled then
    execute 'select cron.unschedule($1)' using 'muh-agent-source-refresh';
  end if;

  execute $schedule$
    select cron.schedule(
      'muh-agent-source-refresh',
      '7 */6 * * *',
      $job$
      select net.http_post(
        url := 'https://uthtozqbacqjtaqitrsk.supabase.co/functions/v1/source-refresh',
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
