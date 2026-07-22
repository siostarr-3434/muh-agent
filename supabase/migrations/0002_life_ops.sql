-- Muh Agent life-ops expansion.
-- Stores user-approved knowledge notes and expands the official source allowlist.

create table if not exists public.knowledge_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category text not null check (category in ('immigration', 'pregnancy', 'fine', 'tax', 'municipality', 'health', 'skill', 'other')),
  title text not null check (char_length(title) between 3 and 160),
  body text not null check (char_length(body) between 10 and 5000),
  source_url text,
  evidence_level text not null default 'review' check (evidence_level in ('verified', 'review', 'demo')),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists knowledge_items_user_created_idx on public.knowledge_items(user_id, created_at desc);
create index if not exists knowledge_items_user_category_idx on public.knowledge_items(user_id, category);

drop trigger if exists knowledge_items_updated_at on public.knowledge_items;
create trigger knowledge_items_updated_at before update on public.knowledge_items for each row execute procedure private.set_updated_at();

alter table public.knowledge_items enable row level security;

drop policy if exists "knowledge items own rows" on public.knowledge_items;
create policy "knowledge items own rows" on public.knowledge_items for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.knowledge_items to authenticated;

insert into public.source_catalog (id, name, domain, purpose, trust) values
  ('mijnoverheid', 'MijnOverheid', 'mijnoverheid.nl', 'Berichtenbox ve resmi devlet mesajları', 'official'),
  ('digid', 'DigiD', 'digid.nl', 'Kimlik doğrulama kapısı; şifre veya token saklanmaz', 'official'),
  ('uwv', 'UWV', 'uwv.nl', 'İş, izin, sosyal güvenlik ve doğum/ebeveyn süreçleri', 'official'),
  ('svb', 'SVB', 'svb.nl', 'Kinderbijslag ve aile yardımları', 'official'),
  ('duo', 'DUO', 'duo.nl', 'Eğitim, diploma ve inburgering bağlantılı süreçler', 'official'),
  ('inburgeren', 'Inburgeren', 'inburgeren.nl', 'Uyum ve vatandaşlık süreci bilgileri', 'official'),
  ('hetcak', 'CAK', 'hetcak.nl', 'Sağlık ve kamu katkı/ödeme yazışmaları', 'official'),
  ('rdw', 'RDW', 'rdw.nl', 'Araç, ehliyet, ceza ve kayıt bağlantılı bilgiler', 'official'),
  ('politie', 'Politie', 'politie.nl', 'Polis duyuruları ve resmi başvuru kanalları', 'official'),
  ('openbaarministerie', 'Openbaar Ministerie', 'om.nl', 'Savcılık, ceza ve itiraz süreçleri', 'official'),
  ('governmentnl', 'Government.nl', 'government.nl', 'İngilizce resmi devlet açıklamaları', 'official'),
  ('nederlandwereldwijd', 'Nederland Wereldwijd', 'nederlandwereldwijd.nl', 'Yurt dışı ve konsolosluk bağlantılı resmi bilgiler', 'official'),
  ('zorginstituut', 'Zorginstituut Nederland', 'zorginstituutnederland.nl', 'Sağlık sistemi ve sigorta kapsamı bilgileri', 'official')
on conflict (id) do update
set name = excluded.name,
    domain = excluded.domain,
    purpose = excluded.purpose,
    trust = excluded.trust;
