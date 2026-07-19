export type ViewId =
  | 'overview'
  | 'inbox'
  | 'payments'
  | 'documents'
  | 'deadlines'
  | 'approvals'
  | 'sources'
  | 'settings'

export type EvidenceLevel = 'verified' | 'review' | 'demo'
export type ObligationStatus = 'open' | 'overdue' | 'paid' | 'disputed'
export type ApprovalStatus = 'pending' | 'approved' | 'rejected'

export interface Obligation {
  id: string
  title: string
  authority: string
  category: 'Ceza' | 'Fatura' | 'Vergi' | 'Sigorta' | 'Diğer'
  amount: number
  currency: 'EUR'
  dueDate: string
  status: ObligationStatus
  evidence: EvidenceLevel
  source: string
  note: string
}

export interface Deadline {
  id: string
  title: string
  owner: string
  date: string
  urgency: 'critical' | 'soon' | 'planned'
  status: 'open' | 'waiting' | 'done'
  evidence: EvidenceLevel
}

export interface ApprovalItem {
  id: string
  title: string
  description: string
  amount?: number
  action: 'payment' | 'send' | 'connect' | 'publish'
  status: ApprovalStatus
  risk: 'high' | 'medium' | 'low'
}

export interface MailAccount {
  id: string
  email: string
  provider: 'Gmail' | 'Outlook' | 'IMAP'
  status: 'not_connected' | 'connected' | 'reauth_required'
  scopes: string[]
  lastSync?: string
}

export interface SourceRecord {
  id: string
  name: string
  domain: string
  purpose: string
  lastChecked: string
  enabled: boolean
  trust: 'official' | 'secondary'
}

export interface Activity {
  id: string
  time: string
  title: string
  detail: string
  kind: 'system' | 'warning' | 'approval' | 'source'
}
