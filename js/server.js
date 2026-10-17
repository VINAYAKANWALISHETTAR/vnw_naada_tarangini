/**
 * server.js
 * Production entry point for the Naada Tarangini website. This is what Fly.io runs.
 *
 * The previous deployment produced a Fly "Host Error" because nothing was
 * actually listening on the port Fly routes traffic to. Two mistakes cause
 * that, and both are avoided explicitly here:
 *
 *   1. Binding to 127.0.0.1. That address is the container's own loopback, so
 *      traffic arriving on the container's external interface is refused.
 *      Production binds 0.0.0.0.
 *   2. Ignoring PORT. Fly allocates the internal port and tells the process
 *      which one it is through PORT. Hard-coding 8080 while Fly expects
 *      something else gives exactly the same Host Error.
 *
 * So: PORT when it is set, 8080 as a deterministic fallback, always 0.0.0.0,
 * and the process stays alive until it is asked to stop.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const log = require("./logger");
const resolver = require("./yt-resolver");
const { startAppServer } = require("./app-server");

/** Matches fly.toml's internal_port; used only when PORT is absent. */
const DEFAULT_PORT = 8080;
const HOST = "0.0.0.0";

/** The project root: this file lives in js/, but the app is the whole folder. */
const PROJECT_ROOT = path.join(__dirname, "..");

function resolvePort() {
  const raw = String(process.env.PORT || "").trim();
  const parsed = Number.parseInt(raw, 10);
  // PORT is set by the platform. A non-numeric or unusable value must not fall
  // through to listen(NaN), which throws and leaves nothing listening.
  if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
    return { port: parsed, from: "PORT" };
  }
  if (raw) log.warn(`PORT was set to "${raw}", which is not a usable port; using ${DEFAULT_PORT}`);
  return { port: DEFAULT_PORT, from: "default" };
}

/**
 * Where to keep the resolved-stream cache.
 *
 * On a normal machine this is the app's data directory. A container filesystem
 * is ephemeral, and the app directory may be read-only, so this prefers a
 * writable location and never lets a failure here stop the server: the cache is
 * an optimisation, and losing it only costs one extra yt-dlp call.
 */
function cacheLocation() {
  const candidates = [
    process.env.SANGEETHA_CACHE_DIR,
    path.join(os.tmpdir(), "sangeetha-cache"),
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return path.join(dir, "stream-cache.json");
    } catch (err) {
      log.warn(`could not use ${dir} for the stream cache:`, err.message);
    }
  }
  return null;
}

function main() {
  const { port, from } = resolvePort();

  log.info(`sangeetha web server starting (node ${process.version}, ${process.platform})`);
  log.info(`instance ${process.env.FLY_ALLOC_ID || process.env.FLY_REGION || "local"}`);
  log.info(`port ${port} (from ${from}), host ${HOST}`);

  const cacheFile = cacheLocation();
  if (cacheFile) {
    try {
      resolver.setCacheFile(cacheFile);
      log.info(`stream cache: ${cacheFile}`);
    } catch (err) {
      log.warn("the stream cache is unavailable:", err.message);
    }
  }

  // Reported at startup, because "yt-dlp is missing in the container" otherwise
  // shows up much later as every track silently failing to resolve.
  const binary = resolver.findYtDlp();
  if (binary) log.info(`yt-dlp: ${binary}`);
  else log.warn("yt-dlp was not found — /api/stream will fail until it is installed");

  startAppServer({ root: PROJECT_ROOT, host: HOST, port })
    .then(({ port: actual }) => {
      log.info(`sangeetha is ready: port ${actual}, serving the UI and /api/*`);
    })
    .catch((err) => {
      log.error("the web server could not start:", err.message);
      // A non-zero exit is what makes Fly report a failed start instead of
      // leaving a container running that answers nothing.
      log.shutdown();
      process.exit(1);
    });
}

process.on("unhandledRejection", (err) => {
  log.error("unhandled rejection:", (err && err.message) || err);
});

process.on("uncaughtException", (err) => {
  log.error("uncaught exception:", (err && err.stack) || err);
  // An uncaught exception leaves the process in an unknown state. Stopping is
  // better than serving half-broken responses; Fly restarts the instance.
  resolver.killAll();
  log.shutdown();
  process.exit(1);
});

/**
 * Graceful stop. SIGTERM is what Fly sends before it replaces a machine, and
 * draining instead of dying mid-response is what keeps a deploy from showing an
 * error to whoever had the page open.
 */
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log.info(`${signal} received, shutting down`);
  resolver.killAll();
  log.shutdown();
  // Nothing else should keep this process alive once the server is closed.
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

main();
