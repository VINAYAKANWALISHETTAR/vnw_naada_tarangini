/**
 * logger.js
 * Crash-safe logging for the main process.
 *
 * Why this exists
 * ---------------
 * `console.log` writes straight to `process.stdout`, which on Windows is a
 * Socket whenever the app was started from a pipe (a terminal, an IDE task
 * runner, a CI step). When the parent process exits or closes its end of the
 * pipe, every later write fails with EPIPE. Node reports that as an
 * unhandled 'error' event on the stream — there is no default handler — and
 * Electron turns it into the "A JavaScript error occurred in the main
 * process" dialog. The stack always looks like this:
 *
 *   Error: EPIPE: broken pipe, write
 *       at Socket._write (node:internal/net:75:18)
 *       ...
 *       at log (...)
 *       at <file>:<line>:<col>
 *       at Timeout._onTimeout (...)
 *
 * The `Timeout` frame is the tell: a timer callback kept running after the
 * parent was gone and logged into a stream that could no longer be written to.
 *
 * What this module does
 * ---------------------
 * 1. Marks stdout/stderr dead on their first stream error and never writes to
 *    them again. A broken pipe is a terminal condition, not a transient one, so
 *    the correct response is to stop using the stream — not to retry it, and
 *    not to keep an 'error' listener that would re-enter on every write.
 * 2. Checks the stream state before every write, so a pending write can never
 *    race the close.
 * 3. Attaches exactly one 'error' listener per stream. That is Node's
 *    documented requirement for process.stdout/stderr; it converts a crash into
 *    a state change, it does not hide anything.
 * 4. De-duplicates repeated identical messages so a failing operation cannot
 *    flood the log every second.
 * 5. Stops itself entirely after `shutdown()` so late callbacks are inert.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** SANGEETHA_LOG=debug|info|warn|error|silent */
function resolveThreshold() {
  const raw = String(process.env.SANGEETHA_LOG || "").toLowerCase();
  if (raw === "silent") return Infinity;
  return LEVELS[raw] || LEVELS.info;
}

const threshold = resolveThreshold();

/** A stream that has emitted 'error', 'close' or 'end' must never be written. */
function isWritable(stream) {
  if (!stream) return false;
  return !stream.destroyed && !stream.writableEnded && !stream.closed && stream.writable !== false;
}

const state = {
  stdout: process.stdout,
  stderr: process.stderr,
  stopped: false,
  seen: new Map(),
  errorGuardInstalled: false,
};

const DEDUPE_LIMIT = 50;

/**
 * Permanently retires a stream.
 *
 * This is called on the stream's 'error' event and is deliberately
 * unconditional. When a write to process.stdout fails with EPIPE, the stream is
 * NOT marked destroyed — it still reports writable — so a check based on
 * `destroyed` would keep using a stream that can never accept a byte again, and
 * every later write would fail the same way. A fault on a stdio handle is
 * terminal: the parent pipe is gone, so the only correct action is to stop
 * writing to it.
 */
function retire(name) {
  state[name] = null;
}

/**
 * One listener per stream, installed once. Node documents that process.stdout
 * and process.stderr need this; without it an EPIPE becomes an uncaught
 * exception. The handler only flips state — it never logs, so it can never
 * recurse into a second failing write.
 */
function installErrorGuard() {
  if (state.errorGuardInstalled) return;
  state.errorGuardInstalled = true;
  for (const name of ["stdout", "stderr"]) {
    const stream = state[name];
    if (!stream || typeof stream.on !== "function") continue;
    stream.on("error", () => retire(name));
    stream.on("close", () => retire(name));
  }
}
installErrorGuard();

/**
 * Suppresses a message repeated within 5 s. This is a rate limit, not a
 * filter: the first occurrence is always written, so a fault is never hidden.
 */
function duplicate(key) {
  const now = Date.now();
  const previous = state.seen.get(key);
  if (previous && now - previous < 5000) return true;
  if (state.seen.size >= DEDUPE_LIMIT) state.seen.clear();
  state.seen.set(key, now);
  return false;
}

function write(name, level, args) {
  if (state.stopped || LEVELS[level] < threshold) return;
  const stream = state[name];
  // Null means the stream was already retired by its own 'error' or 'close'
  // event; the isWritable check covers a stream that was closed silently.
  if (!stream || !isWritable(stream)) {
    retire(name);
    return;
  }
  const line = `${args
    .map((value) => (typeof value === "string" ? value : inspect(value)))
    .join(" ")}\n`;

  if (duplicate(level + line)) return;

  try {
    // A closed stream is already filtered above; this guard covers the window
    // where the stream dies between the check and the write.
    if (!isWritable(stream)) return;
    stream.write(line);
  } catch {
    // A synchronous write failure means the stream is gone for good. Record it
    // and stop using it rather than letting the failure reach the caller.
    retire(name);
  }
}

function inspect(value) {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const logger = {
  debug: (...args) => write("stdout", "debug", args),
  info: (...args) => write("stdout", "info", args),
  warn: (...args) => write("stderr", "warn", args),
  error: (...args) => write("stderr", "error", args),

  /** Number of live output streams; 0 means the parent pipe is gone. */
  healthy() {
    return isWritable(state.stdout) || isWritable(state.stderr);
  },

  /** Whether one specific stream can still be written to. */
  streamAlive(name) {
    return isWritable(state[name]);
  },

  /**
   * Stops all logging. Called from the quit path so nothing can be written
   * while the process is tearing down.
   */
  shutdown() {
    state.stopped = true;
    state.stdout = null;
    state.stderr = null;
    state.seen.clear();
  },
};

module.exports = logger;
