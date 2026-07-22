import { useEffect, useState } from 'react'
import { ApiError, beginGmailConnection, decideApproval, getDashboard, getSession, setPassword, signIn, signOut, type DashboardResponse, type SessionResponse } from './api'
import { activities, approvals as initialApprovals, deadlines, mailAccounts, obligations, sources } from './data'
import type { ApprovalItem, Deadline, EvidenceLevel, MailAccount, Obligation, ObligationStatus, ViewId } from './types'

const nav: Array<{ id: ViewId; label: string; icon: string }> = [
  { id: 'overview', label: 'Genel Bakış', icon: '⌂' },
  { id: 'inbox', label: 'Gelen Kutusu', icon: '✉' },
  { id: 'payments', label: 'Ödeme Planı', icon: '€' },
  { id: 'documents', label: 'Evrak Kasası', icon: '▤' },
  { id: 'deadlines', label: 'Haklar & Süreler', icon: '◷' },
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
    source: item.source_url ?? 'Supabase kaydı',
    status: obligationStatuses.has(item.status as ObligationStatus) ? item.status as ObligationStatus : 'open',
    title: item.title,
  }))
  const liveDeadlines: Deadline[] = payload.deadlines.map((item) => {
    const date = item.due_at.slice(0, 10)
    const days = daysUntil(date)
    return {
      date,
      evidence: evidenceLevels.has(item.evidence_level as EvidenceLevel) ? item.evidence_level as EvidenceLevel : 'review',
      id: item.id,
      owner: item.owner,
      status: item.status === 'waiting' ? 'waiting' : item.status === 'done' || item.status === 'dismissed' ? 'done' : 'open',
      title: item.title,
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
  return { accounts: liveAccounts, approvals: liveApprovals, deadlines: liveDeadlines, obligations: liveObligations }
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
  const pendingApprovals = approvalsState.filter((item) => item.status === 'pending').length

  const showToast = (message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(''), 3200)
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

  const connectGmail = async () => {
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
      const { authorizationUrl } = await beginGmailConnection(false)
      window.location.assign(authorizationUrl)
    } catch (error) {
      showToast(gmailConnectErrorMessage(error))
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
      case 'inbox': return <InboxView live={liveMode} messageCount={liveCounts.messages} />
      case 'payments': return <PaymentsView items={activeObligations} live={liveMode} onOpenApprovals={() => setView('approvals')} />
      case 'documents': return <DocumentsView documentCount={liveCounts.documents} live={liveMode} />
      case 'deadlines': return <DeadlinesView items={activeDeadlines} live={liveMode} />
      case 'approvals': return <ApprovalsView items={approvalsState} live={liveMode} onApprove={approve} />
      case 'sources': return <SourcesView />
      case 'settings': return <SettingsView accounts={activeAccounts} live={liveMode} onConnect={connectGmail} onNotice={showToast} onSignOut={leaveSession} />
      default:
        return <OverviewView accounts={activeAccounts} approvals={approvalsState} deadlines={activeDeadlines} live={liveMode} loginRequired={loginRequired} obligations={activeObligations} onLogin={() => setLoginOpen(true)} onNavigate={setView} />
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

  return <section className="login-panel panel" data-testid="login-panel" aria-labelledby="dashboard-login-title"><div className="login-panel-head"><div><div className="eyebrow">DASHBOARD OTURUMU</div><h2 id="dashboard-login-title">Dashboard’dan giriş yap</h2><p>Giriş yalnızca e-posta ve şifreyle yapılır; bu ekrandan e-posta veya kod gönderilmez.</p></div><button type="button" className="button ghost" onClick={onClose}>Kapat</button></div><form className="auth-form" onSubmit={submit}><label htmlFor="login-email">E-posta adresi</label><input id="login-email" type="email" autoComplete="username" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} /><label htmlFor="login-password">Şifre</label><input id="login-password" type="password" autoComplete="current-password" required minLength={12} maxLength={128} value={password} onChange={(event) => setPasswordValue(event.target.value)} /><button className="button primary" disabled={status === 'submitting'}>{status === 'submitting' ? 'Giriş yapılıyor…' : 'Giriş yap'}</button></form>{status === 'error' && <div className="auth-notice error" role="alert">E-posta veya şifre doğru değil. İlk şifreni mevcut açık oturumdan Ayarlar bölümünde belirleyebilirsin.</div>}<small>Oturum jetonları JavaScript'e açılmaz; yalnızca HttpOnly çerezde tutulur.</small></section>
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

function OverviewView({ accounts, approvals, deadlines: deadlineItems, live, loginRequired, obligations: obligationItems, onLogin, onNavigate }: { accounts: MailAccount[]; approvals: ApprovalItem[]; deadlines: Deadline[]; live: boolean; loginRequired: boolean | undefined; obligations: Obligation[]; onLogin: () => void; onNavigate: (view: ViewId) => void }) {
  const dueSoon = deadlineItems.filter((item) => item.status !== 'done' && daysUntil(item.date) <= 7).length
  const totalOpen = obligationItems.filter((item) => item.status === 'open' || item.status === 'overdue').reduce((sum, item) => sum + item.amount, 0)
  const connectedAccounts = accounts.filter((item) => item.status === 'connected').length
  const activityItems = live ? [{ id: 'live-session', time: 'Şimdi', title: 'Korumalı oturum doğrulandı', detail: 'Kayıtlar kullanıcıya ait RLS kurallarıyla okundu.', kind: 'system' as const }] : activities
  return <>
    <PageIntro eyebrow="BUGÜNÜN KONTROL MERKEZİ" title="Önce neyi güvene alıyoruz?" detail="Muh Agent, para hareketi yapmadan önce kanıtı, son tarihi ve insan onayını aynı yerde toplar." action={loginRequired ? <button className="button primary" data-testid="overview-login" onClick={onLogin}>Dashboard'dan giriş yap <span>→</span></button> : <button className="button primary" onClick={() => onNavigate('approvals')}>Onay kuyruğunu aç <span>→</span></button>} />
    <div className="truth-banner"><span className="banner-icon">!</span><div><strong>{loginRequired ? 'Dashboard önizleme açık — kişisel kayıtların için giriş yap.' : live ? 'Kişisel kasa oturumu doğrulandı; dış işlemler yine kapalı.' : 'Şu anda gerçek Gmail, banka, DigiD veya belge bağlantısı yok.'}</strong><p>{loginRequired ? 'Girişte yalnızca e-posta ve şifre kullanılır; e-posta veya kod gönderilmez. Giriş yaptığında yalnızca sana ait kayıtlar yüklenir.' : live ? 'Canlı kayıtlar RLS ile sınırlandı. Onay vermek yalnızca kararı kaydeder; ödeme veya gönderim ayrı ve denetimli bir adımdır.' : 'Bu ekran yalnızca ürün temelini gösterir. Demo kayıtları ile gerçek kayıtlar birbirine karıştırılmayacak.'}</p></div><EvidencePill level={loginRequired ? 'review' : live ? 'verified' : 'demo'} /></div>
    <div className="metric-grid">
      <MetricCard label="Yaklaşan süre" value={String(dueSoon)} suffix=" adet" detail="7 gün içinde açık iş" tone="amber" />
      <MetricCard label="Açık yükümlülük" value={formatEuro(totalOpen)} suffix="" detail={live ? 'Canlı açık kayıtların toplamı' : 'Demo kayıtlarının toplamı'} tone="blue" />
      <MetricCard label="İnsan onayı" value={String(approvals.filter((item) => item.status === 'pending').length)} suffix=" bekliyor" detail="Dış işlem yapılmadı" tone="violet" />
      <MetricCard label="Bağlı hesap" value={String(connectedAccounts)} suffix=" / 4" detail={connectedAccounts ? 'Salt-okunur OAuth' : 'OAuth kurulumu bekliyor'} tone="green" />
    </div>
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
      <section className="panel connection-panel"><div className="panel-head"><div><div className="eyebrow">VERİ KAYNAKLARI</div><h3>Bağlantı durumu</h3></div><button className="text-button" onClick={() => onNavigate('settings')}>Kurulum →</button></div><div className="connection-row"><span className="connection-icon gmail">G</span><div><strong>Gmail hesapları</strong><p>{connectedAccounts ? `${connectedAccounts} salt-okunur hesap bağlı` : '4 hesap için OAuth gerekli'}</p></div><span className={`pill evidence-${connectedAccounts ? 'verified' : 'review'}`}>{connectedAccounts ? 'Bağlı' : 'Bağlanmadı'}</span></div><div className="connection-row"><span className="connection-icon vault">▤</span><div><strong>Evrak kasası</strong><p>Dosya yükleme ve OCR beklemede</p></div><span className="pill evidence-review">Kurulmadı</span></div></section>
      <section className="panel principle-panel"><div className="principle-mark">◈</div><div><div className="eyebrow">TEMEL KURAL</div><h3>Oku → kanıtla → öner → onay al</h3><p>Ajan hiçbir para transferini, resmi gönderimi veya hesap bağlantısını sessizce yapmaz. Her kritik adım görünür onay ister.</p></div></section>
    </div>
  </>
}

function MetricCard({ label, value, suffix, detail, tone }: { label: string; value: string; suffix: string; detail: string; tone: string }) {
  return <div className={`metric-card tone-${tone}`}><div className="metric-label">{label}</div><div className="metric-value">{value}<small>{suffix}</small></div><div className="metric-detail">{detail}</div></div>
}

function DeadlineRow({ item }: { item: Deadline }) {
  const days = daysUntil(item.date)
  return <div className="deadline-row"><div className={`deadline-icon ${item.urgency}`}>{item.urgency === 'critical' ? '!' : item.urgency === 'soon' ? '◷' : '○'}</div><div className="deadline-main"><strong>{item.title}</strong><span>{item.owner} · {item.date}</span></div><div className={`deadline-count ${item.urgency}`}>{days < 0 ? `${Math.abs(days)} gün geçti` : days === 0 ? 'Bugün' : `${days} gün`}</div></div>
}

function InboxView({ live, messageCount }: { live: boolean; messageCount: number }) {
  return <><PageIntro eyebrow="GELEN KUTUSU" title={live ? `${messageCount} güvenli mesaj kaydı` : 'E-posta akışı henüz bağlanmadı'} detail={live ? 'Mesajlar salt-okunur Gmail kapsamı ve idempotent sağlayıcı kimliğiyle izlenir.' : 'Kimi sürümündeki “canlı akış” iddiasını burada varsaymıyoruz. Önce OAuth bağlantısı, sonra idempotent senkronizasyon kurulacak.'} /><div className="empty-state large"><div className="empty-icon">✉</div><h3>{messageCount ? 'Mesaj gövdeleri bu özet ekranda açılmıyor' : 'İşlenmiş mesaj yok'}</h3><p>Gmail hesapları için yalnızca `gmail.readonly` kapsamı istenir. Mesaj işlenirken kaynak, hash ve işleme zamanı kaydedilir.</p><EvidencePill level={live ? 'verified' : 'review'} /></div><section className="panel"><div className="panel-head"><div><div className="eyebrow">GÜVENLİK SINIRI</div><h3>Bu ekranın yapmayacağı şeyler</h3></div></div><div className="guardrail-grid"><Guardrail title="DigiD şifresi istemez" text="DigiD'ye otomatik giriş veya kimlik bilgisi saklama yok." /><Guardrail title="Mail göndermeyi durdurur" text="Avukat, kurum veya işverene gönderim insan onayı olmadan çalışmaz." /><Guardrail title="Eki körlemesine açmaz" text="Dosya türü, boyutu ve zararlı içerik kontrolünden geçmeden işlenmez." /></div></section></>
}

function PaymentsView({ items, live, onOpenApprovals }: { items: Obligation[]; live: boolean; onOpenApprovals: () => void }) {
  return <><PageIntro eyebrow="PARA VE YÜKÜMLÜLÜKLER" title="Ödeme kararı senden çıkar" detail="Ajan tutarı ve tarihi düzenler; parayı göndermek için ayrı bir insan onayı gerekir." action={<button className="button primary" onClick={onOpenApprovals}>Onayları aç →</button>} /><div className="table-panel panel"><div className="table-toolbar"><div><strong>{items.length} kayıt</strong><span> · {live ? 'canlı kasa / kanıt seviyeleri görünür' : 'tamamı demo/inceleme etiketli'}</span></div><button className="button secondary" onClick={() => undefined}>CSV içe aktar (hazırlık)</button></div><div className="obligation-list">{items.length ? items.map((item) => <div className="obligation-row" key={item.id}><div className="obligation-symbol">{item.category === 'Ceza' ? '!' : item.category === 'Vergi' ? '◈' : '€'}</div><div className="obligation-main"><strong>{item.title}</strong><span>{item.authority} · {item.note}</span></div><div className="obligation-amount">{item.amount ? formatEuro(item.amount) : 'Belirsiz'}</div><div className="obligation-date"><strong>{item.dueDate}</strong><span>{statusLabel[item.status]}</span></div><EvidencePill level={item.evidence} /></div>) : <div className="empty-inline">Yükümlülük kaydı yok.</div>}</div></div><div className="info-callout"><strong>Ödeme entegrasyonu kapalı.</strong><span>Bu sürüm sadece kayıt + onay kararı tutar. Banka bağlantısı kurulsa bile transfer öncesi alıcı, IBAN, tutar ve son tarih yeniden doğrulanır.</span></div></>
}

function DocumentsView({ documentCount, live }: { documentCount: number; live: boolean }) {
  return <><PageIntro eyebrow="EVRAK KASASI" title="Belgeleri tek bir güven zincirinde topla" detail={`${live ? `${documentCount} belge metaverisi kasada. ` : ''}Belgeler şifreli saklama, kaynak hash'i ve erişim günlüğü ile yönetilecek.`} action={<button className="button primary">Belge seç (hazırlık)</button>} /><div className="dropzone"><div className="drop-icon">＋</div><h3>Yükleme güvenlik kapısı henüz kapalı</h3><p>Gerçek yükleme etkinleştirilmeden önce maksimum boyut, MIME doğrulaması, virüs taraması ve saklama süresi uygulanacak.</p><EvidencePill level="review" /></div><div className="document-grid"><DocumentCard title="IND yazısı" detail="Avukat tarafından sağlanacak" status="Belge bekleniyor" /><DocumentCard title="CJIB bildirimi" detail="Gmail / kullanıcı yüklemesi" status="Kaynak doğrulanacak" /><DocumentCard title="İş sözleşmesi ve maaş kanıtı" detail="IND dosyası" status="Hassas veri" /></div></>
}

function DocumentCard({ title, detail, status }: { title: string; detail: string; status: string }) {
  return <div className="document-card panel"><div className="file-icon">▤</div><div><strong>{title}</strong><p>{detail}</p></div><span className="pill evidence-review">{status}</span></div>
}

function DeadlinesView({ items, live }: { items: Deadline[]; live: boolean }) {
  return <><PageIntro eyebrow="HAKLAR, SÜRELER, DOSYALAR" title="Unutulacak tarihi bırakma" detail="Hukuk ve sağlık alanındaki kayıtlar kaynak ve tarih olmadan kesin bilgi olarak gösterilmez." action={<button className="button secondary">Takvim dışa aktar (hazırlık)</button>} /><div className="deadline-board">{items.length ? items.map((item) => <div className="panel deadline-card" key={item.id}><div className={`deadline-icon ${item.urgency}`}>{item.urgency === 'critical' ? '!' : '◷'}</div><div className="eyebrow">{item.owner}</div><h3>{item.title}</h3><div className="date-large">{item.date}</div><div className="card-footer"><EvidencePill level={item.evidence} /><span>{item.status === 'waiting' ? 'Yanıt bekliyor' : item.status === 'done' ? 'Tamamlandı' : 'Aksiyon gerekli'}</span></div></div>) : <div className="panel empty-inline">{live ? 'Canlı son tarih kaydı yok.' : 'Demo son tarih kaydı yok.'}</div>}</div><section className="panel safety-panel"><div className="panel-head"><div><div className="eyebrow">DOSYA GÜVENLİĞİ</div><h3>IND dosyasında sonraki doğru adım</h3></div><EvidencePill level="review" /></div><p>Bu cockpit, yaşadığın oturum sürecinde belge listesi, son tarihler ve avukata sorulacak sorular için düzenleyici olabilir. “%100 sonuç”, gizli hile veya avukatın yerine karar verme iddiası yoktur.</p><div className="question-list"><span>□ Mevcut IND yazısının tarihi ve referans numarası kaydedildi mi?</span><span>□ Yeni işverenin erkend referent durumu avukat tarafından doğrulandı mı?</span><span>□ Maaş kriteri doğru yıl ve oturum türüyle eşleştirildi mi?</span></div></section></>
}

function ApprovalsView({ items, live, onApprove }: { items: ApprovalItem[]; live: boolean; onApprove: (id: string) => void | Promise<void> }) {
  return <><PageIntro eyebrow="İNSAN KONTROLÜ" title="Onay vermeden hiçbir kritik işlem yok" detail={live ? 'Karar canlı audit kaydına yazılır; yürütme ayrı bir worker ve yeniden doğrulama gerektirir.' : 'Bu merkezdeki butonlar yalnızca yerel demo durumunu değiştirir; banka veya e-posta tarafında işlem yapmaz.'} /><div className="approval-list">{items.length ? items.map((item) => <div className={`panel approval-card ${item.status}`} key={item.id}><div className={`approval-icon ${item.risk}`}>{item.action === 'payment' ? '€' : item.action === 'send' ? '✉' : '↗'}</div><div className="approval-content"><div className="approval-top"><span className={`risk-label ${item.risk}`}>{item.risk === 'high' ? 'Yüksek risk' : item.risk === 'medium' ? 'Orta risk' : 'Düşük risk'}</span><span className="approval-status">{item.status === 'pending' ? 'Onay bekliyor' : item.status === 'rejected' ? 'Reddedildi' : live ? 'Karar kaydedildi' : 'Demo onaylandı'}</span></div><h3>{item.title}</h3><p>{item.description}</p>{item.amount && <strong className="approval-amount">{formatEuro(item.amount)}</strong>}<div className="approval-actions">{item.status === 'pending' ? <><button className="button primary" onClick={() => void onApprove(item.id)}>{live ? 'Kararı onayla' : 'Demo onayı ver'}</button><button className="button ghost">Detayları incele</button></> : <EvidencePill level={live ? 'verified' : 'demo'} />}</div></div></div>) : <div className="panel empty-inline">Bekleyen onay kaydı yok.</div>}</div><div className="info-callout"><strong>Onay politikası sabit:</strong><span>Ödeme, dışarıya e-posta, resmi başvuru, hesabı bağlama ve ayar değiştirme işlemleri için yeniden doğrulama + audit log gerekir.</span></div></>
}

function SourcesView() {
  return <><PageIntro eyebrow="KAYNAK KAYDI" title="Resmi kaynağı olmayan bilgi öneri değildir" detail="Ajan, Hollanda kurumları için allowlist kullanacak ve her çıkarımın kaynağını, tarihini ve geçerlilik durumunu gösterecek." action={<button className="button secondary">Kaynakları yenile (hazırlık)</button>} /><div className="source-grid">{sources.map((source) => <div className="panel source-card" key={source.id}><div className="source-top"><span className="source-seal">◎</span><span className="pill official-pill">Resmi alan adı</span></div><h3>{source.name}</h3><a href={`https://${source.domain}`} target="_blank" rel="noreferrer">{source.domain} ↗</a><p>{source.purpose}</p><div className="source-footer"><span>{source.lastChecked}</span><span className="source-toggle"><span className={source.enabled ? 'toggle-on' : ''} /> {source.enabled ? 'İzleme açık' : 'Kapalı'}</span></div></div>)}</div></>
}

function SettingsView({ accounts, live, onConnect, onNotice, onSignOut }: { accounts: MailAccount[]; live: boolean; onConnect: () => void | Promise<void>; onNotice: (message: string) => void; onSignOut: () => void | Promise<void> }) {
  const connected = accounts.filter((account) => account.status === 'connected').length
  return <><PageIntro eyebrow="AYARLAR VE BAĞLANTILAR" title="Yetkiyi küçük ve görünür tut" detail="Her hesap ve kurum için hangi kapsamın verildiği, son senkronizasyon ve iptal düğmesi ayrı görünür." action={<button className="button primary" onClick={() => void onConnect()}>Gmail hesabı bağla</button>} /><section className="panel settings-section"><div className="panel-head"><div><div className="eyebrow">E-POSTA HESAPLARI</div><h3>4 Gmail hesabı için bağlantı durumu</h3></div><span className={`pill evidence-${connected ? 'verified' : 'review'}`}>{connected} / 4 bağlı</span></div><div className="accounts-list">{accounts.length ? accounts.map((account) => <div className="account-row" key={account.id}><span className="connection-icon gmail">G</span><div><strong>{account.email}</strong><span>{account.provider} · {account.lastSync ? `son tarama ${new Date(account.lastSync).toLocaleString('tr-TR')}` : 'son tarama yok'}</span></div><span className="scope-empty">{account.scopes.length ? `${account.scopes.length} kapsam` : 'Kapsam verilmedi'}</span><span className={`pill evidence-${account.status === 'connected' ? 'verified' : 'review'}`}>{account.status === 'connected' ? 'Bağlı' : 'Yeniden yetkilendir'}</span></div>) : <div className="empty-inline">Henüz hesap bağlı değil.</div>}</div></section><div className="settings-two-col"><section className="panel"><div className="eyebrow">GÜVENLİK TERCİHLERİ</div><h3>Kalıcı kurallar</h3><div className="setting-row"><div><strong>Otomatik ödeme</strong><span>Daima kapalı; yalnızca onaylı taslak</span></div><span className="switch off">Kapalı</span></div><div className="setting-row"><div><strong>DigiD otomasyonu</strong><span>Kimlik bilgisi saklanmaz</span></div><span className="switch off">Kapalı</span></div><div className="setting-row"><div><strong>Hassas veri maskeleme</strong><span>Loglarda açık</span></div><span className="switch on">Açık</span></div></section><section className="panel"><div className="eyebrow">VERİ HAKLARI</div><h3>Kontrol sende</h3><p className="setting-copy">Veriyi dışa aktarma, bağlantıyı iptal etme ve tüm veriyi silme işlemleri ayrı, geri dönüşü açık adımlar olacak.</p><button className="button ghost" onClick={() => onNotice('Veri politikası uygulama öncesi hukuk ve güvenlik incelemesinde.')}>Veri politikası taslağı</button>{live && <button className="button secondary signout-button" onClick={() => void onSignOut()}>Bu oturumu kapat</button>}</section></div>{live && <PasswordPanel onNotice={onNotice} />}</>
}

function Guardrail({ title, text }: { title: string; text: string }) {
  return <div className="guardrail"><span>✓</span><div><strong>{title}</strong><p>{text}</p></div></div>
}

export default App
