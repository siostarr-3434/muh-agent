-- Enforce the user-approved Calendar destination below the browser layer.
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
  target_email constant text := 'siostarr@hairartclinics.com';
begin
  if not exists (
    select 1
    from public.email_accounts
    where id = p_account_id
      and user_id = p_user_id
      and provider = 'gmail'
      and lower(email) = target_email
      and status = 'connected'
      and scopes && calendar_scopes
  ) then
    raise exception 'calendar target or scope missing';
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
    jsonb_build_object('calendar_id', 'primary', 'auto_sync', true, 'reminder_minutes', 2880, 'target_email', target_email)
  );

  return p_account_id;
end;
$$;

revoke all on function public.connect_calendar_account(uuid, uuid) from public, anon, authenticated;
grant execute on function public.connect_calendar_account(uuid, uuid) to service_role;
