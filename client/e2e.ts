// End-to-end encryption between phones and machines. The relay stores and forwards message bodies
// it can't read or forge; with e2e 2 it sees only routing fields (id, type, machine).
//
// Spec (app/lib/data/services/e2e.dart implements the same):
//   keys      X25519 per device; public keys travel as base64url (no padding) of the raw 32 bytes
//   pair key  HKDF-SHA256(X25519(mine, theirs), salt = empty, info = "perch-e2e-v1"), 32 bytes
//   body      { e2e: 1, from: <sender pub>, to: { <recipient pub>: b64url(nonce12 ‖ ciphertext ‖ tag16) } }
//             plaintext = JSON of the original body, AES-256-GCM
//   aad       "<dir>\n<id>\n<type>\n<session_id or empty>"  (dir = up | down | push): the relay can't move a
//             body to another message, session or direction
//   e2e 2     the same, except plaintext = JSON { session_id, ts, body } and those two fields leave
//             the envelope; aad = "v2\n<dir>\n<id>\n<type>". Each device reports the newest format it
//             reads to the relay (`e2e` in /v1/sync); a sender uses 2 only when every recipient reads it.
import { generateKeyPairSync, diffieHellman, createPublicKey, createPrivateKey, hkdfSync, createCipheriv, createDecipheriv, randomBytes, createHash, createHmac, timingSafeEqual, type KeyObject } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export type Sealed = { e2e: 1 | 2; from: string; to: Record<string, string> }
export type Version = 1 | 2
/** The newest format this build reads. */
export const E2E_VERSION: Version = 2
type Meta = { id: string; type: string; session_id?: string | null; ts?: string }

const E2E_INFO = 'perch-e2e-v1'
const DIRECT_INFO = 'perch-direct-v1'
// up/down: message bodies. push: the short preview a phone's notification shows, sealed apart from
// the body so the relay can't pass one off as the other.
type Dir = 'up' | 'down' | 'push'
const aad = (dir: Dir, m: Meta, v: Version) =>
  Buffer.from(v === 2 ? `v2\n${dir}\n${m.id}\n${m.type}` : `${dir}\n${m.id}\n${m.type}\n${m.session_id ?? ''}`)
export const isPub = (k: unknown): k is string => typeof k === 'string' && /^[A-Za-z0-9_-]{43}$/.test(k)

/** Short form of a public key for comparing by eye: `perch status` and the phone's Settings show it. */
export const fingerprint = (pub: string) =>
  createHash('sha256').update(Buffer.from(pub, 'base64url')).digest('hex').slice(0, 16).match(/..../g)!.join(' ')

export class Keys {
  readonly pub: string
  private priv: KeyObject
  private cache = new Map<string, Buffer>()
  private secrets = new Map<string, Buffer>()
  private direct = new Map<string, Buffer>()

  constructor(jwk: { d: string; x: string }) {
    this.priv = createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', ...jwk }, format: 'jwk' })
    this.pub = jwk.x
  }

  /** The machine's key pair, created on first use. */
  static load(path: string) {
    if (!existsSync(path)) {
      const jwk = generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' })
      writeFileSync(path, JSON.stringify({ d: jwk.d, x: jwk.x }), { mode: 0o600 })
    }
    return new Keys(JSON.parse(readFileSync(path, 'utf8')))
  }

  private shared(peer: string) {
    let s = this.secrets.get(peer)
    if (!s) {
      const theirs = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: peer }, format: 'jwk' })
      s = diffieHellman({ privateKey: this.priv, publicKey: theirs })
      this.secrets.set(peer, s)
    }
    return s
  }

  private derive(peer: string, info: string) {
    return Buffer.from(hkdfSync('sha256', this.shared(peer), Buffer.alloc(0), info, 32))
  }

  private key(peer: string) {
    let k = this.cache.get(peer)
    if (!k) this.cache.set(peer, (k = this.derive(peer, E2E_INFO)))
    return k
  }

  /// The key used to authenticate direct HTTP requests, separate from message encryption.
  directKey(peer: string): Buffer {
    let k = this.direct.get(peer)
    if (!k) this.direct.set(peer, (k = this.derive(peer, DIRECT_INFO)))
    return k
  }

  seal(dir: Dir, m: Meta & { body: unknown }, recipients: string[], v: Version = 1): Sealed {
    const plain = Buffer.from(JSON.stringify(v === 2 ? { session_id: m.session_id ?? null, ts: m.ts ?? null, body: m.body ?? null } : (m.body ?? null)))
    const to: Record<string, string> = {}
    for (const r of recipients.filter(isPub)) {
      const nonce = randomBytes(12)
      const c = createCipheriv('aes-256-gcm', this.key(r), nonce).setAAD(aad(dir, m, v))
      to[r] = Buffer.concat([nonce, c.update(plain), c.final(), c.getAuthTag()]).toString('base64url')
    }
    return { e2e: v, from: this.pub, to }
  }

  /** The body, if it was sealed for us by one of [senders]; otherwise null (unencrypted, forged, or
   *  not for us). An e2e 2 body also returns the session_id and ts sealed with it. */
  open(dir: Dir, m: Meta & { body: any }, senders: string[]): { body: unknown; from: string; meta?: { session_id: string | null; ts?: string } } | null {
    const b = m.body
    const v = b?.e2e
    if ((v !== 1 && v !== 2) || !senders.includes(b.from) || !isPub(b.from) || typeof b.to?.[this.pub] !== 'string') return null
    try {
      const raw = Buffer.from(b.to[this.pub], 'base64url')
      const d = createDecipheriv('aes-256-gcm', this.key(b.from), raw.subarray(0, 12)).setAAD(aad(dir, m, v))
      d.setAuthTag(raw.subarray(raw.length - 16))
      const plain = JSON.parse(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString())
      if (v === 1) return { body: plain, from: b.from }
      const { session_id = null, ts, body } = plain ?? {}
      if (session_id !== null && typeof session_id !== 'string') return null
      return { body, from: b.from, meta: { session_id, ...(typeof ts === 'string' ? { ts } : {}) } }
    } catch {
      return null
    }
  }

  /** The message as sent: its body sealed, and with e2e 2 its session_id and ts moved inside. */
  sealMessage<M extends Meta & { body?: unknown }>(dir: Dir, m: M, recipients: string[], v: Version): any {
    const body = this.seal(dir, m as M & { body: unknown }, recipients, v)
    if (v === 1) return { ...m, body }
    const { session_id: _s, ts: _t, ...envelope } = m
    return { ...envelope, body }
  }

  /** The message as received, with its body opened (and, for e2e 2, its session and time restored). */
  openMessage<M extends Meta & { body: any }>(dir: Dir, m: M, senders: string[]): (M & { body: unknown }) | null {
    const o = this.open(dir, m, senders)
    return o ? { ...m, body: o.body, ...o.meta } : null
  }
}

const bodyHash = (body: string) => createHash('sha256').update(body).digest('hex')

export function directRequestProof(key: Buffer, method: string, path: string, ts: string, nonce: string, body: string): string {
  return createHmac('sha256', key)
    .update(`direct-v1\n${method}\n${path}\n${ts}\n${nonce}\n${bodyHash(body)}`)
    .digest('base64url')
}

export function directResponseProof(key: Buffer, nonce: string, body: string): string {
  return createHmac('sha256', key)
    .update(`direct-v1-response\n${nonce}\n${bodyHash(body)}`)
    .digest('base64url')
}

export function sameProof(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
