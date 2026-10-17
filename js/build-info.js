/**
 * build-info.js
 * Identity of the build on disk: the version from package.json plus a short
 * tag hashed from the files that make up the UI.
 *
 * The tag is what makes an out-of-date window obvious. It changes as soon as
 * any UI file is edited, so the widget can show which build is actually
 * running instead of leaving a cached copy to be mistaken for a current one.
 *
 * This lives in the main process on purpose: the renderer runs sandboxed, where
 * the preload may not require fs or crypto.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/** The files that define what the user sees. */
const UI_FILES = ["index.html", "js/main.js", "style.css", "js/ytmusic.js", "js/preload.js"];

function buildIdentity(root) {
  let version = "1.0.0";
  try {
    version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  } catch {
    /* keep the default */
  }

  const hash = crypto.createHash("sha1");
  for (const name of UI_FILES) {
    try {
      const data = fs.readFileSync(path.join(root, name));
      hash.update(name).update(String(data.length)).update(data);
    } catch {
      hash.update(name).update("missing");
    }
  }

  return { version, tag: hash.digest("hex").slice(0, 7) };
}

module.exports = { buildIdentity };
