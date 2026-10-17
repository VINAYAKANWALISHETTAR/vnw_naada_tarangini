/**
 * electron-main.js
 * Main process for the Naada Tarangini (Sangeetha) floating desktop music player.
 *
 * Responsibilities:
 * - Creates a frameless, transparent, always-on-top widget window that floats
 *   above other applications (VS Code, browsers, full-screen games, ...).
 * - Serves the UI from a tiny loopback HTTP server so the page runs on a real
 *   http origin (file:// origins give an opaque storage partition and are
 *   rejected by several browser APIs).
 * - Persists the widget position/size so it reopens where the user left it.
 * - Performs YouTube InnerTube requests in the Node context so the renderer
 *   never runs into browser CORS restrictions.
 * - Provides window controls (minimise / close / snap / pin / drag) over IPC.
 * - Creates a Windows desktop shortcut on request.
 * - System tray with quick media controls.
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  screen,
  shell,
  dialog,
} = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const log = require("./js/logger");
const { buildIdentity } = require("./js/build-info");
const { handleYtRequest } = require("./js/yt-proxy");
const { startStaticServer, pageUrl } = require("./js/static-server");
const resolver = require("./js/yt-resolver");
const shortcut = require("./js/desktop-shortcut");

const DEFAULT_SIZE = { width: 460, height: 720 };
const MIN_SIZE = { width: 360, height: 460 };
const MINI_SIZE = { width: 420, height: 68 };
const APP_ID = "Sangeetha.DesktopPlayer";

/** Backoff limits for rebuilding a window that keeps disappearing. */
const MAX_RESTORE_ATTEMPTS = 5;
const MAX_RESTORE_DELAY = 10000;

/** Only these hosts may be handed to the system browser. */
const EXTERNAL_HOSTS = /^(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)$/i;

let mainWindow = null;
let tray = null;
let forceQuit = false;
let staticServer = null;
/** Bounds of the full card while the window is shrunk to the mini bar, else null. */
let fullBounds = null;

/**
 * Identity of the build on disk, shown in the widget so the running version is
 * always verifiable — see build-info.js.
 */
const buildInfo = buildIdentity(__dirname);

const statePath = () => path.join(app.getPath("userData"), "sangeetha-state.json");
function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), "utf8"));
  } catch {
    return {};
  }
}

/**
 * Persists the window state.
 *
 * The file is written to a temporary name and then renamed, because a
 * writeFileSync interrupted by a kill or a power loss leaves a truncated JSON
 * file behind. The read above would then discard the whole state — the window
 * position is not critical, but silently losing it on every such quit is.
 * rename() is atomic on the same volume, so the file is always either the old
 * one or the complete new one.
 */
