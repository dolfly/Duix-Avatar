import { afterEach, describe, expect, it, vi } from 'vitest'

import { RqliteClient, RqliteError, toBatch, toStatement } from '../src/store/rqlite.js'

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }

describe('rqlite statement encoding', () => {
  it('appends bound parameters in order', () => {
    expect(toStatement('SELECT * FROM t WHERE id = ?', [7])).toEqual(['SELECT * FROM t WHERE id = ?', 7])
  })

  it('normalises javascript values to sqlite-friendly ones', () => {
    expect(toStatement('INSERT INTO t VALUES (?, ?, ?, ?)', [true, false, undefined, { a: 1 }])).toEqual([
      'INSERT INTO t VALUES (?, ?, ?, ?)',
      1,
      0,
      null,
      '{"a":1}'
    ])
  })

  it('supports batched statements', () => {
    expect(toBatch([['UPDATE t SET a = ?', [1]], 'DELETE FROM t'])).toEqual([
      ['UPDATE t SET a = ?', 1],
      ['DELETE FROM t']
    ])
  })
})

describe('RqliteClient', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('maps rqlite query results to row objects', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        results: [{ columns: ['id', 'name'], types: ['integer', 'text'], values: [[1, 'a'], [2, 'b']] }]
      })
    )

    const client = new RqliteClient({ url: 'http://rqlite:4001', fetchImpl, logger: silentLogger })
    const rows = await client.query('SELECT id, name FROM t')

    expect(rows).toEqual([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' }
    ])
    const [url, options] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://rqlite:4001/db/query')
    // rqlite 8 reads the body as an array of statements: [[sql, ...params], ...].
    expect(JSON.parse(options.body)).toEqual([['SELECT id, name FROM t']])
  })

  it('posts bound parameters as a single nested statement', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [{ columns: ['val'], values: [['zh']] }] }))
    const client = new RqliteClient({ url: 'http://rqlite:4001', fetchImpl, logger: silentLogger })

    await expect(client.queryScalar('SELECT val FROM context WHERE key = ?', ['lang'])).resolves.toBe('zh')

    // A flat [sql, param] body is parsed by rqlite as three statements and fails with
    // "not enough args to execute query"; this guards against regressing to it.
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual([
      ['SELECT val FROM context WHERE key = ?', 'lang']
    ])
  })

  it('exposes last insert id and affected rows', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [{ last_insert_id: 42, rows_affected: 1 }] }))
    const client = new RqliteClient({ fetchImpl, logger: silentLogger })

    await expect(client.execute('INSERT INTO t (a) VALUES (?)', [1])).resolves.toEqual({
      lastInsertId: 42,
      rowsAffected: 1
    })
  })

  it('retries transient failures for idempotent reads', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('down'), { cause: { code: 'ECONNREFUSED' } }))
      .mockResolvedValueOnce(jsonResponse({ results: [{ columns: ['n'], values: [[1]] }] }))

    const client = new RqliteClient({ fetchImpl, logger: silentLogger, retry: 2 })
    await expect(client.queryScalar('SELECT COUNT(*) AS n FROM t')).resolves.toBe(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not retry client errors', async () => {
    const fetchImpl = vi.fn(async () => new Response('near "SELEC" syntax error', { status: 400 }))
    const client = new RqliteClient({ fetchImpl, logger: silentLogger, retry: 3 })

    await expect(client.query('SELEC 1')).rejects.toBeInstanceOf(RqliteError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('surfaces the body of an error response', async () => {
    const fetchImpl = vi.fn(async () => new Response('store is not ready', { status: 503 }))
    const client = new RqliteClient({ fetchImpl, logger: silentLogger, retry: 0 })

    await expect(client.ping()).rejects.toMatchObject({ status: 503, body: 'store is not ready' })
  })

  it('returns an empty list when rqlite reports no result set', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}))
    const client = new RqliteClient({ fetchImpl, logger: silentLogger })

    await expect(client.query('SELECT 1')).resolves.toEqual([])
  })
})