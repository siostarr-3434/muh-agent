-- Run real Drive document extraction periodically.
-- The function still enforces its own worker-secret/user-JWT authorization.

do $$
begin
  if to_regclass('cron.job') is null
     or to_regclass('vault.decrypted_secrets') is null
     or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise notice 'Skipping document extract schedule: cron, net, or vault is unavailable in this environment.';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'muh-agent-document-extract') then
    perform cron.unschedule('muh-agent-document-extract');
  end if;

  perform cron.schedule(
    'muh-agent-document-extract',
    '4,19,34,49 * * * *',
    $job$
    select net.http_post(
      url := 'https://uthtozqbacqjtaqitrsk.supabase.co/functions/v1/document-extract',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'muh_agent_worker_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
    $job$
  );
end;
$$;
