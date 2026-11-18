import { createRequire } from 'node:module'

/**
 * Test double for the rqlite HTTP client: same interface, backed by a real SQLite
 * database in-process (node:sqlite). This lets the DAO/service/route/worker tests run
 * real SQL semantics without a rqlite node.
 *
 * node:sqlite is loaded through require() because the bundler used by the test runner
 * does not know this builtin and would otherwise try to resolve a package called
 * "sqlite".
 */
const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')
export class SqliteStore {
  constructor(file = ':memory:') {
    this.db = new DatabaseSync(file)
  }

  async query(sql, params = []) {
    const rows = this.db.prepare(sql).all(...normalize(params))
    return rows.map((row) => ({ ...row }))
  }

  async queryOne(sql, params = []) {
    const row = this.db.prepare(sql).get(...normalize(params))
    return row ? { ...row } : undefined
  }

  async queryScalar(sql, params = []) {
    const row = await this.queryOne(sql, params)
    if (!row) return undefined
    const values = Object.values(row)
    return values[0]
  }

  async execute(sql, params = []) {
    const info = this.db.prepare(sql).run(...normalize(params))
    return { lastInsertId: Number(info.lastInsertRowid), rowsAffected: Number(info.changes) }
  }

  async executeBatch(statements) {
    const results = []
    this.db.exec('BEGIN')
    try {
      for (const entry of statements) {
        const [sql, params = []] = Array.isArray(entry) ? entry : [entry, []]
        const info = this.db.prepare(sql).run(...normalize(params))
        results.push({ lastInsertId: Number(info.lastInsertRowid), rowsAffected: Number(info.changes) })
      }
      this.db.exec('COMMIT')
      return results
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  async ping() {
    return true
  }

  close() {
    this.db.close()
  }
}

function normalize(params) {
  return params.map((value) => (value === undefined ? null : value))
}

export default SqliteStore