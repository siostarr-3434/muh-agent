import { createClient } from 'npm:@supabase/supabase-js@2'
import { sha256Hex } from '../_shared/crypto.ts'
import { json } from '../_shared/http.ts'

function env(name: string) {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`${name} is not configured`)
  return value
}

function adminClient() {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { autoRefreshToken: false, persistSession: false } })
}

async function workerAuthorized(request: Request) {
  const supplied = request.headers.get('x-worker-secret')
  if (!supplied) return false
  return await sha256Hex(supplied) === await sha256Hex(env('WORKER_CRON_SECRET'))
}

type Admin = ReturnType<typeof adminClient>
type Severity = 'info' | 'warning' | 'critical'

const driveReadonlyScope = 'https://www.googleapis.com/auth/drive.readonly'
const hourMs = 3_600_000
const dayMs = 86_400_000

function todayKey() {
  return new Date().toISOString().slice(0, 10)
}

function daysUntilDate(value: string) {
  const today = new Date()
  today.setUTCHours(12, 0, 0, 0)
  const target = new Date(`${value.slice(0, 10)}T12:00:00.000Z`)
  return Math.ceil((target.getTime() - today.getTime()) / dayMs)
}

function ageHours(value: string | null | undefined) {
  if (!value) return Number.POSITIVE_INFINITY
  const time = new Date(value).getTime()
  if (!Number.isFinite(time)) return Number.POSITIVE_INFINITY
  return (Date.now() - time) / hourMs
}

function limited(text: string, maximum = 420) {
  return text.replace(/\s+/g, ' ').trim().slice(0, maximum)
}

async function ensureNotification(admin: Admin, input: { body: string; severity: Severity; sourceRef: string; title: string; userId: string }) {
  const { data: existing, error: lookupError } = await admin
    .from('notifications')
    .select('id')
    .eq('user_id', input.userId)
    .eq('source_url', input.sourceRef)
    .limit(1)
  if (lookupError) throw new Error('notification_lookup_failed')
  if ((existing ?? []).length > 0) return false

  const { error } = await admin.from('notifications').insert({
    body: limited(input.body),
    severity: input.severity,
    source_url: input.sourceRef,
    title: limited(input.title, 160),
    user_id: input.userId,
  })
  if (error) throw new Error('notification_insert_failed')
  return true
}

async function countRows(admin: Admin, table: string, filters: (query: ReturnType<Admin['from']>) => unknown) {
  const base = admin.from(table).select('id', { count: 'exact', head: true })
  const result = await filters(base) as { count: number | null; error: unknown }
  if (result.error) throw new Error(`${table}_count_failed`)
  return result.count ?? 0
}

async function latestSourceSnapshot(admin: Admin) {
  const { data, error } = await admin
    .from('source_snapshots')
    .select('fetched_at')
    .order('fetched_at', { ascending: false })
    .limit(1)
  if (error) throw new Error('source_snapshot_query_failed')
  return (data ?? [])[0]?.fetched_at as string | null | undefined
}

async function baselineLifeRights(admin: Admin, userId: string) {
  const items = [
    {
      body: 'Hamilelik/doğum sürecinde doğum bildirimi, kinderbijslag, çocuk sağlık sigortası, kraamzorg/verloskundige ve consultatiebureau adımları ayrı takip edilmeli. DigiD işlemleri manuel kalır; dashboard sadece hatırlatır.',
      severity: 'warning' as const,
      sourceRef: 'radar://baseline/pregnancy-child-rights-v1',
      title: 'Hamilelik ve çocuk hakları checklist’i',
    },
    {
      body: 'Gelir, çalışma durumu, çocuk, ev veya aile yapısı değişince toeslagen geri ödeme riski doğabilir. Proefberekening ve wijzigingen doorgeven sayfaları düzenli kontrol edilmeli.',
      severity: 'warning' as const,
      sourceRef: 'radar://baseline/toeslagen-change-risk-v1',
      title: 'Toeslagen geri ödeme riskini azalt',
    },
    {
      body: 'Kennismigrant dosyasında erkend referent, gelir/normbedrag, sözleşme, maaş bordrosu, karar tarihi ve itiraz süresi birlikte izlenmeli. Hukuki yorum avukatla doğrulanmadan aksiyon alınmaz.',
      severity: 'critical' as const,
      sourceRef: 'radar://baseline/ind-kennismigrant-shield-v1',
      title: 'IND dosyası koruma kontrolü',
    },
    {
      body: 'CJIB cezalarında itiraz ve ödeme planı aynı strateji değildir. İtiraz düşünülüyorsa önce resmi sayfadaki sürelere ve “ödeme planı isteme” etkisine bakılmalı.',
      severity: 'warning' as const,
      sourceRef: 'radar://baseline/cjib-appeal-payment-v1',
      title: 'Ceza/itiraz/ödeme planı ayrımı',
    },
    {
      body: 'Kira ve servicekosten için Huurcommissie araçları ileride gereksiz ödeme riskini azaltabilir. Özellikle yıllık servicekosten afrekening ve kira puan kontrolü saklanmalı.',
      severity: 'info' as const,
      sourceRef: 'radar://baseline/rent-servicecost-check-v1',
      title: 'Kira ve servicekosten kontrol hakkı',
    },
  ]

  let created = 0
  for (const item of items) {
    created += Number(await ensureNotification(admin, { ...item, userId }))
  }
  return created
}

