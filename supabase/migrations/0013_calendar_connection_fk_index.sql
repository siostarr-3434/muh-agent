-- Cover the composite calendar connection foreign key for cascade checks.
create index if not exists calendar_event_links_connection_idx
  on public.calendar_event_links(account_id, user_id);
