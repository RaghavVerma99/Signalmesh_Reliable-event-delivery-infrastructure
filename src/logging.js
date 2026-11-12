'use strict';

/**
 * Minimal leveled JSON logger.
 *
 * Every process writes structured JSON to stdout so that logs can be shipped
 * by the platform (CloudWatch, Loki, Datadog, ...) without a sidecar. The
 * level is read from `SIGNALMESH_LOG_LEVEL` and honoured everywhere - an
 * unfiltered logger in production is a cost and a data-leak problem.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function resolveLevel() {
  const raw = String(process.env.SIGNALMESH_LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[raw] ? raw : 'info';
}

function createLogger(options) {
  const opts = options || {};
  const levelName = opts.level || resolveLevel();
  const threshold = LEVELS[levelName] !== undefined ? LEVELS[levelName] : LEVELS.info;
  const base = opts.base && typeof opts.base === 'object' ? opts.base : {};

  function write(level, msg, fields) {
    if (LEVELS[level] < threshold) return;
    const line = Object.assign({ ts: new Date().toISOString(), level, msg }, base, fields || {});
    try {
      process.stdout.write(JSON.stringify(line) + '\n');
    } catch {
      // Never let logging break the request path.
    }
  }

  return {
    level: levelName,
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (extra) => createLogger({ level: levelName, base: Object.assign({}, base, extra) }),
  };
}

module.exports = { createLogger, LEVELS, resolveLevel };