async function inspectUser(admin: Admin, userId: string) {
  const dateKey = todayKey()
  let created = 0
  created += await baselineLifeRights(admin, userId)

  const { data: accounts, error: accountError } = await admin
    .from('email_accounts')
    .select('id,email,status,scopes,last_sync_at,last_error_code')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
  if (accountError) throw new Error('accounts_query_failed')

  if ((accounts ?? []).length === 0) {
    created += Number(await ensureNotification(admin, {
      body: 'Henüz bağlı Gmail hesabı yok. Ceza, IND, belediye, vergi ve ödeme sinyalleri otomatik yakalanamaz.',
      severity: 'warning',
      sourceRef: `radar://accounts/missing/${dateKey}`,
      title: 'Gmail bağlantısı eksik',
      userId,
    }))
  }

  for (const account of accounts ?? []) {
    const syncAge = ageHours(account.last_sync_at)
    if (account.status !== 'connected') {
      created += Number(await ensureNotification(admin, {
        body: `${account.email} hesabı ${account.status} durumunda. Yeni resmi yazışmalar kaçabilir; Ayarlar’dan yeniden yetkilendirin.`,
        severity: 'critical',
        sourceRef: `radar://account/${account.id}/status/${dateKey}`,
        title: 'Mail hesabı yeniden dikkat istiyor',
        userId,
      }))
    } else if (syncAge > 3) {
      created += Number(await ensureNotification(admin, {
        body: `${account.email} hesabı ${Math.round(syncAge)} saattir taranmamış görünüyor. Gmail worker veya Google izinleri kontrol edilmeli.`,
        severity: 'warning',
        sourceRef: `radar://account/${account.id}/stale-sync/${dateKey}`,
        title: 'Gmail taraması gecikti',
        userId,
      }))
    }

    if (Array.isArray(account.scopes) && account.scopes.includes(driveReadonlyScope)) {
      const { data: latestFiles, error: fileError } = await admin
        .from('provider_files')
        .select('last_seen_at')
        .eq('account_id', account.id)
        .order('last_seen_at', { ascending: false })
        .limit(1)
      if (fileError) throw new Error('provider_files_query_failed')
      const fileAge = ageHours((latestFiles ?? [])[0]?.last_seen_at)
      if (fileAge === Number.POSITIVE_INFINITY) {
        created += Number(await ensureNotification(admin, {
          body: `${account.email} için Drive izni var ama henüz dosya metadata kaydı oluşmadı. Drive worker sonucu ve Google Drive erişimi kontrol edilmeli.`,
          severity: 'warning',
          sourceRef: `radar://drive/${account.id}/empty/${dateKey}`,
          title: 'Drive dosya kasası boş',
          userId,
        }))
      } else if (fileAge > 6) {
        created += Number(await ensureNotification(admin, {
          body: `${account.email} Drive metadata taraması ${Math.round(fileAge)} saattir yenilenmemiş. Evrak takibi eksik kalabilir.`,
          severity: 'warning',
          sourceRef: `radar://drive/${account.id}/stale/${dateKey}`,
          title: 'Drive taraması gecikti',
          userId,
        }))
      }
    }
  }

  const queuedMessages = await countRows(admin, 'email_messages', (query) => query.eq('user_id', userId).in('processing_status', ['queued', 'processing']))
  if (queuedMessages > 0) {
    created += Number(await ensureNotification(admin, {
      body: `${queuedMessages} Gmail kaydı hâlâ kuyrukta/işleniyor. Borç, süre veya kurum sinyali üretimi gecikebilir.`,
      severity: 'warning',
      sourceRef: `radar://gmail/queued/${dateKey}`,
      title: 'Gmail işleme kuyruğu bekliyor',
      userId,
    }))
  }

  const reviewMessages = await countRows(admin, 'email_messages', (query) => query.eq('user_id', userId).eq('processing_status', 'review_required'))
  if (reviewMessages > 0) {
    created += Number(await ensureNotification(admin, {
      body: `${reviewMessages} Gmail kaydı inceleme istiyor. Bunlar resmi yazı, ceza, ödeme veya IND sinyali olabilir; Gelen Kutusu ve Yaşam Radar’dan kontrol edin.`,
      severity: 'warning',
      sourceRef: `radar://gmail/review-required/${dateKey}`,
      title: 'İnceleme bekleyen Gmail kayıtları var',
      userId,
    }))
  }

  const reviewFiles = await countRows(admin, 'provider_files', (query) => query.eq('user_id', userId).eq('status', 'review_required'))
  if (reviewFiles > 0) {
    created += Number(await ensureNotification(admin, {
      body: `${reviewFiles} Drive dosyası isim/metadata seviyesinde önemli görünüyor. Evrak Kasası’nda IND, ceza, vergi, sağlık veya belediye belgelerini kontrol edin.`,
      severity: 'warning',
      sourceRef: `radar://drive/review-required/${dateKey}`,
      title: 'İnceleme bekleyen Drive dosyaları var',
      userId,
    }))
  }

  const { data: obligations, error: obligationsError } = await admin
    .from('obligations')
    .select('id,title,authority,due_date,status,amount,currency')
    .eq('user_id', userId)
    .in('status', ['open', 'overdue', 'disputed'])
    .not('due_date', 'is', null)
    .order('due_date', { ascending: true })
    .limit(50)
  if (obligationsError) throw new Error('obligations_query_failed')
  for (const obligation of obligations ?? []) {
    const days = daysUntilDate(obligation.due_date)
    if (days < 0) {
      created += Number(await ensureNotification(admin, {
        body: `${obligation.authority} kaydı ${Math.abs(days)} gün geçmiş görünüyor. Tutar/ödeme kanalı resmi belgeyle doğrulanmadan ödeme yapılmamalı; gerekiyorsa itiraz veya ödeme planı kontrol edilmeli.`,
        severity: 'critical',
        sourceRef: `radar://obligation/${obligation.id}/overdue/${dateKey}`,
        title: `Geçmiş ödeme/süre: ${obligation.title}`,
        userId,
      }))
    } else if (days <= 14) {
      created += Number(await ensureNotification(admin, {
        body: `${obligation.authority} için ${days === 0 ? 'bugün' : `${days} gün içinde`} aksiyon gerekebilir. Resmi belge, tutar ve son tarih doğrulanmadan işlem yapılmaz.`,
        severity: days <= 3 ? 'critical' : 'warning',
        sourceRef: `radar://obligation/${obligation.id}/due/${dateKey}`,
        title: `Yaklaşan ödeme/süre: ${obligation.title}`,
        userId,
      }))
    }
  }

  const { data: deadlines, error: deadlineError } = await admin
    .from('deadlines')
    .select('id,title,owner,due_at,status')
    .eq('user_id', userId)
    .in('status', ['open', 'waiting'])
    .order('due_at', { ascending: true })
    .limit(50)
  if (deadlineError) throw new Error('deadlines_query_failed')
  for (const deadline of deadlines ?? []) {
    const days = daysUntilDate(deadline.due_at)
    if (days < 0) {
      created += Number(await ensureNotification(admin, {
        body: `${deadline.owner} için kayıtlı son tarih ${Math.abs(days)} gün geçmiş. Avukat/resmi kurumla aksiyon durumu doğrulanmalı.`,
        severity: 'critical',
        sourceRef: `radar://deadline/${deadline.id}/overdue/${dateKey}`,
        title: `Geçmiş son tarih: ${deadline.title}`,
        userId,
      }))
    } else if (days <= 14) {
      created += Number(await ensureNotification(admin, {
        body: `${deadline.owner} için ${days === 0 ? 'bugün' : `${days} gün içinde`} son tarih var. Belge paketi ve gönderim kanıtı hazır mı kontrol edin.`,
        severity: days <= 3 ? 'critical' : 'warning',
        sourceRef: `radar://deadline/${deadline.id}/due/${dateKey}`,
        title: `Yaklaşan son tarih: ${deadline.title}`,
        userId,
      }))
    }
  }

  const snapshotAge = ageHours(await latestSourceSnapshot(admin))
  if (snapshotAge > 18) {
    created += Number(await ensureNotification(admin, {
      body: `Resmi kaynak taraması ${Math.round(snapshotAge)} saattir güncellenmemiş. IND, CJIB, UWV, SVB, Belastingdienst ve belediye kaynak değişiklikleri gecikebilir.`,
      severity: 'warning',
      sourceRef: `radar://sources/stale/${dateKey}`,
      title: 'Resmi kaynak taraması gecikti',
      userId,
    }))
  }

  await admin.from('audit_events').insert({
    actor: 'worker',
    event_type: 'life_watchdog_completed',
    metadata: { created },
    object_type: 'profile',
    object_id: userId,
    user_id: userId,
  })
  return { created, userId }
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' })
  if (!await workerAuthorized(request)) return json({ error: 'unauthorized' }, 401)

  const admin = adminClient()
  const { data: profiles, error } = await admin.from('profiles').select('id').order('created_at', { ascending: true }).limit(50)
  if (error) return json({ error: 'profiles_query_failed' }, 500)

  const results = []
  for (const profile of profiles ?? []) {
    try {
      results.push(await inspectUser(admin, profile.id))
    } catch (error) {
      const code = error instanceof Error ? error.message : 'life_watchdog_failed'
      await admin.from('audit_events').insert({
        actor: 'worker',
        event_type: 'life_watchdog_failed',
        metadata: { code },
        object_type: 'profile',
        object_id: profile.id,
        user_id: profile.id,
      })
      results.push({ code, created: 0, status: 'failed', userId: profile.id })
    }
  }

  return json({ completedAt: new Date().toISOString(), users: results })
})
