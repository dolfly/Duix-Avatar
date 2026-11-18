/**
 * Thin rqlite HTTP client.
 *
 * rqlite speaks the SQLite wire protocol over HTTP and is the metadata store for the
 * web deployment (replaces the desktop app's embedded better-sqlite3 file). Only the
 * primitives this service needs are implemented:
 *
 *   query(sql, params)        -> rows[]                (POST /db/query)
 *   execute(sql, params)      -> { lastInsertId, rowsAffected }
 *   executeBatch(statements)  -> results[]              (single rqlite transaction)
 *
 * Every statement is bound with `?` placeholders; no SQL string interpolation.
 */

const RETRYABLE_STATUS = new Set([429, 502, 503, 504])
const RETRYABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EAI_AGAIN'
])

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function encodeParam(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') return value
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** rqlite expects a single statement plus params, or an array of such arrays. */
export function toStatement(sql, params = []) {
  const bound = (Array.isArray(params) ? params : [params]).map(encodeParam)
  return [sql, ...bound]
}

export function toBatch(statements) {
  return statements.map((entry) =>
    Array.isArray(entry) ? toStatement(entry[0], entry[1] || []) : toStatement(entry, [])
  )
}

export class RqliteError extends Error {
  constructor(message, { status = 0, body = '', url = '' } = {}) {
    super(message)
    this.name = 'RqliteError'
    this.status = status
    this.body = body
    this.url = url
  }
}

export class RqliteClient {
  constructor({
    url = 'http://127.0.0.1:4001',
    level = 'weak',
    timeoutMs = 15000,
    retry = 3,
    fetchImpl,
    logger
  } = {}) {
    if (!fetchImpl) {
      throw new Error('RqliteClient requires a fetch implementation')
    }
    this.baseUrl = url.replace(/\/+$/, '')
    this.level = level
    this.timeoutMs = timeoutMs
    this.retry = Math.max(0, retry)
    this.fetch = fetchImpl
    this.log = logger
  }

  async request(pathname, { method = 'GET', body, retryNonIdempotent = true } = {}) {
    const url = `${this.baseUrl}${pathname}`
    const attempts = this.retry + 1
    let lastError

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await this.fetch(url, {
          method,
          headers: body === undefined ? undefined : { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: timeoutSignal(this.timeoutMs)
        })

        const text = await response.text()
        if (!response.ok) {
          const retryable = RETRYABLE_STATUS.has(response.status)
          if (retryable && attempt < attempts) {
            await sleep(backoffMs(attempt))
            continue
          }
          throw new RqliteError(`rqlite ${pathname} failed: HTTP ${response.status}`, {
            status: response.status,
            body: text,
            url
          })
        }
        return text ? JSON.parse(text) : {}
      } catch (error) {
        if (error instanceof RqliteError) throw error

        const code = error?.cause?.code || error?.code
        const retryable = RETRYABLE_CODES.has(code) || error?.name === 'TimeoutError' || error?.name === 'AbortError'
        // Non-idempotent writes are only retried when the request never reached rqlite.
        const mayRetry = retryNonIdempotent || method === 'GET'
        lastError = error
        if (mayRetry && retryable && attempt < attempts) {
          this.log?.debug?.(`rqlite ${pathname} attempt ${attempt} failed (${code || error?.name}), retrying`)
          await sleep(backoffMs(attempt))
          continue
        }
        break
      }
    }

    throw new RqliteError(`rqlite ${pathname} unreachable: ${lastError?.message || lastError}`, {
      body: String(lastError?.code || ''),
      url
    })
  }

  /**
   * Run one or more statements as a single rqlite transaction.
   * @param {Array<string|Array>} statements
   */
  async executeBatch(statements) {
    const payload = toBatch(statements)
    const data = await this.request('/db/execute', { method: 'POST', body: payload })
    return (data.results || []).map((result) => ({
      lastInsertId: toNumber(result.last_insert_id),
      rowsAffected: toNumber(result.rows_affected),
      time: result.time
    }))
  }

  /**
   * Execute a single statement.
   * @returns {Promise<{lastInsertId: number, rowsAffected: number}>}
   */
  async execute(sql, params = []) {
    const [result] = await this.executeBatch([[sql, params]])
    return result || { lastInsertId: 0, rowsAffected: 0 }
  }

  /**
   * Run a query and return rows as plain objects.
   * @returns {Promise<Array<Record<string, any>>>}
   */
  async query(sql, params = []) {
    // rqlite takes an array of statements in the body; a statement is `[sql, ...params]`.
    // A flat `[sql, ...params]` array is read as *several* statements by rqlite 8 and
    // fails with "not enough args to execute query".
    const data = await this.request('/db/query', { method: 'POST', body: [toStatement(sql, params)] })
    return (data.results || []).flatMap((result) => rowsFromResult(result))
  }

  /** First row of a query, or undefined. */
  async queryOne(sql, params = []) {
    const rows = await this.query(sql, params)
    return rows[0]
  }

  /** Single scalar value of a query, or undefined. */
  async queryScalar(sql, params = []) {
    const row = await this.queryOne(sql, params)
    if (!row) return undefined
    const values = Object.values(row)
    return values[0]
  }

  /** Health probe used by /api/health. */
  async ping() {
    await this.request('/status?level=none')
    return true
  }
}

function rowsFromResult(result) {
  const columns = result?.columns || []
  const values = result?.values || []
  return values.map((row) => {
    const record = {}
    columns.forEach((column, index) => {
      record[column] = row[index] === undefined ? null : row[index]
    })
    return record
  })
}

function toNumber(value) {
  if (value === undefined || value === null) return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function backoffMs(attempt) {
  return Math.min(50 * 2 ** (attempt - 1), 1000)
}

function timeoutSignal(timeoutMs) {
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return undefined
  return AbortSignal.timeout(timeoutMs)
}

export default RqliteClient