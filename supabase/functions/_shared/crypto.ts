const encoder = new TextEncoder()
const decoder = new TextDecoder()

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function base64UrlToBytes(value: string) {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function keyBytes(material: string) {
  const normalized = material.trim()
  const bytes = /^[0-9a-f]{64}$/i.test(normalized)
    ? Uint8Array.from(normalized.match(/.{2}/g)!, (part) => Number.parseInt(part, 16))
    : base64UrlToBytes(normalized)
  if (bytes.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must encode 32 bytes')
  return bytes
}

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function encryptSecret(value: string, material: string) {
  const key = await crypto.subtle.importKey('raw', keyBytes(material), { name: 'AES-GCM' }, false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(value))
  return `${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`
}

export async function decryptSecret(payload: string, material: string) {
  const [ivPart, ciphertextPart] = payload.split('.')
  if (!ivPart || !ciphertextPart) throw new Error('Invalid encrypted secret')
  const key = await crypto.subtle.importKey('raw', keyBytes(material), { name: 'AES-GCM' }, false, ['decrypt'])
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64UrlToBytes(ivPart) }, key, base64UrlToBytes(ciphertextPart))
  return decoder.decode(plaintext)
}

export function randomState() {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))
}