function writeState(patch) {
  const next = Object.assign(readState(), patch);
  const target = statePath();
  const temp = `${target}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(next, null, 2), "utf8");
    fs.renameSync(temp, target);
  } catch (err) {
    log.error("could not persist window state:", err.message);
    try {
      fs.unlinkSync(temp);
    } catch {
      /* the temp file was never created, or is already gone */
    }
  }
}

/**
 * Keeps a restored window on a display that still exists — a remembered
 * position can point at a monitor that has since been unplugged.
 */
function clampToDisplays(bounds) {
  const width = Math.min(bounds.width || DEFAULT_SIZE.width, DEFAULT_SIZE.width * 2);
  const height = Math.min(bounds.height || DEFAULT_SIZE.height, DEFAULT_SIZE.height * 2);
  const area = screen.getDisplayMatching({
    x: bounds.x || 0,
    y: bounds.y || 0,
    width: bounds.width || DEFAULT_SIZE.width,
    height: bounds.height || DEFAULT_SIZE.height,
  }).workArea;

  return {
    width: Math.max(width, MIN_SIZE.width),
    height: Math.max(height, MIN_SIZE.height),
    x: Math.min(Math.max(bounds.x ?? area.x, area.x - 40), area.x + area.width - 80),
    y: Math.min(Math.max(bounds.y ?? area.y, area.y), area.y + area.height - 40),
  };
}

/* ------------------------------------------------------------------ *
 * Window
 * ------------------------------------------------------------------ */

function createWindow() {
  const state = readState();
  const bounds = clampToDisplays({ ...DEFAULT_SIZE, ...pickBounds(state) });

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    alwaysOnTop: false,
    title: "Naada Tarangini",
    icon: path.join(__dirname, "sangeeta_icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "js", "preload.js"),
      // The window is sandboxed, so the preload cannot read the build itself;
      // the identity is handed over here instead.
      additionalArguments: [`--sangeetha-build=${buildInfo.version} ${buildInfo.tag}`],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: true,
      autoplayPolicy: "no-user-gesture-required",
    },
  });

  const win = mainWindow;
  const contents = win.webContents;

  if (staticServer) {
    // loadURL returns a promise that rejects when the page cannot be fetched.
    // Nothing else awaits it, so without a catch an unreachable UI would take
    // the whole application down with an unhandled rejection.
    win.loadURL(pageUrl(staticServer)).then(
      () => noteWindowHealthy(),
      (err) => {
        log.error("could not load the widget UI:", err.message);
        dialog.showErrorBox("Naada Tarangini", `The player interface could not be loaded.\n\n${err.message}`);
      }
    );
  } else {
    // Fallback: the UI still renders without the loopback server.
    win.loadFile(path.join(__dirname, "index.html")).then(
      () => noteWindowHealthy(),
      (err) => {
        log.error("could not load index.html:", err.message);
        dialog.showErrorBox("Naada Tarangini", `index.html could not be loaded.\n\n${err.message}`);
      }
    );
  }

  // Uses the window the event belongs to, not the module-level variable: this
  // can fire after the window has already been destroyed.
  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) win.showInactive();
  });

  const persistBounds = debounce(() => {
    if (win.isDestroyed() || win.isMinimized() || fullBounds) return;
    const [width, height] = win.getSize();
    const [x, y] = win.getPosition();
    writeState({ width, height, x, y });
  }, 500);

  win.on("resize", persistBounds);
  win.on("move", persistBounds);

  // The close button hides to the tray; it never ends the app.
  win.on("close", (event) => {
    if (forceQuit) return;
    event.preventDefault();
    hideToTray();
  });

  // The window is destroyed only when the app is quitting or when something
  // killed it. A destroyed window must never take the player down with it —
  // see scheduleWindowRestore.
  win.on("closed", () => {
    mainWindow = null;
    if (!forceQuit) scheduleWindowRestore("the window was closed unexpectedly");
  });

  // Only warnings and errors are echoed, so a healthy run stays quiet.
  contents.on("console-message", (event) => {
    const detail = (event && event.detail) || event || {};
    const level = detail.level ?? "info";
    if (level === "info" || level === "debug") return;
    if (level === "warning" || level === "warn") log.warn(`[renderer] ${detail.message || ""}`);
    else log.error(`[renderer] ${detail.message || ""}`);
  });

  // A crashed renderer must not leave the app without a window. Recreating it
  // is far better than exiting: the music stops either way, but the player,
  // its tray icon and the desktop shortcut all survive.
  contents.on("render-process-gone", (_event, details) => {
    log.error("the renderer process went away:", details.reason);
    if (!forceQuit) scheduleWindowRestore(`the renderer stopped (${details.reason})`);
  });
  contents.on("unresponsive", () => log.warn("the renderer stopped responding"));
  contents.on("responsive", () => log.info("the renderer is responding again"));

  // External links (e.g. a track on youtube.com) open in the default browser.
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      try {
        const { hostname } = new URL(url);
        if (EXTERNAL_HOSTS.test(hostname)) shell.openExternal(url);
        else log.warn("refused to open an unexpected external link:", hostname);
      } catch {
        log.warn("refused to open a malformed external link");
      }
    }
    return { action: "deny" };
  });

  // Blocks a top-level navigation away from the app's own origin.
  //
  // setWindowOpenHandler only covers window.open() and target=_blank. A link
  // that navigates the *current* frame — a stray anchor without a target, a
  // meta refresh, a script assigning to location — would replace the widget
  // with whatever page it pointed at, and that page would inherit this
  // preload and therefore every IPC channel below, including win:close. The
  // Content-Security-Policy restricts scripts, not top-level navigation, so it
  // does not cover this case.
  contents.on("will-navigate", (event, url) => {
    if (isAppOrigin(url)) return;
    event.preventDefault();
    log.warn("blocked a navigation away from the player:", url);
  });

  // A subframe must not be able to do the same thing either. will-navigate only
  // covers the top-level frame, so this is kept alongside it: this one also
  // fires for a frame that assigns to its own location programmatically.
  contents.on("will-frame-navigate", (details) => {
    if (isAppOrigin(details.url)) return;
    details.preventDefault();
    log.warn(
      `blocked a ${details.isMainFrame ? "top-level" : "sub-frame"} navigation away from the player:`,
      details.url
    );
  });
}

/**
 * True when a URL is the loopback origin this app serves its UI from.
 *
 * The port is random per launch, so it is taken from the running server rather
 * than hard-coded. The file:// fallback (used when the server could not start)
 * is accepted as well, because that is a genuine origin of this app.
 */
function isAppOrigin(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") return true;
    if (parsed.protocol !== "http:") return false;
    if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") return false;
    // No server means the file:// fallback is in use, so no port to compare.
    if (!staticServer) return true;
    return parsed.port === String(staticServer.address().port);
  } catch {
    return false;
  }
}

function pickBounds(state) {
  if (typeof state.x === "number" && typeof state.y === "number") {
    return { x: state.x, y: state.y, width: state.width, height: state.height };
  }
  return { width: state.width || DEFAULT_SIZE.width, height: state.height || DEFAULT_SIZE.height };
}

function showWidget() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  // raise() was removed in Electron 44 and calling it threw a TypeError, so
  // every tray click raised "A JavaScript error occurred in the main process".
  // moveTop() is its replacement.
  if (typeof mainWindow.moveTop === "function") mainWindow.moveTop();
  mainWindow.focus();
}

function hideToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
}

/**
 * The player is meant to stay open until the user closes it, so a window that
 * disappears for any reason other than a requested quit is rebuilt instead of
 * being allowed to end the app.
 *
 * Repeated failures back off and eventually give up, so a window that cannot be
 * created (no display, out of memory) cannot spin forever in a crash loop.
 */
let restoreTimer = null;
let restoreAttempts = 0;
let gaveUpRestoring = false;

function scheduleWindowRestore(reason) {
  if (forceQuit || gaveUpRestoring) return;
  if (mainWindow && !mainWindow.isDestroyed()) return;

  if (restoreAttempts >= MAX_RESTORE_ATTEMPTS) {
    gaveUpRestoring = true;
    log.error(`could not restore the window after ${restoreAttempts} attempts: ${reason}`);
    return;
  }

  restoreAttempts += 1;
  const delay = Math.min(1000 * 2 ** (restoreAttempts - 1), MAX_RESTORE_DELAY);
  log.warn(`rebuilding the window in ${delay}ms — ${reason}`);

  clearTimeout(restoreTimer);
  restoreTimer = setTimeout(() => {
    restoreTimer = null;
    if (forceQuit || gaveUpRestoring) return;
    if (mainWindow && !mainWindow.isDestroyed()) return;
    // createWindow() falls back to loadFile() when the server is not up, so it
    // is safe to call before the loopback server has finished starting.
    if (app.isReady()) createWindow();
  }, delay);
}

/** Called once the window is alive and working again. */
function noteWindowHealthy() {
  restoreAttempts = 0;
  gaveUpRestoring = false;
}

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

/**
 * Rejects an IPC message that did not come from this app's own UI.
 *
 * ipcMain handlers run for *any* renderer in the process. Today the only window
 * loads the loopback origin, but the channels below are privileged: win:close
 * quits the app, app:desktopShortcut spawns PowerShell, yt:stream spawns
 * yt-dlp. If the window were ever navigated to a remote page — or a future
 * change added a webview or an extra window — that page would inherit the
 * preload and could drive all of them. Checking the sender's origin costs one
 * comparison and makes the boundary explicit rather than assumed.
 *
 * The window being the sender is also required, so a stray frame cannot speak.
 */
function assertTrustedSender(event) {
  const frame = event.senderFrame;
  const url = frame ? frame.url : "";
  if (url && isAppOrigin(url)) return;
  if (event.sender === mainWindow && !url) return; // a frame with no URL yet
  log.warn("refused an IPC message from an untrusted sender:", url || "(no url)");
  throw new Error("Refused: this message did not come from the player window");
}

ipcMain.handle("yt:request", (event, payload) => {
  assertTrustedSender(event);
  return handleYtRequest(event, payload);
});

/* Direct audio stream resolution (yt-dlp). */
ipcMain.handle("yt:stream", async (event, track) => {
  assertTrustedSender(event);
  const videoId = String((track && track.videoId) || "").trim();
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error("Invalid YouTube video id");

  // A still-valid cached URL is served without touching the binary, which is
  // what makes a relaunch start playing almost immediately. An invalid id never
  // reaches the cache, because the check above already rejected it.
  const cached = resolver.peekStream(videoId);
  if (cached) return cached;

  if (!resolver.isAvailable()) {
    throw new Error("yt-dlp is not installed — run setup.bat once");
  }
  return resolver.resolveTrack({ ...track, videoId });
});

/* A stream URL the network rejected. The entry is dropped so the retry cannot
   replay the same dead URL. */
ipcMain.handle("yt:forgetStream", (event, videoId) => {
  assertTrustedSender(event);
  const id = String((videoId && videoId.videoId) || "").trim();
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error("Invalid YouTube video id");
  resolver.forgetStream(id);
  return true;
});

ipcMain.handle("yt:status", (event) => {
  assertTrustedSender(event);
  return { ytDlp: resolver.isAvailable(), ytDlpPath: resolver.findYtDlp() || "" };
});

/* Windows desktop shortcut. The main process owns the toggle so the decision
 * is always made from what is really on disk, never from stale UI state. */
ipcMain.handle("app:desktopShortcut", (event) => {
  assertTrustedSender(event);
  return shortcut.toggle();
});
ipcMain.handle("app:desktopShortcutState", (event) => {
  assertTrustedSender(event);
  return shortcut.status();
});

ipcMain.on("win:close", (event) => {
  assertTrustedSender(event);
  forceQuit = true;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  app.quit();
});

/* Mini bar: shrinks toward the bottom-right of the card and restores to that same corner. */
ipcMain.on("win:mini", (event, on) => {
  assertTrustedSender(event);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  const b = mainWindow.getBounds();
  const area = screen.getDisplayMatching(b).workArea;
  if (on && !fullBounds) {
    fullBounds = b;
    mainWindow.setMinimumSize(MINI_SIZE.width, MINI_SIZE.height);
    mainWindow.setBounds({ x: b.x + b.width - MINI_SIZE.width, y: b.y + b.height - MINI_SIZE.height, ...MINI_SIZE });
    mainWindow.setResizable(false);
  } else if (!on && fullBounds) {
    const f = fullBounds;
    fullBounds = null;
    mainWindow.setResizable(true);
    mainWindow.setMinimumSize(MIN_SIZE.width, MIN_SIZE.height);
    mainWindow.setBounds({
      width: f.width,
      height: f.height,
      x: clamp(b.x + b.width - f.width, area.x, area.x + area.width - f.width),
      y: clamp(b.y + b.height - f.height, area.y, area.y + area.height - f.height),
    });
  }
});

/* ------------------------------------------------------------------ *
 * Tray
 * ------------------------------------------------------------------ */

/** Sends to the renderer only while the window and its contents are alive. */
function sendToRenderer(command) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send("player:command", command);
}

function sendShortcutState(present) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send("player:shortcut", present);
}

function buildTray() {
  const iconPath = path.join(__dirname, "sangeeta_icon.png");
  const image = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath).resize({ width: 20, height: 20 }) : null;
  if (!image) {
    log.error("sangeeta_icon.png is missing, the tray icon will be skipped");
    return;
  }
  tray = new Tray(image);
  tray.setToolTip("Naada Tarangini - YouTube Music Player");

  const menu = Menu.buildFromTemplate([
    { label: "Play / Pause", click: () => sendToRenderer("toggle") },
    { label: "Next Track", click: () => sendToRenderer("next") },
    { label: "Previous Track", click: () => sendToRenderer("prev") },
    { type: "separator" },
    { label: "Show / Focus Widget", click: showWidget },
    { label: "Hide to Tray", click: hideToTray },
    { type: "separator" },
    {
      label: "Add / Remove Desktop Shortcut",
      click: () => {
        shortcut
          .toggle()
          .then(({ present }) => {
            if (tray && !tray.isDestroyed()) {
              tray.setToolTip(present ? "Naada Tarangini - desktop shortcut added" : "Naada Tarangini - YouTube Music Player");
            }
            sendShortcutState(present);
          })
          .catch((err) => log.error("desktop shortcut failed:", err.message));
      },
    },
    {
      label: "Quit Naada Tarangini",
      click: () => {
        forceQuit = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
  tray.on("click", showWidget);
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

/**
 * Give each install folder its own user-data directory, and therefore its own
 * single-instance lock.
 *
 * Without this, a copy of the app left in another folder (an old build, a
 * backup, an extracted download) holds the lock, and launching the current one
 * merely focuses that stale window — which looks exactly like the app refusing
 * to update. Now each copy is its own instance and the build badge in the title
 * bar says which one is on screen.
 *
 * Must run before requestSingleInstanceLock().
 */
try {
  const folderTag = crypto
    .createHash("sha1")
    .update(path.resolve(__dirname).toLowerCase())
    .digest("hex")
    .slice(0, 10);
  app.setPath("userData", path.join(app.getPath("appData"), `Sangeetha-${folderTag}`));
} catch (err) {
  log.warn("could not scope user data to this folder:", err.message);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Own taskbar identity instead of "electron".
  app.setAppUserModelId(APP_ID);

  app.on("second-instance", showWidget);

  // Deliberately no "window-all-closed" quit. The player stays open until the
  // user closes it; a window that disappears on its own is rebuilt by
  // scheduleWindowRestore instead of ending the app.

  app.whenReady().then(async () => {
    log.info(`starting Naada Tarangini ${buildInfo.version} (build ${buildInfo.tag})`);

    // Resolved stream URLs are signed and expire, so they are cached on disk
    // with their own deadline. Pointing the resolver at userData has to happen
    // before the first window can ask for a stream.
    try {
      resolver.setCacheFile(path.join(app.getPath("userData"), "stream-cache.json"));
    } catch (err) {
      log.warn("stream cache is unavailable:", err.message);
    }

    try {
      staticServer = await startStaticServer(__dirname);
    } catch (err) {
      log.error("could not start the local UI server:", err.message);
    }
    createWindow();
    buildTray();
    app.on("activate", showWidget);
  });

  // Nothing should escape as an unhandled rejection: a fault is reported, and
  // the process is only ended when continuing would leave the app in a state
  // that is not recoverable.
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled promise rejection:", reason instanceof Error ? reason : String(reason));
  });

  process.on("uncaughtException", (err) => {
    log.error("uncaught exception:", err);
    // A broken pipe or a destroyed stream is survivable: the resource is gone,
    // the player is not, and logger.js has already retired that stream. Only
    // faults that leave the process unable to function are fatal.
    const fatal = new Set(["ENOMEM", "ERR_HEAP_OUT_OF_MEMORY", "EACCES", "EPERM", "EROFS"]);
    if (err && fatal.has(err.code)) {
      app.exit(1);
    }
  });

  // The widget hides to the tray rather than closing, so this only fires on a
  // real quit. Everything is released here, in one place.
  let cleanedUp = false;
  app.on("will-quit", () => {
    if (cleanedUp) return;
    cleanedUp = true;
    forceQuit = true;
    clearTimeout(restoreTimer);
    restoreTimer = null;

    // Stop any in-flight child process so nothing outlives the app.
    resolver.killAll();
    shortcut.killAll();

    if (staticServer) {
      staticServer.close();
      staticServer.closeAllConnections?.();
      staticServer = null;
    }
    if (tray && !tray.isDestroyed()) tray.destroy();
    tray = null;
    mainWindow = null;

    // No timer or late callback may log into a stream that is going away.
    log.shutdown();
  });
}
