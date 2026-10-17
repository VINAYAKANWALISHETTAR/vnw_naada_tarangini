/**
 * desktop-shortcut.js
 * Creates (or removes) a Windows desktop shortcut for the player.
 *
 * PowerShell's WScript.Shell is used because it is the only dependency-free
 * way to write a proper .lnk from Node — no native module, no extra install.
 * The helper is only spawned on an explicit user click, never at startup.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const log = require("./logger");

/**
 * The project root: this file lives in js/, but the app is the whole folder.
 *
 * It matters most here. `args` in a shortcut is the directory Electron is
 * launched with, and Electron reads package.json from it — pointing at js/ would
 * produce a shortcut that starts a window with no application in it.
 */
const PROJECT_ROOT = path.join(__dirname, "..");

const SHORTCUT_NAME = "Naada Tarangini.lnk";
const SCRIPT_TIMEOUT = 20000;
const MAX_OUTPUT = 8 * 1024;

const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

/** Every live PowerShell helper, so quitting cannot leave one behind. */
const live = new Set();

/**
 * Resolved inside PowerShell so OneDrive-redirected desktops are handled.
 * UTF-8 output encoding keeps non-ASCII paths (the project folder is Naada Tarangini)
 * intact when PowerShell answers over a redirected pipe.
 */
function psScript(body) {
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop ${quote(SHORTCUT_NAME)}
$shell = New-Object -ComObject WScript.Shell
${body}
Write-Output $lnk
`.trim();
}

/** Terminates any in-flight helper. Called on quit. */
function killAll() {
  for (const child of live) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
  live.clear();
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    // Explicit pipes: the child must never inherit the Electron stdio handles,
    // otherwise a hung PowerShell keeps the parent's output pipe open and a
    // late write lands on a broken pipe.
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }
    );
    live.add(child);

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      live.delete(child);
      fn(value);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(reject, new Error("Windows took too long to answer"));
    }, SCRIPT_TIMEOUT);

    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk;
    });
    // A killed helper can emit 'error' on its pipes; unhandled, that would
    // terminate the app.
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});

    child.on("error", (err) => finish(reject, err));
    child.on("close", (code, signal) => {
      if (code === 0) {
        finish(resolve, stdout.trim());
      } else {
        const message = (stderr || stdout).split(/\r?\n/).filter(Boolean).pop() || "";
        log.warn(`PowerShell exited with code=${code} signal=${signal}: ${message.trim() || "(no output)"}`);
        finish(reject, new Error(message.replace(/^[^:]+:\s*/, "").trim() || "Windows refused the request"));
      }
    });
  });
}

function electronBinary() {
  const name = process.platform === "win32" ? "electron.exe" : "electron";
  return path.join(PROJECT_ROOT, "node_modules", "electron", "dist", name);
}

/**
 * Where the shortcut should point. `args` is the raw command line; create()
 * quotes it for PowerShell.
 *
 * On Windows it goes through run.bat (window minimised) instead of electron.exe
 * directly, because a .lnk cannot set environment variables: when
 * ELECTRON_RUN_AS_NODE is set, electron.exe boots as a plain Node process and
 * exits with no window and no error. run.bat already clears that variable, and
 * it also covers the very first launch, where the dependencies are still
 * missing. A VBScript shim was tried instead but .vbs has no file association on
 * some Windows installs, which pops up an "unknown file type" alert.
 */
function shortcutTarget() {
  // The installed app is a single exe: point straight at it.
  let packaged = false;
  try {
    packaged = !!require("electron").app.isPackaged;
  } catch {
    /* plain Node, not Electron */
  }
  if (packaged) {
    return { target: process.execPath, args: "", workdir: path.dirname(process.execPath), style: 1 };
  }

  if (process.platform !== "win32") {
    const binary = electronBinary();
    if (fs.existsSync(binary)) {
      return { target: binary, args: PROJECT_ROOT, workdir: PROJECT_ROOT, style: 1 };
    }
  }

  const runBat = path.join(PROJECT_ROOT, "run.bat");
  if (fs.existsSync(runBat)) {
    return {
      target: process.env.ComSpec || "cmd.exe",
      // cmd needs the batch path quoted: the project folder contains a space.
      args: `/c "${runBat}"`,
      workdir: PROJECT_ROOT,
      style: 7,
    };
  }

  // Nothing but the raw binary to point at.
  return { target: electronBinary(), args: PROJECT_ROOT, workdir: PROJECT_ROOT, style: 1 };
}

async function create() {
  const { target, args, workdir, style } = shortcutTarget();
  const icon = path.join(PROJECT_ROOT, "sangeeta_icon.png");
  const lnk = await runPowerShell(psScript(`
$shortcut = $shell.CreateShortcut($lnk)
$shortcut.TargetPath = ${quote(target)}
$shortcut.Arguments = ${quote(args)}
$shortcut.WorkingDirectory = ${quote(workdir)}
$shortcut.WindowStyle = ${style}
$shortcut.IconLocation = ${quote(fs.existsSync(icon) ? icon : target + ",0")}
$shortcut.Description = 'Sangeetha - floating YouTube Music player'
$shortcut.Save()
`));
  return { present: true, path: lnk };
}

async function remove() {
  const lnk = await runPowerShell(psScript(`
if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force }
`));
  return { present: false, path: lnk };
}

/** Reports the real desktop path and whether the shortcut is on disk. */
async function status() {
  try {
    const out = await runPowerShell(`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) ${quote(SHORTCUT_NAME)}
Write-Output $lnk
if (Test-Path -LiteralPath $lnk) { Write-Output 'yes' } else { Write-Output 'no' }
`.trim());
    const [lnk, flag = "no"] = out.split(/\r?\n/);
    return { present: flag.trim().toLowerCase() === "yes", path: (lnk || "").trim() };
  } catch (err) {
    // Reported rather than silently assumed absent: an unreadable desktop would
    // otherwise make the button claim the shortcut is not there.
    log.warn("could not read the desktop shortcut state:", err.message);
    return { present: false, path: "" };
  }
}

// A single PowerShell round trip at a time: two fast clicks must not race.
let queue = Promise.resolve();
function serialise(task) {
  const result = queue.then(task, task);
  queue = result.then(
    () => {},
    () => {}
  );
  return result;
}

/**
 * Adds the shortcut when missing and removes it when present. The decision is
 * taken from what is actually on disk, so the UI can never drift out of sync.
 */
function toggle() {
  return serialise(async () => {
    const { present } = await status();
    const result = present ? await remove() : await create();
    log.info(`desktop shortcut ${result.present ? "added" : "removed"}: ${result.path}`);
    return result;
  });
}

module.exports = { create, remove, toggle, status, killAll };
