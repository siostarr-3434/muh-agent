-- Expand public source monitoring from institution homepages to concrete
-- expat-life watch pages. These are public pages only; no DigiD or private
-- portal access is automated.

create table if not exists public.source_watch_pages (
  id text primary key,
  source_id text not null references public.source_catalog(id) on delete cascade,
  url text not null unique,
  title text not null,
  purpose text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists source_watch_pages_updated_at on public.source_watch_pages;
create trigger source_watch_pages_updated_at before update on public.source_watch_pages for each row execute procedure private.set_updated_at();

alter table public.source_watch_pages enable row level security;

drop policy if exists "source watch pages readable" on public.source_watch_pages;
create policy "source watch pages readable" on public.source_watch_pages for select to authenticated using (true);

grant select on public.source_watch_pages to authenticated;

insert into public.source_catalog (id, name, domain, purpose, trust) values
  ('toeslagen', 'Dienst Toeslagen', 'toeslagen.nl', 'Zorgtoeslag, huurtoeslag, kinderopvangtoeslag, kindgebonden budget ve değişiklik bildirimleri', 'official'),
  ('huurcommissie', 'Huurcommissie', 'huurcommissie.nl', 'Kira fiyatı, servicekosten, onderhoud ve huurgeschil hakları', 'official'),
  ('juridischloket', 'Het Juridisch Loket', 'juridischloket.nl', 'Düşük gelir için ücretsiz hukuki ilk yardım; huur, werk, schulden ve sosyal hak sinyalleri', 'secondary'),
  ('cbr', 'CBR', 'cbr.nl', 'Rijbewijs, sağlık beyanı ve sürüş yetkisi süreçleri', 'official')
on conflict (id) do update
set name = excluded.name,
    domain = excluded.domain,
    purpose = excluded.purpose,
    trust = excluded.trust;

insert into public.source_watch_pages (id, source_id, url, title, purpose) values
  ('ind-kennismigrant', 'ind', 'https://ind.nl/nl/verblijfsvergunningen/werken/kennismigrant', 'Kennismigrant voorwaarden', 'Erkend referent, arbeidscontract, inkomenseis ve marktconform loon şartları'),
  ('ind-normbedragen', 'ind', 'https://ind.nl/nl/inkomenseisen-normbedragen', 'IND normbedragen', 'Güncel gelir/normbedrag değişiklikleri'),
  ('ind-erkend-register', 'ind', 'https://ind.nl/nl/openbaar-register-erkende-referenten/openbaar-register-arbeid', 'Erkende referenten register', 'İşverenin erkend referent durumunu kontrol etmek'),
  ('ind-verlengen-regulier', 'ind', 'https://ind.nl/nl/vervangen-verlengen-vernieuwen-en-wijzigen/verlengen-en-vernieuwen/verblijfsvergunning-regulier-bepaalde-tijd-verlengen', 'Reguliere verblijfsvergunning verlengen', 'Oturum kartı bitmeden uzatma ve belge kontrolü'),
  ('ind-onbepaalde-tijd', 'ind', 'https://ind.nl/nl/vervangen-verlengen-vernieuwen-en-wijzigen/onbepaalde-tijd/verblijfsvergunning-onbepaalde-tijd-aanvragen', 'Onbepaalde tijd aanvragen', '5 yıl ve kalıcı oturum hak kontrolü'),
  ('ind-eu-langdurig', 'ind', 'https://ind.nl/nl/verblijfsvergunningen/langdurig-ingezetene-eu/verblijfsvergunning-eu-langdurig-ingezetene', 'EU-langdurig ingezetene', 'Uzun süreli AB oturumu hak ve şartları'),
  ('rijk-kind-checklist', 'rijksoverheid', 'https://www.rijksoverheid.nl/vraag-en-antwoord/zwangerschap-en-geboorte/checklist-kind-krijgen', 'Kind krijgen checklist', 'Hamilelik, doğum bildirimi, BSN, kinderbijslag ve zorgverzekering adımları'),
  ('rijk-zorgverzekering-werken', 'rijksoverheid', 'https://www.rijksoverheid.nl/vraag-en-antwoord/immigratie-naar-nederland/moet-ik-een-zorgverzekering-afsluiten-als-ik-in-nederland-ga-werken', 'Zorgverzekering bij werken in Nederland', 'Çalışan expat için zorunlu sağlık sigortası ve çocuk sigortası bilgisi'),
  ('rijk-zorgtoeslag', 'rijksoverheid', 'https://www.rijksoverheid.nl/vraag-en-antwoord/zorgverzekering/kan-ik-zorgtoeslag-krijgen', 'Zorgtoeslag', 'Sağlık sigortası desteği hak kontrolü'),
  ('rijk-ehic', 'rijksoverheid', 'https://www.rijksoverheid.nl/vraag-en-antwoord/zorgverzekering/hoe-ben-ik-voor-zorg-verzekerd-als-ik-op-vakantie-ben-in-het-buitenland', 'EHIC buitenland zorg', 'Avrupa seyahatinde sağlık kartı ve masraf riski'),
  ('uwv-zwangerschap', 'uwv', 'https://www.uwv.nl/nl/zwangerschapsverlof-bevallingsverlof', 'Zwangerschaps- en bevallingsuitkering', 'En az 16 hafta izin/ödenek ve UWV süreci'),
  ('uwv-aanvragen-zwangerschap', 'uwv', 'https://www.uwv.nl/nl/zwangerschapsverlof-bevallingsverlof/zwangerschapsverlof-aanvragen', 'Zwangerschapsverlof aanvragen', 'İşveren/çalışan başvuru akışı'),
  ('uwv-zez', 'uwv', 'https://www.uwv.nl/nl/zez', 'ZEZ zelfstandige en zwanger', 'Kendi işi olan hamile kişiler için ZEZ kontrolü'),
  ('svb-kind-geboren', 'svb', 'https://www.svb.nl/nl/kinderbijslag/u-krijgt-een-kind', 'Kind geboren kinderbijslag', 'Doğum sonrası kinderbijslag akışı'),
  ('svb-kinderbijslag-aanvragen', 'svb', 'https://www.svb.nl/nl/kinderbijslag/hoe-vraagt-u-kinderbijslag-aan/kinderbijslag-aanvragen', 'Kinderbijslag aanvragen', 'SVB mektubu ve Mijn SVB başvurusu'),
  ('svb-bedragen-betaaldagen', 'svb', 'https://www.svb.nl/nl/kinderbijslag/bedragen-betaaldagen/bedragen-kinderbijslag', 'Kinderbijslag bedragen en betaaldagen', 'Ödeme tarihleri ve tutar değişiklikleri'),
  ('toeslagen-home', 'toeslagen', 'https://www.toeslagen.nl/', 'Dienst Toeslagen', 'Toeslag türleri ve hızlı girişler'),
  ('toeslagen-wijzigingen', 'toeslagen', 'https://toeslagen.nl/wijzig', 'Welke wijzigingen doorgeven', 'Gelir, çocuk, ev, sağlık ve aile değişikliklerini zamanında bildirme'),
  ('toeslagen-kan-ik', 'toeslagen', 'https://www.toeslagen.nl/kaniktoeslagkrijgen', 'Kan ik toeslag krijgen', 'Hak kontrolü ve proefberekening yönlendirmesi'),
  ('toeslagen-proefberekening', 'toeslagen', 'https://www.toeslagen.nl/proefberekening', 'Proefberekening toeslagen', 'Gelir/çocuk/ev değişince olası hak kaybı veya geri ödeme riski'),
  ('belastingdienst-expatregeling', 'belastingdienst', 'https://www.belastingdienst.nl/wps/wcm/connect/nl/buitenland/content/ik-kom-in-nederland-werken-30-procent-regeling-aanvragen', 'Expatregeling 30%-regeling', '30% ruling koşulları ve süre uyarıları'),
  ('cjib-verkeersboete-bezwaar', 'cjib', 'https://www.cjib.nl/direct-regelen/ik-ben-het-niet-eens-met-mijn-boete/ik-ben-het-niet-eens-met-een-verkeersboete', 'Verkeersboete bezwaar', 'Ceza itiraz süreci ve ödeme/itiraz ayrımı'),
  ('cjib-betalingsregeling', 'cjib', 'https://www.cjib.nl/betalen-in-delen-aanvragen', 'CJIB betalingsregeling', 'Ceza ödeme planı ve itirazla çakışma riski'),
  ('waterland-home', 'waterland', 'https://www.waterland.nl/', 'Gemeente Waterland', 'Adres, doğum bildirimi, afval, belasting ve bekendmakingen'),
  ('huurcommissie-huurprijscheck', 'huurcommissie', 'https://www.huurcommissie.nl/support/huurprijscheck', 'Huurprijscheck', 'Kiranın makul olup olmadığını kontrol etmek'),
  ('huurcommissie-servicekosten', 'huurcommissie', 'https://www.huurcommissie.nl/onderwerpen/huurder-sociale--en-middensector/servicekosten-sociale-middensector-huurder/servicekosten-en-nutsvoorzieningen', 'Servicekosten controleren', 'Servicekosten ve enerji/voorschot itirazı'),
  ('juridischloket-home', 'juridischloket', 'https://www.juridischloket.nl/', 'Gratis juridisch advies', 'Hukuki ilk yardım ve konu başlıkları'),
  ('juridischloket-bijstand-buitenlander', 'juridischloket', 'https://www.juridischloket.nl/werk-en-inkomen/werkloosheid-en-bijstand/bijstandsuitkering-buitenlander/', 'Bijstand buitenlander', 'Sosyal yardım başvurusunun oturuma etkisi dahil genel uyarılar'),
  ('juridischloket-beslagvrije-voet', 'juridischloket', 'https://www.juridischloket.nl/schulden-en-incasso/deurwaarder-en-beslaglegging/beslagvrije-voet/', 'Beslagvrije voet', 'Haciz/borç durumunda temel geçim payı kontrolü')
on conflict (id) do update
set source_id = excluded.source_id,
    url = excluded.url,
    title = excluded.title,
    purpose = excluded.purpose,
    enabled = true;
