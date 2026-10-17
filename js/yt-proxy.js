/**
 * yt-proxy.js
 * Single place where YouTube InnerTube requests are executed, so both the
 * app (electron-main.js) and the smoke test share the exact same behaviour.
 */

const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const INNERTUBE_BASE = "https://www.youtube.com/youtubei/v1/";
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const REQUEST_TIMEOUT = 20000;
const MAX_BODY = 256 * 1024;
/** Responses are InnerTube JSON, which is tens of KB. Anything vastly larger is
 *  an error page or a hostile reply, and reading it in full would spike memory. */
const MAX_RESPONSE = 8 * 1024 * 1024;

/** Reads a fetch body with a hard ceiling, so a huge reply cannot exhaust memory. */
async function readCapped(response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE) {
    throw new Error("YouTube returned an unexpectedly large reply");
  }
  if (!response.body) return await response.text();

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_RESPONSE) {
        await reader.cancel();
        throw new Error("YouTube returned an unexpectedly large reply");
      }
      chunks.push(value);
    }
  } finally {
    // A cancelled or errored read leaves the stream open otherwise.
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function handleYtRequest(_event, payload) {
  const { endpoint, body } = payload && typeof payload === "object" ? payload : {};

  // The renderer is the only caller, but the endpoint is interpolated into a
  // URL and the body is sent to a third party, so both are validated here.
  if (typeof endpoint !== "string" || !/^[a-zA-Z]+$/.test(endpoint)) {
    throw new Error("Invalid InnerTube endpoint");
  }
  if (body !== undefined && body !== null && typeof body !== "object") {
    throw new Error("Invalid request body");
  }
  let serialised;
  try {
    serialised = JSON.stringify(body === undefined ? {} : body);
  } catch {
    throw new Error("The request body could not be serialised");
  }
  if (serialised.length > MAX_BODY) throw new Error("The request body is too large");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const response = await fetch(`${INNERTUBE_BASE}${endpoint}?key=${INNERTUBE_KEY}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": DESKTOP_UA,
        "Accept-Language": "en-US,en;q=0.9",
        "Origin": "https://www.youtube.com",
        "Referer": "https://www.youtube.com/",
      },
      body: serialised,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`YouTube replied ${response.status}`);
    const text = await readCapped(response);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("YouTube returned a reply that was not valid JSON");
    }
  } catch (err) {
    if (err.name === "AbortError") throw new Error("YouTube request timed out");
    throw err;
  } finally {
    // Always released, including on abort, so a slow request cannot leave a
    // timer behind to fire into a stream that may already be closed.
    clearTimeout(timer);
  }
}

module.exports = { handleYtRequest };
