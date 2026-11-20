/**
 * Minimal leveled logger.
 *
 * Writes structured lines to stdout and keeps a bounded in-memory ring buffer so the
 * web UI can tail recent server logs (GET /api/logs) without a log file mount.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 }

export function normalizeLevel(level) {
  return LEVELS[level] || LEVELS.info
}

export function createLogger({ level = 'info', ringSize = 500, now = () => new Date(), sink = console } = {}) {
  const threshold = normalizeLevel(level)
  const ring = []

  function push(entry) {
    ring.push(entry)
    if (ring.length > ringSize) ring.splice(0, ring.length - ringSize)
  }

  function emit(name, args) {
    if (LEVELS[name] < threshold) return
    const message = args
      .map((arg) => {
        if (typeof arg === 'string') return arg
        if (arg instanceof Error) return arg.stack || arg.message
        try {
          return JSON.stringify(arg)
        } catch {
          return String(arg)
        }
      })
      .join(' ')

    const entry = { time: now().toISOString(), level: name, message }
    push(entry)
    const line = `${entry.time} [${name}] ${message}`
    if (name === 'error') sink.error?.(line)
    else if (name === 'warn') sink.warn?.(line)
    else sink.log?.(line)
  }

  return {
    debug: (...args) => emit('debug', args),
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
    /** Recent log entries, oldest first. */
    tail(limit = 200) {
      return ring.slice(-limit)
    }
  }
}

export default createLogger