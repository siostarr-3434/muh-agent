-- Remove any prior Calendar cron before validating its secret-bearing target.
do $$
declare
  function_base_url text;
  expected_base_url constant text := 'https://uthtozqbacqjtaqitrsk.supabase.co';
begin
  if to_regclass('cron.job') is null
     or to_regclass('vault.decrypted_secrets') is null
     or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise notice 'Skipping calendar cron target guard: cron, net, or vault is unavailable in this environment.';
    return;
  end if;

  select rtrim(decrypted_secret, '/') into function_base_url
  from vault.decrypted_secrets
  where name = 'muh_agent_supabase_url';

  if exists (select 1 from cron.job where jobname = 'muh-agent-calendar-sync') then
    perform cron.unschedule('muh-agent-calendar-sync');
  end if;

  if function_base_url is distinct from expected_base_url then
    raise warning 'Calendar cron remains disabled: target is not the expected Supabase project';
    return;
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'muh_agent_worker_secret') then
    raise warning 'Calendar cron remains disabled: worker secret is missing';
    return;
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
      expected_base_url || '/functions/v1/calendar-sync'
    )
  );
end;
$$;
