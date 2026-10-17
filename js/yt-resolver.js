/**
 * yt-resolver.js
 * Resolves a YouTube video to a direct, ad-free audio stream URL using
 * yt-dlp. This works for videos that refuse to play inside the YouTube IFrame
 * embed (error 150), which is common for official music videos.
 *
 * Resolution happens in the main process so no yt-dlp binary is exposed to
 * the renderer.
 */

const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const log = require("./logger");

/**
 * The project root: this file lives in js/, but the vendored binary does not.
 *
 * This is why the app cannot play anything at all if it is missed. setup.bat
 * writes to <project>/vendor/yt-dlp.exe, and a resolver looking in its own
 * folder — js/vendor/ — does not find it, so every stream lookup fails with
 * "yt-dlp is not available" while the binary sits unread a level up. That is
 * exactly the failure this constant exists to prevent.
 */
const PROJECT_ROOT = path.join(__dirname, "..");

const RESOLVE_TIMEOUT = 45000;

/** Cap on captured child output; yt-dlp answers in a few hundred bytes. */
const MAX_OUTPUT = 1024 * 512;

/** Every live yt-dlp child, so quitting the app cannot leave one orphaned. */
const live = new Set();

/* ------------------------------------------------------------------ *
 * Persistent stream cache
 *
 * Resolving a stream through yt-dlp costs about five seconds, and that wait is
 * what the user feels on a first press. The renderer already keeps resolved
 * URLs in memory, but that map dies with the window, so every relaunch paid the
 * full cost again. Writing them to userData means the second launch onwards
 * starts from a warm cache.
 *
 * These URLs are signed and time-limited: googlevideo rejects an expired one
 * with 403, which is what made an unchecked on-disk cache worse than no cache
 * at all. So every entry carries a deadline and is only reused while that
 * deadline is comfortably in the future. The deadline comes from the URL's own
 * `expire` parameter when YouTube supplies one, and otherwise falls back to a
 * conservative fixed lifetime.
 * ------------------------------------------------------------------ */

/** Reuse stops this long before the real deadline, to absorb clock skew. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

/** Used when the URL carries no usable `expire` parameter. */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

const CACHE_VERSION = 1;
const MAX_PERSISTED = 40;

let cacheFile = null;
const persisted = new Map();

/**
 * YouTube signs its stream URLs and states the deadline in the query string.
 * Returns milliseconds until expiry, or null when there is no usable value.
 */
function expiryFromUrl(url) {
  try {
    const raw = new URL(url).searchParams.get("expire");
    // Values are epoch seconds; anything non-numeric is not a deadline.
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    const ms = seconds * 1000 - Date.now();
    return ms > 0 ? ms : null;
  } catch {
    return null;
  }
}

/** The resolver is told where to write; kept injectable so tests can isolate it. */
function setCacheFile(file) {
  cacheFile = file || null;
  persisted.clear();
  if (!cacheFile) return;
  loadCache();
}

function loadCache() {
  try {
    const raw = fs.readFileSync(cacheFile, "utf8");
    const data = JSON.parse(raw);
    if (!data || data.version !== CACHE_VERSION || !Array.isArray(data.entries)) return;
    const now = Date.now();
    let dropped = 0;
    for (const entry of data.entries) {
      if (!entry || typeof entry.videoId !== "string" || typeof entry.url !== "string") continue;
      if (!Number.isFinite(entry.expiresAt) || entry.expiresAt - now <= EXPIRY_MARGIN_MS) {
        dropped += 1;
        continue;
      }
      persisted.set(entry.videoId, { url: entry.url, expiresAt: entry.expiresAt });
    }
    if (dropped) log.info(`stream cache: dropped ${dropped} expired or unusable entries`);
    if (persisted.size) log.info(`stream cache: ${persisted.size} entries loaded from disk`);
  } catch (err) {
    // A missing file is the normal first-run case, so it is not worth logging.
    if (err && err.code !== "ENOENT") {
      log.warn("stream cache could not be read:", err.message);
    }
  }
}

