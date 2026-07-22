import type { Activity, ApprovalItem, Deadline, MailAccount, Obligation, SourceRecord } from './types'

export const obligations: Obligation[] = [
  {
    id: 'demo-cjib-1',
    title: 'CJIB ödeme bildirimi',
    authority: 'CJIB',
    category: 'Ceza',
    amount: 186.4,
    currency: 'EUR',
    dueDate: '2026-07-24',
    status: 'open',
    evidence: 'demo',
    source: 'Örnek kayıt · Gmail bağlanmadı',
    note: 'Ödeme yapılmadan önce belge numarası ve alıcı IBAN doğrulanmalı.',
  },
  {
    id: 'demo-insurance-1',
    title: 'Zorgverzekering prim bildirimi',
    authority: 'Zilveren Kruis',
    category: 'Sigorta',
    amount: 154.2,
    currency: 'EUR',
    dueDate: '2026-07-27',
    status: 'open',
    evidence: 'demo',
    source: 'Örnek kayıt · e-posta bağlantısı yok',
    note: 'Gerçek bakiye ve otomatik ödeme talimatı henüz okunmuyor.',
  },
  {
    id: 'demo-tax-1',
    title: 'Belastingdienst yazışması',
    authority: 'Belastingdienst',
    category: 'Vergi',
    amount: 0,
    currency: 'EUR',
    dueDate: '2026-08-02',
    status: 'disputed',
    evidence: 'demo',
    source: 'Örnek kayıt · kullanıcı belgesi bekleniyor',
    note: 'Tutar ve son tarih resmi belgeden çıkarılmadan karar verilemez.',
  },
]

export const deadlines: Deadline[] = [
  {
    id: 'ind-case',
    title: 'IND dosyası için avukata belge paketi',
    owner: 'IND / avukat',
    date: '2026-07-22',
    urgency: 'critical',
    status: 'open',
    evidence: 'review',
  },
  {
    id: 'cjib-due',
    title: 'CJIB belgesindeki son ödeme tarihi',
    owner: 'CJIB',
    date: '2026-07-24',
    urgency: 'soon',
    status: 'waiting',
    evidence: 'demo',
  },
  {
    id: 'pregnancy-care',
    title: 'Ebe / kraamzorg görüşmesini planla',
    owner: 'Sağlık sistemi',
    date: '2026-08-01',
    urgency: 'planned',
    status: 'open',
    evidence: 'review',
  },
]

export const approvals: ApprovalItem[] = [
  {
    id: 'approval-payment',
    title: 'CJIB ödemesi için taslak',
    description: 'Belge doğrulaması tamamlanmadan para transferi yapılmaz.',
    amount: 186.4,
    action: 'payment',
    status: 'pending',
    risk: 'high',
  },
  {
    id: 'approval-email',
    title: 'Avukata belge özeti gönderimi',
    description: 'Gönderilecek metin ve ekler kullanıcı tarafından onaylanmalı.',
    action: 'send',
    status: 'pending',
    risk: 'medium',
  },
  {
    id: 'approval-gmail',
    title: 'Gmail bağlantısını başlat',
    description: 'Gmail okuma varsayılan; Drive izni sadece ayrı butonla istenecek.',
    action: 'connect',
    status: 'pending',
    risk: 'medium',
  },
]

export const mailAccounts: MailAccount[] = [
  { id: 'gmail-1', email: 'Bağlanacak hesap 1', provider: 'Gmail', status: 'not_connected', scopes: [] },
  { id: 'gmail-2', email: 'Bağlanacak hesap 2', provider: 'Gmail', status: 'not_connected', scopes: [] },
  { id: 'gmail-3', email: 'Bağlanacak hesap 3', provider: 'Gmail', status: 'not_connected', scopes: [] },
  { id: 'gmail-4', email: 'Bağlanacak hesap 4', provider: 'Gmail', status: 'not_connected', scopes: [] },
]

