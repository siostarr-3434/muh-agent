-- Muh Agent core schema.
-- Apply with Supabase migrations. No OAuth secret or personal identifier belongs here.

create extension if not exists pgcrypto;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = statement_timestamp();
  return new;
end;
$$;

revoke execute on function private.set_updated_at() from public, anon, authenticated;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  locale text not null default 'tr-TR',
  timezone text not null default 'Europe/Amsterdam',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.email_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('gmail', 'outlook', 'imap')),
  email text not null,
  label text,
  status text not null default 'connected' check (status in ('connected', 'reauth_required', 'paused', 'error')),
  scopes text[] not null default '{}',
  last_sync_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, email)
);

-- Refresh tokens are encrypted before insertion by the server/Edge Function.
-- There is intentionally no authenticated-user RLS policy on this table.
create table if not exists public.email_tokens (
  account_id uuid primary key references public.email_accounts(id) on delete cascade,
  refresh_token_ciphertext text not null,
  key_version text not null default 'v1',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.email_sync_cursors (
  account_id uuid primary key references public.email_accounts(id) on delete cascade,
  provider_cursor text,
  last_received_at timestamptz,
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.oauth_states (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('gmail')),
  state_hash text not null unique,
  scopes text[] not null,
  redirect_uri text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_type text not null check (source_type in ('gmail', 'drive', 'upload', 'manual')),
  source_ref text,
  storage_path text not null,
  filename text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  sha256 text not null,
  sensitivity text not null default 'restricted' check (sensitivity in ('normal', 'restricted', 'highly_restricted')),
  classification text,
  extracted_data jsonb not null default '{}'::jsonb,
  confidence numeric(5,4) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  status text not null default 'quarantined' check (status in ('quarantined', 'scanned', 'processed', 'review_required', 'rejected')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, sha256)
);

create table if not exists public.obligations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  document_id uuid references public.documents(id) on delete set null,
  authority text not null,
  title text not null,
  category text not null check (category in ('fine', 'invoice', 'tax', 'insurance', 'other')),
  amount numeric(12,2) check (amount is null or amount >= 0),
  currency text not null default 'EUR',
  due_date date,
  status text not null default 'open' check (status in ('open', 'overdue', 'paid', 'disputed', 'cancelled')),
  evidence_level text not null default 'review' check (evidence_level in ('verified', 'review', 'demo')),
  source_url text,
  note text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.email_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.email_accounts(id) on delete cascade,
  provider_message_id text not null,
  thread_id text,
  from_address text,
  subject text,
  received_at timestamptz,
  snippet text,
  label_ids text[] not null default '{}',
  body_storage_path text,
  body_sha256 text,
  sensitivity text not null default 'restricted' check (sensitivity in ('normal', 'restricted', 'highly_restricted')),
  classification text,
  extracted_data jsonb not null default '{}'::jsonb,
  processing_status text not null default 'queued' check (processing_status in ('queued', 'processing', 'processed', 'review_required', 'failed')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (account_id, provider_message_id)
);

create table if not exists public.agent_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  message_id uuid references public.email_messages(id) on delete cascade,
  job_type text not null check (job_type in ('classify_email', 'extract_document', 'refresh_sources', 'deadline_check')),
  status text not null default 'queued' check (status in ('queued', 'leased', 'done', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default timezone('utc', now()),
  leased_until timestamptz,
  last_error_code text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.deadlines (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  owner text not null,
  due_at timestamptz not null,
  status text not null default 'open' check (status in ('open', 'waiting', 'done', 'dismissed')),
  evidence_level text not null default 'review' check (evidence_level in ('verified', 'review', 'demo')),
  source_url text,
  reminder_offsets jsonb not null default '[168, 72, 24]'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.source_catalog (
  id text primary key,
  name text not null,
  domain text not null unique,
  purpose text not null,
  trust text not null default 'official' check (trust in ('official', 'secondary')),
  enabled_by_default boolean not null default true,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.source_snapshots (
  id uuid primary key default gen_random_uuid(),
  source_id text not null references public.source_catalog(id) on delete cascade,
  url text not null,
  content_sha256 text not null,
  title text,
  published_at timestamptz,
  fetched_at timestamptz not null default timezone('utc', now()),
  content_ref text,
  unique (url, content_sha256)
);

create table if not exists public.user_sources (
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id text not null references public.source_catalog(id) on delete cascade,
  enabled boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (user_id, source_id)
);

create table if not exists public.approvals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  action_type text not null check (action_type in ('payment', 'send_email', 'submit_form', 'connect_account', 'publish')),
  risk text not null default 'medium' check (risk in ('low', 'medium', 'high')),
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired', 'executed', 'failed')),
  expires_at timestamptz,
  approved_at timestamptz,
  executed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.audit_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  actor text not null check (actor in ('user', 'agent', 'worker', 'system')),
  event_type text not null,
  object_type text,
  object_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  severity text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  title text not null,
  body text not null,
  source_url text,
  read_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists obligations_user_due_idx on public.obligations(user_id, due_date);
create index if not exists email_messages_user_received_idx on public.email_messages(user_id, received_at desc);
create index if not exists agent_jobs_available_idx on public.agent_jobs(status, available_at);
create index if not exists deadlines_user_due_idx on public.deadlines(user_id, due_at);
create index if not exists approvals_user_status_idx on public.approvals(user_id, status);
create index if not exists audit_user_created_idx on public.audit_events(user_id, created_at desc);
create index if not exists notifications_user_read_idx on public.notifications(user_id, read_at, created_at desc);
create index if not exists oauth_states_user_idx on public.oauth_states(user_id, created_at desc);
create index if not exists obligations_document_idx on public.obligations(document_id) where document_id is not null;
create index if not exists agent_jobs_user_idx on public.agent_jobs(user_id);
create index if not exists agent_jobs_message_idx on public.agent_jobs(message_id) where message_id is not null;
create index if not exists source_snapshots_source_idx on public.source_snapshots(source_id, fetched_at desc);

-- Security-definer RPCs are service-role only and make the decision/audit and
-- account/token/audit writes atomic. A failed audit or token write rolls back
-- the whole call instead of leaving a misleading partial state.
create or replace function public.decide_approval(
  p_user_id uuid,
  p_approval_id uuid,
  p_decision text
)
returns table (id uuid, action_type text, risk text, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  decided_at timestamptz := statement_timestamp();
  decided public.approvals%rowtype;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'invalid approval decision';
  end if;

  update public.approvals as approval
  set status = p_decision,
      approved_at = case when p_decision = 'approved' then decided_at else null end
  where approval.id = p_approval_id
    and approval.user_id = p_user_id
    and approval.status = 'pending'
    and (approval.expires_at is null or approval.expires_at > decided_at)
  returning approval.* into decided;

  if not found then
    return;
  end if;

  insert into public.audit_events (user_id, actor, event_type, object_type, object_id, metadata)
  values (
    p_user_id,
    'user',
    case when p_decision = 'approved' then 'approval_approved' else 'approval_rejected' end,
    'approval',
    decided.id::text,
    jsonb_build_object('action_type', decided.action_type, 'risk', decided.risk)
  );

  return query select decided.id, decided.action_type, decided.risk, decided.status;
end;
$$;

revoke all on function public.decide_approval(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.decide_approval(uuid, uuid, text) to service_role;

create or replace function public.connect_gmail_account(
  p_user_id uuid,
  p_email text,
  p_scopes text[],
  p_refresh_token_ciphertext text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  connected_account_id uuid;
begin
  insert into public.email_accounts (user_id, provider, email, status, scopes, last_error_code)
  values (p_user_id, 'gmail', lower(p_email), 'connected', p_scopes, null)
  on conflict (user_id, email) do update
  set provider = 'gmail', status = 'connected', scopes = excluded.scopes, last_error_code = null
  returning id into connected_account_id;

  if p_refresh_token_ciphertext is not null then
    insert into public.email_tokens (account_id, refresh_token_ciphertext, key_version)
    values (connected_account_id, p_refresh_token_ciphertext, 'v1')
    on conflict (account_id) do update
    set refresh_token_ciphertext = excluded.refresh_token_ciphertext, key_version = excluded.key_version;
  elsif not exists (select 1 from public.email_tokens where email_tokens.account_id = connected_account_id) then
    raise exception 'refresh token missing';
  end if;

  insert into public.audit_events (user_id, actor, event_type, object_type, object_id, metadata)
  values (p_user_id, 'user', 'gmail_account_connected', 'email_account', connected_account_id::text, jsonb_build_object('provider', 'gmail', 'scopes', p_scopes));

  return connected_account_id;
end;
$$;

revoke all on function public.connect_gmail_account(uuid, text, text[], text) from public, anon, authenticated;
grant execute on function public.connect_gmail_account(uuid, text, text[], text) to service_role;

drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at before update on public.profiles for each row execute procedure private.set_updated_at();
drop trigger if exists email_accounts_updated_at on public.email_accounts;
create trigger email_accounts_updated_at before update on public.email_accounts for each row execute procedure private.set_updated_at();
drop trigger if exists email_tokens_updated_at on public.email_tokens;
create trigger email_tokens_updated_at before update on public.email_tokens for each row execute procedure private.set_updated_at();
drop trigger if exists email_sync_cursors_updated_at on public.email_sync_cursors;
create trigger email_sync_cursors_updated_at before update on public.email_sync_cursors for each row execute procedure private.set_updated_at();
drop trigger if exists email_messages_updated_at on public.email_messages;
create trigger email_messages_updated_at before update on public.email_messages for each row execute procedure private.set_updated_at();
drop trigger if exists agent_jobs_updated_at on public.agent_jobs;
create trigger agent_jobs_updated_at before update on public.agent_jobs for each row execute procedure private.set_updated_at();
drop trigger if exists documents_updated_at on public.documents;
create trigger documents_updated_at before update on public.documents for each row execute procedure private.set_updated_at();
drop trigger if exists obligations_updated_at on public.obligations;
create trigger obligations_updated_at before update on public.obligations for each row execute procedure private.set_updated_at();
drop trigger if exists deadlines_updated_at on public.deadlines;
create trigger deadlines_updated_at before update on public.deadlines for each row execute procedure private.set_updated_at();
drop trigger if exists approvals_updated_at on public.approvals;
create trigger approvals_updated_at before update on public.approvals for each row execute procedure private.set_updated_at();

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;

revoke execute on function private.handle_new_user() from public, anon, authenticated;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure private.handle_new_user();
insert into public.profiles (id) select id from auth.users on conflict (id) do nothing;

alter table public.profiles enable row level security;
alter table public.email_accounts enable row level security;
alter table public.email_tokens enable row level security;
alter table public.email_sync_cursors enable row level security;
alter table public.oauth_states enable row level security;
alter table public.documents enable row level security;
alter table public.email_messages enable row level security;
alter table public.agent_jobs enable row level security;
alter table public.obligations enable row level security;
alter table public.deadlines enable row level security;
alter table public.source_catalog enable row level security;
alter table public.source_snapshots enable row level security;
alter table public.user_sources enable row level security;
alter table public.approvals enable row level security;
alter table public.audit_events enable row level security;
alter table public.notifications enable row level security;

create policy "profiles own rows" on public.profiles for all to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
create policy "email accounts own rows" on public.email_accounts for select to authenticated using ((select auth.uid()) = user_id);
create policy "documents own rows" on public.documents for select to authenticated using ((select auth.uid()) = user_id);
create policy "email messages own rows" on public.email_messages for select to authenticated using ((select auth.uid()) = user_id);
create policy "agent jobs own rows" on public.agent_jobs for select to authenticated using ((select auth.uid()) = user_id);
create policy "obligations own rows" on public.obligations for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "deadlines own rows" on public.deadlines for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "source catalog readable" on public.source_catalog for select to authenticated using (true);
create policy "source snapshots readable" on public.source_snapshots for select to authenticated using (true);
create policy "user sources own rows" on public.user_sources for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "approvals own rows" on public.approvals for select to authenticated using ((select auth.uid()) = user_id);
create policy "notifications own rows" on public.notifications for select to authenticated using ((select auth.uid()) = user_id);
create policy "notifications own read state" on public.notifications for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "audit own rows" on public.audit_events for select to authenticated using ((select auth.uid()) = user_id);

-- Data API access is explicit. Server-only tables intentionally receive no grant.
revoke all on all tables in schema public from anon, authenticated;
grant usage on schema public to authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select on public.email_accounts, public.documents, public.email_messages, public.agent_jobs to authenticated;
grant select, insert, update, delete on public.obligations, public.deadlines, public.user_sources to authenticated;
grant select on public.source_catalog, public.source_snapshots, public.approvals, public.audit_events, public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;

insert into public.source_catalog (id, name, domain, purpose, trust) values
  ('ind', 'IND', 'ind.nl', 'Oturum, kennismigrant ve aile birleşimi', 'official'),
  ('cjib', 'CJIB', 'cjib.nl', 'Ceza, ödeme ve itiraz süreçleri', 'official'),
  ('belastingdienst', 'Belastingdienst', 'belastingdienst.nl', 'Vergi, toeslagen ve ödeme düzenlemeleri', 'official'),
  ('waterland', 'Gemeente Waterland', 'waterland.nl', 'Yerel vergi ve belediye hizmetleri', 'official'),
  ('rechtspraak', 'Rechtspraak', 'rechtspraak.nl', 'Mahkeme ve usul bilgileri', 'official'),
  ('rijksoverheid', 'Rijksoverheid', 'rijksoverheid.nl', 'Yasa ve devlet duyuruları', 'official')
on conflict (id) do update set name = excluded.name, domain = excluded.domain, purpose = excluded.purpose, trust = excluded.trust;
