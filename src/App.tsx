import { useEffect, useState } from 'react'
import { ApiError, beginGmailConnection, createKnowledgeItem, decideApproval, extractDocuments, getDashboard, getSession, requestPasswordRecovery, setPassword, signIn, signOut, type DashboardResponse, type SessionResponse } from './api'
import { activities, approvals as initialApprovals, deadlines, mailAccounts, obligations, sources } from './data'
import type { ApprovalItem, DashboardMessage, Deadline, EvidenceLevel, KnowledgeItem, MailAccount, NotificationItem, Obligation, ObligationStatus, PaymentGuidance, ProviderFile, SourceRecord, ViewId } from './types'

const nav: Array<{ id: ViewId; label: string; icon: string }> = [
  { id: 'overview', label: 'Genel Bakış', icon: '⌂' },
  { id: 'inbox', label: 'Gelen Kutusu', icon: '✉' },
  { id: 'payments', label: 'Ödeme Planı', icon: '€' },
  { id: 'documents', label: 'Evrak Kasası', icon: '▤' },
  { id: 'deadlines', label: 'Haklar & Süreler', icon: '◷' },
  { id: 'life', label: 'Yaşam Radar', icon: '✦' },
  { id: 'approvals', label: 'Onay Merkezi', icon: '✓' },
  { id: 'sources', label: 'Kaynaklar', icon: '◎' },
  { id: 'settings', label: 'Ayarlar', icon: '⚙' },
]

const statusLabel: Record<ObligationStatus, string> = {
  open: 'Açık',
  overdue: 'Gecikmiş',
  paid: 'Ödendi',
  disputed: 'İtiraz / inceleme',
}

const evidenceLabel: Record<EvidenceLevel, string> = {
  verified: 'Doğrulandı',
  review: 'İnceleme gerekli',
  demo: 'Demo veri',
}

const knowledgeCategoryLabel: Record<KnowledgeItem['category'], string> = {
  fine: 'Ceza',
  health: 'Sağlık',
  immigration: 'IND / oturum',
  municipality: 'Belediye',
  other: 'Diğer',
  pregnancy: 'Hamilelik',
  skill: 'Skill / yöntem',
  tax: 'Vergi',
}

const processingLabel: Record<DashboardMessage['status'], string> = {
  failed: 'Hata',
  processed: 'İşlendi',
  processing: 'İşleniyor',
  queued: 'Kuyrukta',
  review_required: 'İnceleme',
}

const fileExtractionLabel: Record<ProviderFile['extractionStatus'], string> = {
  extracted: 'Belge okundu',
  failed: 'Okuma hatası',
  pending: 'Okuma bekliyor',
  processing: 'Okunuyor',
  skipped: 'Okundu · aksiyon yok',
}

const officialPaymentGuides: Array<{ match: RegExp; guidance: PaymentGuidance }> = [
  {
    match: /\b(cjib|centraal justitieel|verkeersboete|bekeuring)\b/i,
    guidance: {
      bulkPayment: 'Mijn CJIB / resmi CJIB portali açık cezaları birlikte gösterir; ödeme öncesi belge numarası ve tutar eşleşmeli.',
      installmentSummary: 'CJIB’de bazı cezalar için taksit/ödeme planı istenebilir. İtiraz/beroep düşünülüyorsa ödeme planı istemeden önce resmi uyarıyı kontrol et.',
      objectionUrl: 'https://www.cjib.nl/direct-regelen/ik-ben-het-niet-eens-met-mijn-boete/ik-ben-het-niet-eens-met-een-verkeersboete',
      paymentMethod: 'CJIB mektubundaki QR/IBAN/betalingskenmerk veya resmi CJIB portali.',
      paymentPlanUrl: 'https://www.cjib.nl/betalen-in-delen-aanvragen',
      paymentUrl: 'https://www.cjib.nl/direct-regelen/ik-wil-graag/ik-wil-betalen',
      portalLabel: 'CJIB betalen',
      sourceLabel: 'CJIB',
      sourceUrl: 'https://www.cjib.nl/',
      warning: 'İtiraz, ödeme ve taksit ayrı kararlar. Resmi mektuptaki kenmerk olmadan ödeme yapma.',
    },
  },
  {
    match: /\b(amsterdam|gemeente amsterdam|belastingbalie)\b/i,
    guidance: {
      bulkPayment: 'Amsterdam Mijn Belastingen açık parkeerbon/belastingaanslag kayıtlarını tek portalda gösterir; açık kayıtlar üzerinden toplu ödeme veya düzenleme kontrol edilir.',
      installmentSummary: 'Parkeerbon için ödeme düzeni en fazla 12 parça ve en az €30/ay; wielklem varsa düzenleme yok. Vergi aanslag için de Mijn Belastingen üzerinden düzenleme kontrol edilir.',
      objectionUrl: 'https://www.amsterdam.nl/parkeren/parkeerbon/bezwaar-maken-parkeerbon/',
      paymentMethod: 'Mijn Belastingen veya mektuptaki betalingskenmerk ile resmi Amsterdam ödeme kanalı.',
      paymentPlanUrl: 'https://www.amsterdam.nl/parkeren/parkeerbon/betalingsregeling-afspreken-parkeerbon/',
      paymentUrl: 'https://belastingbalie.amsterdam.nl/',
      portalLabel: 'Amsterdam Mijn Belastingen',
      sourceLabel: 'Gemeente Amsterdam',
      sourceUrl: 'https://www.amsterdam.nl/parkeren/parkeerbon/parkeerbon-betalen/',
      warning: 'Parkeerbon ve bezwaar kararını karıştırma; belge tarihi ve aanslagnummer kontrol edilmeli.',
    },
  },
  {
    match: /\b(den haag|denhaag|gemeente den haag|mijndenhaag|haagse)\b/i,
    guidance: {
      bulkPayment: 'MijnDenHaag parkeerbon/fatura gibi açık belediye kayıtlarını gösterir. Birden fazla belediye factuur için Den Haag resmi sayfası debiteuren e-posta yolunu belirtir.',
      installmentSummary: 'Gemeentelijke belasting için en fazla 12 ay ve en az €25/ay; factuur tarafında kişisel bakiye en az €50 ve taksit en az €20 koşulu geçebilir.',
      objectionUrl: 'https://www.denhaag.nl/nl/parkeren/bezwaar-maken-tegen-een-parkeerbon-naheffingsaanslag/',
      paymentMethod: 'MijnDenHaag veya mektuptaki betalingskenmerk ile Gemeente Den Haag ödeme kanalı.',
      paymentPlanUrl: 'https://www.denhaag.nl/nl/belastingen/betalingsregeling-belastingen-aanvragen/',
      paymentUrl: 'https://www.denhaag.nl/nl/parkeren/parkeerbon-naheffingsaanslag/',
      portalLabel: 'MijnDenHaag / parkeerbon',
      sourceLabel: 'Gemeente Den Haag',
      sourceUrl: 'https://www.denhaag.nl/nl/parkeren/contact-over-parkeren/',
      warning: 'Parkeerbon bezwaarında süre genelde dagtekening’den 6 hafta; itiraz sürecinde ödeme gerekip gerekmediği resmi sayfadan kontrol edilmeli.',
    },
  },
  {
    match: /\b(belastingdienst|toeslagen|belasting)\b/i,
    guidance: {
      bulkPayment: 'Belastingdienst/Mijn Belastingdienst açık aanslag ve ödeme düzeni için resmi portala yönlendirir.',
      installmentSummary: 'Vergi ve toeslagen borçlarında ödeme düzeni kişisel duruma göre değişir; geri ödeme riski için tutar ve jaar/kenmerk eşleşmeli.',
      paymentMethod: 'Resmi Belastingdienst portalı veya mektuptaki betalingskenmerk.',
      paymentUrl: 'https://www.belastingdienst.nl/wps/wcm/connect/nl/betalen-en-ontvangen/betalen-en-ontvangen',
      portalLabel: 'Belastingdienst betalen',
      sourceLabel: 'Belastingdienst',
      sourceUrl: 'https://www.belastingdienst.nl/',
      warning: 'Toeslagen değişikliği geç bildirilirse sonradan borç doğabilir.',
    },
  },
]

const lifeRadarItems = [
  {
    source: 'Gemeente Waterland',
    tag: 'Belediye',
    text: 'Nieuwland 51, Broek in Waterland 1151 AZ adresi belediye işlemleri için Gemeente Waterland hattına düşer. Vergi, adres, doğum kaydı ve bazı sosyal destek başlıkları burada takip edilmeli.',
    title: 'Adres ve belediye merkezi',
    url: 'https://www.waterland.nl/',
  },
  {
    source: 'IND',
    tag: 'Oturum',
    text: 'Kennismigrant dosyasında kritik kontrol: yeni işverenin erkend referent durumu, maaş kriteri, karar/itiraz tarihleri ve IND’nin istediği belge listesi avukatla aynı tabloda tutulmalı.',
    title: 'IND dosyası yüksek öncelik',
    url: 'https://ind.nl/en/residence-permits/work/highly-skilled-migrant',
  },
  {
    source: 'IND',
    tag: '5 yıl',
    text: '5 yıl kesintisiz yasal oturum eşiği kalıcı oturum ve vatandaşlık kontrolü için ayrı incelenmeli. Bu, mevcut iptal/itiraz dosyasından bağımsız kanıt gerektirir.',
    title: 'Kalıcı oturum / vatandaşlık kontrolü',
    url: 'https://ind.nl/en/replace-extend-renew-and-change/permanent-residency/permanent-residence-permit',
  },
  {
    source: 'Rijksoverheid / UWV',
    tag: 'Hamilelik',
    text: 'Hamilelikte verloskundige, kraamzorg, doğum izni, partner izni, doğum kaydı ve kinderbijslag başlıkları ayrı son tarih ve belge listesine bağlanmalı.',
    title: 'Hamilelik hakları ve yapılacaklar',
    url: 'https://www.rijksoverheid.nl/onderwerpen/zwangerschapsverlof-en-bevallingsverlof',
  },
  {
    source: 'CJIB / Rechtspraak',
    tag: 'Ceza',
    text: 'Cezalarda ödeme, taksit ve itiraz aynı anda ele alınmamalı. Belge numarası, karar tarihi, ödeme tarihi ve itiraz kanalı önce doğrulanmalı.',
    title: 'Ceza ödeme/itiraz güvenlik kapısı',
    url: 'https://www.cjib.nl/en/do-you-disagree-traffic-fine',
  },
  {
    source: 'MijnOverheid / DigiD',
    tag: 'DigiD',
    text: 'DigiD kimlik bilgisi uygulamada saklanmaz. Berichtenbox ve kurum portalları için kullanıcı manuel giriş yapar; dashboard sadece kontrol listesi ve kaynak linki gösterir.',
    title: 'Devlet mesaj kutusu sınırı',
    url: 'https://mijnoverheid.nl/',
  },
]

const preventiveChecklist = [
  {
    action: 'Kraamzorg, verloskundige ve doğum planı belgelerini Drive’da tek klasöre koy; mail/Drive worker bu klasörü izlesin.',
    source: 'Rijksoverheid',
    tag: 'Hamilelik',
    title: 'Doğum öncesi hazırlık paketi',
    url: 'https://www.rijksoverheid.nl/vraag-en-antwoord/zwangerschap-en-geboorte/checklist-kind-krijgen',
  },
  {
    action: 'Doğumdan sonra 3 iş günü içinde doğum bildirimi, 4 ay içinde sağlık sigortasına çocuk ekleme ve SVB/kinderbijslag mektubunu takip et.',
    source: 'Rijksoverheid / SVB',
    tag: 'Bebek',
    title: 'Doğum sonrası kritik süreler',
    url: 'https://www.rijksoverheid.nl/vraag-en-antwoord/zwangerschap-en-geboorte/checklist-kind-krijgen',
  },
  {
    action: 'Kind doğunca toeslagpartner, kindgebonden budget, kinderopvangtoeslag ve gelir değişikliği etkisini kontrol et; yanlış toeslag ileride borç doğurur.',
    source: 'Dienst Toeslagen',
    tag: 'Para',
    title: 'Toeslagen geri ödeme riskini azalt',
    url: 'https://www.toeslagen.nl/',
  },
  {
    action: 'IND dosyasında erkend referent, gelir şartı, iş sözleşmesi, maaş bordrosu, karar/itiraz tarihi ve avukatın istediği belge listesini tek kontrol tablosunda tut.',
    source: 'IND',
    tag: 'Oturum',
    title: 'Kennismigrant dosya kalkanı',
    url: 'https://ind.nl/nl/verblijfsvergunningen/werken/kennismigrant',
  },
  {
    action: '5 yıl çalışma/oturum eşiği ve “arbeid vrij toegestaan” notu için IND sayfasındaki şartları avukatla doğrula; sistem sadece hatırlatıcı üretir.',
    source: 'IND',
    tag: 'Gelecek hak',
    title: 'Serbest çalışma / kalıcı statü kontrolü',
    url: 'https://ind.nl/nl/vervangen-verlengen-vernieuwen-en-wijzigen/onbepaalde-tijd/verblijfsvergunning-onbepaalde-tijd-aanvragen',
  },
  {
    action: 'CJIB, mahkeme, belediye vergisi ve Belastingdienst yazılarında tutar + son ödeme + bezwaar süresini ayrı ayrı doğrula; ödeme ve itiraz kararını karıştırma.',
    source: 'CJIB / Rechtspraak / Belastingdienst',
    tag: 'Ceza/Borç',
    title: 'Borç-ceza erken uyarı kuralı',
    url: 'https://www.cjib.nl/direct-regelen/ik-ben-het-niet-eens-met-mijn-boete/ik-ben-het-niet-eens-met-een-verkeersboete',
  },
]

const featureLaunchpad = [
  { area: 'Akıllı arama', detail: 'Belge, mail, ödeme ve süre kayıtlarında tek kutudan doğal dil arama.', owner: 'Genel Bakış' },
  { area: 'Otomatik belge adı', detail: 'Kurum, tarih, tür ve tutardan arşiv adı önerisi.', owner: 'Evrak Kasası' },
  { area: 'Güven skoru', detail: 'Tutar, kurum, son tarih, kaynak ve özet eksikse açık uyarı.', owner: 'Evrak Kasası' },
  { area: 'Kurum profili', detail: 'Ödeme, itiraz, taksit ve portal linkleri tek kurum kartında.', owner: 'Kaynaklar' },
  { area: 'Berichtenbox akışı', detail: 'DigiD otomasyonu yapmadan resmi mesajı içeri alma rehberi.', owner: 'Yaşam Radar' },
  { area: 'Hatırlatma ladder', detail: '14/7/2/0/geçti takibi ve Google Takvim/.ics aksiyonu.', owner: 'Ödeme Planı' },
  { area: 'Karar sihirbazı', detail: 'Öde / itiraz et / taksit iste seçeneklerini riskle gösterir.', owner: 'Ödeme Planı' },
  { area: 'Onay workflow', detail: 'Belirsiz/tutarı yüksek/kritik kayıtları insan kontrolüne taşır.', owner: 'Onay Merkezi' },
  { area: 'AI mail kuralları', detail: 'CJIB/IND/belediye/toeslagen gibi sinyallerin sınıflandırma kuralı.', owner: 'Ayarlar' },
  { area: 'Düzeltmeden öğrenme', detail: 'Senin düzeltmeni bilgi bankasına kaydedip sonraki yorumlara katar.', owner: 'Ayarlar' },
  { area: 'Hayat takvimi', detail: 'Ceza, borç, IND, hamilelik ve kurum sürelerini tek timeline yapar.', owner: 'Yaşam Radar' },
  { area: 'Paylaşımlı görünüm', detail: 'Avukat/eş/muhasebe için kısıtlı paylaşım kapsamı taslağı.', owner: 'Yaşam Radar' },
]

