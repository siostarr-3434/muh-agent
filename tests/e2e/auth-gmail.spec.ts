import { expect, test, type Page } from '@playwright/test'

const emptyDashboard = {
  accounts: [],
  approvals: [],
  calendarConnections: [],
  calendarEventLinks: [],
  counts: { documents: 0, messages: 0 },
  deadlines: [],
  files: [],
  knowledgeItems: [],
  messages: [],
  notifications: [],
  obligations: [],
  sourceSnapshots: [],
  sources: [],
}

async function mockSession(page: Page, authenticated: boolean, dashboard: Record<string, unknown> = emptyDashboard) {
  await page.route('**/api/session', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      authenticated,
      email: authenticated ? 'user@example.com' : null,
      mode: 'live',
    }),
  }))

  if (authenticated) {
    await page.route('**/api/dashboard', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(dashboard),
    }))
  }
}

test('opens the dashboard without sending a login email', async ({ page }) => {
  let passwordSignInRequests = 0
  let passwordRecoveryRequests = 0
  await page.route('**/api/auth/sign-in', (route) => {
    passwordSignInRequests += 1
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ signedIn: true }) })
  })
  await page.route('**/api/auth/recover-password', (route) => {
    passwordRecoveryRequests += 1
    return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ accepted: true }) })
  })
  await mockSession(page, false)

  await page.goto('/')

  await expect(page.getByTestId('dashboard-shell')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Genel Bakış', exact: true })).toBeVisible()
  await expect(page.getByTestId('login-panel')).toHaveCount(0)
  expect(passwordSignInRequests).toBe(0)

  await page.getByTestId('open-login').click()
  const loginPanel = page.getByTestId('login-panel')
  await expect(loginPanel).toBeVisible()
  await expect(loginPanel.getByLabel('E-posta adresi')).toBeVisible()
  await expect(loginPanel.getByLabel('Şifre')).toBeVisible()
  await expect(loginPanel.getByText('e-posta veya kod gönderilmez')).toBeVisible()
  expect(passwordSignInRequests).toBe(0)
  expect(passwordRecoveryRequests).toBe(0)
})

test('signs in with password only after an explicit dashboard form submit', async ({ page }) => {
  let passwordSignInRequests = 0
  await page.route('**/api/auth/sign-in', async (route) => {
    passwordSignInRequests += 1
    const body = route.request().postDataJSON() as { email?: string; password?: string }
    expect(body).toEqual({ email: 'user@example.com', password: 'correcthorsebattery' })
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ signedIn: true }) })
  })
  await mockSession(page, false)

  await page.goto('/')
  await page.getByTestId('open-login').click()
  const loginPanel = page.getByTestId('login-panel')
  await loginPanel.getByLabel('E-posta adresi').fill('user@example.com')
  await loginPanel.getByLabel('Şifre').fill('correcthorsebattery')
  await Promise.all([
    page.waitForRequest((request) => request.url().includes('/api/auth/sign-in') && request.method() === 'POST'),
    loginPanel.getByRole('button', { name: 'Giriş yap' }).click(),
  ])
  expect(passwordSignInRequests).toBe(1)
})

test('requests a legacy password setup link only after explicit click', async ({ page }) => {
  let passwordRecoveryRequests = 0
  await page.route('**/api/auth/recover-password', async (route) => {
    passwordRecoveryRequests += 1
    const body = route.request().postDataJSON() as { email?: string }
    expect(body).toEqual({ email: 'siostarr@hairartclinics.com' })
    return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ accepted: true }) })
  })
  await mockSession(page, false)

  await page.goto('/')
  await page.getByTestId('open-login').click()
  const loginPanel = page.getByTestId('login-panel')
  await loginPanel.getByLabel('E-posta adresi').fill('siostarr@hairartclinics.com')
  await Promise.all([
    page.waitForRequest((request) => request.url().includes('/api/auth/recover-password') && request.method() === 'POST'),
    loginPanel.getByRole('button', { name: 'İlk şifre bağlantısı gönder' }).click(),
  ])

  await expect(loginPanel.getByRole('status')).toContainText('şifre belirleme bağlantısı gönderildi')
  expect(passwordRecoveryRequests).toBe(1)
})

