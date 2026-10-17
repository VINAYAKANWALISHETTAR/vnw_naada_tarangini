/**
 * preload.js
 * Narrow, context-isolated bridge between the renderer and the Electron
 * main process. Only the calls the widget actually needs are exposed.
 *
 * The window runs with `sandbox: true`, so this file may only require the few
 * modules Node polyfills into a sandboxed preload (electron, events, timers,
 * url). Anything else — fs, crypto, path — has to come from the main process,
 * which passes the build identity in through additionalArguments.
 */

const { contextBridge, ipcRenderer } = require("electron");

/** Read by the main process: --sangeetha-build=<version> <tag>. */
function buildFromArgs(argv) {
  const flag = argv.find((arg) => arg.startsWith("--sangeetha-build="));
  if (!flag) return { version: "1.0.0", tag: "unknown" };
  const [version, tag] = flag.slice("--sangeetha-build=".length).split(" ");
  return { version: version || "1.0.0", tag: tag || "unknown" };
}

/**
 * Invokes a main-process handler and returns a clean error on failure.
 *
 * A handler that throws reaches the renderer as
 * "Error invoking remote method 'yt:stream': Error: Invalid YouTube video id".
 * That prefix is Electron plumbing, and showing it to the user tells them
 * nothing they can act on — so only the part the main process actually chose to
 * say is kept.
 */
function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload).catch((err) => {
    const message = String((err && err.message) || err || "Something went wrong");
    const cleaned = message
      .replace(/^Error invoking remote method '[^']*':\s*/, "")
      .replace(/^(Uncaught )?Error:\s*/, "")
      .trim();
    throw new Error(cleaned || "Something went wrong");
  });
}

contextBridge.exposeInMainWorld("sangeethaDesktop", {
  isDesktop: true,
  platform: process.platform,

  /** Version and build tag, so the running build is always identifiable. */
  build: buildFromArgs(process.argv),

  /** Performs a YouTube InnerTube call in the main process (no CORS issues). */
  yt: (endpoint, body) => invoke("yt:request", { endpoint, body }),

  /** Resolves a YouTube video to a direct, ad-free audio stream URL. */
  stream: (track) => invoke("yt:stream", track),

  /**
   * Reports that a stream URL was rejected, so it is not handed out again.
   * Without this, a retry after an aged-out signature would replay the same
   * dead URL and the track would never start.
   */
  forgetStream: (videoId) => invoke("yt:forgetStream", { videoId }),

  /** Reports whether the local yt-dlp helper is available. */
  status: () => invoke("yt:status"),

  /** Windows desktop shortcut. */
  desktop: {
    /** Flips the shortcut based on what is really on disk. */
    toggle: () => invoke("app:desktopShortcut"),
    state: () => invoke("app:desktopShortcutState"),
  },

  window: {
    close: () => ipcRenderer.send("win:close"),
    setMini: (on) => ipcRenderer.send("win:mini", !!on),
  },

  /** Commands coming from the system tray menu. */
  onCommand: (handler) => {
    const listener = (_event, command) => handler(command);
    ipcRenderer.on("player:command", listener);
    return () => ipcRenderer.removeListener("player:command", listener);
  },

  /** Fires when the tray menu toggles the desktop shortcut. */
  onShortcut: (handler) => {
    const listener = (_event, present) => handler(present);
    ipcRenderer.on("player:shortcut", listener);
    return () => ipcRenderer.removeListener("player:shortcut", listener);
  },
});
