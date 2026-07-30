-- Store official payment guidance alongside extracted obligations.
-- Nullable JSON keeps the change zero-downtime for existing rows.

alter table public.obligations
  add column if not exists payment_guidance jsonb not null default '{}'::jsonb;

create index if not exists obligations_payment_guidance_gin_idx
  on public.obligations using gin (payment_guidance);
