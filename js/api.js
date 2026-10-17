/**
 * api.js
 * The HTTP API that stands in for Electron's IPC on the web.
 *
 * The desktop app answers three privileged questions on behalf of the renderer:
 *
 *   "search YouTube Music for X"      -> InnerTube search, then parse
 *   "what is this link / video id?"   -> InnerTube player/next, then parse
 *   "give me a direct audio URL"      -> yt-dlp
 *
 * None of that can happen in a browser: YouTube answers an unknown web origin
 * with 403 and no CORS header, and there is no child process to run. So the web
 * build asks this module over HTTP instead of over IPC, and the answers are
 * identical because the same code produces them:
 *
 *   - InnerTube goes through yt-proxy.js, which is the very function Electron
 *     registers as the `yt:request` handler.
 *   - search/metadata parsing runs in ytmusic.js, the same file the renderer
 *     loads. The Node server requires it and injects that transport, so there
 *     is no second copy of the YouTube parsing anywhere.
 *   - yt-dlp goes through yt-resolver.js, the same module the main process
 *     uses, including its signed-URL cache.
 *
 * This module deliberately does NOT expose a generic "proxy this InnerTube
 * endpoint" route. The desktop bridge accepts any [a-z]+ endpoint, which is
 * fine for a local IPC channel a trusted renderer already owns; the same route
 * on a public origin would be an open, unthrottled proxy to YouTube for anyone
 * on the internet. Only the three operations the UI actually performs are
 * reachable, each is rate limited, and each is validated below.
 */

const path = require("path");
const log = require("./logger");
const proxy = require("./yt-proxy");
const resolver = require("./yt-resolver");

/** Injected into ytmusic.js so its InnerTube calls work without a browser. */
globalThis.sangeethaTransport = (endpoint, body) => proxy.handleYtRequest(null, { endpoint, body });

const ytmusic = require("./ytmusic");

/* ------------------------------------------------------------------ *
 * Limits
 *
 * This server is public, so every input is treated as hostile. The defaults are
 * generous for real use and still bound the work a single client can cause:
 * spawning yt-dlp costs seconds of CPU, and InnerTube costs a round trip to
 * YouTube.
 * ------------------------------------------------------------------ */

const LIMITS = {
  /** Longest accepted search string. */
  query: 200,
  /** Results returned. Also what the UI asks for. */
  searchResults: 25,
  /** Requests allowed per window, per client. */
  perWindow: 60,
  /** Length of the rate-limit window. */
  windowMs: 60 * 1000,
  /** Distinct clients tracked at once; past this the oldest are forgotten. */
  maxClients: 5000,
};

/**
 * Fixed-window counter, keyed by client address.
 *
 * A Map preserves insertion order, so the oldest key is always the first one
 * found and dropping it evicts in the order the clients arrived.
 */
function createRateLimiter(options = {}) {
  const perWindow = options.perWindow || LIMITS.perWindow;
  const windowMs = options.windowMs || LIMITS.windowMs;
  const maxClients = options.maxClients || LIMITS.maxClients;
  const hits = new Map();

  return function take(key) {
    const now = Date.now();
    const entry = hits.get(key);
    // A window that has fully elapsed is a fresh allowance, not a failure.
    if (!entry || now >= entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
    } else if (entry.count >= perWindow) {
      return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
    } else {
      entry.count += 1;
    }

    if (hits.size > maxClients) {
      const oldest = hits.keys().next();
      if (!oldest.done) hits.delete(oldest.value);
    }
    return { allowed: true };
  };
}

/** Client address, used only for rate limiting and never echoed back. */
function clientKey(request) {
  return request.socket && request.socket.remoteAddress ? request.socket.remoteAddress : "unknown";
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body)),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

/**
 * Turns a thrown error into a status the browser can act on.
 *
 * The message is passed through because these are messages written for the user
 * ("YouTube replied 403"), not diagnostics. Anything unrecognised is replaced
 * rather than forwarded, so an unexpected failure cannot leak a stack, a file
 * path or a yt-dlp command line into a public response.
 */
function sendError(response, err) {
  const message = String((err && err.message) || err || "Something went wrong");
  const known = /^(Invalid |No audio stream|YouTube |yt-dlp |The server |Search |Timeout|timed out)/i;
  const safe = known.test(message) ? message : "Something went wrong on the server";
  const status = /timed out|Timeout/i.test(message)
    ? 504
    : /YouTube replied 429|too many/i.test(message)
      ? 429
      : /^Invalid |not a playable/i.test(message)
        ? 400
        : 502;
  if (!known.test(message)) log.error("unhandled API failure:", err);
  sendJson(response, status, { error: safe });
}