test('asks for dashboard login before starting Gmail OAuth', async ({ page }) => {
  let gmailConnectRequests = 0
  await page.route('**/api/gmail/connect', (route) => {
    gmailConnectRequests += 1
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authorizationUrl: 'https://accounts.google.com/' }) })
  })
  await mockSession(page, false)

  await page.goto('/')
  await page.getByTestId('nav-settings').click()
  await page.getByRole('button', { name: 'Gmail hesabı bağla' }).click()

  await expect(page.getByTestId('login-panel')).toBeVisible()
  await expect(page.getByRole('status')).toContainText('önce dashboarddan oturum aç')
  expect(gmailConnectRequests).toBe(0)
})

test('explains a Gmail OAuth configuration failure', async ({ page }) => {
  await mockSession(page, true)
  await page.route('**/api/gmail/connect', (route) => route.fulfill({
    status: 502,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'oauth_not_configured' }),
  }))

  await page.goto('/')
  await page.getByTestId('nav-settings').click()
  await page.getByRole('button', { name: 'Gmail hesabı bağla' }).click()

  await expect(page.getByRole('status')).toContainText('Google OAuth ayarları')
})

test('requests Drive scope only after the explicit Drive connect click', async ({ page }) => {
  let connectBody: { includeDrive?: boolean } | undefined
  await mockSession(page, true)
  await page.route('**/api/gmail/connect', async (route) => {
    connectBody = route.request().postDataJSON() as { includeDrive?: boolean }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test' }) })
  })
  await page.route('https://accounts.google.com/**', (route) => route.fulfill({ status: 200, body: 'ok' }))

  await page.goto('/')
  await page.getByTestId('nav-settings').click()
  await Promise.all([
    page.waitForRequest((request) => request.url().includes('/api/gmail/connect') && request.method() === 'POST'),
    page.getByRole('button', { name: 'Gmail + Drive bağla' }).click(),
  ])

  expect(connectBody).toEqual({ includeDrive: true })
})

test('starts incremental Google Calendar authorization for the preferred Gmail account', async ({ page }) => {
  const accountId = '11111111-1111-4111-8111-111111111111'
  let connectBody: { accountId?: string } | undefined
  await mockSession(page, true, {
    ...emptyDashboard,
    accounts: [{ email: 'siostarr@hairartclinics.com', id: accountId, last_sync_at: null, provider: 'gmail', scopes: [], status: 'connected' }],
  })
  await page.route('**/api/calendar/connect', async (route) => {
    connectBody = route.request().postDataJSON() as { accountId?: string }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test-calendar' }) })
  })
  await page.route('https://accounts.google.com/**', (route) => route.fulfill({ status: 200, body: 'ok' }))

  await page.goto('/')
  await page.getByTestId('nav-payments').click()
  await expect(page.getByText('Takvim hedefi: siostarr@hairartclinics.com')).toBeVisible()
  await Promise.all([
    page.waitForRequest((request) => request.url().includes('/api/calendar/connect') && request.method() === 'POST'),
    page.getByTestId('calendar-connect').click(),
  ])

  expect(connectBody).toEqual({ accountId })
})

test('never falls back to a different Gmail account for Calendar', async ({ page }) => {
  let connectRequests = 0
  await mockSession(page, true, {
    ...emptyDashboard,
    accounts: [{ email: 'other@example.com', id: '33333333-3333-4333-8333-333333333333', last_sync_at: null, provider: 'gmail', scopes: [], status: 'connected' }],
  })
  await page.route('**/api/calendar/connect', (route) => {
    connectRequests += 1
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authorizationUrl: 'https://accounts.google.com/' }) })
  })

  await page.goto('/')
  await page.getByTestId('nav-payments').click()
  await page.getByTestId('calendar-connect').click()

  await expect(page.getByRole('status')).toContainText('Takvim hedefi siostarr@hairartclinics.com')
  expect(connectRequests).toBe(0)
})

