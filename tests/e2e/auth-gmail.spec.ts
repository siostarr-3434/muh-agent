import { expect, test, type Page } from '@playwright/test'

const emptyDashboard = {
  accounts: [],
  approvals: [],
  counts: { documents: 0, messages: 0 },
  deadlines: [],
  obligations: [],
}

async function mockSession(page: Page, authenticated: boolean) {
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
      body: JSON.stringify(emptyDashboard),
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
