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
  let loginLinkRequests = 0
  await page.route('**/api/auth/request-link', (route) => {
    loginLinkRequests += 1
    return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ accepted: true }) })
  })
  await mockSession(page, false)

  await page.goto('/')

  await expect(page.getByTestId('dashboard-shell')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Genel Bakış', exact: true })).toBeVisible()
  await expect(page.getByTestId('login-panel')).toHaveCount(0)
  expect(loginLinkRequests).toBe(0)

  await page.getByTestId('open-login').click()
  await expect(page.getByTestId('login-panel')).toBeVisible()
  expect(loginLinkRequests).toBe(0)
})

test('sends a login email only after an explicit dashboard form submit', async ({ page }) => {
  let loginLinkRequests = 0
  await page.route('**/api/auth/request-link', (route) => {
    loginLinkRequests += 1
    return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ accepted: true }) })
  })
  await mockSession(page, false)

  await page.goto('/')
  await page.getByTestId('open-login').click()
  await page.getByLabel('E-posta adresi').fill('user@example.com')
  await page.getByRole('button', { name: 'Güvenli bağlantı gönder' }).click()

  await expect(page.getByRole('status')).toContainText('bağlantı gönderildi')
  expect(loginLinkRequests).toBe(1)
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
    body: JSON.stringify({ error: 'gmail_connect_failed' }),
  }))

  await page.goto('/')
  await page.getByTestId('nav-settings').click()
  await page.getByRole('button', { name: 'Gmail hesabı bağla' }).click()

  await expect(page.getByRole('status')).toContainText('Google OAuth yapılandırması')
})
