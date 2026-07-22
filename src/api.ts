export interface SessionResponse {
  authenticated: boolean
  email?: string | null
  mode: 'demo' | 'live'
}

export interface DashboardResponse {
  accounts: Array<{
    email: string
    id: string
    label: string | null
    last_error_code: string | null
    last_sync_at: string | null
    provider: string
    scopes: string[]
    status: string
  }>
  approvals: Array<{
    actionType: string
    amount: number | null
    description: string
    expiresAt: string | null
    id: string
    risk: string
    status: string
    title: string
  }>
  counts: { documents: number; messages: number }
  deadlines: Array<{
    due_at: string
    evidence_level: string
    id: string
    owner: string
    source_url: string | null
    status: string
    title: string
  }>
  obligations: Array<{
    amount: number | string | null
    authority: string
    category: string
    currency: string
    due_date: string | null
    evidence_level: string
    id: string
    note: string | null
    source_url: string | null
    status: string
    title: string
  }>
}

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
  })
  const payload = await response.json().catch(() => ({})) as { error?: string } & T
  if (!response.ok) throw new ApiError(response.status, payload.error ?? 'request_failed')
  return payload
}

export function getSession() {
  return request<SessionResponse>('/api/session')
}

export function getDashboard() {
  return request<DashboardResponse>('/api/dashboard')
}

export function signIn(email: string, password: string) {
  return request<{ signedIn: true }>('/api/auth/sign-in', {
    body: JSON.stringify({ email, password }),
    method: 'POST',
  })
}

export function setPassword(password: string) {
  return request<{ passwordUpdated: true }>('/api/auth/password', {
    body: JSON.stringify({ password }),
    method: 'POST',
  })
}

export function decideApproval(id: string, decision: 'approved' | 'rejected') {
  return request<{ approval: { id: string; status: string } }>(`/api/approvals/${encodeURIComponent(id)}/decision`, {
    body: JSON.stringify({ decision }),
    method: 'POST',
  })
}

export function beginGmailConnection(includeDrive = false) {
  return request<{ authorizationUrl: string }>('/api/gmail/connect', {
    body: JSON.stringify({ includeDrive }),
    method: 'POST',
  })
}

export function signOut() {
  return request<{ signedOut: true }>('/api/auth/signout', {
    body: JSON.stringify({}),
    method: 'POST',
  })
}