function saveCache() {
  if (!cacheFile) return;
  try {
    const now = Date.now();
    const entries = [];
    for (const [videoId, entry] of persisted) {
      if (entry.expiresAt - now <= EXPIRY_MARGIN_MS) continue;
      entries.push({ videoId, url: entry.url, expiresAt: entry.expiresAt });
    }
    // Newest first, so trimming to the cap keeps the most useful entries.
    entries.sort((a, b) => b.expiresAt - a.expiresAt);
    const trimmed = entries.slice(0, MAX_PERSISTED);

    // Written to a sibling temp file and renamed, so a crash mid-write cannot
    // leave a half-written cache that fails to parse on the next launch.
    const temp = `${cacheFile}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: CACHE_VERSION, entries: trimmed }));
    fs.renameSync(temp, cacheFile);
  } catch (err) {
    log.warn("stream cache could not be written:", err.message);
  }
}

function rememberStream(videoId, url) {
  const remaining = expiryFromUrl(url);
  const entry = { url, expiresAt: Date.now() + (remaining || DEFAULT_TTL_MS) };
  persisted.set(videoId, entry);
  if (persisted.size > MAX_PERSISTED) {
    const oldest = [...persisted.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (const [id] of oldest.slice(0, persisted.size - MAX_PERSISTED)) persisted.delete(id);
  }
  saveCache();
  return entry;
}

/** A still-valid URL for this video, or null. */
function cachedStream(videoId) {
  const entry = persisted.get(videoId);
  if (!entry) return null;
  if (entry.expiresAt - Date.now() <= EXPIRY_MARGIN_MS) {
    persisted.delete(videoId);
    saveCache();
    return null;
  }
  return entry;
}

/**
 * Drops one entry after the network rejected its URL. A 403 from googlevideo
 * means the signature aged out, so the entry must not be handed out again —
 * otherwise the retry would replay the same dead URL.
 */
function forgetStream(videoId) {
  if (persisted.delete(videoId)) saveCache();
}

let cachedBinary;

/** Locates yt-dlp: bundled copy first, then the usual system locations. */
function findYtDlp() {
  if (cachedBinary !== undefined) return cachedBinary;

  const isWindows = process.platform === "win32";
  const exeName = isWindows ? "yt-dlp.exe" : "yt-dlp";
  const candidates = [
    path.join(PROJECT_ROOT, "vendor", exeName),
    path.join(process.resourcesPath || "", "vendor", exeName),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        cachedBinary = candidate;
        return cachedBinary;
      }
    } catch {
      /* ignore unreadable paths */
    }
  }

  // Fall back to whatever is on PATH. The stdio must be captured rather than
  // inherited: an inherited handle would point at the parent's stdout, so a
  // failing lookup could write into our own console and, if that console is a
  // closed pipe, surface as EPIPE in the middle of the lookup.
  const lookup = isWindows ? "where" : "which";
  try {
    const found = execFileSync(lookup, [isWindows ? "yt-dlp.exe" : "yt-dlp"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)[0];
    if (found) {
      cachedBinary = found;
      return cachedBinary;
    }
  } catch {
    /* not installed on PATH */
  }

  cachedBinary = null;
  // Named per platform on purpose: on Linux the binary comes from the
  // container image, and "run setup.bat" would be advice that cannot work.
  log.warn(
    isWindows
      ? "yt-dlp was not found in vendor/, on PATH, or in resources — run setup.bat"
      : "yt-dlp was not found in vendor/ or on PATH — install it with: pip install -U yt-dlp"
  );
  return cachedBinary;
}

function isAvailable() {
  return !!findYtDlp();
}

/** Terminates every in-flight lookup. Called on quit. */
function killAll() {
  for (const child of live) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
  live.clear();
  // The lookups will settle as their children die; clearing the map stops a
  // rejected one from being handed to a caller after shutdown.
  pendingLookups.clear();
}

function runYtDlp(args, timeout = RESOLVE_TIMEOUT) {
  const binary = findYtDlp();
  if (!binary) return Promise.reject(new Error("yt-dlp is not available"));

  return new Promise((resolve, reject) => {
    // Explicit pipes: the child must never inherit the parent's stdio handles.
    const child = spawn(binary, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    live.add(child);

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      live.delete(child);
      fn(value);
    };

    timer = setTimeout(() => {
      child.kill();
      settle(reject, new Error("yt-dlp timed out"));
    }, timeout);

    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk;
    });
    // A killed or crashed child can emit 'error' on the streams too; without a
    // listener that is an unhandled 'error' event and it takes the app down.
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});

    child.on("error", (err) => settle(reject, err));
    child.on("close", (code) => {
      if (code === 0) return settle(resolve, stdout.trim());
      const message = stderr.split(/\r?\n/).filter(Boolean).slice(-1)[0] || `yt-dlp exited with ${code}`;
      settle(reject, new Error(message.replace(/^ERROR:\s*/i, "")));
    });
  });
}

const videoUrl = (videoId) => `https://www.youtube.com/watch?v=${videoId}`;

/**
 * YouTube clients to try, in order.
 *
 * YouTube bot-gates by IP. A home connection is rarely affected, but a shared
 * datacentre address — which is exactly what the deployed site runs on — hits
 * "Sign in to confirm you're not a bot" regularly, and when it does, every
 * lookup fails at once with no way for the user to do anything about it.
 *
 * Each entry names a client whose request shape YouTube treats differently, so
 * one being gated does not mean all of them are. `null` is yt-dlp's own default
 * and is tried first because it is the best-behaved; the rest are fallbacks for
 * when it is the one that got blocked. Verified against the live endpoint: with
 * the default client gated, the android client still returned a working
 * googlevideo URL for the same video at the same moment.
 */
const PLAYER_CLIENTS = [
  null,
  "youtube:player_client=android",
  "youtube:player_client=android_vr",
];

/** Direct audio URL, best quality available. */
async function fetchStreamUrl(videoId) {
  let lastError = null;

  for (const client of PLAYER_CLIENTS) {
    const args = ["-f", "bestaudio[ext=m4a]/bestaudio/best", "-g", "--no-warnings", "--no-playlist"];
    if (client) args.push("--extractor-args", client);
    // --no-call-home used to be passed here. yt-dlp deprecated it (issue
    // #14198) and prints a warning on every single lookup; it now does
    // nothing and will eventually be an error, so it was removed.
    args.push(videoUrl(videoId));

    try {
      const raw = await runYtDlp(args);
      const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (lines.length) {
        // Only worth logging when a fallback was needed; the default succeeding
        // is the normal case and has nothing to report.
        if (client) log.warn(`yt-dlp: the default client was refused, fell back to ${client}`);
        return lines[0];
      }
      lastError = new Error("No audio stream found");
    } catch (err) {
      lastError = err;
      // A genuine timeout or a missing binary will not be fixed by trying the
      // next client, and retrying it three times just triples the wait.
      if (/yt-dlp timed out|yt-dlp is not available/i.test(err.message)) throw err;
    }
  }

  // Every client was refused. Say what actually happened rather than leaking
  // yt-dlp's raw wording, which is written for a command line, not a listener.
  const detail = String((lastError && lastError.message) || "");
  if (/not a bot|sign in/i.test(detail)) {
    throw new Error("YouTube is asking this server to sign in, so playback is unavailable right now");
  }
  throw lastError || new Error("No audio stream found");
}

/**
 * In-flight lookups, keyed by video id.
 *
 * The renderer can ask for the same track twice in quick succession — a
 * prewarm in progress when the user presses play, say. Without this both
 * requests spawned their own yt-dlp, which cost another five seconds of work
 * and raced to write the cache, so the URL actually being played could be
 * replaced by one that was never used.
 */
const pendingLookups = new Map();

/**
 * Stream URL for a track. Title/artist are already known from the search
 * results (or the InnerTube link lookup), so only one yt-dlp call is made —
 * roughly half the latency of resolving metadata as well.
 *
 * A still-valid cached URL short-circuits the whole lookup, which is what makes
 * a relaunch start playing almost immediately.
 */
async function resolveTrack(track) {
  const videoId = String((track && track.videoId) || "").trim();
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error("Invalid YouTube video id");

  const hit = cachedStream(videoId);
  if (hit) return { videoId, url: hit.url, cached: true };

  const inFlight = pendingLookups.get(videoId);
  if (inFlight) return inFlight;

  const task = fetchStreamUrl(videoId)
    .then((url) => {
      const entry = rememberStream(videoId, url);
      return { videoId, url, expiresAt: entry.expiresAt };
    })
    .finally(() => pendingLookups.delete(videoId));

  pendingLookups.set(videoId, task);
  return task;
}

/** The cached URL for a video, or null. Lets a caller avoid the binary entirely. */
function peekStream(videoId) {
  const id = String((videoId && videoId.videoId) || videoId || "").trim();
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
  const hit = cachedStream(id);
  return hit ? { videoId: id, url: hit.url, cached: true } : null;
}

module.exports = {
  isAvailable,
  findYtDlp,
  resolveTrack,
  killAll,
  setCacheFile,
  peekStream,
  forgetStream,
};