export const sources: SourceRecord[] = [
  { id: 'ind', name: 'IND', domain: 'ind.nl', purpose: 'Oturum, kennismigrant ve aile birleşimi duyuruları', lastChecked: 'Henüz bağlanmadı', enabled: true, trust: 'official' },
  { id: 'cjib', name: 'CJIB', domain: 'cjib.nl', purpose: 'Ceza, ödeme ve itiraz süreçleri', lastChecked: 'Henüz bağlanmadı', enabled: true, trust: 'official' },
  { id: 'belastingdienst', name: 'Belastingdienst', domain: 'belastingdienst.nl', purpose: 'Vergi, toeslagen ve ödeme düzenlemeleri', lastChecked: 'Henüz bağlanmadı', enabled: true, trust: 'official' },
  { id: 'waterland', name: 'Gemeente Waterland', domain: 'waterland.nl', purpose: 'Yerel vergi, adres ve belediye hizmetleri', lastChecked: 'Henüz bağlanmadı', enabled: true, trust: 'official' },
  { id: 'rechtspraak', name: 'Rechtspraak', domain: 'rechtspraak.nl', purpose: 'Mahkeme ve usul bilgileri', lastChecked: 'Henüz bağlanmadı', enabled: true, trust: 'official' },
  { id: 'rijksoverheid', name: 'Rijksoverheid', domain: 'rijksoverheid.nl', purpose: 'Yasa, hak ve devlet duyuruları', lastChecked: 'Henüz bağlanmadı', enabled: true, trust: 'official' },
  { id: 'mijnoverheid', name: 'MijnOverheid', domain: 'mijnoverheid.nl', purpose: 'Berichtenbox ve resmi devlet mesajları', lastChecked: 'Henüz bağlanmadı', enabled: true, trust: 'official' },
  { id: 'digid', name: 'DigiD', domain: 'digid.nl', purpose: 'Kimlik doğrulama kapısı; şifre saklanmaz', lastChecked: 'Henüz bağlanmadı', enabled: true, trust: 'official' },
  { id: 'uwv', name: 'UWV', domain: 'uwv.nl', purpose: 'İş, izin ve doğum/ebeveyn süreçleri', lastChecked: 'Henüz bağlanmadı', enabled: true, trust: 'official' },
  { id: 'svb', name: 'SVB', domain: 'svb.nl', purpose: 'Kinderbijslag ve aile yardımları', lastChecked: 'Henüz bağlanmadı', enabled: true, trust: 'official' },
  { id: 'rdw', name: 'RDW', domain: 'rdw.nl', purpose: 'Araç, ehliyet ve kayıt bağlantılı bilgiler', lastChecked: 'Henüz bağlanmadı', enabled: true, trust: 'official' },
  { id: 'politie', name: 'Politie', domain: 'politie.nl', purpose: 'Polis duyuruları ve resmi başvuru kanalları', lastChecked: 'Henüz bağlanmadı', enabled: true, trust: 'official' },
  { id: 'om', name: 'Openbaar Ministerie', domain: 'om.nl', purpose: 'Savcılık, ceza ve itiraz süreçleri', lastChecked: 'Henüz bağlanmadı', enabled: true, trust: 'official' },
]

export const activities: Activity[] = [
  { id: 'a1', time: 'Şimdi', title: 'Cockpit hazırlandı', detail: 'Gerçek bağlantı kurulmadığı açıkça işaretlendi.', kind: 'system' },
  { id: 'a2', time: 'Bugün', title: 'IND dosyası inceleme kuyruğuna alındı', detail: 'Sonuç garantisi yok; avukat doğrulaması gerekli.', kind: 'warning' },
  { id: 'a3', time: 'Bugün', title: 'Kaynak kayıtları oluşturuldu', detail: 'Sadece resmi alan adları başlangıç listesine eklendi.', kind: 'source' },
  { id: 'a4', time: 'Bekliyor', title: 'Gmail OAuth yetkisi', detail: 'Kullanıcı onayı ve sunucu sırları olmadan başlatılmadı.', kind: 'approval' },
]
