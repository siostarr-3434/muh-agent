-- Public official payment/objection sources for the payment calendar.
-- This is data-only; DigiD/private portal access is not automated.

insert into public.source_catalog (id, name, domain, purpose, trust) values
  ('amsterdam-belastingen', 'Gemeente Amsterdam Belastingen', 'amsterdam.nl', 'Amsterdam parkeerbon, belastingaanslag, betaling, bezwaar en betalingsregeling', 'official'),
  ('denhaag-belastingen', 'Gemeente Den Haag Belastingen', 'denhaag.nl', 'Den Haag parkeerbon, factuur, gemeentelijke belasting, betaling, bezwaar en betalingsregeling', 'official')
on conflict (id) do update
set name = excluded.name,
    domain = excluded.domain,
    purpose = excluded.purpose,
    trust = excluded.trust;

insert into public.source_watch_pages (id, source_id, url, title, purpose) values
  ('amsterdam-parkeerbon-betalen', 'amsterdam-belastingen', 'https://www.amsterdam.nl/parkeren/parkeerbon/parkeerbon-betalen/', 'Amsterdam parkeerbon betalen', 'Parkeerbon betalen, betalingstermijn, kosten en MijnOverheid/Berichtenbox signaal'),
  ('amsterdam-parkeerbon-betalingsregeling', 'amsterdam-belastingen', 'https://www.amsterdam.nl/parkeren/parkeerbon/betalingsregeling-afspreken-parkeerbon/', 'Amsterdam parkeerbon betalingsregeling', 'Openstaande parkeerbonnen in maximaal 12 delen en minimaal maandbedrag controleren'),
  ('amsterdam-parkeerbon-bezwaar', 'amsterdam-belastingen', 'https://www.amsterdam.nl/parkeren/parkeerbon/bezwaar-maken-parkeerbon/', 'Amsterdam parkeerbon bezwaar', 'Bezwaar en beroepstermijn bij parkeerbon'),
  ('amsterdam-mijn-belastingen', 'amsterdam-belastingen', 'https://belastingbalie.amsterdam.nl/', 'Amsterdam Mijn Belastingen', 'Belastingaanslagen/parkeerbonnen bekijken, betalen, betalingsregeling, bezwaar en incasso regelen'),
  ('denhaag-parkeerbon', 'denhaag-belastingen', 'https://www.denhaag.nl/nl/parkeren/parkeerbon-naheffingsaanslag/', 'Den Haag parkeerbon betalen', 'Parkeerbon bekijken, betalen en betalingskenmerk controleren'),
  ('denhaag-parkeerbon-bezwaar', 'denhaag-belastingen', 'https://www.denhaag.nl/nl/parkeren/bezwaar-maken-tegen-een-parkeerbon-naheffingsaanslag/', 'Den Haag parkeerbon bezwaar', 'Bezwaar binnen 6 weken, bewijsstukken en betaalpauze tijdens bezwaar'),
  ('denhaag-belasting-betalingsregeling', 'denhaag-belastingen', 'https://www.denhaag.nl/nl/belastingen/betalingsregeling-belastingen-aanvragen/', 'Den Haag belasting betalingsregeling', 'Gemeentelijke belasting betaalafspraak, maximaal 12 maanden en minimum maandbedrag'),
  ('denhaag-facturen-betalen', 'denhaag-belastingen', 'https://www.denhaag.nl/nl/contact-met-de-gemeente/facturen-betalen/', 'Den Haag facturen betalen', 'Gemeentelijke facturen, meerdere facturen en betalingsregelingvoorwaarden'),
  ('denhaag-parkeren-contact', 'denhaag-belastingen', 'https://www.denhaag.nl/nl/parkeren/contact-over-parkeren/', 'Den Haag parkeren contact', 'MijnDenHaag parkeerbon betalen, betaalregeling en parkeerzaken')
on conflict (id) do update
set source_id = excluded.source_id,
    url = excluded.url,
    title = excluded.title,
    purpose = excluded.purpose,
    enabled = true;
