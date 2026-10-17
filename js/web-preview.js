/**
 * web-preview.js
 * Runs Naada Tarangini on this machine and opens it in the default browser.
 *
 * This used to serve the UI over a loopback origin with no API behind it, so
 * search could only ever report that it needed the desktop app. It now starts
 * the same server the deployed website uses — same API, same /api/search and
 * /api/stream — so what you check here is what Fly will serve, and a working
 * local setup is a real test of the deploy rather than a different code path.
 *
 * The difference from the deployed server is only the bind address: this one
 * stays on 127.0.0.1 so a development server is not exposed to the network,
 * while production binds 0.0.0.0 because Fly routes traffic to it.
 *
 * Usage: npm run web:open
 */

"use strict";

const path = require("path");
const { spawn } = require("child_process");
const log = require("./logger");
const resolver = require("./yt-resolver");
const { startAppServer } = require("./app-server");

/** The project root: this file lives in js/, but the app is the whole folder. */
const PROJECT_ROOT = path.join(__dirname, "..");

/** Opens a URL in the default browser without going through a shell. */
function openInBrowser(url) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd.exe", ["/c", "start", "", url]]
        : ["xdg-open", [url]];

  const child = spawn(command, args, {
    stdio: "ignore",
    windowsHide: true,
    detached: true,
  });
  child.on("error", (err) => {
    log.error("could not open a browser:", err.message);
  });
  // The browser outlives this process.
  child.unref();
}

startAppServer({ root: PROJECT_ROOT, host: "127.0.0.1", port: Number(process.env.PORT) || 8080 })
  .then(({ port }) => {
    const url = `http://127.0.0.1:${port}/`;
    log.info(`\n  Naada Tarangini local web app\n  ${url}\n`);
    log.info("  Search and playback work here, exactly as they do on the site.\n");
    if (!resolver.isAvailable()) {
      log.warn("  yt-dlp was not found, so playback will not resolve.");
      log.warn("  Run setup.bat on Windows, or `pip install yt-dlp`, then try again.\n");
    }
    log.info("  Press Ctrl+C to stop.\n\n");
    openInBrowser(url);
  })
  .catch((err) => {
    log.error("could not start the local web server:", err.message);
    if (err && err.code === "EADDRINUSE") {
      log.error("  That port is already in use. Try: PORT=8081 npm run web:open");
    }
    log.shutdown();
    process.exitCode = 1;
  });

// Ctrl+C must not produce a stack trace, and must not leave yt-dlp orphaned.
process.on("SIGINT", () => {
  log.info("\nstopping the local web server");
  resolver.killAll();
  log.shutdown();
  process.exit(0);
});
