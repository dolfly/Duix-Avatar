import crypto from 'node:crypto'

/**
 * Web auth primitives: password hashing and opaque bearer tokens.
 *
 * Only the browser deployment reaches this code. The desktop (Electron) client talks
 * to the main process over IPC and never hits the HTTP auth layer, so its local usage
 * is unchanged.
 *
 * No third-party dependencies: password hashing uses node:crypto scrypt, comparisons
 * use timingSafeEqual, and tokens are CSPRNG bytes. Passwords are never stored or
 * compared in plaintext — only the scrypt hash lives in configuration.
 */

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LENGTH = 64
const TOKEN_BYTES = 32
const DEFAULT_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Hash a password for storage. The result carries its own parameters and salt so a
 * future parameter bump still verifies hashes produced by older versions.
 * Format: scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>.
 */
export function hashPassword(password, { N = SCRYPT_N, r = SCRYPT_R, p = SCRYPT_P } = {}) {
  const salt = crypto.randomBytes(16)
  const derived = crypto.scryptSync(String(password), salt, KEY_LENGTH, { N, r, p })
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${derived.toString('hex')}`
}

/**
 * Verify a password against a stored hash in constant time. Returns false (never
 * throws) for malformed stored hashes.
 */
export function verifyPassword(password, stored) {
  try {
    const [scheme, n, r, p, saltHex, hashHex] = String(stored || '').split('$')
    if (scheme !== 'scrypt') return false
    const salt = Buffer.from(saltHex, 'hex')
    const expected = Buffer.from(hashHex, 'hex')
    if (expected.length === 0) return false
    const actual = crypto.scryptSync(String(password), salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p)
    })
    return crypto.timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

export function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex')
}

/**
 * In-memory session store. Sessions are per-process: a server restart logs everyone
 * out, and multiple server replicas do not share sessions. That is fine for the
 * default single duix-server deployment; multi-instance deployments would need a
 * shared store (out of scope).
 */
export function createSessionStore({ ttlMs = DEFAULT_TOKEN_TTL_MS, now = () => Date.now() } = {}) {
  const sessions = new Map()

  return {
    create(username) {
      const token = generateToken()
      sessions.set(token, { username, expiresAt: now() + ttlMs })
      return token
    },
    get(token) {
      const session = token ? sessions.get(token) : undefined
      if (!session) return null
      if (session.expiresAt <= now()) {
        sessions.delete(token)
        return null
      }
      return session
    },
    revoke(token) {
      sessions.delete(token)
    }
  }
}

/**
 * Build the auth service for one configured account.
 *
 * login() returns an opaque token on success and null otherwise. It always runs the
 * scrypt comparison (even for an unknown username) so the response time does not
 * reveal whether the account exists.
 */
export function createAuthService({ username, passwordHash, sessionStore, now = () => Date.now() } = {}) {
  const store = sessionStore || createSessionStore({ now })

  return {
    login(candidateUsername, candidatePassword) {
      const passwordOk = verifyPassword(candidatePassword, passwordHash)
      const usernameOk = candidateUsername === username
      if (!passwordOk || !usernameOk) return null
      return store.create(username)
    },
    verify(token) {
      return store.get(token)
    },
    revoke(token) {
      store.revoke(token)
    }
  }
}

export default createAuthService