const institutionProfiles = [
  {
    match: /\b(cjib|centraal justitieel|verkeersboete|bekeuring)\b/i,
    name: 'CJIB',
    purpose: 'Trafik cezası, ödeme, taksit ve itiraz akışları.',
    portalUrl: 'https://www.cjib.nl/direct-regelen/ik-wil-graag/ik-wil-betalen',
    objectionUrl: 'https://www.cjib.nl/direct-regelen/ik-ben-het-niet-eens-met-mijn-boete/ik-ben-het-niet-eens-met-een-verkeersboete',
    planUrl: 'https://www.cjib.nl/betalen-in-delen-aanvragen',
    risk: 'Ödeme, taksit ve itiraz kararını aynı anda alma; önce kenmerk/tutar/tarih eşleşsin.',
  },
  {
    match: /\b(den haag|denhaag|gemeente den haag|mijndenhaag|haagse)\b/i,
    name: 'Gemeente Den Haag',
    purpose: 'Parkeerbon, belediye faturası, taksit ve bezwaar kanalları.',
    portalUrl: 'https://www.denhaag.nl/nl/parkeren/parkeerbon-naheffingsaanslag/',
    objectionUrl: 'https://www.denhaag.nl/nl/parkeren/bezwaar-maken-tegen-een-parkeerbon-naheffingsaanslag/',
    planUrl: 'https://www.denhaag.nl/nl/belastingen/betalingsregeling-belastingen-aanvragen/',
    risk: 'Dagtekening, aanslagnummer ve ödeme kenmerk bilgisi görünmeden işlem yapma.',
  },
  {
    match: /\b(amsterdam|gemeente amsterdam|belastingbalie)\b/i,
    name: 'Gemeente Amsterdam',
    purpose: 'Parkeerbon, gemeentelijke belastingen ve ödeme düzeni.',
    portalUrl: 'https://belastingbalie.amsterdam.nl/',
    objectionUrl: 'https://www.amsterdam.nl/parkeren/parkeerbon/bezwaar-maken-parkeerbon/',
    planUrl: 'https://www.amsterdam.nl/parkeren/parkeerbon/betalingsregeling-afspreken-parkeerbon/',
    risk: 'Parkeerbon ile gemeentelijke belasting ödeme düzenleri farklı olabilir.',
  },
  {
    match: /\b(belastingdienst|toeslagen|belasting)\b/i,
    name: 'Belastingdienst / Toeslagen',
    purpose: 'Vergi, toeslagen, ödeme ve geri ödeme riski.',
    portalUrl: 'https://www.belastingdienst.nl/wps/wcm/connect/nl/betalen-en-ontvangen/betalen-en-ontvangen',
    objectionUrl: 'https://www.belastingdienst.nl/wps/wcm/connect/nl/bezwaar-en-beroep/bezwaar-en-beroep',
    planUrl: 'https://www.belastingdienst.nl/wps/wcm/connect/nl/betalen-en-ontvangen/content/betalingsregeling-aanvragen',
    risk: 'Gelir/aile değişikliği geç bildirilirse sonradan borç doğabilir.',
  },
  {
    match: /\b(ind|immigratie|kennismigrant|residence|oturum)\b/i,
    name: 'IND',
    purpose: 'Oturum, kennismigrant, aile birleşimi, belge ve süre takibi.',
    portalUrl: 'https://ind.nl/en/residence-permits/work/highly-skilled-migrant',
    objectionUrl: 'https://ind.nl/en/decision-on-your-application/objecting-to-the-decision-on-your-application',
    planUrl: 'https://ind.nl/en/service-contact/contact-with-ind',
    risk: 'Avukat ve resmi karar mektubu olmadan kesin hukuki karar üretme.',
  },
  {
    match: /\b(mijnoverheid|berichtenbox|digid|rijksoverheid)\b/i,
    name: 'MijnOverheid / Berichtenbox',
    purpose: 'Resmi devlet mesajları ve ekleri için manuel içe alma kapısı.',
    portalUrl: 'https://mijnoverheid.nl/',
    objectionUrl: 'https://www.digid.nl/',
    planUrl: 'https://mijnoverheid.nl/',
    risk: 'DigiD şifresi saklanmaz; kullanıcı manuel indirip Drive inbox’a koyar.',
  },
]

const emailAutomationRules = [
  { match: 'CJIB, parkeerbon, naheffing, boete', action: 'Ceza olarak işaretle, tutar/kenmerk/dagtekening/son ödeme çıkar, yüksek öncelik ver.' },
  { match: 'IND, kennismigrant, residence, bezwaar', action: 'Hukuk/IND olarak işaretle, avukat kontrolü ve belge paketi görevi üret.' },
  { match: 'Belastingdienst, toeslagen, aanslag', action: 'Vergi/borç olarak işaretle, ödeme ve bezwaar sürelerini ayrı göster.' },
  { match: 'Gemeente, Waterland, Den Haag, Amsterdam', action: 'Belediye profiliyle eşleştir, ödeme/taksit/itiraz linklerini bağla.' },
  { match: 'Reclame, nieuwsbrief, marketing', action: 'Düşük öncelik; ödeme/süre çıkmadıysa evrak kasasına aksiyon üretme.' },
]

const berichtenboxSteps = [
  'MijnOverheid / Berichtenbox’a kullanıcı manuel DigiD ile girer.',
  'Yeni resmi mesajın PDF/ekini indirir veya telefonda paylaş/kaydet yapar.',
  'Dosyayı Drive içindeki “Muh Agent Inbox” klasörüne koyar.',
  'Dashboard’da “Belgeleri şimdi oku” çalışır; kurum, tutar, süre ve kaynak panelde görünür.',
  'Ajan otomatik ödeme veya resmi başvuru yapmaz; sadece aksiyon taslağı ve onay kaydı üretir.',
]

const shareScopes = [
  { audience: 'Avukat görünümü', detail: 'Sadece IND/mahkeme dosyaları, tarihçe, kaynak linki ve belge paketi taslağı.' },
  { audience: 'Eş görünümü', detail: 'Ortak ödeme, hamilelik, belediye ve aile takvimi; hassas teknik log yok.' },
  { audience: 'Muhasebe görünümü', detail: 'Fatura/vergi/ödeme belgeleri; IND sağlık ve özel notlar kapalı.' },
]

const learningTemplates = [
  {
    category: 'skill' as const,
    title: 'Düzeltme: kurum/tarih/tutar öğrenme kuralı',
    body: 'Kullanıcı bir belgede kurum, belge türü, tutar veya son tarihi düzeltirse aynı gönderen/kurum/anahtar kelime için sonraki belgelerde bu düzeltme öneri olarak kullanılacak; yine kaynak doğrulaması istenecek.',
  },
  {
    category: 'fine' as const,
    title: 'Ceza kararı: ödeme/itiraz/taksit ayrımı',
    body: 'Ceza belgesinde ödeme, bezwaar/itiraz ve taksit seçenekleri ayrı aksiyon olarak gösterilecek. Belge numarası, dagtekening, tutar ve resmi portal linki görülmeden kesin ödeme önerilmeyecek.',
  },
  {
    category: 'immigration' as const,
    title: 'IND dosyası: avukat kontrolü zorunlu',
    body: 'IND, kennismigrant, erkend referent, bezwaar veya oturum iptali içeren kayıtlar ödeme gibi kapatılmayacak; avukat kontrolü ve belge paketi görevi üretilecek.',
  },
]

const formatEuro = (amount: number) =>
  new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(amount)

const currentDateLabel = new Intl.DateTimeFormat('tr-TR', {
  day: 'numeric',
  month: 'long',
  timeZone: 'Europe/Amsterdam',
  weekday: 'long',
  year: 'numeric',
}).format(new Date()).toLocaleUpperCase('tr-TR')

const daysUntil = (date: string) => {
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  const target = new Date(`${date}T12:00:00`)
  return Math.ceil((target.getTime() - today.getTime()) / 86_400_000)
}

const validViews = new Set<ViewId>(nav.map((item) => item.id))

function initialView(): ViewId {
  const candidate = new URLSearchParams(window.location.search).get('view') as ViewId | null
  return candidate && validViews.has(candidate) ? candidate : 'overview'
}

function initialNotice() {
  const query = new URLSearchParams(window.location.search)
  if (query.get('password') === 'recovery') return 'Şifre belirleme oturumu açıldı. Ayarlar bölümünden yeni şifreni kaydet.'
  if (query.get('password') === 'recovery_failed') return 'Şifre belirleme bağlantısı doğrulanamadı. Yeni bağlantı iste.'
  if (query.get('gmail') === 'connected') return 'Gmail hesabı bağlandı; ilk güvenli senkronizasyon hazırlanıyor.'
  if (query.get('gmail') === 'cancelled') return 'Google izin ekranı kapatıldı; hiçbir Gmail hesabı bağlanmadı.'
  if (query.get('gmail') === 'expired') return 'Gmail bağlantı oturumu sona erdi. Bağlantıyı yeniden başlatın.'
  if (query.get('gmail') === 'failed') {
    const error = query.get('gmail_error')
    if (error === 'google_client_invalid') return 'Google OAuth istemci kimliği ve gizli anahtarı eşleşmiyor. Aynı Google OAuth uygulamasına ait olduklarını kontrol edin.'
    if (error === 'google_code_invalid') return 'Google yetkilendirme kodu geçersiz veya kullanılmış. Bağlantıyı yeniden başlatın.'
    if (error === 'google_scope_mismatch') return 'Google gerekli salt-okunur Gmail izinlerini döndürmedi. İzin ekranında tüm istenen izinleri onaylayın.'
    if (error === 'google_refresh_token_missing') return 'Google kalıcı erişim anahtarını döndürmedi. Hesabı Google izinlerinden kaldırıp yeniden bağlayın.'
    if (error === 'token_encryption_invalid') return 'Gmail token şifreleme anahtarı geçerli değil. Supabase ayarını 32 bayt anahtarla güncelleyin.'
    if (error === 'account_save_failed') return 'Gmail hesabı güvenli biçimde kaydedilemedi. Bağlantı kaydı oluşturulmadı.'
    if (error === 'oauth_not_configured') return 'Google OAuth ayarları eksik. Client ID, Client Secret ve yönlendirme adresini kontrol edin.'
    return 'Gmail bağlantısı tamamlanamadı. Güvenli hata kaydı oluşturuldu; ayarlardan yeniden deneyin.'
  }
  return ''
}

function gmailConnectErrorMessage(error: unknown) {
  const code = error instanceof ApiError ? error.code : ''
  if (code === 'unauthorized') return 'Gmail bağlantısı için önce dashboarddan oturum açın.'
  if (code === 'rate_limited') return 'Gmail bağlantısı için çok sık deneme yapıldı. Bir dakika bekleyin.'
  if (code === 'oauth_not_configured') return 'Google OAuth ayarları eksik veya token şifreleme anahtarı geçersiz; mevcut Gmail izinleri değişmedi.'
  if (code === 'oauth_start_failed') return 'Gmail OAuth başlangıcı güvenli biçimde tamamlanamadı; mevcut Gmail izinleri değişmedi.'
  return 'Gmail bağlantısı başlatılamadı; mevcut yetkiler değişmedi.'
}

const evidenceLevels = new Set<EvidenceLevel>(['verified', 'review', 'demo'])
const obligationStatuses = new Set<ObligationStatus>(['open', 'overdue', 'paid', 'disputed'])

