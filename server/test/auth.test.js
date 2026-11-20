import { describe, expect, it } from 'vitest'

import { createAuthService, createSessionStore, generateToken, hashPassword, verifyPassword } from '../src/auth.js'

describe('password hashing', () => {
  it('round-trips a password', () => {
    const stored = hashPassword('s3cret')
    expect(stored).toMatch(/^scrypt\$/)
    expect(verifyPassword('s3cret', stored)).toBe(true)
  })

  it('rejects a wrong password', () => {
    const stored = hashPassword('s3cret')
    expect(verifyPassword('wrong', stored)).toBe(false)
  })

  it('rejects empty and malformed stored hashes without throwing', () => {
    expect(verifyPassword('x', '')).toBe(false)
    expect(verifyPassword('x', 'not-a-hash')).toBe(false)
    expect(verifyPassword('x', 'scrypt$1$2$3$zz$yy')).toBe(false)
    expect(verifyPassword('x', 'scrypt$16384$8$1$00$00')).toBe(false)
  })

  it('uses a fresh salt for every call', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'))
  })
})

describe('session store', () => {
  it('creates, reads and revokes tokens', () => {
    const store = createSessionStore()
    const token = store.create('admin')
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(store.get(token)).toMatchObject({ username: 'admin' })
    store.revoke(token)
    expect(store.get(token)).toBeNull()
  })

  it('expires tokens after the ttl', () => {
    let now = 0
    const store = createSessionStore({ ttlMs: 1000, now: () => now })
    const token = store.create('admin')

    now = 999
    expect(store.get(token)).not.toBeNull()

    now = 1001
    expect(store.get(token)).toBeNull()
  })
})

describe('auth service', () => {
  const service = createAuthService({ username: 'admin', passwordHash: hashPassword('s3cret') })

  it('issues a verifiable token for correct credentials', () => {
    const token = service.login('admin', 's3cret')
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(service.verify(token)).toMatchObject({ username: 'admin' })
  })

  it('returns null for a wrong password and a wrong username alike', () => {
    expect(service.login('admin', 'nope')).toBeNull()
    expect(service.login('nobody', 's3cret')).toBeNull()
    expect(service.login('nobody', 'nope')).toBeNull()
  })

  it('rejects unknown and revoked tokens', () => {
    expect(service.verify(generateToken())).toBeNull()
    expect(service.verify('')).toBeNull()

    const token = service.login('admin', 's3cret')
    service.revoke(token)
    expect(service.verify(token)).toBeNull()
  })
})
