-- Track real document extraction separately from Drive metadata discovery.
-- Existing rows remain pending so the extractor can process already-seen files.

alter table public.provider_files
  add column if not exists document_id uuid references public.documents(id) on delete set null,
  add column if not exists extraction_status text not null default 'pending'
    check (extraction_status in ('pending', 'processing', 'extracted', 'skipped', 'failed')),
  add column if not exists extraction_attempts integer not null default 0 check (extraction_attempts >= 0),
  add column if not exists extraction_error_code text,
  add column if not exists extracted_at timestamptz;

create index if not exists provider_files_extraction_queue_idx
  on public.provider_files(extraction_status, modified_at desc nulls last)
  where provider = 'drive';

create index if not exists provider_files_document_idx
  on public.provider_files(document_id)
  where document_id is not null;