function normalizePaymentGuidance(value: unknown): PaymentGuidance | undefined {
  if (!value || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  const guidance: PaymentGuidance = {}
  for (const key of ['bulkPayment', 'installmentSummary', 'objectionUrl', 'paymentMethod', 'paymentPlanUrl', 'paymentUrl', 'portalLabel', 'referenceHint', 'sourceLabel', 'sourceUrl', 'warning'] as const) {
    const text = source[key]
    if (typeof text === 'string' && text.trim()) guidance[key] = text.trim()
  }
  return Object.keys(guidance).length ? guidance : undefined
}

function guidanceForObligation(item: Pick<Obligation, 'authority' | 'note' | 'paymentGuidance' | 'title'>): PaymentGuidance | undefined {
  if (item.paymentGuidance && Object.keys(item.paymentGuidance).length > 0) return item.paymentGuidance
  const haystack = `${item.authority} ${item.title} ${item.note}`
  return officialPaymentGuides.find((guide) => guide.match.test(haystack))?.guidance
}

function authorityProfileFor(text: string) {
  return institutionProfiles.find((profile) => profile.match.test(text)) ?? institutionProfiles[institutionProfiles.length - 1]
}

function searchText(...parts: Array<string | undefined | null>) {
  return parts.filter(Boolean).join(' ').toLocaleLowerCase('tr-TR')
}

function matchesQuery(query: string, ...parts: Array<string | undefined | null>) {
  const term = query.trim().toLocaleLowerCase('tr-TR')
  if (!term) return true
  return searchText(...parts).includes(term)
}

function documentConfidence(file: ProviderFile) {
  const missing: string[] = []
  const extraction = extractionRecord(file)
  const amount = extractionAmount(file)
  const authority = fileAuthority(file)
  const dueDate = extractionText(file, 'due_date')
  const summary = extractionSummary(file)
  if (!extraction) missing.push('içerik OCR')
  if (!authority || authority === file.classification) missing.push('kurum')
  if (amount === null && ['Ceza', 'Fatura / ödeme', 'Vergi / belediye'].includes(fileCategory(file))) missing.push('tutar')
  if (!dueDate && ['Ceza', 'Fatura / ödeme', 'Vergi / belediye', 'Hukuk / IND'].includes(fileCategory(file))) missing.push('son tarih')
  if (!file.webUrl) missing.push('kaynak linki')
  if (!summary || summary === 'İçerik okuma bekliyor.') missing.push('özet')
  const score = Math.max(30, 100 - missing.length * 12 - (file.extractionStatus === 'failed' ? 25 : 0) - (file.extractionStatus === 'pending' ? 20 : 0))
  return { label: score >= 86 ? 'Yüksek güven' : score >= 65 ? 'Kontrol et' : 'Eksik okuma', missing, score }
}

function suggestedDocumentName(file: ProviderFile) {
  const date = extractionText(file, 'due_date') ?? file.modifiedAt?.slice(0, 10) ?? new Date().toISOString().slice(0, 10)
  const authority = fileAuthority(file).replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60)
  const category = fileCategory(file).replaceAll(' / ', '-').replace(/[\\/:*?"<>|]+/g, '-')
  const amount = extractionAmount(file)
  return `${date} - ${authority || 'Bilinmeyen kurum'} - ${category}${amount === null ? '' : ` - ${formatEuro(amount).replace(/\s/g, '')}`}.pdf`
}

function reminderMilestones(date: string) {
  const days = validPaymentDate(date) ? daysUntil(date) : null
  if (days === null) return ['Tarih okununca 14/7/2/0 gün uyarıları hazırlanır.']
  if (days < 0) return [`${Math.abs(days)} gün geçti`, 'Bugün kontrol', 'Kaynak doğrula', 'Onay Merkezi']
  return ['14 gün kala hazırlık', '7 gün kala kaynak kontrolü', '2 gün kala alarm', days === 0 ? 'Bugün son gün' : `${days} gün kaldı`]
}

function decisionOptionsFor(item: Obligation) {
  const guidance = guidanceForObligation(item)
  const time = paymentTimeLabel(item)
  return [
    {
      action: 'Öde',
      detail: guidance?.paymentMethod ?? 'Resmi portal veya belgedeki kenmerk ile ödeme doğrulanmalı.',
      risk: item.amount > 250 || time.days === null ? 'Kontrol' : 'Uygun',
      url: guidance?.paymentUrl,
    },
    {
      action: 'İtiraz et',
      detail: guidance?.warning ?? 'İtiraz süresi ve ödeme gerekip gerekmediği resmi sayfadan kontrol edilmeli.',
      risk: 'Avukat/kaynak',
      url: guidance?.objectionUrl,
    },
    {
      action: 'Taksit iste',
      detail: guidance?.installmentSummary ?? 'Kurumun ödeme düzeni sayfasından koşul kontrol edilmeli.',
      risk: 'Koşullu',
      url: guidance?.paymentPlanUrl,
    },
  ]
}

function lifeCalendarItems(obligationItems: Obligation[], deadlineItems: Deadline[]) {
  const paymentItems = obligationItems
    .filter((item) => item.status !== 'paid' && validPaymentDate(item.dueDate))
    .map((item) => ({ date: item.dueDate, title: item.title, meta: `${item.authority} · ${item.amount ? formatEuro(item.amount) : 'Tutar belirsiz'}`, kind: 'Ödeme' }))
  const deadlineRows = deadlineItems
    .filter((item) => item.status !== 'done')
    .map((item) => ({ date: item.date, title: item.title, meta: item.owner, kind: 'Süre' }))
  return [...paymentItems, ...deadlineRows].sort((a, b) => daysUntil(a.date) - daysUntil(b.date)).slice(0, 10)
}

function mapDashboard(payload: DashboardResponse) {
  const liveObligations: Obligation[] = payload.obligations.map((item) => ({
    amount: Number(item.amount ?? 0),
    authority: item.authority,
    category: ({ fine: 'Ceza', invoice: 'Fatura', tax: 'Vergi', insurance: 'Sigorta' } as const)[item.category as 'fine'] ?? 'Diğer',
    currency: 'EUR',
    dueDate: item.due_date ?? 'Tarih yok',
    evidence: evidenceLevels.has(item.evidence_level as EvidenceLevel) ? item.evidence_level as EvidenceLevel : 'review',
    id: item.id,
    note: item.note ?? 'Açıklama eklenmedi.',
    paymentGuidance: normalizePaymentGuidance(item.payment_guidance),
    source: item.source_url ?? 'Supabase kaydı',
    sourceExcerpt: item.source_excerpt ?? undefined,
    sourceLabel: item.source_label ?? undefined,
    sourceUrl: item.source_web_url ?? (item.source_url?.startsWith('http') ? item.source_url : undefined),
    status: obligationStatuses.has(item.status as ObligationStatus) ? item.status as ObligationStatus : 'open',
    title: item.display_title ?? item.title,
  }))
  const liveDeadlines: Deadline[] = payload.deadlines.map((item) => {
    const date = item.due_at.slice(0, 10)
    const days = daysUntil(date)
    return {
      date,
      evidence: evidenceLevels.has(item.evidence_level as EvidenceLevel) ? item.evidence_level as EvidenceLevel : 'review',
      id: item.id,
      owner: item.owner,
      sourceExcerpt: item.source_excerpt ?? undefined,
      sourceLabel: item.source_label ?? undefined,
      sourceUrl: item.source_web_url ?? (item.source_url?.startsWith('http') ? item.source_url : undefined),
      status: item.status === 'waiting' ? 'waiting' : item.status === 'done' || item.status === 'dismissed' ? 'done' : 'open',
      title: item.display_title ?? item.title,
      urgency: days <= 2 ? 'critical' : days <= 7 ? 'soon' : 'planned',
    }
  })
  const liveApprovals: ApprovalItem[] = payload.approvals.map((item) => ({
    action: item.actionType === 'payment' ? 'payment' : item.actionType === 'send_email' ? 'send' : item.actionType === 'connect_account' ? 'connect' : 'publish',
    amount: typeof item.amount === 'number' ? item.amount : undefined,
    description: item.description || 'Detaylar onay ekranında yeniden doğrulanmalı.',
    id: item.id,
    risk: item.risk === 'high' || item.risk === 'low' ? item.risk : 'medium',
    status: item.status === 'approved' ? 'approved' : item.status === 'rejected' ? 'rejected' : 'pending',
    title: item.title,
  }))
  const liveAccounts: MailAccount[] = payload.accounts.map((item) => ({
    email: item.email,
    id: item.id,
    lastSync: item.last_sync_at ?? undefined,
    provider: item.provider === 'outlook' ? 'Outlook' : item.provider === 'imap' ? 'IMAP' : 'Gmail',
    scopes: item.scopes,
    status: item.status === 'connected' ? 'connected' : 'reauth_required',
  }))
  const accountsById = new Map(liveAccounts.map((account) => [account.id, account.email]))
  const liveMessages: DashboardMessage[] = payload.messages.map((item) => {
    const status = ['queued', 'processing', 'processed', 'review_required', 'failed'].includes(item.processing_status) ? item.processing_status as DashboardMessage['status'] : 'queued'
    return {
      accountEmail: accountsById.get(item.account_id) ?? 'Bilinmeyen hesap',
      accountId: item.account_id,
      classification: item.classification ?? 'general',
      extracted: item.extracted_data ?? {},
      from: item.from_address ?? 'Gönderen yok',
      id: item.id,
      receivedAt: item.received_at ?? undefined,
      snippet: item.snippet ?? '',
      status,
      subject: item.subject ?? '(konu yok)',
      sourceUrl: item.source_web_url ?? undefined,
    }
  })
  const liveFiles: ProviderFile[] = payload.files.map((item) => {
    const status = ['metadata', 'review_required', 'ignored', 'failed'].includes(item.status) ? item.status as ProviderFile['status'] : 'metadata'
    const extractionStatus = ['pending', 'processing', 'extracted', 'skipped', 'failed'].includes(item.extraction_status ?? '') ? item.extraction_status as ProviderFile['extractionStatus'] : 'pending'
    return {
      accountEmail: accountsById.get(item.account_id) ?? 'Bilinmeyen hesap',
      accountId: item.account_id,
      classification: item.classification ?? 'drive_document',
      documentId: item.document_id ?? undefined,
      extracted: item.extracted_data ?? {},
      extractedAt: item.extracted_at ?? undefined,
      extractionErrorCode: item.extraction_error_code ?? undefined,
      extractionStatus,
      id: item.id,
      lastSeenAt: item.last_seen_at,
      mimeType: item.mime_type,
      modifiedAt: item.modified_at ?? undefined,
      name: item.name,
      provider: item.provider === 'gmail' ? 'Gmail' : item.provider === 'upload' ? 'Upload' : 'Drive',
      sizeBytes: typeof item.size_bytes === 'number' ? item.size_bytes : undefined,
      status,
      sourceLabel: item.source_label ?? undefined,
      webUrl: item.web_url ?? undefined,
    }
  })
  const liveNotifications: NotificationItem[] = payload.notifications.map((item) => ({
    body: item.body,
    createdAt: item.created_at,
    id: item.id,
    readAt: item.read_at ?? undefined,
    severity: item.severity === 'critical' || item.severity === 'warning' ? item.severity : 'info',
    sourceUrl: item.source_url ?? undefined,
    title: item.title,
  }))
  const latestSnapshotBySource = new Map<string, DashboardResponse['sourceSnapshots'][number]>()
  for (const snapshot of payload.sourceSnapshots) {
    if (!latestSnapshotBySource.has(snapshot.source_id)) latestSnapshotBySource.set(snapshot.source_id, snapshot)
  }
  const liveSources: SourceRecord[] = payload.sources.map((item) => {
    const snapshot = latestSnapshotBySource.get(item.id)
    return {
      domain: item.domain,
      enabled: item.enabled_by_default,
      id: item.id,
      lastChecked: snapshot ? new Date(snapshot.fetched_at).toLocaleString('tr-TR') : 'Henüz public kontrol yok',
      name: item.name,
      purpose: snapshot?.title ? `${item.purpose} · Son başlık: ${snapshot.title}` : item.purpose,
      trust: item.trust === 'secondary' ? 'secondary' : 'official',
    }
  })
  const liveKnowledge: KnowledgeItem[] = payload.knowledgeItems.map((item) => {
    const category = Object.hasOwn(knowledgeCategoryLabel, item.category) ? item.category as KnowledgeItem['category'] : 'other'
    return {
      body: item.body,
      category,
      createdAt: item.created_at,
      evidence: evidenceLevels.has(item.evidence_level as EvidenceLevel) ? item.evidence_level as EvidenceLevel : 'review',
      id: item.id,
      sourceUrl: item.source_url ?? undefined,
      title: item.title,
    }
  })
  return { accounts: liveAccounts, approvals: liveApprovals, deadlines: liveDeadlines, files: liveFiles, knowledge: liveKnowledge, messages: liveMessages, notifications: liveNotifications, obligations: liveObligations, sources: liveSources }
}

function EvidencePill({ level }: { level: EvidenceLevel }) {
  return <span className={`pill evidence-${level}`}>{evidenceLabel[level]}</span>
}

function App() {
  const [view, setView] = useState<ViewId>(initialView)
  const [session, setSession] = useState<SessionResponse>()
  const [runtimeError, setRuntimeError] = useState('')
  const [liveData, setLiveData] = useState<ReturnType<typeof mapDashboard>>()
  const [liveCounts, setLiveCounts] = useState({ documents: 0, messages: 0 })
  const [approvalsState, setApprovalsState] = useState<ApprovalItem[]>(initialApprovals)
  const [loginOpen, setLoginOpen] = useState(false)
  const [toast, setToast] = useState(initialNotice)
  const [extractingDocuments, setExtractingDocuments] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [chatMessages, setChatMessages] = useState([
    { role: 'agent', text: 'Merhaba. Gerçek hesap, belge ve resmi kaynak doğrulanmadan kesin karar vermem; hiçbir dış işlemi sessizce yürütmem.' },
  ])

  useEffect(() => {
    let active = true
    void getSession().then(async (nextSession) => {
      if (!active) return
      setSession(nextSession)
      if (nextSession.mode === 'live' && nextSession.authenticated) {
        try {
          const payload = await getDashboard()
          if (!active) return
          const mapped = mapDashboard(payload)
          setLiveData(mapped)
          setLiveCounts(payload.counts)
          setApprovalsState(mapped.approvals)
        } catch {
          if (active) setRuntimeError('Canlı veriler güvenli biçimde alınamadı. Yenilemeden önce bağlantıyı kontrol edin.')
        }
      }
    }).catch(() => {
      if (active) setRuntimeError('Uygulama sunucusuna ulaşılamadı.')
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (window.location.search) window.history.replaceState({}, '', window.location.pathname)
  }, [])

  const liveMode = session?.mode === 'live' && session.authenticated
  const loginRequired = session?.mode === 'live' && !session.authenticated
  const activeObligations = liveData?.obligations ?? obligations
  const activeDeadlines = liveData?.deadlines ?? deadlines
  const activeAccounts = liveData?.accounts ?? mailAccounts
  const activeFiles = liveData?.files ?? []
  const activeKnowledge = liveData?.knowledge ?? []
  const activeMessages = liveData?.messages ?? []
  const activeNotifications = liveData?.notifications ?? []
  const activeSources = liveData?.sources.length ? liveData.sources : sources
  const pendingApprovals = approvalsState.filter((item) => item.status === 'pending').length

  const showToast = (message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(''), 3200)
  }

  const refreshDashboard = async () => {
    const payload = await getDashboard()
    const mapped = mapDashboard(payload)
    setLiveData(mapped)
    setLiveCounts(payload.counts)
    setApprovalsState(mapped.approvals)
    return mapped
  }

  const approve = async (id: string) => {
    if (liveMode) {
      try {
        await decideApproval(id, 'approved')
        setApprovalsState((items) => items.map((item) => (item.id === id ? { ...item, status: 'approved' } : item)))
        showToast('Karar denetim kaydına işlendi. Bu onay dış işlemi kendiliğinden yürütmez.')
      } catch {
        showToast('Onay kaydedilemedi; hiçbir dış işlem yapılmadı.')
      }
      return
    }
    setApprovalsState((items) => items.map((item) => (item.id === id ? { ...item, status: 'approved' } : item)))
    showToast('Onay demo kaydına işlendi; dış sistemde işlem yapılmadı.')
  }

  const connectGmail = async (includeDrive = false) => {
    if (!liveMode) {
      if (loginRequired) {
        setLoginOpen(true)
        showToast('Gmail bağlantısı için önce dashboarddan oturum açın.')
        return
      }
      showToast('OAuth kurulumu canlı ortamda henüz yapılandırılmadı.')
      return
    }
    try {
      const { authorizationUrl } = await beginGmailConnection(includeDrive)
      window.location.assign(authorizationUrl)
    } catch (error) {
      showToast(gmailConnectErrorMessage(error))
    }
  }

  const saveKnowledge = async (input: { body: string; category: string; sourceUrl?: string; title: string }) => {
    if (!liveMode) {
      showToast(loginRequired ? 'Bilgi kaydı için önce dashboarddan oturum açın.' : 'Bilgi bankası canlı ortamda kaydedilir.')
      if (loginRequired) setLoginOpen(true)
      return false
    }
    try {
      const { item } = await createKnowledgeItem(input)
      const category = Object.hasOwn(knowledgeCategoryLabel, item.category) ? item.category as KnowledgeItem['category'] : 'other'
      const nextItem: KnowledgeItem = {
        body: item.body,
        category,
        createdAt: item.created_at,
        evidence: evidenceLevels.has(item.evidence_level as EvidenceLevel) ? item.evidence_level as EvidenceLevel : 'review',
        id: item.id,
        sourceUrl: item.source_url ?? undefined,
        title: item.title,
      }
      setLiveData((current) => current ? { ...current, knowledge: [nextItem, ...current.knowledge] } : current)
      showToast('Bilgi bankasına kaydedildi. Ajan bunu önerilerde inceleme kaydı olarak kullanacak.')
      return true
    } catch {
      showToast('Bilgi kaydedilemedi; kayıt değiştirilmedi.')
      return false
    }
  }

  const runDocumentExtraction = async () => {
    if (!liveMode) {
      showToast(loginRequired ? 'Belge okuma için önce dashboarddan oturum açın.' : 'Belge okuma canlı ortamda çalışır.')
      if (loginRequired) setLoginOpen(true)
      return
    }
    setExtractingDocuments(true)
    try {
      const result = await extractDocuments(5)
      await refreshDashboard()
      const failed = result.files.filter((file) => file.status === 'failed').length
      if (result.files.length === 0) showToast('Okunacak yeni Drive belgesi yok.')
      else if (failed) showToast(`${result.files.length - failed} belge okundu, ${failed} belge hata verdi. Detay Evrak Kasası’nda.`)
      else showToast(`${result.files.length} belge okundu ve sisteme işlendi.`)
    } catch (error) {
      const code = error instanceof ApiError ? error.code : 'document_extract_failed'
      showToast(code === 'ocr_not_configured'
        ? 'Belge OCR motoru için OpenAI anahtarı eksik. Kod hazır; anahtar eklenince okuyacak.'
        : 'Belge okuma başlatılamadı; veri değiştirilmedi.')
    } finally {
      setExtractingDocuments(false)
    }
  }

  const leaveSession = async () => {
    try {
      await signOut()
      window.location.assign('/')
    } catch {
      showToast('Oturum güvenli biçimde kapatılamadı; sayfayı yenilemeden devam etmeyin.')
    }
  }

  const sendChat = () => {
    const text = chatInput.trim()
    if (!text) return
    setChatMessages((items) => [
      ...items,
      { role: 'user', text },
      { role: 'agent', text: liveMode ? 'Canlı sohbet motoru henüz etkin değil. Kayıtlarını değiştirmedim ve dışarıya mesaj ya da ödeme göndermedim.' : 'Bu güvenli önizlemede canlı veri kaynağı yok. Kaynak gösteren inceleme taslağı dışında ödeme ya da mesaj gönderimi yapılmaz.' },
    ])
    setChatInput('')
  }

  if (!session && !runtimeError) return <LoadingScreen />
  if (runtimeError) return <FailureScreen message={runtimeError} />
  if (liveMode && !liveData) return <LoadingScreen label="Şifreli kayıtlar yükleniyor…" />

  const content = (() => {
    switch (view) {
      case 'inbox': return <InboxView accounts={activeAccounts} live={liveMode} messageCount={liveCounts.messages} messages={activeMessages} />
      case 'payments': return <PaymentsView items={activeObligations} live={liveMode} onOpenApprovals={() => setView('approvals')} />
      case 'documents': return <DocumentsView documentCount={liveCounts.documents} extracting={extractingDocuments} files={activeFiles} live={liveMode} onExtract={runDocumentExtraction} />
      case 'deadlines': return <DeadlinesView items={activeDeadlines} live={liveMode} />
      case 'life': return <LifeRadarView deadlines={activeDeadlines} knowledge={activeKnowledge} live={liveMode} notifications={activeNotifications} obligations={activeObligations} onOpenSettings={() => setView('settings')} />
      case 'approvals': return <ApprovalsView deadlines={activeDeadlines} items={approvalsState} live={liveMode} obligations={activeObligations} onApprove={approve} onNavigate={setView} />
      case 'sources': return <SourcesView sources={activeSources} />
      case 'settings': return <SettingsView accounts={activeAccounts} knowledge={activeKnowledge} live={liveMode} onConnect={connectGmail} onNotice={showToast} onSaveKnowledge={saveKnowledge} onSignOut={leaveSession} />
      default:
        return <OverviewView accounts={activeAccounts} approvals={approvalsState} deadlines={activeDeadlines} documentCount={liveCounts.documents} files={activeFiles} live={liveMode} loginRequired={loginRequired} messages={activeMessages} notifications={activeNotifications} obligations={activeObligations} onLogin={() => setLoginOpen(true)} onNavigate={setView} />
    }
  })()

  return (
    <div className="app-shell" data-testid="dashboard-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-mark">M</div>
          <div>
            <div className="brand-name">MUH AGENT</div>
            <div className="brand-subtitle">kişisel güvenlik cockpit'i</div>
          </div>
        </div>

        <div className="mode-card">
          <div className="mode-dot" />
          <div>
            <div className="eyebrow">ÇALIŞMA MODU</div>
            <strong>{liveMode ? 'Canlı / korumalı' : 'Demo / güvenli önizleme'}</strong>
            <p>{liveMode ? 'HttpOnly oturum etkin' : 'Gerçek hesaplara bağlı değil'}</p>
          </div>
        </div>

        <nav className="nav-list" aria-label="Ana menü">
          {nav.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${view === item.id ? 'active' : ''}`}
              onClick={() => setView(item.id)}
              data-testid={`nav-${item.id}`}
            >
              <span className="nav-icon">{item.icon}</span>
              <span>{item.label}</span>
              {item.id === 'approvals' && pendingApprovals > 0 && <span className="nav-badge">{pendingApprovals}</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="security-note"><span>●</span> {liveMode ? 'Şifreli oturum' : 'Yerel önizleme'}</div>
          <div className="security-note muted">v0.2 · {liveMode ? 'RLS etkin' : 'bağlantı yok'}</div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div>
            <div className="eyebrow" data-testid="current-date">{currentDateLabel}</div>
            <h1>{nav.find((item) => item.id === view)?.label}</h1>
          </div>
          <div className="topbar-actions">
            <span className="status-chip"><span className="status-dot" /> {liveMode ? 'Canlı kasa bağlı' : 'Veri bağlantısı yok'}</span>
            {loginRequired && <button className="button secondary login-topbar" data-testid="open-login" onClick={() => setLoginOpen(true)}>Dashboard'dan giriş yap</button>}
            <button className="avatar-button" aria-label="Profil ayarları" onClick={() => setView('settings')}>S</button>
          </div>
        </header>

        <div className="content-wrap">
          {loginOpen && <LoginPanel onClose={() => setLoginOpen(false)} />}
          {content}
        </div>
      </main>

      {view === 'overview' && (
        <section className="chat-dock" aria-label="Ajan sohbeti">
          <div className="chat-head">
            <div className="agent-orb">✦</div>
            <div><strong>Güvenlik ajanı</strong><span>Kaynak görmeden kesin konuşmaz</span></div>
            <span className="live-label">{liveMode ? 'KORUMALI' : 'DEMO'}</span>
          </div>
          <div className="chat-messages">
            {chatMessages.slice(-3).map((message, index) => <div className={`chat-message ${message.role}`} key={`${message.role}-${index}`}>{message.text}</div>)}
          </div>
          <div className="chat-input-row">
            <input value={chatInput} onChange={(event) => setChatInput(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && sendChat()} placeholder="Bir soru yaz…" aria-label="Ajan sorusu" />
            <button onClick={sendChat} aria-label="Gönder">↑</button>
          </div>
        </section>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  )
}

function LoadingScreen({ label = 'Güvenli çalışma modu denetleniyor…' }: { label?: string }) {
  return <main className="auth-shell"><section className="auth-card panel"><div className="brand-mark">M</div><div className="eyebrow">MUH AGENT</div><h1>{label}</h1><p>Oturum ve çalışma modu doğrulanmadan kişisel kayıt gösterilmiyor.</p></section></main>
}

function FailureScreen({ message }: { message: string }) {
  return <main className="auth-shell"><section className="auth-card panel"><div className="brand-mark">!</div><div className="eyebrow">GÜVENLİ DURUŞ</div><h1>Bağlantı kurulamadı</h1><p>{message}</p><button className="button primary" onClick={() => window.location.reload()}>Yeniden dene</button></section></main>
}

function LoginPanel({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPasswordValue] = useState('')
  const [status, setStatus] = useState<'idle' | 'submitting' | 'error'>('idle')
  const [recoveryStatus, setRecoveryStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setStatus('submitting')
    try {
      await signIn(email, password)
      window.location.assign('/')
    } catch {
      setStatus('error')
    }
  }

  const requestRecovery = async () => {
    if (!email.trim()) {
      setRecoveryStatus('error')
      return
    }
    setRecoveryStatus('sending')
    try {
      await requestPasswordRecovery(email)
      setRecoveryStatus('sent')
    } catch {
      setRecoveryStatus('error')
    }
  }

  return <section className="login-panel panel" data-testid="login-panel" aria-labelledby="dashboard-login-title"><div className="login-panel-head"><div><div className="eyebrow">DASHBOARD OTURUMU</div><h2 id="dashboard-login-title">Dashboard’dan giriş yap</h2><p>Giriş yalnızca e-posta ve şifreyle yapılır; normal girişte e-posta veya kod gönderilmez.</p></div><button type="button" className="button ghost" onClick={onClose}>Kapat</button></div><form className="auth-form" onSubmit={submit}><label htmlFor="login-email">E-posta adresi</label><input id="login-email" type="email" autoComplete="username" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} /><label htmlFor="login-password">Şifre</label><input id="login-password" type="password" autoComplete="current-password" required minLength={12} maxLength={128} value={password} onChange={(event) => setPasswordValue(event.target.value)} /><button className="button primary" disabled={status === 'submitting'}>{status === 'submitting' ? 'Giriş yapılıyor…' : 'Giriş yap'}</button><button type="button" className="button ghost" disabled={recoveryStatus === 'sending'} onClick={() => void requestRecovery()}>{recoveryStatus === 'sending' ? 'Bağlantı hazırlanıyor…' : 'İlk şifre bağlantısı gönder'}</button></form>{status === 'error' && <div className="auth-notice error" role="alert">E-posta veya şifre doğru değil. Bu hesap eski magic-link hesabıysa “İlk şifre bağlantısı gönder” düğmesini kullan.</div>}{recoveryStatus === 'sent' && <div className="auth-notice" role="status">Adres sistemde kayıtlıysa şifre belirleme bağlantısı gönderildi. Linke basınca Ayarlar bölümünden yeni şifreni kaydet.</div>}{recoveryStatus === 'error' && <div className="auth-notice error" role="alert">Şifre belirleme bağlantısı istenemedi. E-posta adresini kontrol et ve tekrar dene.</div>}<small>Oturum jetonları JavaScript'e açılmaz; yalnızca HttpOnly çerezde tutulur.</small></section>
}

function PasswordPanel({ onNotice }: { onNotice: (message: string) => void }) {
  const [password, setPasswordValue] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [status, setStatus] = useState<'idle' | 'saving' | 'error' | 'saved'>('idle')
  const [message, setMessage] = useState('')

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (password.length < 12) {
      setMessage('Şifre en az 12 karakter olmalı.')
      setStatus('error')
      return
    }
    if (password !== confirmation) {
      setMessage('Şifre tekrarı eşleşmiyor.')
      setStatus('error')
      return
    }

    setStatus('saving')
    try {
      await setPassword(password)
      setPasswordValue('')
      setConfirmation('')
      setMessage('Şifre kaydedildi. Sonraki girişlerde e-posta ve şifren yeterli olacak.')
      setStatus('saved')
      onNotice('Oturum şifresi kaydedildi; artık e-posta kodu gönderilmeyecek.')
    } catch (error) {
      const code = error instanceof ApiError ? error.code : ''
      setMessage(code === 'password_reauthentication_required'
        ? 'Bu oturum çok eski. Şifreyi belirlemek için yeni bir oturum açın.'
        : 'Şifre kaydedilemedi. Şifren değiştirilmedi.')
      setStatus('error')
    }
  }

  return <section className="panel password-panel" aria-labelledby="password-panel-title"><div className="eyebrow">ŞİFRELİ GİRİŞ</div><h3 id="password-panel-title">Oturum şifresi belirle</h3><p>Bu açık oturumda bir kez şifre belirle. Bundan sonra girişte yalnızca e-posta ve şifre kullanılacak.</p><form className="auth-form" onSubmit={submit}><label htmlFor="new-password">Yeni şifre</label><input id="new-password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={password} onChange={(event) => setPasswordValue(event.target.value)} /><label htmlFor="confirm-password">Şifre tekrarı</label><input id="confirm-password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /><button className="button primary" disabled={status === 'saving'}>{status === 'saving' ? 'Kaydediliyor…' : 'Şifreyi kaydet'}</button></form>{status === 'error' && <div className="auth-notice error" role="alert">{message}</div>}{status === 'saved' && <div className="auth-notice" role="status">{message}</div>}<small>Şifre yalnızca doğrulama servisine HTTPS üzerinden iletilir; uygulama içinde tutulmaz.</small></section>
}

function PageIntro({ eyebrow, title, detail, action }: { eyebrow: string; title: string; detail: string; action?: React.ReactNode }) {
  return <div className="page-intro"><div><div className="eyebrow">{eyebrow}</div><h2>{title}</h2><p>{detail}</p></div>{action}</div>
}

function OverviewView({ accounts, approvals, deadlines: deadlineItems, documentCount, files, live, loginRequired, messages, notifications, obligations: obligationItems, onLogin, onNavigate }: { accounts: MailAccount[]; approvals: ApprovalItem[]; deadlines: Deadline[]; documentCount: number; files: ProviderFile[]; live: boolean; loginRequired: boolean | undefined; messages: DashboardMessage[]; notifications: NotificationItem[]; obligations: Obligation[]; onLogin: () => void; onNavigate: (view: ViewId) => void }) {
  const [searchQuery, setSearchQuery] = useState('')
  const dueSoon = deadlineItems.filter((item) => item.status !== 'done' && daysUntil(item.date) <= 7).length
  const totalOpen = obligationItems.filter((item) => item.status === 'open' || item.status === 'overdue').reduce((sum, item) => sum + item.amount, 0)
  const connectedAccounts = accounts.filter((item) => item.status === 'connected').length
  const activityItems = live ? [{ id: 'live-session', time: 'Şimdi', title: 'Korumalı oturum doğrulandı', detail: 'Kayıtlar kullanıcıya ait RLS kurallarıyla okundu.', kind: 'system' as const }] : activities
  const smartResults = [
    ...obligationItems.filter((item) => matchesQuery(searchQuery, item.title, item.authority, item.note, item.sourceLabel)).slice(0, 4).map((item) => ({ id: `o-${item.id}`, type: 'Ödeme', title: item.title, detail: `${item.authority} · ${item.amount ? formatEuro(item.amount) : 'Tutar belirsiz'} · ${item.dueDate}`, view: 'payments' as ViewId })),
    ...deadlineItems.filter((item) => matchesQuery(searchQuery, item.title, item.owner, item.sourceLabel)).slice(0, 4).map((item) => ({ id: `d-${item.id}`, type: 'Süre', title: item.title, detail: `${item.owner} · ${item.date}`, view: 'deadlines' as ViewId })),
    ...files.filter((item) => matchesQuery(searchQuery, item.name, fileAuthority(item), fileCategory(item), extractionSummary(item))).slice(0, 4).map((item) => ({ id: `f-${item.id}`, type: 'Evrak', title: item.name, detail: `${fileCategory(item)} · ${documentConfidence(item).label}`, view: 'documents' as ViewId })),
    ...messages.filter((item) => matchesQuery(searchQuery, item.subject, item.from, item.snippet, item.accountEmail)).slice(0, 4).map((item) => ({ id: `m-${item.id}`, type: 'Mail', title: item.subject, detail: `${item.accountEmail} · ${item.classification}`, view: 'inbox' as ViewId })),
  ].slice(0, 8)
  return <>
    <PageIntro eyebrow="BUGÜNÜN KONTROL MERKEZİ" title="Önce neyi güvene alıyoruz?" detail="Muh Agent, para hareketi yapmadan önce kanıtı, son tarihi ve insan onayını aynı yerde toplar." action={loginRequired ? <button className="button primary" data-testid="overview-login" onClick={onLogin}>Dashboard'dan giriş yap <span>→</span></button> : <button className="button primary" onClick={() => onNavigate('approvals')}>Onay kuyruğunu aç <span>→</span></button>} />
    <div className="truth-banner"><span className="banner-icon">!</span><div><strong>{loginRequired ? 'Dashboard önizleme açık — kişisel kayıtların için giriş yap.' : live ? 'Kişisel kasa oturumu doğrulandı; dış işlemler yine kapalı.' : 'Şu anda gerçek Gmail, banka, DigiD veya belge bağlantısı yok.'}</strong><p>{loginRequired ? 'Girişte yalnızca e-posta ve şifre kullanılır; e-posta veya kod gönderilmez. Giriş yaptığında yalnızca sana ait kayıtlar yüklenir.' : live ? 'Canlı kayıtlar RLS ile sınırlandı. Onay vermek yalnızca kararı kaydeder; ödeme veya gönderim ayrı ve denetimli bir adımdır.' : 'Bu ekran yalnızca ürün temelini gösterir. Demo kayıtları ile gerçek kayıtlar birbirine karıştırılmayacak.'}</p></div><EvidencePill level={loginRequired ? 'review' : live ? 'verified' : 'demo'} /></div>
    <div className="metric-grid">
      <MetricCard label="Yaklaşan süre" value={String(dueSoon)} suffix=" adet" detail="7 gün içinde açık iş" tone="amber" />
      <MetricCard label="Açık yükümlülük" value={formatEuro(totalOpen)} suffix="" detail={live ? 'Canlı açık kayıtların toplamı' : 'Demo kayıtlarının toplamı'} tone="blue" />
      <MetricCard label="İnsan onayı" value={String(approvals.filter((item) => item.status === 'pending').length)} suffix=" bekliyor" detail="Dış işlem yapılmadı" tone="violet" />
      <MetricCard label="Bağlı hesap" value={String(connectedAccounts)} suffix=" / 4" detail={connectedAccounts ? 'Salt-okunur OAuth' : 'OAuth kurulumu bekliyor'} tone="green" />
    </div>
    {notifications.length > 0 && <section className="panel notification-strip"><div><div className="eyebrow">CANLI UYARILAR</div><h3>{notifications.length} yeni radar kaydı</h3></div><button className="button secondary" onClick={() => onNavigate('life')}>Yaşam Radar’ı aç →</button></section>}
    <section className="panel smart-command-panel">
      <div className="panel-head"><div><div className="eyebrow">AKILLI KOMUT MERKEZİ</div><h3>Belge, mail, ödeme ve süre içinde ara</h3></div><span className="pill evidence-verified">{featureLaunchpad.length} özellik aktif</span></div>
      <div className="smart-command-body">
        <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Örn. Den Haag cezası, IND, 150 euro, hamilelik, son ödeme…" aria-label="Akıllı arama" />
        <div className="smart-result-grid">{smartResults.length ? smartResults.map((item) => <button className="smart-result-card" key={item.id} onClick={() => onNavigate(item.view)}><span className="pill evidence-review">{item.type}</span><strong>{item.title}</strong><small>{item.detail}</small></button>) : <div className="empty-inline">Arama sonucu yok. Farklı kelime dene veya yeni belgeleri Evrak Kasası’nda okut.</div>}</div>
      </div>
      <div className="feature-launchpad">{featureLaunchpad.map((feature) => <button className="feature-chip" key={feature.area} onClick={() => onNavigate(feature.owner === 'Evrak Kasası' ? 'documents' : feature.owner === 'Ödeme Planı' ? 'payments' : feature.owner === 'Kaynaklar' ? 'sources' : feature.owner === 'Ayarlar' ? 'settings' : feature.owner === 'Onay Merkezi' ? 'approvals' : feature.owner === 'Yaşam Radar' ? 'life' : 'overview')}><strong>{feature.area}</strong><span>{feature.owner}</span></button>)}</div>
    </section>
    <div className="overview-grid">
      <section className="panel priority-panel">
        <div className="panel-head"><div><div className="eyebrow">ÖNCELİK KUYRUĞU</div><h3>Bugün ilgilenmen gerekenler</h3></div><button className="text-button" onClick={() => onNavigate('deadlines')}>Tümünü gör →</button></div>
        <div className="priority-list">
          {deadlineItems.length ? deadlineItems.map((item) => <DeadlineRow key={item.id} item={item} />) : <div className="empty-inline">Açık son tarih kaydı yok.</div>}
        </div>
      </section>
      <section className="panel activity-panel">
        <div className="panel-head"><div><div className="eyebrow">DENETİM İZİ</div><h3>Ajanın son hareketleri</h3></div><span className={`pill evidence-${live ? 'verified' : 'demo'}`}>{live ? 'Oturum kanıtı' : 'Sadece demo'}</span></div>
        <div className="activity-list">{activityItems.map((item) => <div className="activity-row" key={item.id}><span className={`activity-dot ${item.kind}`} /><div><strong>{item.title}</strong><p>{item.detail}</p></div><time>{item.time}</time></div>)}</div>
      </section>
    </div>
    <div className="lower-grid">
      <section className="panel connection-panel"><div className="panel-head"><div><div className="eyebrow">VERİ KAYNAKLARI</div><h3>Bağlantı durumu</h3></div><button className="text-button" onClick={() => onNavigate('settings')}>Kurulum →</button></div><div className="connection-row"><span className="connection-icon gmail">G</span><div><strong>Gmail hesapları</strong><p>{connectedAccounts ? `${connectedAccounts} salt-okunur hesap bağlı` : '4 hesap için OAuth gerekli'}</p></div><span className={`pill evidence-${connectedAccounts ? 'verified' : 'review'}`}>{connectedAccounts ? 'Bağlı' : 'Bağlanmadı'}</span></div><div className="connection-row"><span className="connection-icon vault">▤</span><div><strong>Evrak kasası</strong><p>{documentCount ? `${documentCount} Drive dosya metaverisi görüldü` : live ? 'Drive worker dosya bekliyor' : 'Dosya yükleme ve OCR beklemede'}</p></div><span className={`pill evidence-${documentCount ? 'verified' : 'review'}`}>{documentCount ? 'Aktif' : 'Bekliyor'}</span></div></section>
      <section className="panel principle-panel"><div className="principle-mark">◈</div><div><div className="eyebrow">TEMEL KURAL</div><h3>Oku → kanıtla → öner → onay al</h3><p>Ajan hiçbir para transferini, resmi gönderimi veya hesap bağlantısını sessizce yapmaz. Her kritik adım görünür onay ister.</p></div></section>
    </div>
  </>
}

function MetricCard({ label, value, suffix, detail, tone }: { label: string; value: string; suffix: string; detail: string; tone: string }) {
  return <div className={`metric-card tone-${tone}`}><div className="metric-label">{label}</div><div className="metric-value">{value}<small>{suffix}</small></div><div className="metric-detail">{detail}</div></div>
}

function DeadlineRow({ item }: { item: Deadline }) {
  const days = daysUntil(item.date)
  const meta = [item.owner, item.date, item.sourceLabel].filter(Boolean).join(' · ')
  return <div className="deadline-row"><div className={`deadline-icon ${item.urgency}`}>{item.urgency === 'critical' ? '!' : item.urgency === 'soon' ? '◷' : '○'}</div><div className="deadline-main">{item.sourceUrl ? <a href={item.sourceUrl} target="_blank" rel="noreferrer"><strong>{item.title}</strong></a> : <strong>{item.title}</strong>}<span>{meta}</span></div><div className={`deadline-count ${item.urgency}`}>{days < 0 ? `${Math.abs(days)} gün geçti` : days === 0 ? 'Bugün' : `${days} gün`}</div></div>
}

function InboxView({ accounts, live, messageCount, messages }: { accounts: MailAccount[]; live: boolean; messageCount: number; messages: DashboardMessage[] }) {
  const connected = accounts.filter((account) => account.status === 'connected')
  return <><PageIntro eyebrow="GELEN KUTUSU" title={live ? `${messageCount} güvenli mesaj kaydı` : 'E-posta akışı henüz bağlanmadı'} detail={live ? 'Her mesaj hangi Gmail hesabından okunduğu bilgisiyle gösterilir. Teknik gmail:// kayıtları ekranda gösterilmez; kaynak butonu Gmail web’de ilgili mesajı açar.' : 'Önce OAuth bağlantısı, sonra idempotent senkronizasyon ve hesap bazlı kaynak izi.'} /><section className="panel account-scan-panel"><div className="panel-head"><div><div className="eyebrow">TARANAN HESAPLAR</div><h3>Bu hesapların gelen kutusu izleniyor</h3></div><span className={`pill evidence-${connected.length ? 'verified' : 'review'}`}>{connected.length} bağlı</span></div><div className="scan-grid">{connected.length ? connected.map((account) => <div className="scan-card" key={account.id}><strong>{account.email}</strong><span>{account.lastSync ? `Son tarama ${new Date(account.lastSync).toLocaleString('tr-TR')}` : 'İlk tarama bekleniyor'}</span><small>{account.scopes.includes('https://www.googleapis.com/auth/drive.readonly') ? 'Gmail + Drive izni' : 'Sadece Gmail'}</small></div>) : <div className="empty-inline">Henüz taranan Gmail hesabı yok.</div>}</div></section><section className="panel message-panel"><div className="panel-head"><div><div className="eyebrow">MESAJ KAYITLARI</div><h3>Kaynak hesap, konu ve sınıflandırma</h3></div><EvidencePill level={live ? 'verified' : 'review'} /></div><div className="message-list">{messages.length ? messages.map((message) => <div className="message-row" key={message.id}><div className={`message-severity ${message.status === 'review_required' ? 'hot' : ''}`}>✉</div><div className="message-main"><div className="message-meta"><span>{message.accountEmail}</span><span>{message.receivedAt ? new Date(message.receivedAt).toLocaleString('tr-TR') : 'Tarih yok'}</span></div><strong>{message.subject}</strong><p>{message.snippet || 'Özet yok.'}</p><small>Gönderen: {message.from}</small></div><div className="message-tags"><span className="pill evidence-review">{message.classification}</span><span className="pill">{processingLabel[message.status]}</span>{message.sourceUrl && <a className="tag-link" href={message.sourceUrl} target="_blank" rel="noreferrer">Maili aç ↗</a>}</div></div>) : <div className="empty-state large"><div className="empty-icon">✉</div><h3>{messageCount ? 'Son tarama henüz detay döndürmedi' : 'İşlenmiş mesaj yok'}</h3><p>Worker çalıştığında Gmail metadata’sı hesap bazlı kaydedilir ve ceza/vergi/IND/son-tarih sinyalleri ayrı kayıt üretir.</p><EvidencePill level={live ? 'verified' : 'review'} /></div>}</div></section><section className="panel"><div className="panel-head"><div><div className="eyebrow">GÜVENLİK SINIRI</div><h3>Bu ekranın yapmayacağı şeyler</h3></div></div><div className="guardrail-grid"><Guardrail title="DigiD şifresi istemez" text="DigiD'ye otomatik giriş veya kimlik bilgisi saklama yok." /><Guardrail title="Mail göndermeyi durdurur" text="Avukat, kurum veya işverene gönderim insan onayı olmadan çalışmaz." /><Guardrail title="Eki körlemesine açmaz" text="Dosya türü, boyutu ve zararlı içerik kontrolünden geçmeden işlenmez." /></div></section></>
}

function validPaymentDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

function paymentSortValue(item: Obligation) {
  const date = validPaymentDate(item.dueDate)
  return date ? new Date(`${date}T12:00:00`).getTime() : Number.MAX_SAFE_INTEGER
}

function paymentTone(days: number | null, status: ObligationStatus) {
  if (status === 'paid') return 'paid'
  if (status === 'disputed') return 'disputed'
  if (days === null) return 'planned'
  if (days < 0) return 'critical'
  if (days <= 3) return 'critical'
  if (days <= 14) return 'soon'
  return 'planned'
}

function paymentTimeLabel(item: Obligation) {
  const date = validPaymentDate(item.dueDate)
  if (!date) return { days: null, label: 'Tarih okunmadı', tone: paymentTone(null, item.status) }
  const days = daysUntil(date)
  const label = days < 0 ? `${Math.abs(days)} gün geçti` : days === 0 ? 'Bugün' : `${days} gün kaldı`
  return { days, label, tone: paymentTone(days, item.status) }
}

function paymentStatus(item: Obligation) {
  const time = paymentTimeLabel(item)
  if (item.status === 'open' && typeof time.days === 'number' && time.days < 0) return 'Gecikmiş'
  return statusLabel[item.status]
}

function groupByAuthority(items: Obligation[]) {
  const groups = new Map<string, { amount: number; count: number; guidance?: PaymentGuidance; items: Obligation[]; nextDue: string | null }>()
  for (const item of items) {
    const key = item.authority || 'Bilinmeyen kurum'
    const existing = groups.get(key) ?? { amount: 0, count: 0, guidance: guidanceForObligation(item), items: [], nextDue: null }
    existing.amount += item.status === 'paid' ? 0 : item.amount
    existing.count += 1
    existing.items.push(item)
    const dueDate = validPaymentDate(item.dueDate)
    if (dueDate && (!existing.nextDue || dueDate < existing.nextDue)) existing.nextDue = dueDate
    existing.guidance = existing.guidance ?? guidanceForObligation(item)
    groups.set(key, existing)
  }
  return Array.from(groups.entries()).map(([authority, group]) => ({ authority, ...group })).sort((a, b) => (a.nextDue ?? '9999').localeCompare(b.nextDue ?? '9999'))
}

function calendarDate(value: string) {
  return value.replaceAll('-', '')
}

function addDays(value: string, days: number) {
  const date = new Date(`${value}T12:00:00`)
  date.setDate(date.getDate() + days)
  return date.toISOString().slice(0, 10)
}

function icsEscape(value: string) {
  return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll(',', '\\,').replaceAll(';', '\\;')
}

function googleCalendarUrl(title: string, date: string, description: string) {
  const nextDay = addDays(date, 1)
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    authuser: 'siostarr@hairartclinics.com',
    ctz: 'Europe/Amsterdam',
    dates: `${calendarDate(date)}/${calendarDate(nextDay)}`,
    details: description,
    text: title,
  })
  return `https://calendar.google.com/calendar/render?${params.toString()}`
}

function downloadPaymentCalendar(items: Obligation[]) {
  const events = items
    .filter((item) => item.status !== 'paid' && validPaymentDate(item.dueDate))
    .sort((a, b) => paymentSortValue(a) - paymentSortValue(b))
    .map((item) => {
      const date = validPaymentDate(item.dueDate)!
      const guidance = guidanceForObligation(item)
      const description = [
        `${item.authority} · ${item.amount ? formatEuro(item.amount) : 'Tutar belirsiz'}`,
        item.note,
        guidance?.paymentUrl ? `Ödeme: ${guidance.paymentUrl}` : null,
        guidance?.paymentPlanUrl ? `Taksit/plan: ${guidance.paymentPlanUrl}` : null,
        guidance?.objectionUrl ? `İtiraz: ${guidance.objectionUrl}` : null,
      ].filter(Boolean).join('\\n')
      return [
        'BEGIN:VEVENT',
        `UID:${item.id}@muh-agent`,
        `DTSTAMP:${calendarDate(new Date().toISOString().slice(0, 10))}T120000Z`,
        `DTSTART;VALUE=DATE:${calendarDate(date)}`,
        `SUMMARY:${icsEscape(`Ödeme: ${item.authority} ${item.amount ? formatEuro(item.amount) : ''}`.trim())}`,
        `DESCRIPTION:${icsEscape(description)}`,
        'BEGIN:VALARM',
        'TRIGGER:-P2D',
        'ACTION:DISPLAY',
        `DESCRIPTION:${icsEscape(`2 gün kaldı: ${item.title}`)}`,
        'END:VALARM',
        'END:VEVENT',
      ].join('\r\n')
    })
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Muh Agent//Payment Calendar//TR', 'CALSCALE:GREGORIAN', ...events, 'END:VCALENDAR'].join('\r\n')
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'muh-agent-odeme-takvimi.ics'
  link.click()
  URL.revokeObjectURL(url)
}

function downloadDeadlineCalendar(items: Deadline[]) {
  const events = items
    .filter((item) => item.status !== 'done' && validPaymentDate(item.date))
    .sort((a, b) => daysUntil(a.date) - daysUntil(b.date))
    .map((item) => {
      const description = [item.owner, item.sourceLabel, item.sourceExcerpt].filter(Boolean).join('\n')
      return [
        'BEGIN:VEVENT',
        `UID:deadline-${item.id}@muh-agent`,
        `DTSTAMP:${calendarDate(new Date().toISOString().slice(0, 10))}T120000Z`,
        `DTSTART;VALUE=DATE:${calendarDate(item.date)}`,
        `SUMMARY:${icsEscape(`Muh Agent süre: ${item.title}`)}`,
        `DESCRIPTION:${icsEscape(description)}`,
        'BEGIN:VALARM',
        'TRIGGER:-P2D',
        'ACTION:DISPLAY',
        `DESCRIPTION:${icsEscape(`2 gün kaldı: ${item.title}`)}`,
        'END:VALARM',
        'END:VEVENT',
      ].join('\r\n')
    })
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Muh Agent//Deadline Calendar//TR', 'CALSCALE:GREGORIAN', ...events, 'END:VCALENDAR'].join('\r\n')
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'muh-agent-haklar-sureler.ics'
  link.click()
  URL.revokeObjectURL(url)
}

function PaymentsView({ items, live, onOpenApprovals }: { items: Obligation[]; live: boolean; onOpenApprovals: () => void }) {
  const sorted = [...items].sort((a, b) => paymentSortValue(a) - paymentSortValue(b))
  const openItems = sorted.filter((item) => item.status !== 'paid')
  const totalOpen = openItems.reduce((sum, item) => sum + item.amount, 0)
  const overdue = openItems.filter((item) => paymentTimeLabel(item).days !== null && paymentTimeLabel(item).days! < 0).length
  const dueSoon = openItems.filter((item) => {
    const days = paymentTimeLabel(item).days
    return days !== null && days >= 0 && days <= 14
  }).length
  const authorityGroups = groupByAuthority(sorted)
  const nextActionItem = openItems.find((item) => validPaymentDate(item.dueDate)) ?? openItems[0]

  return <>
    <PageIntro
      eyebrow="PARA VE YÜKÜMLÜLÜKLER"
      title="Tek ödeme takvimi"
      detail="Belgelerden çıkan tutar, kurum, son ödeme ve itiraz süreleri burada gün sayacıyla görünür. Ödeme/taksit linkleri resmi kurum sayfalarına gider; para transferi otomatik yapılmaz."
      action={<div className="action-pair"><button className="button primary" onClick={onOpenApprovals}>Onayları aç →</button><button className="button secondary" onClick={() => downloadPaymentCalendar(sorted)}>Takvim indir (.ics)</button></div>}
    />
    <div className="payment-summary-grid">
      <MetricCard label="Açık toplam" value={formatEuro(totalOpen)} suffix="" detail="Ödenmemiş / itirazdaki kayıtlar" tone="blue" />
      <MetricCard label="14 gün içinde" value={String(dueSoon)} suffix=" ödeme" detail="Yaklaşan son tarih" tone="amber" />
      <MetricCard label="Geciken" value={String(overdue)} suffix=" kayıt" detail="Bugün aksiyon gerekir" tone="violet" />
      <MetricCard label="Kurum sayısı" value={String(authorityGroups.length)} suffix="" detail="Toplu ödeme/taksit kontrolü" tone="green" />
    </div>
    {nextActionItem && <section className="panel decision-panel"><div className="panel-head"><div><div className="eyebrow">KARAR SİHİRBAZI</div><h3>{nextActionItem.title}</h3></div><span className="pill evidence-review">{paymentTimeLabel(nextActionItem).label}</span></div><div className="decision-grid">{decisionOptionsFor(nextActionItem).map((option) => <article className="decision-card" key={option.action}><span className="pill evidence-review">{option.risk}</span><h3>{option.action}</h3><p>{option.detail}</p>{option.url && <a href={option.url} target="_blank" rel="noreferrer">Resmi kanal ↗</a>}</article>)}</div><div className="reminder-ladder">{reminderMilestones(nextActionItem.dueDate).map((step, index) => <span key={`${step}-${index}`}>{step}</span>)}</div></section>}
    <section className="panel authority-panel">
      <div className="panel-head"><div><div className="eyebrow">KURUMA GÖRE TOPLAM</div><h3>Hangi kuruma ne kadar ve nereden ödenecek</h3></div><span className={`pill evidence-${live ? 'verified' : 'review'}`}>{live ? 'Canlı belge kayıtları' : 'Demo veri'}</span></div>
      <div className="authority-grid">
        {authorityGroups.length ? authorityGroups.map((group) => <div className="authority-card" key={group.authority}>
          <div><strong>{group.authority}</strong><span>{group.count} kayıt · sonraki tarih {group.nextDue ?? 'okunmadı'}</span></div>
          <div className="authority-total">{formatEuro(group.amount)}</div>
          <p>{group.guidance?.bulkPayment ?? 'Toplu ödeme/taksit kanalı için resmi belge veya kurum portalı kontrol edilmeli.'}</p>
          <div className="payment-links">
            {group.guidance?.paymentUrl && <a href={group.guidance.paymentUrl} target="_blank" rel="noreferrer">Öde / portal ↗</a>}
            {group.guidance?.paymentPlanUrl && <a href={group.guidance.paymentPlanUrl} target="_blank" rel="noreferrer">Taksit/plan ↗</a>}
          </div>
        </div>) : <div className="empty-inline">Henüz ödeme kaydı yok. Evrak Kasası’nda belgeyi oku.</div>}
      </div>
    </section>
    <section className="table-panel panel">
      <div className="table-toolbar"><div><strong>{sorted.length} kayıt</strong><span> · ödeme, taksit, itiraz ve geçmiş kayıtlar tek listede</span></div><button className="button secondary" onClick={() => downloadPaymentCalendar(sorted)}>Takvime aktar</button></div>
      <div className="payment-calendar-list">
        {sorted.length ? sorted.map((item) => {
          const time = paymentTimeLabel(item)
          const guidance = guidanceForObligation(item)
          const calendarDescription = [
            `${item.authority} · ${item.amount ? formatEuro(item.amount) : 'Tutar belirsiz'}`,
            item.note,
            item.sourceLabel ? `Kaynak: ${item.sourceLabel}` : null,
            guidance?.paymentUrl ? `Ödeme: ${guidance.paymentUrl}` : null,
            guidance?.paymentPlanUrl ? `Taksit/plan: ${guidance.paymentPlanUrl}` : null,
            guidance?.objectionUrl ? `İtiraz: ${guidance.objectionUrl}` : null,
          ].filter(Boolean).join('\n')
          return <article className={`payment-calendar-row ${time.tone}`} key={item.id}>
            <div className={`payment-days ${time.tone}`}><strong>{time.label}</strong><span>{validPaymentDate(item.dueDate) ?? 'tarih yok'}</span></div>
            <div className="payment-main">
              <div className="message-meta"><span>{item.authority}</span><span>{item.category}</span><span>{paymentStatus(item)}</span></div>
              <h3>{item.title}</h3>
              <p>{item.note}</p>
              {item.sourceLabel && <small className="extract-line">Kaynak: {item.sourceLabel}</small>}
              {item.sourceExcerpt && <small className="source-excerpt">{item.sourceExcerpt}</small>}
              {guidance?.installmentSummary && <small className="extract-action">Taksit: {guidance.installmentSummary}</small>}
              {guidance?.warning && <small className="extract-line">Kontrol: {guidance.warning}</small>}
            </div>
            <div className="payment-side">
              <div className="obligation-amount">{item.amount ? formatEuro(item.amount) : 'Tutar belirsiz'}</div>
              <EvidencePill level={item.evidence} />
              <div className="payment-links">
                {item.sourceUrl && <a href={item.sourceUrl} target="_blank" rel="noreferrer">Belge/mail ↗</a>}
                {validPaymentDate(item.dueDate) && <a href={googleCalendarUrl(`Muh Agent: ${item.title}`, item.dueDate, calendarDescription)} target="_blank" rel="noreferrer">Google Takvim ↗</a>}
                {guidance?.paymentUrl && <a href={guidance.paymentUrl} target="_blank" rel="noreferrer">{guidance.portalLabel ?? 'Ödeme'} ↗</a>}
                {guidance?.paymentPlanUrl && <a href={guidance.paymentPlanUrl} target="_blank" rel="noreferrer">Taksit ↗</a>}
                {guidance?.objectionUrl && <a href={guidance.objectionUrl} target="_blank" rel="noreferrer">İtiraz ↗</a>}
              </div>
            </div>
          </article>
        }) : <div className="empty-state large"><div className="empty-icon">€</div><h3>Henüz okunmuş ödeme belgesi yok</h3><p>PDF/JPG belgeleri “Muh Agent Inbox” klasörüne koyup Evrak Kasası’nda “Belgeleri şimdi oku” dediğinde tutar, tarih ve kurum bu takvime düşer.</p><EvidencePill level="review" /></div>}
      </div>
    </section>
    <div className="info-callout"><strong>Ödeme entegrasyonu kapalı.</strong><span>Bu panel ödeme kararını hazırlar: kurum, tutar, son tarih, link ve taksit/itiraz kontrolü görünür. Banka transferi, DigiD girişi veya resmi başvuru otomatik yapılmaz.</span></div>
  </>
}

function formatFileSize(sizeBytes?: number) {
  if (sizeBytes === undefined) return 'Boyut yok'
  if (sizeBytes < 1024) return `${sizeBytes} B`
  if (sizeBytes < 1_048_576) return `${(sizeBytes / 1024).toFixed(1)} KB`
  return `${(sizeBytes / 1_048_576).toFixed(1)} MB`
}

function extractionRecord(file: ProviderFile) {
  const value = file.extracted.extraction
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function extractionLine(file: ProviderFile) {
  const extraction = extractionRecord(file)
  if (!extraction) return null
  const amount = typeof extraction.amount_eur === 'number' ? formatEuro(extraction.amount_eur) : null
  const dueDate = typeof extraction.due_date === 'string' ? extraction.due_date : null
  const objection = typeof extraction.objection_deadline === 'string' ? extraction.objection_deadline : null
  return [amount ? `Tutar ${amount}` : null, dueDate ? `Son ödeme ${dueDate}` : null, objection ? `İtiraz ${objection}` : null].filter(Boolean).join(' · ')
}

function extractionSummary(file: ProviderFile) {
  const extraction = extractionRecord(file)
  if (!extraction) return file.extractionErrorCode ? `Okuma notu: ${file.extractionErrorCode}` : 'İçerik okuma bekliyor.'
  return typeof extraction.summary_tr === 'string' ? extraction.summary_tr : 'Belge okundu; özet bekleniyor.'
}

function extractionText(file: ProviderFile, key: string) {
  const extraction = extractionRecord(file)
  const value = extraction?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function extractionAmount(file: ProviderFile) {
  const value = extractionRecord(file)?.amount_eur
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function fileCategory(file: ProviderFile) {
  const type = extractionText(file, 'document_type') ?? file.classification
  if (file.extractionStatus === 'failed') return 'Hata'
  if (file.extractionStatus === 'pending' || file.extractionStatus === 'processing') return 'Okunacak'
  if (type === 'fine') return 'Ceza'
  if (type === 'tax' || type === 'municipality') return 'Vergi / belediye'
  if (type === 'invoice' || extractionAmount(file) !== null) return 'Fatura / ödeme'
  if (type === 'immigration' || type === 'court') return 'Hukuk / IND'
  if (type === 'health' || type === 'insurance' || type === 'benefit') return 'Sağlık / hak'
  return 'Diğer'
}

function fileAuthority(file: ProviderFile) {
  return (extractionText(file, 'authority') ?? (Array.isArray(file.extracted.authorities) ? String(file.extracted.authorities[0] ?? '') : '')) || file.classification
}

function fileDetailFields(file: ProviderFile) {
  const amount = extractionAmount(file)
  return [
    { label: 'Kurum', value: fileAuthority(file) },
    { label: 'Tür', value: fileCategory(file) },
    { label: 'Tutar', value: amount === null ? 'Tutar yok' : formatEuro(amount) },
    { label: 'Son ödeme', value: extractionText(file, 'due_date') ?? 'Tarih yok' },
    { label: 'İtiraz', value: extractionText(file, 'objection_deadline') ?? 'Süre yok' },
    { label: 'Hesap', value: file.accountEmail },
  ]
}

function fileStatusTone(file: ProviderFile): EvidenceLevel {
  if (file.extractionStatus === 'extracted') return 'verified'
  if (file.extractionStatus === 'failed' || file.extractionStatus === 'pending' || file.extractionStatus === 'processing') return 'review'
  return 'demo'
}

function DocumentsView({ documentCount, extracting, files, live, onExtract }: { documentCount: number; extracting: boolean; files: ProviderFile[]; live: boolean; onExtract: () => void | Promise<void> }) {
  const readCount = files.filter((file) => file.extractionStatus === 'extracted').length
  const categories = ['Tümü', 'Ceza', 'Fatura / ödeme', 'Vergi / belediye', 'Hukuk / IND', 'Sağlık / hak', 'Okunacak', 'Diğer', 'Hata']
  const [activeCategory, setActiveCategory] = useState('Tümü')
  const [selectedId, setSelectedId] = useState(files[0]?.id ?? '')
  const [fileQuery, setFileQuery] = useState('')
  const visibleFiles = (activeCategory === 'Tümü' ? files : files.filter((file) => fileCategory(file) === activeCategory))
    .filter((file) => matchesQuery(fileQuery, file.name, fileAuthority(file), fileCategory(file), extractionSummary(file), file.accountEmail))
  const selectedFile = files.find((file) => file.id === selectedId) ?? visibleFiles[0] ?? files[0]
  const counts = new Map(categories.map((category) => [category, category === 'Tümü' ? files.length : files.filter((file) => fileCategory(file) === category).length]))
  const selectedConfidence = selectedFile ? documentConfidence(selectedFile) : null

  return <><PageIntro eyebrow="EVRAK KASASI" title={live ? `${documentCount} görünür belge / Drive kaydı` : 'Belgeleri tek bir güven zincirinde topla'} detail={live ? 'Muh Agent Inbox klasöründeki PDF/JPG/PNG/HEIC belgeler içerikten okunur; kurum, borç/ceza türü, tutar, son tarih, itiraz süresi ve kaynak linki aynı kartta gösterilir.' : 'Canlı ortamda Drive belgesi OCR ile okunup yükümlülük ve süre kayıtlarına dönüştürülür.'} action={<button className="button primary" disabled={extracting} onClick={() => void onExtract()}>{extracting ? 'Belgeler okunuyor…' : 'Belgeleri şimdi oku'}</button>} /><section className="panel drive-file-panel"><div className="panel-head"><div><div className="eyebrow">BELGE OKUMA DURUMU</div><h3>Kategorili kasa, akıllı arama ve güven skoru</h3></div><span className={`pill evidence-${readCount ? 'verified' : 'review'}`}>{readCount} ödeme/aksiyon belgesi · {files.length} görünür kayıt</span></div><div className="vault-toolbar"><input value={fileQuery} onChange={(event) => setFileQuery(event.target.value)} placeholder="Evrakta ara: kurum, tutar, ceza, IND, tarih…" aria-label="Evrak arama" /><span>{visibleFiles.length} sonuç</span></div><div className="category-tabs">{categories.filter((category) => counts.get(category)).map((category) => <button className={category === activeCategory ? 'category-tab active' : 'category-tab'} key={category} onClick={() => setActiveCategory(category)}>{category}<span>{counts.get(category)}</span></button>)}</div><div className="document-workbench"><div className="file-list">{visibleFiles.length ? visibleFiles.map((file) => { const line = extractionLine(file); const confidence = documentConfidence(file); return <button className={selectedFile?.id === file.id ? 'file-row file-row-expanded selectable active' : 'file-row file-row-expanded selectable'} key={file.id} onClick={() => setSelectedId(file.id)}><div className={`file-icon ${file.status === 'review_required' || file.extractionStatus === 'extracted' ? 'hot' : ''}`}>▤</div><div className="file-main"><div className="message-meta"><span>{file.accountEmail}</span><span>{file.modifiedAt ? new Date(file.modifiedAt).toLocaleString('tr-TR') : 'Tarih yok'}</span><span>{formatFileSize(file.sizeBytes)}</span></div><strong>{file.name}</strong><p>{extractionSummary(file)}</p>{line && <small className="extract-line">{line}</small>}<small className="source-excerpt">Önerilen ad: {suggestedDocumentName(file)}</small></div><div className="file-actions"><span className={`pill evidence-${fileStatusTone(file)}`}>{fileExtractionLabel[file.extractionStatus]}</span><span className={`pill evidence-${confidence.score >= 86 ? 'verified' : 'review'}`}>{confidence.score}% · {confidence.label}</span><span className="pill evidence-review">{fileCategory(file)}</span></div></button> }) : <div className="empty-inline">Bu kategoride/arama teriminde belge yok.</div>}</div>{selectedFile && selectedConfidence && <aside className="document-detail-panel"><div className="detail-header"><div><div className="eyebrow">SEÇİLİ BELGE</div><h3>{extractionText(selectedFile, 'title') ?? selectedFile.name}</h3></div><span className={`pill evidence-${selectedConfidence.score >= 86 ? 'verified' : 'review'}`}>{selectedConfidence.score}%</span></div><p>{extractionSummary(selectedFile)}</p><div className="confidence-meter"><span style={{ width: `${selectedConfidence.score}%` }} /></div><div className="detail-action"><strong>Otomatik arşiv adı</strong><p>{suggestedDocumentName(selectedFile)}</p></div><div className="detail-field-grid">{fileDetailFields(selectedFile).map((field) => <div className="detail-field" key={field.label}><span>{field.label}</span><strong>{field.value}</strong></div>)}</div><div className="detail-action"><strong>Kurum profili</strong><p>{authorityProfileFor(fileAuthority(selectedFile)).name}: {authorityProfileFor(fileAuthority(selectedFile)).risk}</p></div>{selectedConfidence.missing.length > 0 && <div className="detail-action warning"><strong>Eksik / kontrol edilecek alanlar</strong><p>{selectedConfidence.missing.join(', ')}</p></div>}{extractionText(selectedFile, 'action_summary_tr') && <div className="detail-action"><strong>Aksiyon</strong><p>{extractionText(selectedFile, 'action_summary_tr')}</p></div>}<div className="action-tags"><button className="tag-button" onClick={() => navigator.clipboard?.writeText(`${suggestedDocumentName(selectedFile)}\n\n${extractionSummary(selectedFile)}`)}>Ad + özeti kopyala</button>{selectedFile.webUrl && <a className="tag-button" href={selectedFile.webUrl} target="_blank" rel="noreferrer">Belgeyi Drive’da aç ↗</a>}{selectedFile.sourceLabel && <span className="tag-note">{selectedFile.sourceLabel}</span>}</div>{selectedFile.extractionStatus === 'pending' && <div className="info-callout"><strong>Okuma bekliyor.</strong><span>“Belgeleri şimdi oku” düğmesi bu belgeyi OCR kuyruğuna alır.</span></div>}{selectedFile.extractionStatus === 'skipped' && extractionRecord(selectedFile) && <div className="info-callout"><strong>Okundu ama ödeme/son tarih çıkmadı.</strong><span>Bu yanlışsa belgeyi daha net PDF/JPG olarak tekrar yükle veya aynı belgenin tüm sayfalarını tek PDF yap.</span></div>}</aside>}</div></section><div className="dropzone"><div className="drop-icon">＋</div><h3>Telefonla tara → “Muh Agent Inbox” klasörüne koy → “Belgeleri şimdi oku”</h3><p>En hızlı yol Google Drive Scan ile tek PDF oluşturmak. Bir ceza/fatura birden fazla fotoğraftaysa hepsini tek PDF yapmak OCR doğruluğunu artırır.</p><EvidencePill level="review" /></div><div className="document-grid"><DocumentCard title="Ceza / CJIB / belediye" detail="Tutar, son ödeme, bezwaar ve resmi ödeme kanalı çıkarılır" status="OCR" /><DocumentCard title="Vergi / fatura" detail="Kurum, ödeme referansı, taksit/plan kontrolü ayrılır" status="OCR" /><DocumentCard title="IND / mahkeme / sağlık" detail="Süre, belge teslimi ve insan kontrolü paneline düşer" status="İnceleme" /></div></>
}

function DocumentCard({ title, detail, status }: { title: string; detail: string; status: string }) {
  return <div className="document-card panel"><div className="file-icon">▤</div><div><strong>{title}</strong><p>{detail}</p></div><span className="pill evidence-review">{status}</span></div>
}

function DeadlinesView({ items, live }: { items: Deadline[]; live: boolean }) {
  return <><PageIntro eyebrow="HAKLAR, SÜRELER, DOSYALAR" title="Unutulacak tarihi bırakma" detail="Hukuk ve sağlık alanındaki kayıtlar kaynak ve tarih olmadan kesin bilgi olarak gösterilmez. Her kartta kaynak açma ve takvime ekleme bulunur." action={<button className="button secondary" onClick={() => downloadDeadlineCalendar(items)}>Takvim dışa aktar (.ics)</button>} /><div className="deadline-board">{items.length ? items.map((item) => {
    const description = [item.owner, item.sourceLabel, item.sourceExcerpt].filter(Boolean).join('\n')
    return <div className="panel deadline-card" key={item.id}><div className={`deadline-icon ${item.urgency}`}>{item.urgency === 'critical' ? '!' : '◷'}</div><div className="eyebrow">{item.owner}</div><h3>{item.title}</h3>{item.sourceLabel && <p className="deadline-source">{item.sourceLabel}</p>}<div className="date-large">{item.date}</div><div className="payment-links deadline-links">{item.sourceUrl && <a href={item.sourceUrl} target="_blank" rel="noreferrer">Kaynak aç ↗</a>}<a href={googleCalendarUrl(`Muh Agent süre: ${item.title}`, item.date, description)} target="_blank" rel="noreferrer">Google Takvim ↗</a></div><div className="card-footer"><EvidencePill level={item.evidence} /><span>{item.status === 'waiting' ? 'Yanıt bekliyor' : item.status === 'done' ? 'Tamamlandı' : 'Aksiyon gerekli'}</span></div></div>
  }) : <div className="panel empty-inline">{live ? 'Canlı son tarih kaydı yok.' : 'Demo son tarih kaydı yok.'}</div>}</div><section className="panel safety-panel"><div className="panel-head"><div><div className="eyebrow">DOSYA GÜVENLİĞİ</div><h3>IND dosyasında sonraki doğru adım</h3></div><EvidencePill level="review" /></div><p>Bu cockpit, yaşadığın oturum sürecinde belge listesi, son tarihler ve avukata sorulacak sorular için düzenleyici olabilir. “%100 sonuç”, gizli hile veya avukatın yerine karar verme iddiası yoktur.</p><div className="question-list"><span>□ Mevcut IND yazısının tarihi ve referans numarası kaydedildi mi?</span><span>□ Yeni işverenin erkend referent durumu avukat tarafından doğrulandı mı?</span><span>□ Maaş kriteri doğru yıl ve oturum türüyle eşleştirildi mi?</span></div></section></>
}

function LifeRadarView({ deadlines: deadlineItems, knowledge, live, notifications, obligations: obligationItems, onOpenSettings }: { deadlines: Deadline[]; knowledge: KnowledgeItem[]; live: boolean; notifications: NotificationItem[]; obligations: Obligation[]; onOpenSettings: () => void }) {
  const calendarItems = lifeCalendarItems(obligationItems, deadlineItems)
  return <><PageIntro eyebrow="YAŞAM RADAR" title="Hollanda’da seni etkileyen kurum, süre ve haklar" detail="Bu bölüm resmi kaynakları, bağlı Gmail sinyallerini ve senin manuel eklediğin bilgileri bir araya getirir. Hukuki/medikal karar yerine geçmez; avukat veya resmi kurumla doğrulanacak aksiyon listesi üretir." action={<button className="button primary" onClick={onOpenSettings}>Bilgi / skill ekle →</button>} /><div className="life-hero panel"><div><div className="eyebrow">KİŞİSEL BAĞLAM</div><h3>Adres: Nieuwland 51, Broek in Waterland 1151 AZ</h3><p>Belediye odağı: Gemeente Waterland. Öncelikler: IND dosyası, 5 yıl oturum eşiği, hamilelik hakları, CJIB/vergi/mahkeme yazışmaları ve Berichtenbox kontrolü.</p></div><EvidencePill level="review" /></div><section className="panel life-calendar-panel"><div className="panel-head"><div><div className="eyebrow">TEK HAYAT TAKVİMİ</div><h3>Borç, ceza, IND, sağlık ve resmi süreler</h3></div><span className={`pill evidence-${calendarItems.length ? 'review' : 'verified'}`}>{calendarItems.length} açık kayıt</span></div><div className="life-timeline">{calendarItems.length ? calendarItems.map((item) => <div className="timeline-row" key={`${item.kind}-${item.title}-${item.date}`}><span>{item.kind}</span><strong>{item.title}</strong><small>{item.date} · {daysUntil(item.date) < 0 ? `${Math.abs(daysUntil(item.date))} gün geçti` : `${daysUntil(item.date)} gün kaldı`} · {item.meta}</small></div>) : <div className="empty-inline">Açık takvim kaydı yok.</div>}</div></section><div className="life-grid">{lifeRadarItems.map((item) => <article className="panel life-card" key={item.title}><div className="life-card-top"><span className="pill evidence-review">{item.tag}</span><a href={item.url} target="_blank" rel="noreferrer">Kaynak ↗</a></div><h3>{item.title}</h3><p>{item.text}</p><small>{item.source}</small></article>)}</div><section className="panel berichtenbox-panel"><div className="panel-head"><div><div className="eyebrow">BERICHTENBOX İÇE ALMA</div><h3>DigiD otomasyonu yok; resmi mesajı güvenli şekilde kasaya al</h3></div><a className="button secondary" href="https://mijnoverheid.nl/" target="_blank" rel="noreferrer">MijnOverheid aç ↗</a></div><div className="step-list">{berichtenboxSteps.map((step, index) => <div className="step-row" key={step}><span>{index + 1}</span><p>{step}</p></div>)}</div></section><section className="panel preventive-panel"><div className="panel-head"><div><div className="eyebrow">ÖNLEYİCİ KONTROL LİSTESİ</div><h3>Yaşam kalitesini artıracak erken kontroller</h3></div><span className="pill evidence-review">{preventiveChecklist.length} başlık</span></div><div className="preventive-grid">{preventiveChecklist.map((item) => <article className="preventive-card" key={item.title}><div className="life-card-top"><span className="pill evidence-review">{item.tag}</span><a href={item.url} target="_blank" rel="noreferrer">Kaynak ↗</a></div><h3>{item.title}</h3><p>{item.action}</p><small>{item.source}</small></article>)}</div></section><section className="panel share-scope-panel"><div className="panel-head"><div><div className="eyebrow">PAYLAŞIM GÖRÜNÜMLERİ</div><h3>Avukat, eş ve muhasebe için kısıtlı kapsam</h3></div><EvidencePill level="review" /></div><div className="share-scope-grid">{shareScopes.map((scope) => <article className="share-scope-card" key={scope.audience}><strong>{scope.audience}</strong><p>{scope.detail}</p><span>Link üretmeden önce yeniden onay + audit gerekir.</span></article>)}</div></section><div className="overview-grid"><section className="panel"><div className="panel-head"><div><div className="eyebrow">CANLI UYARILAR</div><h3>Gmail/Drive/watchdog’ın yakaladığı riskler</h3></div><span className={`pill evidence-${live ? 'verified' : 'review'}`}>{notifications.length} kayıt</span></div><div className="notification-list">{notifications.length ? notifications.map((item) => <div className={`notification-row ${item.severity}`} key={item.id}><strong>{item.title}</strong><p>{item.body}</p><span>{new Date(item.createdAt).toLocaleString('tr-TR')}</span></div>) : <div className="empty-inline">{live ? 'Henüz canlı uyarı yok. Watchdog, Gmail ve Drive taramalarından sonra burada görünür.' : 'Canlı oturum yok; demo uyarı üretilmez.'}</div>}</div></section><section className="panel"><div className="panel-head"><div><div className="eyebrow">AJAN BEYNİ</div><h3>Manuel kayıtlı bilgi / skill</h3></div><button className="text-button" onClick={onOpenSettings}>Ekle →</button></div><div className="knowledge-list">{knowledge.length ? knowledge.slice(0, 6).map((item) => <div className="knowledge-row" key={item.id}><span className="pill evidence-review">{knowledgeCategoryLabel[item.category]}</span><strong>{item.title}</strong><p>{item.body}</p>{item.sourceUrl && <a href={item.sourceUrl} target="_blank" rel="noreferrer">Kaynak ↗</a>}</div>) : <div className="empty-inline">Henüz manuel bilgi yok. Ayarlar’dan “skill / yöntem / hak” ekleyebilirsin.</div>}</div></section></div><section className="panel safety-panel"><div className="panel-head"><div><div className="eyebrow">YETKİ SINIRI</div><h3>DigiD, BSN, ödeme ve resmi başvuru otomatikleşmez</h3></div><EvidencePill level="verified" /></div><p>Sistem sana kaynaklı kontrol listesi, belge paketi ve uyarı üretir. DigiD şifresi/BSN saklamaz; itiraz, ödeme, form gönderimi veya kurumla yazışma ancak ayrı ekranda metin ve kanıtı görüp sen onayladıktan sonra ilerler.</p></section></>
}

function ApprovalsView({ deadlines: deadlineItems, items, live, obligations: obligationItems, onApprove, onNavigate }: { deadlines: Deadline[]; items: ApprovalItem[]; live: boolean; obligations: Obligation[]; onApprove: (id: string) => void | Promise<void>; onNavigate: (view: ViewId) => void }) {
  const reviewPayments = obligationItems
    .filter((item) => item.status !== 'paid')
    .sort((a, b) => paymentSortValue(a) - paymentSortValue(b))
    .slice(0, 4)
  const reviewDeadlines = deadlineItems
    .filter((item) => item.status !== 'done')
    .sort((a, b) => daysUntil(a.date) - daysUntil(b.date))
    .slice(0, 3)

  return <><PageIntro eyebrow="İNSAN KONTROLÜ" title="Onay vermeden hiçbir kritik işlem yok" detail={live ? 'Karar canlı audit kaydına yazılır; yürütme ayrı bir worker ve yeniden doğrulama gerektirir. Aşağıda ödeme/süre kayıtlarından üretilen inceleme taslakları da görünür.' : 'Bu merkezdeki butonlar yalnızca yerel demo durumunu değiştirir; banka veya e-posta tarafında işlem yapmaz.'} /><div className="approval-list">{items.length ? items.map((item) => <div className={`panel approval-card ${item.status}`} key={item.id}><div className={`approval-icon ${item.risk}`}>{item.action === 'payment' ? '€' : item.action === 'send' ? '✉' : '↗'}</div><div className="approval-content"><div className="approval-top"><span className={`risk-label ${item.risk}`}>{item.risk === 'high' ? 'Yüksek risk' : item.risk === 'medium' ? 'Orta risk' : 'Düşük risk'}</span><span className="approval-status">{item.status === 'pending' ? 'Onay bekliyor' : item.status === 'rejected' ? 'Reddedildi' : live ? 'Karar kaydedildi' : 'Demo onaylandı'}</span></div><h3>{item.title}</h3><p>{item.description}</p>{item.amount && <strong className="approval-amount">{formatEuro(item.amount)}</strong>}<div className="approval-actions">{item.status === 'pending' ? <><button className="button primary" onClick={() => void onApprove(item.id)}>{live ? 'Kararı onayla' : 'Demo onayı ver'}</button><button className="button ghost" onClick={() => onNavigate(item.action === 'payment' ? 'payments' : 'inbox')}>Detayları incele</button></> : <EvidencePill level={live ? 'verified' : 'demo'} />}</div></div></div>) : <div className="panel empty-inline">Bekleyen elle oluşturulmuş onay kaydı yok. Aşağıdaki taslaklar canlı belgelerden otomatik üretildi.</div>}</div><section className="panel review-queue-panel"><div className="panel-head"><div><div className="eyebrow">BELGEDEN ÜRETİLEN İNCELEME</div><h3>Ödeme, itiraz ve süre taslakları</h3></div><span className={`pill evidence-${reviewPayments.length || reviewDeadlines.length ? 'review' : 'verified'}`}>{reviewPayments.length + reviewDeadlines.length} taslak</span></div><div className="review-queue-grid">{reviewPayments.map((item) => {
    const time = paymentTimeLabel(item)
    return <article className="review-card" key={`payment-${item.id}`}><span className="pill evidence-review">Ödeme kontrolü</span><h3>{item.title}</h3><p>{item.authority} · {item.amount ? formatEuro(item.amount) : 'Tutar belirsiz'} · {time.label}</p>{item.sourceExcerpt && <small>{item.sourceExcerpt}</small>}<div className="approval-actions"><button className="button secondary" onClick={() => onNavigate('payments')}>Ödeme planında aç</button>{item.sourceUrl && <a className="button ghost" href={item.sourceUrl} target="_blank" rel="noreferrer">Kaynak aç ↗</a>}</div></article>
  })}{reviewDeadlines.map((item) => <article className="review-card" key={`deadline-${item.id}`}><span className="pill evidence-review">Süre kontrolü</span><h3>{item.title}</h3><p>{item.owner} · {item.date} · {daysUntil(item.date) < 0 ? `${Math.abs(daysUntil(item.date))} gün geçti` : `${daysUntil(item.date)} gün kaldı`}</p>{item.sourceExcerpt && <small>{item.sourceExcerpt}</small>}<div className="approval-actions"><button className="button secondary" onClick={() => onNavigate('deadlines')}>Sürelerde aç</button>{item.sourceUrl && <a className="button ghost" href={item.sourceUrl} target="_blank" rel="noreferrer">Kaynak aç ↗</a>}</div></article>)}{!reviewPayments.length && !reviewDeadlines.length && <div className="empty-inline">Aksiyon gerektiren canlı belge/süre taslağı yok.</div>}</div></section><div className="info-callout"><strong>Onay politikası sabit:</strong><span>Ödeme, dışarıya e-posta, resmi başvuru, hesabı bağlama ve ayar değiştirme işlemleri için yeniden doğrulama + audit log gerekir.</span></div></>
}

function SourcesView({ sources: sourceItems }: { sources: SourceRecord[] }) {
  return <><PageIntro eyebrow="KAYNAK KAYDI" title="Resmi kaynağı olmayan bilgi öneri değildir" detail="Ajan, Hollanda kurumları için allowlist kullanacak ve her çıkarımın kaynağını, tarihini ve geçerlilik durumunu gösterecek." action={<button className="button secondary">Kaynakları yenile (hazırlık)</button>} /><section className="panel institution-panel"><div className="panel-head"><div><div className="eyebrow">KURUM PROFİLLERİ</div><h3>Ödeme, itiraz, taksit ve portal linkleri</h3></div><span className="pill evidence-verified">{institutionProfiles.length} profil</span></div><div className="institution-grid">{institutionProfiles.map((profile) => <article className="institution-card" key={profile.name}><div className="source-top"><span className="pill official-pill">Resmi işlem</span><strong>{profile.name}</strong></div><p>{profile.purpose}</p><small>{profile.risk}</small><div className="payment-links"><a href={profile.portalUrl} target="_blank" rel="noreferrer">Portal ↗</a><a href={profile.objectionUrl} target="_blank" rel="noreferrer">İtiraz/bilgi ↗</a><a href={profile.planUrl} target="_blank" rel="noreferrer">Taksit/iletişim ↗</a></div></article>)}</div></section><div className="source-grid">{sourceItems.map((source) => <div className="panel source-card" key={source.id}><div className="source-top"><span className="source-seal">◎</span><span className="pill official-pill">Resmi alan adı</span></div><h3>{source.name}</h3><a href={`https://${source.domain}`} target="_blank" rel="noreferrer">{source.domain} ↗</a><p>{source.purpose}</p><div className="source-footer"><span>{source.lastChecked}</span><span className="source-toggle"><span className={source.enabled ? 'toggle-on' : ''} /> {source.enabled ? 'İzleme açık' : 'Kapalı'}</span></div></div>)}</div></>
}

function SettingsView({ accounts, knowledge, live, onConnect, onNotice, onSaveKnowledge, onSignOut }: { accounts: MailAccount[]; knowledge: KnowledgeItem[]; live: boolean; onConnect: (includeDrive?: boolean) => void | Promise<void>; onNotice: (message: string) => void; onSaveKnowledge: (input: { body: string; category: string; sourceUrl?: string; title: string }) => Promise<boolean>; onSignOut: () => void | Promise<void> }) {
  const [knowledgeCategory, setKnowledgeCategory] = useState<KnowledgeItem['category']>('skill')
  const [knowledgeTitle, setKnowledgeTitle] = useState('')
  const [knowledgeBody, setKnowledgeBody] = useState('')
  const [knowledgeSource, setKnowledgeSource] = useState('')
  const [savingKnowledge, setSavingKnowledge] = useState(false)
  const [uiPreferences, setUiPreferences] = useState({
    autoOpenDocument: true,
    calendarAlarms: true,
    driveOcr: true,
    radarWarnings: true,
  })
  const connected = accounts.filter((account) => account.status === 'connected').length

  const togglePreference = (key: keyof typeof uiPreferences, label: string) => {
    setUiPreferences((current) => {
      const next = { ...current, [key]: !current[key] }
      onNotice(`${label}: ${next[key] ? 'açık' : 'kapalı'}. Kritik işlem politikaları değişmedi.`)
      return next
    })
  }

  const lockedPreference = (label: string) => {
    onNotice(`${label} güvenlik nedeniyle buradan açılamaz. Önce kaynak, sonra Onay Merkezi ve audit gerekir.`)
  }

  const applyLearningTemplate = (template: typeof learningTemplates[number]) => {
    setKnowledgeCategory(template.category)
    setKnowledgeTitle(template.title)
    setKnowledgeBody(template.body)
    setKnowledgeSource('')
    onNotice('Öğrenme şablonu forma aktarıldı; kaydettiğinde bilgi bankasına yazılır.')
  }

  const submitKnowledge = async (event: React.FormEvent) => {
    event.preventDefault()
    setSavingKnowledge(true)
    const saved = await onSaveKnowledge({
      body: knowledgeBody,
      category: knowledgeCategory,
      sourceUrl: knowledgeSource || undefined,
      title: knowledgeTitle,
    })
    setSavingKnowledge(false)
    if (saved) {
      setKnowledgeTitle('')
      setKnowledgeBody('')
      setKnowledgeSource('')
    }
  }

  return <><PageIntro eyebrow="AYARLAR VE BAĞLANTILAR" title="Yetkiyi küçük ve görünür tut" detail="Her Gmail/Drive hesabı ayrı bağlanır. Sistem hangi hesabı taradığını, hangi kapsamı aldığını ve son taramayı açıkça gösterir." action={<div className="action-pair"><button className="button primary" onClick={() => void onConnect(false)}>Gmail hesabı bağla</button><button className="button secondary" onClick={() => void onConnect(true)}>Gmail + Drive bağla</button></div>} /><section className="panel settings-section"><div className="panel-head"><div><div className="eyebrow">E-POSTA VE DRIVE HESAPLARI</div><h3>4-5 hesap için bağlantı durumu</h3></div><span className={`pill evidence-${connected ? 'verified' : 'review'}`}>{connected} / 5 bağlı</span></div><div className="accounts-list">{accounts.length ? accounts.map((account) => { const hasDrive = account.scopes.includes('https://www.googleapis.com/auth/drive.readonly'); return <div className="account-row" key={account.id}><span className="connection-icon gmail">G</span><div><strong>{account.email}</strong><span>{account.provider} · {account.lastSync ? `son tarama ${new Date(account.lastSync).toLocaleString('tr-TR')}` : 'son tarama yok'}</span></div><span className="scope-empty">{hasDrive ? 'Gmail + Drive' : account.scopes.length ? 'Gmail okuma' : 'Kapsam verilmedi'}</span><span className={`pill evidence-${account.status === 'connected' ? 'verified' : 'review'}`}>{account.status === 'connected' ? 'Bağlı' : 'Yeniden yetkilendir'}</span></div> }) : <div className="empty-inline">Henüz hesap bağlı değil. Her hesabı ayrı ayrı ekle.</div>}</div></section><div className="settings-two-col"><section className="panel"><div className="eyebrow">GÜVENLİK TERCİHLERİ</div><h3>Kalıcı kurallar</h3><SettingSwitch title="Otomatik ödeme" detail="Daima kapalı; yalnızca onaylı taslak ve yeniden doğrulama" enabled={false} locked onToggle={() => lockedPreference('Otomatik ödeme')} /><SettingSwitch title="DigiD otomasyonu" detail="Kimlik bilgisi saklanmaz, manuel giriş gerekir" enabled={false} locked onToggle={() => lockedPreference('DigiD otomasyonu')} /><SettingSwitch title="Hassas veri maskeleme" detail="Loglarda ve hata mesajlarında açık kalır" enabled locked onToggle={() => lockedPreference('Hassas veri maskeleme')} /><SettingSwitch title="Resmi işlem gönderimi" detail="Avukat/kullanıcı onayı olmadan yok" enabled={false} locked onToggle={() => lockedPreference('Resmi işlem gönderimi')} /></section><section className="panel"><div className="eyebrow">ÇALIŞMA TERCİHLERİ</div><h3>Okuma ve uyarı davranışı</h3><SettingSwitch title="Drive OCR sonrası borç/süre çıkar" detail="Okunan belgeden ödeme, itiraz ve son tarih üret" enabled={uiPreferences.driveOcr} onToggle={() => togglePreference('driveOcr', 'Drive OCR çıkarımı')} /><SettingSwitch title="2 gün önce takvim alarmı" detail="İndirilen .ics ve Google Takvim linkleri alarm bilgisi taşır" enabled={uiPreferences.calendarAlarms} onToggle={() => togglePreference('calendarAlarms', 'Takvim alarmı')} /><SettingSwitch title="Radar uyarılarını göster" detail="Gmail/Drive/watchdog sinyallerini Yaşam Radar’da göster" enabled={uiPreferences.radarWarnings} onToggle={() => togglePreference('radarWarnings', 'Radar uyarıları')} /><SettingSwitch title="Evrak detayını açık tut" detail="Kasa listesinde seçili belgenin özetini ve alanlarını yanında göster" enabled={uiPreferences.autoOpenDocument} onToggle={() => togglePreference('autoOpenDocument', 'Evrak detayı')} /><p className="setting-copy">Bu kontroller şimdilik dashboard davranışını görünür yapar. Kritik server politikaları ayrıca korunur.</p></section></div><section className="panel rule-panel"><div className="panel-head"><div><div className="eyebrow">AI MAIL KURALLARI</div><h3>Gmail/Drive sinyalini nasıl sınıflandıracak?</h3></div><span className="pill evidence-review">{emailAutomationRules.length} kural</span></div><div className="rule-grid">{emailAutomationRules.map((rule) => <article className="rule-card" key={rule.match}><strong>{rule.match}</strong><p>{rule.action}</p></article>)}</div></section><div className="settings-two-col"><section className="panel"><div className="eyebrow">VERİ HAKLARI</div><h3>Kontrol sende</h3><p className="setting-copy">Veriyi dışa aktarma, bağlantıyı iptal etme ve tüm veriyi silme işlemleri ayrı, geri dönüşü açık adımlar olacak.</p><button className="button ghost" onClick={() => onNotice('Veri politikası uygulama öncesi hukuk ve güvenlik incelemesinde.')}>Veri politikası taslağı</button>{live && <button className="button secondary signout-button" onClick={() => void onSignOut()}>Bu oturumu kapat</button>}</section><section className="panel"><div className="eyebrow">TAKVİM HEDEFİ</div><h3>siostarr@hairartclinics.com</h3><p className="setting-copy">Ödeme ve süre kartlarındaki Google Takvim linkleri bu hesapla açılacak şekilde hazırlanır. Dosya dışa aktarımı ayrıca 2 gün önce alarm içerir.</p><a className="button secondary" href="https://calendar.google.com/calendar/u/0/r?authuser=siostarr@hairartclinics.com" target="_blank" rel="noreferrer">Google Takvim’i aç ↗</a></section></div><section className="panel knowledge-panel"><div className="panel-head"><div><div className="eyebrow">AJAN BEYNİ / MANUEL SKILL</div><h3>Düzeltmeden öğrenen bilgi bankası</h3></div><span className="pill evidence-review">{knowledge.length} kayıt</span></div><div className="learning-template-grid">{learningTemplates.map((template) => <button className="learning-template-card" key={template.title} onClick={() => applyLearningTemplate(template)}><strong>{template.title}</strong><span>{knowledgeCategoryLabel[template.category]}</span></button>)}</div><form className="knowledge-form" onSubmit={submitKnowledge}><label htmlFor="knowledge-category">Kategori</label><select id="knowledge-category" value={knowledgeCategory} onChange={(event) => setKnowledgeCategory(event.target.value as KnowledgeItem['category'])}>{Object.entries(knowledgeCategoryLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><label htmlFor="knowledge-title">Başlık</label><input id="knowledge-title" required minLength={3} maxLength={160} value={knowledgeTitle} onChange={(event) => setKnowledgeTitle(event.target.value)} placeholder="Örn. CJIB itirazında önce ödeme yapma kontrolü" /><label htmlFor="knowledge-body">Bilgi / skill</label><textarea id="knowledge-body" required minLength={10} maxLength={5000} value={knowledgeBody} onChange={(event) => setKnowledgeBody(event.target.value)} placeholder="Kaynak, koşul, ne zaman uygulanır ve hangi kanıt gerekir?" /><label htmlFor="knowledge-source">Kaynak URL (opsiyonel)</label><input id="knowledge-source" type="url" maxLength={2048} value={knowledgeSource} onChange={(event) => setKnowledgeSource(event.target.value)} placeholder="https://..." /><button className="button primary" disabled={savingKnowledge}>{savingKnowledge ? 'Kaydediliyor…' : 'Bilgi bankasına kaydet'}</button></form>{knowledge.length > 0 && <div className="knowledge-preview">{knowledge.slice(0, 3).map((item) => <div className="knowledge-row" key={item.id}><span className="pill evidence-review">{knowledgeCategoryLabel[item.category]}</span><strong>{item.title}</strong><p>{item.body}</p></div>)}</div>}</section>{live && <PasswordPanel onNotice={onNotice} />}</>
}

function SettingSwitch({ detail, enabled, locked = false, onToggle, title }: { detail: string; enabled: boolean; locked?: boolean; onToggle: () => void; title: string }) {
  return <div className="setting-row"><div><strong>{title}</strong><span>{detail}</span></div><button type="button" className={`switch ${enabled ? 'on' : 'off'} ${locked ? 'locked' : ''}`} onClick={onToggle}>{locked ? 'Kilitli' : enabled ? 'Açık' : 'Kapalı'}</button></div>
}

function Guardrail({ title, text }: { title: string; text: string }) {
  return <div className="guardrail"><span>✓</span><div><strong>{title}</strong><p>{text}</p></div></div>
}

export default App
