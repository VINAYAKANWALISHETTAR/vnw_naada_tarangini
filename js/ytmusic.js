/**
 * ytmusic.js
 * YouTube data layer — search and direct-link resolving, the same features the
 * desktop widget pulls from `ytmusicapi`.
 *
 * Everything runs against YouTube's public InnerTube endpoint, so no API key,
 * login or cookies are required.
 *
 * This one file is used in three places, so the YouTube parsing below is
 * written exactly once:
 *
 *  - Desktop (Electron): the renderer parses YouTube's own JSON, which the main
 *    process fetched for it (see preload.js / yt-proxy.js). This is how it has
 *    always worked and it is unchanged.
 *  - Web (browser on a real origin): the browser asks this origin's own
 *    backend for the finished result over /api/search and /api/metadata, so
 *    YouTube's markup is parsed on the server and the browser never talks to
 *    YouTube at all.
 *  - Node (the backend itself): required directly, with the InnerTube call
 *    injected, which is how it serves the two endpoints above.
 *
 * The wrapper at the bottom is what lets the same body be a browser global and
 * a CommonJS module; there is no second copy of the parsing to drift.
 */

(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.sangeetha = api;
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  const API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
  const BASE = "https://www.youtube.com/youtubei/v1/";
  const CLIENT = {
    clientName: "WEB",
    clientVersion: "2.20240101.00.00",
    hl: "en",
    gl: "US",
  };
  const BROWSER_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  // Deliberately unused by the fetch below. It was passed as a header there,
  // where a browser drops it as a forbidden header name, so it could never do
  // anything; the desktop path sets the same UA in yt-proxy.js instead.

  const bridge = (root && root.sangeethaDesktop) || null;

  /**
   * Same origin that serves this page, when the page is on a real web origin.
   *
   * Empty in Electron, in Node, and for a page opened straight off disk. On a
   * deployed web app it is set, and search/resolve go through this server's own
   * API instead of reaching YouTube from the browser — YouTube answers a
   * browser origin with 403, and the loopback preview cannot search either, so
   * the API is the only thing that works in a normal browser.
   */
  const apiBase =
    !bridge && typeof location !== "undefined" && /^https?:$/.test(location.protocol)
      ? location.origin
      : "";

  /* ----------------------------- transport ----------------------------- */

  /**
   * The Node backend injects `sangeethaTransport` before requiring this file, so
   * the server parses YouTube's JSON with exactly this code rather than keeping
   * a second implementation of the renderers above.
   */
  function nodeTransport() {
    return root && typeof root.sangeethaTransport === "function" ? root.sangeethaTransport : null;
  }

  /**
   * Direct-to-YouTube fallback, used only when the page was opened straight off
   * disk, where `Origin: null` is answered with a permissive CORS header.
   *
   * Two things were wrong here. The fetch had no timeout at all, so a request
   * that never answered left the search button spinning indefinitely. And it set
   * `Origin` and `User-Agent`, which a browser silently drops as forbidden
   * header names — so it could not make the request look like a desktop client
   * even in principle.
   *
   * The request cannot succeed from any other browser origin. Measured against
   * the live endpoint: a http://127.0.0.1 origin is answered with 403 and no
   * Access-Control-Allow-Origin header, while Origin: null — what a file:// page
   * sends — is answered 200 with `access-control-allow-origin: null`.
   */
  const BROWSER_TIMEOUT = 12000;

  /** Reads a JSON reply from this origin's backend, turning failures into plain messages. */
  async function apiGet(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(`${apiBase}${path}`, {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        signal: controller.signal,
      });
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        // A non-JSON body from an /api/ path means the origin is serving
        // something that is not this app's backend — most often index.html,
        // because the request fell through to the static file handler. Saying
        // "not valid JSON" would be technically true and completely useless; the
        // useful thing to say is that there is no server here to ask.
        throw new Error("This page has no search server behind it — open the site, or run run.bat");
      }
      if (!response.ok) {
        throw new Error((data && data.error) || `The server replied ${response.status}`);
      }
      return data;
    } catch (err) {
      if (err && err.name === "AbortError") throw new Error("The server did not answer in time");
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function post(endpoint, body) {
    if (bridge && typeof bridge.yt === "function") {
      return bridge.yt(endpoint, body);
    }

    const injected = nodeTransport();
    if (injected) return injected(endpoint, body);

    if (typeof location === "undefined" || location.protocol !== "file:") {
      throw new Error("YouTube does not allow requests from this origin");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BROWSER_TIMEOUT);
    try {
      const response = await fetch(`${BASE}${endpoint}?key=${API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`YouTube replied ${response.status}`);
      return await response.json();
    } catch (err) {
      if (err && err.name === "AbortError") throw new Error("YouTube did not answer in time");
      throw err;
    } finally {
      // Released on every path, including the abort, so a slow answer cannot
      // leave a timer behind.
      clearTimeout(timer);
    }
  }

  const context = (extra) => Object.assign({ client: Object.assign({}, CLIENT) }, extra || {});

  /* ------------------------------ helpers ------------------------------ */

  const isObject = (value) => value !== null && typeof value === "object";

  /** Depth-first collection of every value stored under `key`. */
  function collect(node, key, out = []) {
    if (Array.isArray(node)) {
      for (const item of node) collect(item, key, out);
    } else if (isObject(node)) {
      for (const name of Object.keys(node)) {
        if (name === key && isObject(node[name]) && !Array.isArray(node[name])) out.push(node[name]);
        collect(node[name], key, out);
      }
    }
    return out;
  }

  const text = (node) => {
    if (!node) return "";
    if (typeof node === "string") return node;
    if (node.simpleText) return node.simpleText;
    if (Array.isArray(node.runs)) return node.runs.map((run) => run.text || "").join("");
    if (node.content) return node.content;
    return "";
  };

  const firstOf = (node, keys) => {
    for (const key of keys) {
      if (node && node[key]) return node[key];
    }
    return null;
  };

  function largestThumb(sources) {
    if (!Array.isArray(sources) || !sources.length) return "";
    return sources.reduce((best, item) => {
      const width = (item && item.width) || 0;
      return width > ((best && best.width) || 0) ? item : best;
    }, sources[0]).url;
  }

  function thumbnailFor(videoId, quality = "hqdefault") {
    return `https://i.ytimg.com/vi/${videoId}/${quality}.jpg`;
  }

  function parseDuration(raw) {
    if (typeof raw === "number" && isFinite(raw)) return raw;
    const value = String(raw || "").trim();
    if (/^\d+$/.test(value)) return Number(value);
    const parts = value.split(":").map(Number);
    if (parts.some(Number.isNaN)) return 0;
    return parts.reduce((acc, part) => acc * 60 + part, 0);
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    if (mins >= 60) {
      return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    }
    return `${mins}:${String(secs).padStart(2, "0")}`;
  }

  /** Strips the decorations YouTube adds to official/verified channel names. */
  function cleanArtist(value) {
    return String(value || "")
      .replace(/^Go to channel\s*/i, "")
      .replace(/\s*•\s*$/, "")
      .trim();
  }

  const JUNK =
    /\b(lyrics?|reaction|review|tutorial|unofficial|karaoke|nightcore|sleep|asmr|full album|greatest hits|top \d+|playlist|1 hour|loop|visualizer|sped up|slowed|reverb|8d audio)\b/i;

  /** YouTube Music mix/playlist ids — they are not directly playable videos. */
  const isPlayableId = (id) => /^[A-Za-z0-9_-]{11}$/.test(id) && !/^(RD|OLAK5uy_)/.test(id);

  /** Keeps search results that plausibly are songs, drops the usual noise. */
  function looksLikeTrack(track) {
    if (!track.title || !track.artist) return false;
    if (!isPlayableId(track.videoId)) return false;
    if (/^mix\s*-\s*/i.test(track.title)) return false;
    if (JUNK.test(track.title)) return false;
    if (track.seconds && track.seconds > 15 * 60) return false;
    if (track.seconds && track.seconds < 45) return false;
    return true;
  }

  /* ------------------------------ parsing ------------------------------ */

  function fromVideoRenderer(node) {
    const videoId = node.videoId;
    if (!videoId) return null;
    const title = text(node.title);
    const artist =
      text(node.longBylineText) ||
      text(node.shortBylineText) ||
      text(node.ownerText) ||
      "YouTube Music";
    const rawLength = text(node.lengthText);
    const thumb =
      largestThumb((node.thumbnail && node.thumbnail.thumbnails) || []) ||
      thumbnailFor(videoId);
    return {
      videoId,
      title,
      artist: cleanArtist(artist),
      duration: formatDuration(parseDuration(rawLength)),
      seconds: parseDuration(rawLength),
      thumb,
    };
  }

  function fromLockupViewModel(node) {
    const videoId = node.contentId;
    if (!videoId) return null;
    if (node.contentType && !/VIDEO/i.test(node.contentType)) return null;

    const meta = (node.metadata && node.metadata.lockupMetadataViewModel) || {};
    const title = text(meta.title);
    const thumb =
      largestThumb(collect(node.contentImage || {}, "sources")) || thumbnailFor(videoId);

    let duration = "";
    for (const badge of collect(node, "thumbnailBadgeViewModel")) {
      if (badge.text && /^\d+(:\d+)*$/.test(badge.text)) duration = badge.text;
    }

    // Channel name: either the avatar's accessibility label or the first
    // metadata row underneath the title.
    let artist = cleanArtist(
      (meta.image && meta.image.decoratedAvatarViewModel && meta.image.decoratedAvatarViewModel.a11yLabel) || ""
    );
    if (!/^\w/.test(artist)) {
      artist = "";
      for (const label of collect(meta, "a11yLabel")) {
        if (/^Go to channel/i.test(String(label))) {
          artist = cleanArtist(String(label));
          break;
        }
      }
    }
    if (!artist) {
      const rows =
        (meta.metadata &&
          meta.metadata.contentMetadataViewModel &&
          meta.metadata.contentMetadataViewModel.metadataRows) ||
        [];
      for (const row of rows) {
        for (const part of row.metadataParts || []) {
          const value = text(part);
          if (value && !/^\d+(:\d+)*$/.test(value) && !/view|ago|stream/i.test(value)) {
            artist = cleanArtist(value);
            break;
          }
        }
        if (artist) break;
      }
    }

    return {
      videoId,
      title,
      artist: artist || "YouTube Music",
      duration: formatDuration(parseDuration(duration)),
      seconds: parseDuration(duration),
      thumb,
    };
  }

  function readTrack(node) {
    if (!isObject(node)) return null;
    if (node.videoRenderer) return fromVideoRenderer(node.videoRenderer);
    if (node.lockupViewModel) return fromLockupViewModel(node.lockupViewModel);
    if (node.videoId && (node.title || node.lengthText)) return fromVideoRenderer(node);
    return null;
  }

  /* ------------------------------- search ------------------------------ */

  async function search(query, limit = 20) {
    const term = String(query || "").trim();
    if (!term) return [];

    // On the deployed web app the server does the InnerTube call and runs this
    // same parsing, so the browser receives finished tracks. Electron and the
    // Node server itself fall through to the code below.
    if (apiBase) {
      const data = await apiGet(`/api/search?q=${encodeURIComponent(term)}&limit=${limit}`);
      return Array.isArray(data && data.results) ? data.results : [];
    }

    const data = await post("search", {
      context: context(),
      query: term,
    });

    const primary =
      (data.contents &&
        data.contents.twoColumnSearchResultsRenderer &&
        data.contents.twoColumnSearchResultsRenderer.primaryContents &&
        data.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer) ||
      null;

    const nodes = [];
    if (primary && Array.isArray(primary.contents)) {
      for (const section of primary.contents) {
        const items = section.itemSectionRenderer && section.itemSectionRenderer.contents;
        if (Array.isArray(items)) nodes.push(...items);
      }
    }
    if (!nodes.length) nodes.push(...collect(data, "videoRenderer").map((r) => ({ videoRenderer: r })));

    const results = [];
    const seen = new Set();
    for (const node of nodes) {
      const track = readTrack(node);
      if (!track || seen.has(track.videoId) || !looksLikeTrack(track)) continue;
      seen.add(track.videoId);
      results.push(track);
      if (results.length >= limit) break;
    }
    return results;
  }

  /* ----------------------------- resolving ----------------------------- */

  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

  function parseVideoId(input) {
    const value = String(input || "").trim();
    if (!value) return "";
    if (VIDEO_ID.test(value)) return value;
    const match = value.match(
      /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|v\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
    );
    return match ? match[1] : "";
  }

  /** Fetches title/artist/cover for a pasted YouTube link or bare video id. */
  async function resolve(input) {
    const videoId = parseVideoId(input);
    if (!videoId) return null;

    // Same split as search(): a web origin asks its own backend.
    if (apiBase) {
      const data = await apiGet(`/api/metadata?input=${encodeURIComponent(videoId)}`);
      return data && data.track ? data.track : null;
    }

    let meta = {};
    try {
      const data = await post("player", { context: context(), videoId });
      const details = data.videoDetails || {};
      if (details.title) {
        meta = {
          title: details.title,
          artist: cleanArtist(details.author || "YouTube"),
          seconds: Number(details.lengthSeconds) || 0,
        };
      }
    } catch {
      /* fall through to the watch-page lookup below */
    }

    if (!meta.title) {
      try {
        const data = await post("next", { context: context(), videoId });
        const primary = collect(data, "videoPrimaryInfoRenderer")[0] || {};
        const secondary = collect(data, "videoSecondaryInfoRenderer")[0] || {};
        const owner = collect(secondary, "videoOwnerRenderer")[0] || {};
        meta = {
          title: text(primary.title) || "YouTube Track",
          artist: cleanArtist(text(owner.title) || "YouTube"),
          seconds: parseDuration(text((data.microformat && data.microformat.playerMicroformatRenderer) || {}).replace(/[^0-9:]/g, "")),
        };
      } catch {
        meta = { title: "YouTube Track", artist: "YouTube", seconds: 0 };
      }
    }

    return {
      videoId,
      title: meta.title || "YouTube Track",
      artist: meta.artist || "YouTube",
      duration: formatDuration(meta.seconds || 0),
      seconds: meta.seconds || 0,
      thumb: thumbnailFor(videoId),
    };
  }

  return {
    search,
    resolve,
    parseVideoId,
    isDesktop: !!(bridge && bridge.isDesktop),
    /** True when this copy is talking to a backend over HTTP rather than IPC. */
    isWeb: !!apiBase,
  };
});
