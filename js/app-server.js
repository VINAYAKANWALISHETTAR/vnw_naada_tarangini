/**
 * app-server.js
 * The web server behind the Naada Tarangini website.
 *
 * It serves the exact same index.html, style.css, main.js and ytmusic.js that
 * the desktop widget loads, plus the /api endpoints from api.js. There is no
 * second front end and no second set of styles: what the site shows and what
 * the widget shows come from the same files on disk.
 *
 * This is deliberately separate from static-server.js, which the desktop app
 * uses. That one binds 127.0.0.1 on a random port, because the desktop app is a
 * single-user local process and nothing on the network should be able to reach
 * it. This one binds 0.0.0.0, because it is a public website. Both share the
 * same hardened file handler.
 *
 * The host and port are arguments, never constants: Fly hands the port in
 * through PORT, and local development overrides it. Hard-coding either one is
 * what makes a deploy fail to start.
 */

const http = require("http");
const path = require("path");
const log = require("./logger");
const { createStaticHandler } = require("./static-server");
const { createApiHandler } = require("./api");

/**
 * The project root, which is the parent of this folder.
 *
 * The source lives in js/ but the app is the whole directory: index.html,
 * style.css and the icon sit beside this folder, not inside it. Anything that
 * serves the UI has to be handed the parent, or it will look for index.html one
 * level too deep and 404 the entire site.
 */
const PROJECT_ROOT = path.join(__dirname, "..");

/**
 * The only files the website may serve.
 *
 * This is a security boundary, not a convenience. The project folder also holds
 * .git/ (the remote URL and every commit object), node_modules/, package-lock,
 * and vendor/yt-dlp — a 17 MB binary. Anything not named here returns 404, so
 * none of that is reachable from the internet. The desktop app deliberately does
 * not use this list, because it is bound to 127.0.0.1 where there is no
 * exposure; the allowlist exists for the public origin.
 */
const PUBLIC_FILES = [
  "index.html",
  "style.css",
  "js/main.js",
  "js/ytmusic.js",
  "sangeeta_icon.png",
  "manifest.webmanifest",
  "sw.js",
  // The seven local covers for the default library. They are named one by one
  // rather than allowed as a directory because the allowlist is the only thing
  // between the internet and this tree: a wildcard here would re-open every
  // file that ever lands in assets/. About 1.3 MB in total, and they are the
  // reason the default library still has artwork on a network where
  // i.ytimg.com is blocked.
  "assets/covers/f2vB9CLbqIc.jpg",
  "assets/covers/x9VXlf0j980.jpg",
  "assets/covers/0NAJX4DrXv0.jpg",
  "assets/covers/CUdJ-n2l1Hk.jpg",
  "assets/covers/pUK8-1JtC0M.jpg",
  "assets/covers/DeV43VUG1aY.jpg",
  "assets/covers/Y_tzn4vM3ks.jpg",
];

/**
 * Creates the server without starting it, so tests can drive it on a random
 * port and so the caller decides when and where it listens.
 */
function createAppServer(options = {}) {
  const root = path.resolve(options.root || PROJECT_ROOT);

  const serveApi = createApiHandler({ root, limiter: options.limiter });

  const serveStatic = createStaticHandler(root, {
    // The desktop app must never reuse a cached copy. The site keeps the same
    // guarantee, because "the site is showing yesterday's build" is exactly the
    // confusion the desktop build tag exists to prevent.
    cacheControl: "no-store, no-cache, must-revalidate, max-age=0",
    allow: PUBLIC_FILES,
  });

  const server = http.createServer((request, response) => {
    Promise.resolve(serveApi(request, response))
      .then((handled) => {
        if (handled) return;
        serveStatic(request, response);
      })
      .catch((err) => {
        // createApiHandler answers its own failures; reaching here means the
        // request handling itself broke, which must not take the process down.
        log.error("a request could not be handled:", (err && err.message) || err);
        if (!response.headersSent) response.writeHead(500);
        response.end("internal error");
      });
  });

  // A dropped client (mobile networks do this constantly) must not surface as
  // an unhandled 'error' event, which would terminate the whole server.
  request_logGuard(server);

  return server;
}

function request_logGuard(server) {
  server.on("clientError", (err, socket) => {
    if (err && err.code === "ECONNRESET") return;
    log.warn("client error:", (err && err.message) || err);
    if (socket && !socket.destroyed) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });
}

/**
 * Starts the server and resolves once it is accepting connections.
 *
 * The caller supplies host and port so the same code runs in production and in
 * local development. `port` may be 0, which asks the OS for a free port — that
 * is what the tests use.
 */
function startAppServer(options = {}) {
  const root = path.resolve(options.root || PROJECT_ROOT);
  const host = options.host || "0.0.0.0";
  const port = Number.isFinite(options.port) ? options.port : 8080;

  return new Promise((resolve, reject) => {
    const server = createAppServer({ root, limiter: options.limiter });

    server.on("error", (err) => {
      if (!server.listening) reject(err);
      else log.error("the web server reported an error:", err.message);
    });

    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = address && typeof address === "object" ? address.port : port;
      log.info(`sangeetha web server listening on http://${host}:${actualPort}`);
      resolve({ server, port: actualPort, host });
    });
  });
}

module.exports = { createAppServer, startAppServer, PUBLIC_FILES };