test('creates a real Calendar event request for one payment record', async ({ page }) => {
  const accountId = '11111111-1111-4111-8111-111111111111'
  const obligationId = '22222222-2222-4222-8222-222222222222'
  let syncBody: { accountId?: string; sourceId?: string; sourceType?: string } | undefined
  await mockSession(page, true, {
    ...emptyDashboard,
    accounts: [{ email: 'siostarr@hairartclinics.com', id: accountId, last_sync_at: null, provider: 'gmail', scopes: ['https://www.googleapis.com/auth/calendar.events.owned'], status: 'connected' }],
    calendarConnections: [{ account_id: accountId, auto_sync: true, calendar_id: 'primary', last_error_code: null, last_sync_at: null, reminder_minutes: 2880, status: 'connected' }],
    obligations: [{ amount: 150.75, authority: 'Gemeente Den Haag', category: 'fine', currency: 'EUR', due_date: '2026-08-10', evidence_level: 'verified', id: obligationId, note: 'Parkeerbelasting', payment_guidance: null, source_url: null, status: 'open', title: 'Parkeerbelasting' }],
  })
  await page.route('**/api/calendar/sync', async (route) => {
    syncBody = route.request().postDataJSON() as { accountId?: string; sourceId?: string; sourceType?: string }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ artifacts: [], completedAt: '2026-08-01T09:00:00.000Z', status: 'success', summary: '1 etkinlik oluşturuldu', totals: { created: 1, deleted: 0, failed: 0, skipped: 0, updated: 0 } }),
    })
  })

  await page.goto('/')
  await page.getByTestId('nav-payments').click()
  await Promise.all([
    page.waitForRequest((request) => request.url().includes('/api/calendar/sync') && request.method() === 'POST'),
    page.getByTestId(`calendar-add-obligation-${obligationId}`).click(),
  ])

  expect(syncBody).toEqual({ accountId, sourceId: obligationId, sourceType: 'obligation' })
  await expect(page.getByRole('status')).toContainText('Google Takvim eşitlendi')
})

test('saves a manual knowledge item from settings', async ({ page }) => {
  let knowledgeRequests = 0
  await mockSession(page, true)
  await page.route('**/api/knowledge', async (route) => {
    knowledgeRequests += 1
    const body = route.request().postDataJSON() as { title?: string; body?: string; category?: string; sourceUrl?: string }
    expect(body).toEqual({
      body: 'Önce resmi kaynak ve avukat kontrolü gerekiyor.',
      category: 'skill',
      sourceUrl: 'https://ind.nl/',
      title: 'IND belge kontrolü',
    })
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        item: {
          body: body.body,
          category: body.category,
          created_at: '2026-07-22T08:00:00.000Z',
          evidence_level: 'review',
          id: 'knowledge-1',
          source_url: body.sourceUrl,
          title: body.title,
        },
      }),
    })
  })

  await page.goto('/')
  await page.getByTestId('nav-settings').click()
  await page.getByLabel('Başlık').fill('IND belge kontrolü')
  await page.getByLabel('Bilgi / skill').fill('Önce resmi kaynak ve avukat kontrolü gerekiyor.')
  await page.getByLabel('Kaynak URL (opsiyonel)').fill('https://ind.nl/')
  await page.getByRole('button', { name: 'Bilgi bankasına kaydet' }).click()

  await expect(page.getByRole('status')).toContainText('Bilgi bankasına kaydedildi')
  expect(knowledgeRequests).toBe(1)
})

test('lets an authenticated user set a password without email codes', async ({ page }) => {
  let passwordUpdateRequests = 0
  await mockSession(page, true)
  await page.route('**/api/auth/password', (route) => {
    passwordUpdateRequests += 1
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ passwordUpdated: true }) })
  })

  await page.goto('/')
  await page.getByTestId('nav-settings').click()
  await page.getByLabel('Yeni şifre').fill('newstrongpassword')
  await page.getByLabel('Şifre tekrarı').fill('newstrongpassword')
  await page.getByRole('button', { name: 'Şifreyi kaydet' }).click()

  await expect(page.getByText('Şifre kaydedildi. Sonraki girişlerde')).toBeVisible()
  expect(passwordUpdateRequests).toBe(1)
})

test('shows the safe Gmail callback diagnostic code to the user', async ({ page }) => {
  await mockSession(page, true)

  await page.goto('/?view=settings&gmail=failed&gmail_error=google_client_invalid')

  await expect(page.getByRole('status')).toContainText('OAuth istemci kimliği')
})

test('opens settings password panel after recovery callback', async ({ page }) => {
  await mockSession(page, true)

  await page.goto('/?view=settings&password=recovery')

  await expect(page.getByRole('status')).toContainText('Şifre belirleme oturumu açıldı')
  await expect(page.getByRole('heading', { name: 'Oturum şifresi belirle' })).toBeVisible()
})
