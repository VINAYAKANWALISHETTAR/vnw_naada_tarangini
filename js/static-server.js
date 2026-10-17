/**
 * static-server.js
 * Static file serving for the widget UI.
 *
 * YouTube's IFrame player refuses to run on a `file://` page and replies with
 * error 153, so the widget is served from http://127.0.0.1 instead. Only files
 * inside the app folder are exposed.
 *
 * `createStaticHandler` is the whole implementation and is shared with the
 * public web server (app-server.js), so the desktop widget and the deployed
 * site can never disagree about what is safe to serve. `startStaticServer` is
 * the loopback wrapper the desktop app uses.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const log = require("./logger");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".webmanifest": "application/manifest+json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** Rejects anything that resolves outside the served folder. */
function isInside(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Builds a request handler that serves files from `root`.
 *
 * `cacheControl` exists because the two callers want opposite things. The
 * desktop app serves from a random port on every launch, so it must never
 * reuse a cached copy — a stale renderer is how an updated app keeps behaving
 * like the old one. The public site keeps the same guarantee, because "the site
 * is showing yesterday's build" is exactly the confusion the desktop build tag
 * exists to prevent.
 *
 * `allow` is an optional list of file names, relative to the root, that are the
 * ONLY things served. The public site passes one, and it is not a nicety:
 * without it the whole project folder is readable over the internet, which
 * includes .git/ (the remote URL and every object), node_modules/, and the 17 MB
 * vendor/yt-dlp binary. The desktop app does not pass one because it is bound to
 * 127.0.0.1, where there is nothing to leak to; if that ever changes, this is
 * the switch that has to be thrown.
 */
function createStaticHandler(root, options = {}) {
  const base = path.resolve(root);
  const cacheControl =
    options.cacheControl || "no-store, no-cache, must-revalidate, max-age=0";

  const allow = Array.isArray(options.allow) ? new Set(options.allow) : null;

  return function serveStatic(request, response) {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url || "/", "http://127.0.0.1").pathname);
    } catch {
      response.writeHead(400).end("bad request");
      return;
    }
    if (pathname === "/") pathname = "/index.html";

    // Compared before touching the filesystem at all, so a denied name cannot
    // even be probed for existence.
    if (allow) {
      const name = pathname.replace(/^\/+/, "");
      if (!allow.has(name)) {
        response.writeHead(404).end("not found");
        return;
      }
    }

    const filePath = path.join(base, path.normalize(pathname).replace(/^([/\\])+/, ""));
    if (!isInside(base, filePath)) {
      response.writeHead(403).end("forbidden");
      return;
    }

    // A symbolic link inside the app folder can point anywhere, and the check
    // above is done on the link, not on what it resolves to. The file is
    // resolved for real before it is served, so a link cannot be used to read
    // anything outside the app.
    let realPath;
    try {
      realPath = fs.realpathSync(filePath);
    } catch {
      response.writeHead(404).end("not found");
      return;
    }
    if (!isInside(base, realPath)) {
      log.warn("refused a file that resolves outside the app folder:", pathname);
      response.writeHead(403).end("forbidden");
      return;
    }

    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        response.writeHead(404).end("not found");
        return;
      }
      response.writeHead(200, {
        "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
        "Content-Length": String(stats.size),
        "Cache-Control": cacheControl,
        Pragma: "no-cache",
        Expires: "0",
      });

      // A HEAD request asks for the headers only. Sending a body anyway breaks
      // the protocol, and the client reports the whole request as failed
      // rather than as a successful empty response.
      if (request.method === "HEAD") {
        response.end();
        return;
      }

      const stream = fs.createReadStream(filePath);
      // A read stream that fails (file deleted mid-read, permission change)
      // emits 'error'. With no listener that is an unhandled stream error and
      // it terminates the process, so the response is failed explicitly.
      stream.on("error", (streamErr) => {
        log.warn("could not send", path.basename(filePath), "-", streamErr.message);
        response.destroy();
      });
      // The client may hang up (reload, navigation). Ending quietly is normal.
      response.on("close", () => stream.destroy());
      stream.pipe(response);
    });
  };
}

/**
 * Serves the UI on a random loopback port for the desktop app.
 *
 * The desktop app is a single-user local process, so the listener is pinned to
 * 127.0.0.1: nothing on the network can reach the widget or the yt-dlp call it
 * makes. The public site uses app-server.js, which deliberately does the
 * opposite and listens on 0.0.0.0.
 */
function startStaticServer(root) {
  const serve = createStaticHandler(root);
  return new Promise((resolve, reject) => {
    const server = http.createServer(serve);

    server.on("error", (err) => {
      if (!server.listening) {
        reject(err);
        return;
      }
      // After listen() the promise is already settled; a later error would be
      // an unhandled 'error' event with no listener left, so it is reported.
      log.error("the local UI server reported an error:", err.message);
    });

    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function pageUrl(server) {
  const address = server && server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  return `http://127.0.0.1:${port}/index.html`;
}

module.exports = { startStaticServer, pageUrl, createStaticHandler };