const asPositiveInt = (value, fallback, max) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
};

/**
 * Version for the health payload.
 *
 * Read once, defensively, and never with require(): package.json is beside this
 * file rather than a module, so require() would throw if it were absent or
 * unreadable — and that throw would happen inside the /api/health handler,
 * turning the health check into a 502. Fly would then discard a machine that is
 * in fact serving the site perfectly well, which is the worst possible outcome
 * for the one endpoint whose job is to report that things are fine.
 */
const APP_VERSION = (() => {
  try {
    const raw = require("fs").readFileSync(path.join(__dirname, "..", "package.json"), "utf8");
    return JSON.parse(raw).version || "unknown";
  } catch {
    return "unknown";
  }
})();

/**
 * Builds the /api request handler.
 *
 * Returns false for any path it does not own, so the caller can fall through to
 * the static file handler instead of having to enumerate what is not an API
 * call.
 */
function createApiHandler(options = {}) {
  const take = createRateLimiter(options.limiter);

  return async function handleApi(request, response) {
    let url;
    try {
      url = new URL(request.url || "/", "http://localhost");
    } catch {
      return false;
    }
    if (!url.pathname.startsWith("/api/")) return false;

    // Only reads are offered; there is nothing here that changes state on disk.
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }).end("method not allowed");
      return true;
    }

    const limit = take(clientKey(request));
    if (!limit.allowed) {
      log.warn("rate limit hit for", clientKey(request));
      response.setHeader("Retry-After", String(limit.retryAfter));
      sendJson(response, 429, { error: "Too many requests — please wait a moment" });
      return true;
    }

    const q = url.searchParams;

    try {
      switch (url.pathname) {
        /* ---- liveness: what the deploy checks, and what the page shows ---- */
        case "/api/health": {
          // Resolving yt-dlp is a filesystem lookup; it is cached after the
          // first call, and it must not be able to fail this response.
          let ytDlp = false;
          try {
            ytDlp = !!resolver.findYtDlp();
          } catch {
            ytDlp = false;
          }
          sendJson(response, 200, {
            ok: true,
            service: "sangeetha",
            version: APP_VERSION,
            ytDlp,
          });
          return true;
        }

        /* ---- search: InnerTube + the shared parser ---- */
        case "/api/search": {
          const term = String(q.get("q") || "").trim();
          if (!term) {
            sendJson(response, 400, { error: "Type something to search for" });
            return true;
          }
          if (term.length > LIMITS.query) {
            sendJson(response, 400, { error: "That search is too long" });
            return true;
          }
          const count = asPositiveInt(q.get("limit"), LIMITS.searchResults, LIMITS.searchResults);
          const results = await ytmusic.search(term, count);
          sendJson(response, 200, { results, count: results.length });
          return true;
        }

        /* ---- metadata: title/artist/cover for a pasted link or id ---- */
        case "/api/metadata": {
          const input = String(q.get("input") || "").trim();
          if (!input) {
            sendJson(response, 400, { error: "No link was given" });
            return true;
          }
          const track = await ytmusic.resolve(input);
          if (!track) {
            sendJson(response, 400, { error: "That is not a playable YouTube link" });
            return true;
          }
          sendJson(response, 200, { track });
          return true;
        }

        /* ---- stream: the one that costs a yt-dlp process ---- */
        case "/api/stream": {
          const videoId = String(q.get("videoId") || "").trim();
          if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
            sendJson(response, 400, { error: "That is not a playable YouTube video" });
            return true;
          }
          const resolved = await resolver.resolveTrack({ videoId });
          sendJson(response, 200, {
            videoId: resolved.videoId,
            url: resolved.url,
          });
          return true;
        }

        /* ---- forget: drop a URL the network rejected ---- */
        case "/api/forget-stream": {
          const videoId = String(q.get("videoId") || "").trim();
          if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
            sendJson(response, 400, { error: "Invalid YouTube video id" });
            return true;
          }
          resolver.forgetStream(videoId);
          sendJson(response, 200, { ok: true });
          return true;
        }

        default:
          sendJson(response, 404, { error: "No such endpoint" });
          return true;
      }
    } catch (err) {
      sendError(response, err);
      return true;
    }
  };
}

module.exports = { createApiHandler, createRateLimiter, LIMITS };
