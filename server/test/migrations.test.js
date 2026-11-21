import { beforeEach, describe, expect, it } from 'vitest'

import { migrate, BOOTSTRAP, LATEST_VERSION } from '../src/store/schema.js'
import { SqliteStore } from './helpers/sqlite-store.js'

describe('rqlite migrations', () => {
  let store

  beforeEach(() => {
    store = new SqliteStore()
  })

  it('creates the desktop-compatible schema on an empty store', async () => {
    const version = await migrate(store, { info() {} })

    expect(version).toBe(0)
    expect(Number(await store.queryScalar('SELECT val FROM context WHERE key = ?', ['db_version']))).toBe(
      LATEST_VERSION
    )

    const tables = await store.query(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    const names = tables.map((row) => row.name)
    expect(names).toEqual(expect.arrayContaining(['context', 'f2f_model', 'video', 'voice', 'audition']))

    const videoColumns = (await store.query('PRAGMA table_info(video)')).map((row) => row.name)
    expect(videoColumns).toEqual(expect.arrayContaining(['claimed_by', 'claimed_at', 'voice_id', 'duration']))

    const auditionColumns = (await store.query('PRAGMA table_info(audition)')).map((row) => row.name)
    expect(auditionColumns).toEqual(expect.arrayContaining(['voice_id', 'text', 'status', 'file_path', 'claimed_by', 'claimed_at']))
  })

  it('is idempotent when the schema is already current', async () => {
    await migrate(store, { info() {} })
    const before = await store.query('SELECT * FROM context ORDER BY id')

    await expect(migrate(store, { info() {} })).resolves.toBe(LATEST_VERSION)

    const after = await store.query('SELECT * FROM context ORDER BY id')
    expect(after).toEqual(before)
  })

  it('seeds db_version only once', () => {
    expect(BOOTSTRAP.join(' ')).toContain('INSERT INTO context')
  })
})