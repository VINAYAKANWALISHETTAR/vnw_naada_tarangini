/**
 * main.js
 * Naada Tarangini — floating YouTube Music desktop player.
 *
 * Keeps the original coverflow music-player design and adds:
 *  - YouTube Music searching (and direct YouTube link support)
 *  - Ad-free audio streamed straight from YouTube (resolved with yt-dlp in the
 *    main process), so official music videos that block embedding still play
 *  - A dedicated "Auto" button that plays the next track automatically
 *  - Volume slider + mute control
 *  - An always-on-top floating desktop window with minimise / pin / snap / quit
 *  - An up-next list that holds only what was deliberately chosen: the loaded
 *    track, plus anything played from a search result
 *
 * Performance notes: playback uses a single <audio> element, the carousel is
 * only rebuilt when the queue really changes, the progress bar is driven by a
 * requestAnimationFrame loop that stops while paused, and nothing polls in the
 * background.
 */

(() => {
  "use strict";

  const bridge = window.sangeethaDesktop || null;
  const isDesktop = !!(bridge && bridge.isDesktop);
  document.body.classList.toggle("is-web", !isDesktop);

  /**
   * True on the deployed website: no Electron bridge, and this origin serves the
   * API itself. It is the same page as the widget, so the only real difference
   * is how the privileged work is requested — over HTTP here, over IPC there.
   */
  const isWebsite =
    !isDesktop && typeof location !== "undefined" && /^https?:$/.test(location.protocol);

  /**
   * Calls this origin's own API.
   *
   * The same-origin check is not paranoia about CORS: there is nothing to be
   * afraid of cross-origin here. It exists so that a file:// page, or a copy
   * opened from somewhere unexpected, fails with a plain message instead of
   * firing requests that can only 404.
   */
  function webApi(path, { method = "GET" } = {}) {
    if (!isWebsite) {
      return Promise.reject(new Error("This feature needs the desktop app or the website"));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    return fetch(path, { method, headers: { Accept: "application/json" }, signal: controller.signal })
      .then(async (response) => {
        const text = await response.text();
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          // A non-JSON body from an /api/ path means the origin is not serving
          // this app's backend — the request most likely fell through to the
          // static file handler and came back as HTML. "Not valid JSON" is
          // accurate and tells the user nothing; this names the actual problem.
          throw new Error("This page has no streaming server behind it — open the site, or run run.bat");
        }
        if (!response.ok) throw new Error((data && data.error) || `The server replied ${response.status}`);
        return data;
      })
      .catch((err) => {
        if (err && err.name === "AbortError") throw new Error("The server did not answer in time");
        throw err;
      })
      .finally(() => clearTimeout(timer));
  }

  const $ = (selector) => document.querySelector(selector);

  const els = {
    title: $("#trackTitle"),
    artist: $("#trackArtist"),
    progress: $("#progress"),
    currentTime: $("#currentTime"),
    totalTime: $("#totalTime"),
    controlIcon: $("#controlIcon"),
    playPause: $(".play-pause-btn"),
    forward: $(".controls button.forward"),
    backward: $(".controls button.backward"),
    audio: $("#song"),
    volume: $("#volume"),
    mute: $("#muteBtn"),
    autoNext: $("#autoNextBtn"),
    shuffle: $("#shuffleBtn"),
    repeat: $("#repeatBtn"),
    favorite: $("#favBtn"),
    libraryBtn: $("#libraryBtn"),
    libraryPanel: $("#libraryPanel"),
    libraryList: $("#libraryList"),
    libraryClose: $("#libraryClose"),
    tabQueue: $("#tabQueue"),
    tabFavs: $("#tabFavs"),
    tabHistory: $("#tabHistory"),
    queueCount: $("#queueCount"),
    favCount: $("#favCount"),
    libraryFoot: $("#libraryFoot"),
    clearQueue: $("#clearQueueBtn"),
    searchInput: $("#searchInput"),
    searchBtn: $("#searchBtn"),
    searchStatus: $("#searchStatus"),
    searchResults: $("#searchResults"),
    swiperWrapper: $("#swiperWrapper"),
    toast: $("#toast"),
    minimize: $("#minimizeBtn"),
    miniBar: $("#miniBar"),
    miniCover: $("#miniCover"),
    miniTitle: $("#miniTitle"),
    miniArtist: $("#miniArtist"),
    miniPlay: $("#miniPlay"),
    miniPlayIcon: $("#miniPlayIcon"),
    miniPrev: $("#miniPrev"),
    miniNext: $("#miniNext"),
    miniExpand: $("#miniExpand"),
    close: $("#closeBtn"),
    desktop: $("#desktopBtn"),
    buildBadge: $("#buildBadge"),
    brand: $("#brand"),
    installPanel: $("#installPanel"),
    installClose: $("#installClose"),
    installPwa: $("#installPwa"),
    installPwaLabel: $("#installPwaLabel"),
    downloadWindows: $("#downloadWindows"),
    windowsNote: $("#windowsNote"),
  };

  /**
   * The app's own name, read from the title bar rather than written out here.
   *
   * Keeping the Kannada spelling in exactly one place — the markup — means it
   * cannot drift between the window title, the media session and the docs, which
   * is how two near-identical spellings got mixed up in the first place. The
   * Font Awesome icon contributes no text content, so this is the bare name.
   */
  const APP_NAME = (els.brand.textContent || document.title).trim() || "Sangeetha";

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */

  /**
   * The startup list: seven Kannada songs, one card each.
   *
   * This is Sangeetha's permanent default library, not a placeholder, so each
   * entry was re-checked against YouTube and corrected. The earlier artist
   * strings were wrong: they led with the album name and then listed composers
   * that were not always the credited ones — "His Aura Hits You" was credited to
   * Yogaraj Bhat when the video actually credits Vishal Mishra and Santhosh
   * Venky. `artist` is now the credited artist, and the film is `album`.
   *
   * `videoId` is the only authoritative field: it is what yt-dlp resolves to a
   * real audio stream, so the audio can never be wrong even if a title drifts.
   * Durations are what YouTube reports.
   *
   * `thumb` points at the copy in assets/covers/ rather than at i.ytimg.com.
   * The remote host is not always reachable — it is blocked on some networks and
   * subject to regional blocking — and a default library whose artwork silently
   * disappears is worse than one that carries its own. The remote URL is kept as
   * thumbRemote so a sharper original can still be fetched when it is
   * available; see the `onerror` fallback in createSlide().
   */
  const DEFAULT_PLAYLIST = [
    {
      videoId: "f2vB9CLbqIc",
      title: "Aaradha Gaaya",
      artist: "Vishal Mishra, Yogaraj Bhat",
      album: "Toxic (Kannada)",
      seconds: 352,
      thumb: "assets/covers/f2vB9CLbqIc.jpg",
      thumbRemote: "https://i.ytimg.com/vi/f2vB9CLbqIc/maxresdefault.jpg",
    },
    {
      videoId: "x9VXlf0j980",
      title: "Tabaahi",
      artist: "Vishal Mishra, Yogaraj Bhat",
      album: "Toxic (Kannada)",
      seconds: 268,
      thumb: "assets/covers/x9VXlf0j980.jpg",
      thumbRemote: "https://i.ytimg.com/vi/x9VXlf0j980/maxresdefault.jpg",
    },
    {
      videoId: "0NAJX4DrXv0",
      title: "Manamohaka",
      artist: "Tanishk, Arslan, Faheem",
      album: "Toxic (Kannada)",
      seconds: 195,
      thumb: "assets/covers/0NAJX4DrXv0.jpg",
      thumbRemote: "https://i.ytimg.com/vi/0NAJX4DrXv0/maxresdefault.jpg",
    },
    {
      videoId: "CUdJ-n2l1Hk",
      title: "His Aura Hits You",
      artist: "Vishal Mishra, Santhosh Venky",
      album: "Toxic (Kannada)",
      seconds: 174,
      thumb: "assets/covers/CUdJ-n2l1Hk.jpg",
      thumbRemote: "https://i.ytimg.com/vi/CUdJ-n2l1Hk/maxresdefault.jpg",
    },
    {
      videoId: "pUK8-1JtC0M",
      title: "Maharaya",
      artist: "Vishal Mishra, Jonita Gandhi, Yogaraj Bhat",
      album: "Toxic (Kannada)",
      seconds: 156,
      thumb: "assets/covers/pUK8-1JtC0M.jpg",
      thumbRemote: "https://i.ytimg.com/vi/pUK8-1JtC0M/maxresdefault.jpg",
    },
    {
      videoId: "DeV43VUG1aY",
      title: "Blood On Blood",
      artist: "Ravi Basrur",
      album: "Toxic - Kannada",
      seconds: 98,
      thumb: "assets/covers/DeV43VUG1aY.jpg",
      thumbRemote: "https://i.ytimg.com/vi/DeV43VUG1aY/maxresdefault.jpg",
    },
    {
      videoId: "Y_tzn4vM3ks",
      title: "Punyathma",
      artist: "Rockline Venkatesh, V. Harikrishna",
      album: "KAATERA",
      seconds: 195,
      thumb: "assets/covers/Y_tzn4vM3ks.jpg",
      thumbRemote: "https://i.ytimg.com/vi/Y_tzn4vM3ks/maxresdefault.jpg",
    },
  ];

  /**
   * Turns a library entry into what the UI renders, without mutating it.
   *
   * A copy matters because the queue is reordered (shuffle), trimmed, and
   * written to storage; mutating the shared constant would corrupt the default
   * library for the rest of the session.
   */
  const fromLibrary = (entry) => ({
    videoId: entry.videoId,
    title: entry.title,
    artist: entry.artist,
    album: entry.album,
    seconds: entry.seconds,
    duration: formatTime(entry.seconds),
    thumb: entry.thumb,
    thumbRemote: entry.thumbRemote,
    source: "library",
  });

  const store = {
    get(key, fallback) {
      try {
        const value = localStorage.getItem("sangeetha." + key);
        return value === null ? fallback : JSON.parse(value);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem("sangeetha." + key, JSON.stringify(value));
      } catch {
        /* storage disabled — settings simply will not persist */
      }
    },
  };

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */

  let toastTimer = null;
  function toast(message, isError = false) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    els.toast.classList.toggle("is-error", isError);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.hidden = true;
    }, 3200);
  }

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function formatTime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    if (mins >= 60) {
      return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    }
    return `${mins}:${String(secs).padStart(2, "0")}`;
  }

  function setStatus(message) {
    if (els.searchStatus.textContent !== message) {
      els.searchStatus.textContent = message;
    }
  }

  /** Debounced so dragging a slider never hits localStorage synchronously. */
  function debounce(fn, wait) {
    let timer = 0;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  const persistVolume = debounce((value) => store.set("volume", value), 400);

  /**
   * Player state.
   *
   * Declared after the helpers rather than before them because building the
   * startup queue calls formatTime. A `const` used before its initialiser runs
   * throws a ReferenceError, and this object is a const, so it has to come
   * after the functions it depends on.
   */
  const state = {
    // The list starts as the seven Kannada songs, so the app opens with
    // something to show and next walks through them in order. Beyond those it
    // only ever holds what was deliberately chosen: tracks played from a
    // search. The player used to pull YouTube "Up Next" recommendations on
    // every track change, so tracks the user never chose appeared on their own
    // and started playing by themselves. That is gone — see playAt() and next().
    //
    // fromLibrary() copies each entry, so reordering the queue (shuffle) or
    // trimming it cannot corrupt the shared DEFAULT_PLAYLIST constant.
    queue: DEFAULT_PLAYLIST.map(fromLibrary),
    index: 0,
    autoplay: store.get("autoplay", true),
    volume: store.get("volume", 85),
    muted: false,
    seeking: false,
    loading: false,
    /** True while the decoder stalls mid-track, as opposed to the initial load. */
    buffering: false,
    lastVolume: store.get("volume", 85),

    /** "off" | "one" | "all" — see the repeat button in the volume row. */
    repeat: store.get("repeat", "off"),
    /** When on, next() picks a random track rather than the following one. */
    shuffle: store.get("shuffle", false),
    /**
     * The queue in its natural order, kept so turning shuffle off can put the
     * list back the way it was instead of leaving it randomly permuted.
     */
    orderedQueue: null,
    /** Video ids the user has starred, newest last. */
    favorites: store.get("favorites", []),
    /** Recently played video ids, newest first, for the history panel. */
    history: store.get("history", []),
  };

  state.orderedQueue = state.queue.slice();

  const current = () => state.queue[state.index] || null;

  /* ------------------------------------------------------------------ *
   * Playback
   * ------------------------------------------------------------------ */

  let loadToken = 0;
  let frame = 0;
  let lastPaintSecond = -1;
  let loadWatchdog = 0;

  /** A resolved stream that never starts must not leave the controls locked. */
  const LOAD_WATCHDOG = 20000;

  const audio = els.audio;

  /* Resolved stream URLs, keyed by video id. Keeps the ~4 s yt-dlp lookup off
     the critical path: the current and next track are resolved in advance. */
  const streamCache = new Map();
  const pendingStreams = new Map();
  const CACHE_LIMIT = 12;

  /* The list now only grows when the user plays something from a search, but
     there is still no ceiling: the queue array and one carousel slide per track
     would grow without bound, and Swiper has to lay out every slide on each
     update. */
  const QUEUE_LIMIT = 120;

  function cacheStream(videoId, url) {
    if (streamCache.size >= CACHE_LIMIT) {
      streamCache.delete(streamCache.keys().next().value);
    }
    streamCache.set(videoId, url);
  }

  /**
   * A stream URL the network rejected, remembered so the retry below knows it
   * must resolve afresh instead of handing the same dead URL back. Bounded like
   * the caches: a long session must not grow it without limit.
   */
  const rejectedStreams = new Set();
  const REJECTED_LIMIT = 24;

  function dropStream(videoId) {
    streamCache.delete(videoId);
    pendingStreams.delete(videoId);
    rejectedStreams.add(videoId);
    if (rejectedStreams.size > REJECTED_LIMIT) {
      rejectedStreams.delete(rejectedStreams.values().next().value);
    }
  }

  function resolveStream(track, { fresh = false } = {}) {
    const videoId = track.videoId;

    // Checked here as well as in the main process. A malformed id would
    // otherwise come back as a raw "Error invoking remote method 'yt:stream':
    // Error: Invalid YouTube video id", which tells the user nothing and is not
    // something they can act on.
    if (!/^[A-Za-z0-9_-]{11}$/.test(String(videoId || ""))) {
      return Promise.reject(new Error("That link is not a playable YouTube video"));
    }

    if (fresh) {
      // A retry is explicitly asking for a new URL, so the rejection marker and
      // any cached entry for this id are cleared first.
      streamCache.delete(videoId);
      rejectedStreams.delete(videoId);
    } else if (rejectedStreams.has(videoId)) {
      return Promise.reject(new Error("That stream was rejected — retrying"));
    }

    if (streamCache.has(videoId)) return Promise.resolve(streamCache.get(videoId));
    if (pendingStreams.has(videoId)) return pendingStreams.get(videoId);

    // Two transports, one contract. Electron answers over IPC; the website
    // answers the same question over HTTP from its own backend, which runs the
    // same yt-dlp resolver. Resolving needs a child process and a signed URL, so
    // there is no third option — a browser cannot do it on its own.
    const ask = bridge && typeof bridge.stream === "function"
      ? bridge.stream({ videoId, title: track.title, artist: track.artist })
      : webApi(`/api/stream?videoId=${encodeURIComponent(videoId)}`);

    const task = ask
      .then((resolved) => {
        cacheStream(resolved.videoId || videoId, resolved.url);
        return resolved.url;
      })
      .finally(() => pendingStreams.delete(videoId));

    pendingStreams.set(videoId, task);
    return task;
  }

  /**
   * One scheduled warm-up per video id, keyed by id.
   *
   * This was a single timer, and warming the current track was immediately
   * followed by warming the next one — so the second call cleared the first and
   * the very press the prewarm exists for still waited the full lookup.
   */
  const prewarmTimers = new Map();

  /**
   * Warms a track's stream so pressing play feels instant.
   *
   * Resolving a YouTube stream through yt-dlp takes around five seconds, and
   * that is what the user waits for on a first press. Doing it ahead of time
   * moves the wait off the critical path: the loaded track is warmed as soon as
   * the window opens, and the next one after each change.
   */
  function prewarm(track, delay) {
    if (!isDesktop || !track) return;
    // A URL that was already rejected must not be warmed back in; the retry
    // needs a genuinely new one.
    if (rejectedStreams.has(track.videoId)) return;
    if (streamCache.has(track.videoId) || pendingStreams.has(track.videoId)) return;

    cancelPrewarm(track.videoId);
    prewarmTimers.set(
      track.videoId,
      setTimeout(() => {
        prewarmTimers.delete(track.videoId);
        resolveStream(track).catch(() => {});
      }, delay)
    );
  }

  function cancelPrewarm(videoId) {
    const timer = prewarmTimers.get(videoId);
    if (timer === undefined) return;
    clearTimeout(timer);
    prewarmTimers.delete(videoId);
  }

  /** Drops every scheduled warm-up — the queue changed and they no longer apply. */
  function cancelAllPrewarms() {
    for (const timer of prewarmTimers.values()) clearTimeout(timer);
    prewarmTimers.clear();
  }

  /** Warms the track that is loaded now, so the first play does not wait. */
  function prewarmCurrent(delay = 700) {
    prewarm(current(), delay);
  }

  /**
   * Warms the tracks just ahead, staggered.
   *
   * Skipping forward two or three cards is as common as pressing next, and each
   * un-warmed track still costs the full lookup. The delays are spread out on
   * purpose: every entry here is a real yt-dlp process, and starting them all at
   * once makes each one slower rather than making the app feel more ready.
   */
  function prewarmUpcoming(delays = [1500]) {
    delays.forEach((delay, offset) => {
      prewarm(state.queue[state.index + 1 + offset], delay);
    });
  }

  function isPlaying() {
    return !audio.paused && !audio.ended && audio.readyState > 0;
  }

  function play() {
    const attempt = audio.play();
    if (attempt && typeof attempt.catch === "function") {
      attempt.catch(() => {
        /* autoplay blocked before the first user gesture */
      });
    }
  }

  function stopFrameLoop() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  }

  function startFrameLoop() {
    if (frame) return;
    const tick = () => {
      paintProgress();
      frame = audio.paused ? 0 : requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  }

  /** Only touches the DOM when something actually changed. */
  function paintProgress() {
    const duration = audio.duration;
    const time = audio.currentTime || 0;
    if (duration && els.progress.max !== duration) {
      els.progress.max = duration;
      els.totalTime.textContent = formatTime(duration);
    }
    if (!state.seeking && Math.abs(els.progress.value - time) > 0.04) {
      els.progress.value = time;
    }
    const second = Math.floor(time);
    if (second !== lastPaintSecond) {
      lastPaintSecond = second;
      els.currentTime.textContent = formatTime(time);
    }
  }

  function renderPlayState(playing) {
    els.controlIcon.classList.toggle("fa-pause", playing);
    els.controlIcon.classList.toggle("fa-play", !playing);
    els.miniPlayIcon.classList.toggle("fa-pause", playing);
    els.miniPlayIcon.classList.toggle("fa-play", !playing);
    if ("mediaSession" in navigator) {
      navigator.mediaSession.playbackState = playing ? "playing" : "paused";
    }
  }

  function setLoading(loading) {
    state.loading = loading;
    els.playPause.classList.toggle("is-loading", loading);
    if (!loading) {
      clearTimeout(loadWatchdog);
      loadWatchdog = 0;
    }
  }

  /**
   * The loading state is normally released by the first audio event, but a
   * stream that stalls without reporting an error fires none of them — and since
   * togglePlay() ignores clicks while loading, the play button would then stay
   * dead for the rest of the session. This releases it regardless.
   */
  function armLoadWatchdog(token) {
    clearTimeout(loadWatchdog);
    loadWatchdog = setTimeout(() => {
      loadWatchdog = 0;
      if (token !== loadToken) return;
      if (audio.readyState > 0 || isPlaying()) return;
      setLoading(false);
      renderPlayState(false);
    }, LOAD_WATCHDOG);
  }

  /**
   * Resolves a direct YouTube audio stream and hands it to the <audio> element.
   *
   * There is no bundled-sample fallback any more: the sample files the player
   * used to ship were Western tracks, so falling back to them for a Kannada one
   * would have played the wrong song. A track that cannot be streamed now says
   * so plainly instead of quietly playing something else.
   */
  async function loadTrack(track, autoplay = true) {
    if (!track) return;
    const token = ++loadToken;
    setLoading(true);

    setStatus("Resolving YouTube stream…");
    const cached = streamCache.has(track.videoId);
    if (cached) setStatus("");
    try {
      // One retry with a freshly resolved URL. Stream URLs are signed and time
      // limited, so a URL that worked minutes ago can be rejected with a 403 by
      // the time the audio element asks for it — and the only cure is a new one.
      // Without this the track simply never started, which is the stall this
      // retry exists to end.
      let url;
      try {
        url = await resolveStream(track);
      } catch (firstErr) {
        if (!/rejected/i.test(firstErr.message) || !bridge || typeof bridge.stream !== "function") {
          throw firstErr;
        }
        setStatus("Stream expired — resolving again…");
        url = await resolveStream(track, { fresh: true });
      }
      if (token !== loadToken) return;

      track.streamUrl = url;
      audio.src = url;
      if (autoplay) play();
      setStatus("");
      armLoadWatchdog(token);
    } catch (err) {
      if (token !== loadToken) return;
      setStatus("");
      setLoading(false);
      renderPlayState(false);
      toast(err.message || "This track could not be played", true);
      return;
    }
    // The loaded track is settled, so only the next one is worth warming.
    cancelAllPrewarms();
    prewarmUpcoming([1500, 6000]);
  }

  function playAt(index, autoplay = true) {
    if (index < 0 || index >= state.queue.length) return;
    state.index = index;
    const track = current();
    // One stream retry per play, so a genuinely broken track cannot loop.
    if (track) delete track.retriedStream;
    renderTrack();
    scrollToIndex(index);
    loadTrack(track, autoplay);
    // Recorded here, not when the audio actually starts: this is the point the
    // listener asked for a track, which is what a history of "what did I play"
    // should mean. It is also the only place that runs for every track change,
    // including the repeat-one restart.
    rememberPlayed(track);
    // Nothing is added to the queue here. Tracks join it only when the user
    // plays one from a search result (playFromSearch).
  }

  function togglePlay() {
    if (state.loading) return;
    if (isPlaying()) {
      audio.pause();
    } else if (audio.src) {
      play();
    } else {
      playAt(state.index);
    }
  }

  /**
   * Picks the index to play next, honouring shuffle and repeat.
   *
   * Kept apart from next() because "which track is next" and "what happens when
   * there is no next track" are different questions, and the ended handler needs
   * the answer without the announcement.
   */
  function nextIndex({ fromEnded = false } = {}) {
    const total = state.queue.length;
    if (!total) return -1;

    // Repeat one restarts the current track, but only when a track reached its
    // end on its own. Honouring it for a manual Next would trap the listener on
    // one song with no way forward except turning it off.
    if (state.repeat === "one" && fromEnded) return state.index;

    if (state.shuffle && total > 1) {
      // A single random pick can land back on the current track, which reads as
      // "next did nothing". Redrawing keeps the skip meaningful.
      let pick = state.index;
      for (let attempt = 0; attempt < 8 && pick === state.index; attempt += 1) {
        pick = Math.floor(Math.random() * total);
      }
      if (pick !== state.index) return pick;
    }

    if (state.index + 1 < total) return state.index + 1;

    // Past the end. Repeat all wraps around; otherwise the list is finished.
    if (state.repeat === "all" && total) return 0;
    return -1;
  }

  function next({ manual = true, fromEnded = false } = {}) {
    if (!state.queue.length) return;
    const target = nextIndex({ fromEnded });
    if (target >= 0) {
      playAt(target);
      return;
    }
    // End of the list. The player used to fetch YouTube recommendations here
    // and start one, so the app kept generating music on its own. It now stops
    // and says so, and auto play stops with it.
    setStatus("End of your list");
    if (manual) toast("End of your list — search to add more");
  }

  function previous() {
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    if (state.shuffle && state.queue.length > 1) {
      const target = Math.floor(Math.random() * state.queue.length);
      if (target !== state.index) {
        playAt(target);
        return;
      }
    }
    if (state.index > 0) {
      playAt(state.index - 1);
    } else {
      audio.currentTime = 0;
    }
  }

  /* ------------------------------------------------------------------ *
   * Repeat, shuffle, favourites, history
   * ------------------------------------------------------------------ */

  const REPEAT_ORDER = ["off", "all", "one"];
  const REPEAT_LABEL = { off: "Repeat off", all: "Repeat all", one: "Repeat one" };

  function cycleRepeat() {
    const nextMode = REPEAT_ORDER[(REPEAT_ORDER.indexOf(state.repeat) + 1) % REPEAT_ORDER.length];
    state.repeat = nextMode;
    store.set("repeat", nextMode);
    renderModes();
    toast(REPEAT_LABEL[nextMode]);
  }

  /**
   * Turns shuffle on or off.
   *
   * The natural order is kept in state.orderedQueue, so switching shuffle off
   * restores the list the user built instead of leaving it randomly permuted —
   * which is what a naive shuffle does, and it makes the carousel jump around
   * for no reason the listener can see.
   */
  function toggleShuffle() {
    state.shuffle = !state.shuffle;
    store.set("shuffle", state.shuffle);
    const playing = current();

    if (state.shuffle) {
      state.orderedQueue = state.queue.slice();
      // Fisher-Yates. A sort by Math.random() is not uniform, and this runs over
      // at most a couple of hundred entries, so the cost does not matter.
      for (let i = state.queue.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
      }
    } else if (state.orderedQueue) {
      state.queue = state.orderedQueue.slice();
    }

    // Keep playing the same track across the reorder, otherwise toggling shuffle
    // silently changes what is playing.
    if (playing) {
      const found = state.queue.findIndex((t) => t.videoId === playing.videoId);
      state.index = found >= 0 ? found : 0;
      buildSwiper(state.index);
      renderTrack();
    }
    renderModes();
    toast(state.shuffle ? "Shuffle on" : "Shuffle off");
  }

  function isFavorite(videoId) {
    return state.favorites.includes(videoId);
  }

  function toggleFavorite() {
    const track = current();
    if (!track) return;
    const id = track.videoId;
    if (isFavorite(id)) {
      state.favorites = state.favorites.filter((entry) => entry !== id);
      toast(`Removed ${track.title} from favourites`);
    } else {
      // Newest last, and bounded: an unbounded list here would grow localStorage
      // without limit over a long-running widget.
      state.favorites = [...state.favorites, id].slice(-200);
      toast(`Saved ${track.title} to favourites`);
    }
    store.set("favorites", state.favorites);
    renderModes();
  }

  const HISTORY_LIMIT = 40;

  function rememberPlayed(track) {
    if (!track) return;
    // Re-playing a track moves it to the front rather than adding a duplicate.
    state.history = [track.videoId, ...state.history.filter((id) => id !== track.videoId)].slice(
      0,
      HISTORY_LIMIT
    );
    store.set("history", state.history);
  }

  /* ------------------------------------------------------------------ *
   * Queue management
   * ------------------------------------------------------------------ */

  /**
   * Removes one track from the queue.
   *
   * Removing something other than the playing track just drops it. Removing the
   * track that is playing would otherwise change the audio mid-song with no
   * indication of why, so the list advances to whatever now sits in that
   * position and says what happened.
   */
  function removeFromQueue(index) {
    if (index < 0 || index >= state.queue.length) return;
    const wasPlaying = index === state.index;
    const removed = state.queue[index];

    state.queue.splice(index, 1);
    if (state.orderedQueue) {
      const at = state.orderedQueue.findIndex((t) => t.videoId === removed.videoId);
      if (at >= 0) state.orderedQueue.splice(at, 1);
    }

    if (!state.queue.length) {
      // The last track is gone, so there is nothing to play and nothing to play
      // *to*. Halting here is not the removed stop button: it is the only way to
      // avoid leaving audio running for a queue that no longer exists.
      state.index = 0;
      audio.pause();
      stopFrameLoop();
      setLoading(false);
      renderPlayState(false);
      buildSwiper(0);
      renderTrack();
      toast("Queue cleared");
      return;
    }

    if (wasPlaying) {
      const target = Math.min(index, state.queue.length - 1);
      state.index = target;
      playAt(target);
      // The list carries on with whatever is now at this position. Silently
      // carrying on is what made the old toast ("Stopped …") a lie, and
      // stopping outright would drop the listener out of a queue they are
      // still listening to.
      toast(`Moved on from ${removed.title}`);
      return;
    }

    // Removing something before the playhead shifts it down by one; removing
    // something after it leaves the index alone. Getting this wrong is what
    // makes a deleted item skip a track.
    if (index < state.index) state.index -= 1;
    buildSwiper(state.index);
    renderTrack();
    toast(`Removed ${removed.title}`);
  }

  function clearQueue() {
    if (!state.queue.length) return;
    // The default library is not the user's queue, so clearing leaves the seven
    // Kannada songs in place rather than an empty player.
    const library = DEFAULT_PLAYLIST.map(fromLibrary);
    state.queue = library;
    state.orderedQueue = library.slice();
    state.index = 0;
    playAt(0);
    toast("Queue reset to the 7 Kannada songs");
  }

  /**
   * Puts a search result straight after the current track.
   *
   * "Play next" and "Add to queue" are the two things a listener actually wants
   * from a search result, and neither existed.
   */
  function playNext(track) {
    insertIntoQueue(track, state.index + 1);
    toast(`${track.title} will play next`);
  }

  function addToQueue(track) {
    insertIntoQueue(track, state.queue.length);
    toast(`Added ${track.title} to the queue`);
  }

  function insertIntoQueue(track, at) {
    const existing = state.queue.findIndex((t) => t.videoId === track.videoId);
    if (existing >= 0) state.queue.splice(existing, 1);
    const position = clamp(at, 0, state.queue.length);
    state.queue.splice(position, 0, track);
    if (existing >= 0 && existing < state.index) state.index -= 1;
    trimQueue();
    buildSwiper(state.index);
    renderTrack();
  }

  /* ------------------------------------------------------------------ *
   * Library panel
   * ------------------------------------------------------------------ */

  const TABS = ["queue", "favorites", "history"];
  let activeTab = "queue";

  function toggleLibrary(force) {
    const shouldOpen = typeof force === "boolean" ? force : els.libraryPanel.hidden;
    if (!shouldOpen) {
      els.libraryPanel.hidden = true;
      return;
    }
    els.libraryPanel.hidden = false;
    renderLibrary();
  }

  function renderLibrary() {
    if (els.libraryPanel.hidden) return;

    // Favourites and history are stored as bare video ids to keep localStorage
    // small. They are looked up against the queue, so an id whose track has
    // left the queue is simply skipped rather than rendered as a blank row.
    const byId = new Map(state.queue.map((track) => [track.videoId, track]));

    let rows = [];
    if (activeTab === "queue") {
      rows = state.queue.map((track, index) => ({
        track,
        index,
        playing: index === state.index,
      }));
    } else {
      const ids = activeTab === "favorites" ? state.favorites : state.history;
      rows = ids
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((track) => ({ track, index: state.queue.findIndex((t) => t.videoId === track.videoId) }));
    }

    els.queueCount.textContent = String(state.queue.length);
    els.favCount.textContent = String(state.favorites.length);
    // The reset button only makes sense on the queue tab.
    els.libraryFoot.hidden = activeTab !== "queue" || state.queue.length === 0;

    els.libraryList.innerHTML = "";
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "library-empty";
      empty.textContent =
        activeTab === "queue"
          ? "Your queue is empty."
          : activeTab === "favorites"
            ? "No favourites yet. Tap the heart while a track plays."
            : "Nothing played yet.";
      els.libraryList.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const row of rows) {
      fragment.appendChild(libraryRow(row.track, row.index, row.playing));
    }
    els.libraryList.appendChild(fragment);
  }

  function libraryRow(track, index, playing) {
    const row = document.createElement("div");
    row.className = "library-row";
    if (playing) row.classList.add("is-playing");

    const cover = document.createElement("img");
    cover.className = "library-cover";
    cover.src = track.thumb || `https://i.ytimg.com/vi/${track.videoId}/hqdefault.jpg`;
    cover.alt = "";
    cover.loading = "lazy";
    cover.decoding = "async";
    cover.addEventListener("error", () => {
      cover.src = `https://i.ytimg.com/vi/${track.videoId}/hqdefault.jpg`;
    });
    row.appendChild(cover);

    const text = document.createElement("div");
    text.className = "library-text";
    const name = document.createElement("strong");
    name.textContent = track.title;
    const meta = document.createElement("span");
    meta.textContent = `${track.artist || "YouTube Music"}${
      track.duration ? ` · ${track.duration}` : ""
    }`;
    text.appendChild(name);
    text.appendChild(meta);
    row.appendChild(text);

    // Only the queue tab can remove anything: favourites and history are
    // derived from the same data and a remove button there would be a lie.
    if (activeTab === "queue") {
      const remove = document.createElement("button");
      remove.className = "library-remove";
      remove.type = "button";
      remove.title = `Remove ${track.title} from the queue`;
      remove.setAttribute("aria-label", remove.title);
      remove.innerHTML = '<i class="fa-solid fa-xmark"></i>';
      remove.addEventListener("click", () => removeFromQueue(index));
      row.appendChild(remove);
    }

    // A row that is no longer in the queue has index -1, so it is played by id
    // rather than by position.
    row.addEventListener("click", () => {
      if (index >= 0) {
        playAt(index);
      } else {
        const at = state.queue.findIndex((t) => t.videoId === track.videoId);
        if (at >= 0) playAt(at);
      }
    });

    return row;
  }

  function setActiveTab(tab) {
    if (!TABS.includes(tab)) return;
    activeTab = tab;
    const buttons = { queue: els.tabQueue, favorites: els.tabFavs, history: els.tabHistory };
    for (const [name, button] of Object.entries(buttons)) {
      const isActive = name === tab;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-selected", String(isActive));
    }
    renderLibrary();
  }


  /* ------------------------------------------------------------------ *
   * Volume
   * ------------------------------------------------------------------ */

  function setVolume(value, { persist = true } = {}) {
    state.volume = clamp(Math.round(value), 0, 100);
    if (state.volume > 0) state.lastVolume = state.volume;
    state.muted = state.volume === 0;
    audio.volume = state.volume / 100;
    audio.muted = state.muted;
    if (persist) persistVolume(state.volume);
    renderVolume();
  }

  function toggleMute() {
    if (state.muted) {
      setVolume(state.lastVolume || 60);
    } else {
      state.lastVolume = state.volume;
      state.muted = true;
      audio.muted = true;
      renderVolume();
    }
  }

  function renderVolume() {
    const level = state.muted ? 0 : state.volume;
    els.volume.value = level;
    const icon = els.mute.querySelector("i");
    icon.className =
      level === 0 ? "fa-solid fa-volume-xmark" : level < 45 ? "fa-solid fa-volume-low" : "fa-solid fa-volume-high";
    els.mute.classList.toggle("is-muted", state.muted || level === 0);
  }

  function toggleAutoplay() {
    state.autoplay = !state.autoplay;
    store.set("autoplay", state.autoplay);
    renderAutoplay();
    toast(state.autoplay ? "Auto play next: ON" : "Auto play next: OFF");
  }

  function renderAutoplay() {
    els.autoNext.classList.toggle("is-on", state.autoplay);
    els.autoNext.title = state.autoplay ? "Auto play next: ON" : "Auto play next: OFF";
  }

  /**
   * Renders the four small mode buttons: shuffle, repeat, favourite and stop.
   *
   * Grouped because they all read from state and are painted on the same
   * occasions, and splitting them meant each one had to remember to update the
   * heart when the track changed.
   */
  function renderModes() {
    els.shuffle.classList.toggle("is-on", state.shuffle);
    els.shuffle.setAttribute("aria-pressed", String(state.shuffle));
    els.shuffle.title = state.shuffle ? "Shuffle: ON" : "Shuffle: OFF";

    els.repeat.classList.toggle("is-on", state.repeat !== "off");
    els.repeat.setAttribute("aria-pressed", String(state.repeat !== "off"));
    els.repeat.title = REPEAT_LABEL[state.repeat];

    // Repeat one needs a different glyph, otherwise "off", "all" and "one" are
    // the same button with a colour change and the mode is unreadable.
    els.repeat.innerHTML =
      state.repeat === "one"
        ? '<i class="fa-solid fa-repeat"></i><span class="repeat-one">1</span>'
        : '<i class="fa-solid fa-repeat"></i>';

    const track = current();
    const faved = Boolean(track) && isFavorite(track.videoId);
    els.favorite.classList.toggle("is-on", faved);
    els.favorite.setAttribute("aria-pressed", String(faved));
    els.favorite.innerHTML = faved
      ? '<i class="fa-solid fa-heart"></i>'
      : '<i class="fa-regular fa-heart"></i>';
    els.favorite.title = faved ? "Remove from favourites" : "Save to favourites";
  }

  /* ------------------------------------------------------------------ *
   * Coverflow carousel
   * ------------------------------------------------------------------ */

  let swiper = null;

  /**
   * Swiper and its stylesheet are loaded from a CDN. If that CDN cannot be
   * reached the constructor never appears, and building the carousel unguarded
   * threw out of init() — which left the widget half-built with an error in the
   * log and no covers at all. The carousel is decoration; losing it must not
   * cost the player itself, so it falls back to a plain scrollable strip and
   * playback, search and the controls carry on exactly as before.
   */
  const hasSwiper = typeof window.Swiper === "function";

  /** Centres a slide: through Swiper when it is there, natively when it is not. */
  function scrollToIndex(index) {
    if (swiper) {
      swiper.slideTo(index, 0, false);
      return;
    }
    const slides = els.swiperWrapper.children;
    for (const child of slides) child.classList.remove("swiper-slide-active");
    const slide = slides[index];
    if (!slide) return;
    // Swiper marks the active slide for the hover overlay; without it the plain
    // strip needs the same hint or the cover link never becomes visible.
    slide.classList.add("swiper-slide-active");
    const left = slide.offsetLeft - (els.swiperWrapper.clientWidth - slide.offsetWidth) / 2;
    if (typeof els.swiperWrapper.scrollTo === "function") {
      els.swiperWrapper.scrollTo({ left, behavior: "smooth" });
    } else {
      els.swiperWrapper.scrollLeft = left;
    }
  }

  function buildSwiper(activeIndex) {
    if (swiper) {
      swiper.destroy(true, true);
      swiper = null;
    }
    els.swiperWrapper.innerHTML = "";
    els.swiperWrapper.classList.toggle("is-plain", !hasSwiper);

    const fragment = document.createDocumentFragment();
    state.queue.forEach((track, index) => {
      fragment.appendChild(createSlide(track, index));
    });
    els.swiperWrapper.appendChild(fragment);

    if (!hasSwiper) {
      scrollToIndex(clamp(activeIndex, 0, Math.max(0, state.queue.length - 1)));
      return;
    }

    swiper = new window.Swiper(".swiper", {
      effect: "coverflow",
      centeredSlides: true,
      initialSlide: clamp(activeIndex, 0, Math.max(0, state.queue.length - 1)),
      slidesPerView: "auto",
      allowTouchMove: false,
      watchSlidesProgress: false,
      spaceBetween: 40,
      coverflowEffect: {
        rotate: 25,
        stretch: 0,
        depth: 50,
        modifier: 1,
        slideShadows: false,
      },
    });
  }

  /**
   * Caps the list once it grows past QUEUE_LIMIT.
   *
   * The overflow is taken off the *end*, not the front. A track played from a
   * search is prepended, so the list only ever grows at the head while the
   * playhead stays put — dropping from the front would have meant either
   * removing the track being played or removing nothing at all, and the list
   * would have grown without limit. The tail holds the oldest entries, which are
   * the ones least likely to be wanted.
   *
   * The current track and everything before it are never touched, so the index
   * cannot shift and the carousel does not move.
   */
  function trimQueue() {
    const excess = state.queue.length - QUEUE_LIMIT;
    // Never touch the track being played or anything before it, so the amount
    // that can actually go is bounded by the number of entries after the
    // playhead.
    const afterPlayhead = state.queue.length - state.index - 1;
    const removable = Math.min(excess, afterPlayhead);
    if (removable <= 0) return;

    // Kept so the restorable natural order drops the same tracks. Without this,
    // turning shuffle off after a long session would put every trimmed track
    // back and undo the cap the trimming exists to enforce.
    const trimmed = state.queue.splice(state.index + 1, removable);
    if (state.orderedQueue) {
      const dropped = new Set(trimmed.map((track) => track.videoId));
      state.orderedQueue = state.orderedQueue.filter((track) => !dropped.has(track.videoId));
    }

    if (swiper) {
      // Swiper re-indexes after a removal, so the dropped slides are found by
      // counting from the last one backwards.
      for (let i = 0; i < removable; i += 1) swiper.removeSlide(swiper.slides.length - 1);
      swiper.update();
    } else {
      for (let i = 0; i < removable; i += 1) {
        const last = els.swiperWrapper.lastElementChild;
        if (!last) break;
        last.remove();
      }
    }

    // Indices after the playhead shifted, so the recorded positions are restated
    // from the DOM. Clicking reads the live position, but leaving a stale
    // data-index behind would make the markup lie about the list.
    const slides = els.swiperWrapper.children;
    for (let i = 0; i < slides.length; i += 1) {
      slides[i].setAttribute("data-index", String(i));
    }
  }

  function createSlide(track, index) {
    const slide = document.createElement("div");
    slide.className = "swiper-slide";
    slide.setAttribute("data-index", String(index));

    const img = document.createElement("img");
    img.referrerPolicy = "no-referrer";
    // Covers are tried local -> remote -> a smaller remote, and only then is the
    // slide left as a placeholder. The local copy is what makes the default
    // library reliable: i.ytimg.com is blocked on some networks, and a silent
    // failure there used to leave all seven cards blank with nothing in the log.
    img.addEventListener("error", () => {
      const stage = Number(img.dataset.fallback || "0");
      if (stage === 0 && track.thumbRemote) {
        img.dataset.fallback = "1";
        img.src = track.thumbRemote;
        return;
      }
      if (stage <= 1) {
        img.dataset.fallback = "2";
        img.src = `https://i.ytimg.com/vi/${track.videoId}/hqdefault.jpg`;
        return;
      }
      // Nothing worked. Say so on the slide rather than showing a broken image.
      img.dataset.fallback = "3";
      img.removeAttribute("src");
      slide.classList.add("is-cover-missing");
    });
    img.src = track.thumb || `https://i.ytimg.com/vi/${track.videoId}/maxresdefault.jpg`;
    img.alt = track.title;
    // Deliberately not lazy. There are only ever a handful of covers, and
    // Swiper's coverflow moves slides with 3D transforms, which stops the
    // browser's lazy-loading from ever deciding the images are on screen — the
    // covers simply never loaded. The saving was never worth that.
    img.decoding = "async";
    slide.appendChild(img);

    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const link = document.createElement("a");
    link.href = `https://www.youtube.com/watch?v=${track.videoId}`;
    link.title = track.title;
    link.innerHTML = '<ion-icon name="logo-youtube"></ion-icon>';
    link.addEventListener("click", (event) => {
      event.preventDefault();
      // The index is read at click time, not captured when the slide was made:
      // trimQueue() drops slides from the end and shifts positions, so a captured
      // index could point at a different track once that has happened.
      playAt(Array.prototype.indexOf.call(els.swiperWrapper.children, slide));
    });
    overlay.appendChild(link);
    slide.appendChild(overlay);

    return slide;
  }

  function renderTrack() {
    const track = current();
    if (!track) return;
    els.title.textContent = track.title;
    els.artist.textContent = track.artist || "YouTube Music";
    els.miniTitle.textContent = track.title;
    els.miniArtist.textContent = track.artist || "YouTube Music";
    if (track.thumb && els.miniCover.getAttribute("src") !== track.thumb) els.miniCover.src = track.thumb;
    document.title = `${track.title} · ${track.artist || "YouTube Music"}`;
    updateMediaSession(track);
    scrollToIndex(state.index);
    // The heart reflects the current track and the panel highlights the row
    // that is playing, so both follow every track change.
    renderModes();
    renderLibrary();
  }

  function updateMediaSession(track) {
    if (!("mediaSession" in navigator) || !track) return;
    try {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: track.title,
        artist: track.artist || "YouTube Music",
        // The film, where the track reports one. Search results carry
        // no album, so it falls back to the app name.
        album: track.album || APP_NAME,
        artwork: [{ src: track.thumb, sizes: "480x480", type: "image/jpeg" }],
      });
    } catch {
      /* the artwork host may reject the URL — metadata is optional */
    }
  }

  /* ------------------------------------------------------------------ *
   * Search
   * ------------------------------------------------------------------ */

  let searchToken = 0;
  let resultItems = [];
  let resultCursor = -1;

  function hideResults() {
    els.searchResults.hidden = true;
    els.searchResults.innerHTML = "";
    resultItems = [];
    resultCursor = -1;
  }

  /**
   * Normalises a search result into a queue entry.
   *
   * The parser already returns the right fields, so this is a light copy that
   * adds what the queue needs on top: the remote-thumbnail fallback, so a
   * search result also survives i.ytimg.com being unreachable, and a `source`
   * marker so the UI can tell a queued search track from one of the seven.
   */
  const fromSearch = (track) => ({
    videoId: track.videoId,
    title: track.title,
    artist: track.artist,
    album: track.album || "",
    seconds: Number(track.seconds) || 0,
    duration: track.duration || formatTime(track.seconds),
    thumb: track.thumb || `https://i.ytimg.com/vi/${track.videoId}/maxresdefault.jpg`,
    thumbRemote: `https://i.ytimg.com/vi/${track.videoId}/maxresdefault.jpg`,
    source: "search",
  });

  function renderResults(results) {
    els.searchResults.innerHTML = "";
    resultItems = [];
    if (!results.length) {
      hideResults();
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const track of results) {
      const item = document.createElement("li");
      item.tabIndex = -1;

      const img = document.createElement("img");
      img.src = track.thumb;
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      item.appendChild(img);

      const text = document.createElement("div");
      text.className = "result-text";
      const strong = document.createElement("strong");
      strong.textContent = track.title;
      const span = document.createElement("span");
      span.textContent = track.artist || "YouTube Music";
      text.appendChild(strong);
      text.appendChild(span);
      item.appendChild(text);

      // A result can be played, put straight after the current track, or parked
      // at the end of the list. Clicking the row plays; these do the other two
      // without discarding the results, because searching again to find the same
      // song is the part that was missing.
      const actions = document.createElement("div");
      actions.className = "result-actions";
      actions.appendChild(
        actionButton("fa-forward-step", "Play next", (event) => {
          event.stopPropagation();
          playNext(fromSearch(track));
          hideResults();
        })
      );
      actions.appendChild(
        actionButton("fa-plus", "Add to queue", (event) => {
          event.stopPropagation();
          addToQueue(fromSearch(track));
          hideResults();
        })
      );
      item.appendChild(actions);

      const duration = document.createElement("span");
      duration.className = "result-duration";
      duration.textContent = track.duration || "";
      item.appendChild(duration);

      item.addEventListener("click", () => playFromSearch(track));
      fragment.appendChild(item);
      resultItems.push(item);
    }
    els.searchResults.appendChild(fragment);
    els.searchResults.hidden = false;
    resultCursor = -1;
  }

  function actionButton(icon, label, onClick) {
    const button = document.createElement("button");
    button.className = "result-action";
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.innerHTML = `<i class="fa-solid ${icon}"></i>`;
    button.addEventListener("click", onClick);
    return button;
  }

  function highlightResult(index) {
    if (!resultItems.length) return;
    resultCursor = (index + resultItems.length) % resultItems.length;
    resultItems.forEach((item, i) => item.classList.toggle("is-active", i === resultCursor));
    resultItems[resultCursor].scrollIntoView({ block: "nearest" });
  }

  function playFromSearch(track) {
    const knownIndex = state.queue.findIndex((item) => item.videoId === track.videoId);
    if (knownIndex >= 0) {
      playAt(knownIndex);
    } else {
      // New track becomes the head of the queue so the carousel follows it.
      state.queue = [fromSearch(track)].concat(state.queue);
      if (state.orderedQueue) state.orderedQueue = [state.queue[0]].concat(state.orderedQueue);
      // Search is now the only way the list grows, so the cap has to be applied
      // here or a long session would grow the array and the carousel forever.
      // Rebuilt first, then trimmed: trimming after the rebuild keeps the slide
      // order and the queue in step.
      buildSwiper(0);
      trimQueue();
      playAt(0);
    }
    hideResults();
    setStatus("");
    els.searchInput.blur();
  }

  async function runSearch() {
    const raw = els.searchInput.value.trim();
    if (!raw) return;

    const token = ++searchToken;
    els.searchBtn.classList.add("is-busy");
    hideResults();
    setStatus("Searching YouTube Music…");

    try {
      // A pasted YouTube link (or bare video id) plays straight away.
      if (window.sangeetha.parseVideoId(raw)) {
        const track = await window.sangeetha.resolve(raw);
        if (!track) throw new Error("That link could not be resolved");
        if (token === searchToken) playFromSearch(track);
        return;
      }

      const results = await window.sangeetha.search(raw, 18);
      if (token !== searchToken) return;
      if (!results.length) {
        hideResults();
        setStatus("No results found");
        return;
      }
      renderResults(results);
      setStatus(`${results.length} result${results.length === 1 ? "" : "s"} — click to play`);
    } catch (err) {
      if (token !== searchToken) return;
      hideResults();
      // The website and the desktop app both really do search; the message
      // about needing run.bat is only true for a page opened straight off disk,
      // where there is no backend to ask.
      const message =
        isDesktop || isWebsite
          ? `Search failed: ${err.message}`
          : "Search needs the desktop app or the website — run run.bat";
      setStatus(message);
      toast(message, true);
    } finally {
      els.searchBtn.classList.remove("is-busy");
    }
  }

  /* ------------------------------------------------------------------ *
   * Window controls
   * ------------------------------------------------------------------ */

  /** Shrinks the card to the mini bar (and the desktop window with it), or restores it. */
  function setMini(on) {
    document.body.classList.toggle("is-mini", on);
    els.miniBar.hidden = !on;
    if (bridge) bridge.window.setMini(on);
  }

  function setupWindowControls() {
    if (!els.minimize) return;
    els.minimize.addEventListener("click", () => setMini(true));
    els.miniExpand.addEventListener("click", () => setMini(false));
    els.miniPlay.addEventListener("click", togglePlay);
    els.miniPrev.addEventListener("click", previous);
    els.miniNext.addEventListener("click", () => next());

    els.close.addEventListener("click", () => {
      if (bridge) bridge.window.close();
      else window.close();
    });

    if (els.desktop) els.desktop.addEventListener("click", toggleDesktopShortcut);

    if (bridge && typeof bridge.onCommand === "function") {
      bridge.onCommand((command) => {
        if (command === "toggle") togglePlay();
        if (command === "next") next();
        if (command === "prev") previous();
      });
    }

    if (bridge && typeof bridge.onShortcut === "function") {
      bridge.onShortcut((present) => renderShortcutState(present));
    }
  }

  /* ------------------------------------------------------------------ *
   * Desktop shortcut
   * ------------------------------------------------------------------ */

  function renderShortcutState(present) {
    if (!els.desktop) return;
    if (!isDesktop) {
      // The website has no Windows shortcut to reflect. The button stays
      // enabled because it opens the install dialog, and is never shown in the
      // "already on the desktop" state, which would be a lie here.
      els.desktop.classList.remove("is-on");
      els.desktop.setAttribute("aria-pressed", "false");
      return;
    }
    els.desktop.classList.toggle("is-on", present);
    els.desktop.title = present ? "Remove from desktop" : "Add to desktop";
    els.desktop.setAttribute("aria-pressed", present ? "true" : "false");
  }

  async function toggleDesktopShortcut() {
    if (isWebsite) {
      openInstallPanel();
      return;
    }
    if (!bridge || !bridge.desktop) {
      toast("The desktop shortcut is only available in the desktop app");
      return;
    }
    if (els.desktop.classList.contains("is-busy")) return;
    els.desktop.classList.add("is-busy");
    setStatus("Updating your desktop…");

    try {
      // The main process decides from the real file, so the button can never
      // end up showing a state the desktop does not actually have.
      const result = await bridge.desktop.toggle();
      renderShortcutState(result.present);
      toast(result.present ? "Added to your desktop" : "Removed from your desktop");
    } catch (err) {
      // Re-sync the button with reality after a failure.
      bridge.desktop
        .state()
        .then(({ present }) => renderShortcutState(present))
        .catch(() => {});
      toast(`Desktop shortcut failed: ${err.message}`, true);
    } finally {
      els.desktop.classList.remove("is-busy");
      setStatus("");
    }
  }

  /* ------------------------------------------------------------------ *
   * Installing the app from the website
   *
   * There are two genuinely different things here, and conflating them is the
   * usual way this goes wrong:
   *
   *  - The Windows desktop app is Electron. It is the only thing that has an
   *    always-on-top window, a system tray, snap corners and a real desktop
   *    shortcut, because those are OS features a web page cannot reach.
   *  - A PWA install is the browser putting this same page in its own window.
   *    It is real, but it is still a web page: no always-on-top, no tray.
   *
   * So the dialog offers both and states what each one lacks. It never implies
   * that installing the PWA gives the floating widget.
   * ------------------------------------------------------------------ */

  /** Where the Windows build is published. Change this when a release exists. */
  const WINDOWS_DOWNLOAD =
    "https://github.com/VINAYAKANWALISHETTAR/Sangeetha/releases";

  const isWindows =
    typeof navigator !== "undefined" && /win/i.test(navigator.platform || navigator.userAgent || "");

  /** Held until the user asks for it: Chrome only allows one prompt per page. */
  let deferredPwaPrompt = null;

  function openInstallPanel() {
    if (!els.installPanel) return;
    els.installPanel.hidden = false;
    if (els.installClose) els.installClose.focus();
  }

  function closeInstallPanel() {
    if (!els.installPanel) return;
    els.installPanel.hidden = true;
  }

  /**
   * Wires the dialog up.
   *
   * The PWA button is only enabled when the browser has actually offered an
   * install. If it stays disabled with an explanation, the user learns the truth
   * instead of clicking a button that silently does nothing — which is also why
   * the PWA is never described as giving native features.
   */
  function setupInstallPanel() {
    if (!els.installPanel) return;

    if (els.installClose) els.installClose.addEventListener("click", closeInstallPanel);
    els.installPanel.addEventListener("click", (event) => {
      // A click on the backdrop, not on the card, closes it.
      if (event.target === els.installPanel) closeInstallPanel();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !els.installPanel.hidden) closeInstallPanel();
    });

    if (els.downloadWindows) {
      els.downloadWindows.href = WINDOWS_DOWNLOAD;
      if (els.windowsNote) {
        els.windowsNote.textContent = isWindows
          ? "Opens the project's releases. The app is a small download and needs no installer — run it and use the desktop button to add it to your desktop."
          : "The desktop widget is Windows-only. This link still shows the project if you want to read about it.";
      }
    }

    // Only the website has an install dialog; Electron toggles the real
    // shortcut instead, which is handled by toggleDesktopShortcut.
    if (els.installPwaLabel) {
      els.installPwaLabel.textContent = "Not available in this browser";
    }

    window.addEventListener("beforeinstallprompt", (event) => {
      // Suppresses the browser's own mini-infobar so the in-app button is the
      // single, explained way to install.
      event.preventDefault();
      deferredPwaPrompt = event;
      if (els.installPwa) {
        els.installPwa.disabled = false;
        if (els.installPwaLabel) els.installPwaLabel.textContent = "Install as an app";
      }
    });

    if (els.installPwa) {
      els.installPwa.addEventListener("click", async () => {
        if (!deferredPwaPrompt) {
          toast("This browser cannot install apps — use the Windows app instead");
          return;
        }
        deferredPwaPrompt.prompt();
        const choice = await deferredPwaPrompt.userChoice.catch(() => null);
        deferredPwaPrompt = null;
        if (els.installPwa) els.installPwa.disabled = true;
        if (choice && choice.outcome === "accepted") closeInstallPanel();
        else toast("Install cancelled");
      });
    }

    // A browser that already has the app installed fires this instead of
    // beforeinstallprompt, so the button must not keep claiming it is possible.
    window.addEventListener("appinstalled", () => {
      closeInstallPanel();
      toast("Naada Tarangini installed");
    });
  }

  /**
   * Registers the service worker.
   *
   * Only on the website, and only over https (or localhost), because a service
   * worker is refused on an insecure origin elsewhere. The worker deliberately
   * caches nothing — see sw.js — so this cannot serve a stale build.
   */
  function setupServiceWorker() {
    if (!isWebsite || !("serviceWorker" in navigator)) return;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // No install prompt is a minor loss; a failed registration must not
        // surface as an error in a page that otherwise works.
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * Build identity
   * ------------------------------------------------------------------ */

  /**
   * Shows which build is running and which mode it is in.
   *
   * The browser preview and the desktop app are the same UI with different
   * capabilities, and a cached copy of either looks like an out-of-date app.
   * Printing the version and build tag in the title bar makes the running build
   * verifiable at a glance, and states plainly when desktop-only features are
   * unavailable.
   */
  function renderBuildBadge() {
    if (!els.buildBadge) return;
    // On the website the running build is whatever the server is serving, which
    // is not a tag computed on this machine. The version is still useful, so it
    // is shown and the mode is named instead of inventing a tag.
    const build = (bridge && bridge.build) || { version: "1.0.0", tag: "web" };
    els.buildBadge.textContent = isDesktop ? `v${build.version} · ${build.tag}` : `v${build.version} · web`;
    els.buildBadge.classList.toggle("is-web", !isDesktop);
    els.buildBadge.title = isDesktop
      ? `Naada Tarangini ${build.version} (build ${build.tag}) — desktop app`
      : `Naada Tarangini ${build.version} — browser preview. Desktop features (add to desktop, pin, tray) need run.bat.`;

    if (els.brand) {
      els.brand.title = isDesktop
        ? `Naada Tarangini ${build.version} (build ${build.tag})`
        : `Naada Tarangini ${build.version} — browser preview`;
    }

    // The desktop button means different things in the two places. In Electron
    // it creates or removes the real Windows shortcut, and the main process
    // decides from what is actually on disk. On the website there is no
    // shortcut to toggle, so it opens the install dialog instead — and on a bare
    // file:// page it is disabled, because there is nothing behind it.
    if (els.desktop) {
      const usable = isDesktop || isWebsite;
      els.desktop.classList.toggle("is-unavailable", !usable);
      els.desktop.disabled = !usable;
      els.desktop.title = usable
        ? isWebsite
          ? "Get Naada Tarangini for your computer"
          : "Add to desktop"
        : "Available on the website or in the desktop app";
    }
  }

  /* ------------------------------------------------------------------ *
   * Events
   * ------------------------------------------------------------------ */

  function setupEvents() {
    els.playPause.addEventListener("click", togglePlay);
    els.forward.addEventListener("click", () => next());
    els.backward.addEventListener("click", previous);

    els.volume.addEventListener("input", (event) => setVolume(Number(event.target.value)));
    els.mute.addEventListener("click", toggleMute);
    els.autoNext.addEventListener("click", toggleAutoplay);
    els.shuffle.addEventListener("click", toggleShuffle);
    els.repeat.addEventListener("click", cycleRepeat);
    els.favorite.addEventListener("click", toggleFavorite);

    els.libraryBtn.addEventListener("click", () => toggleLibrary());
    els.libraryClose.addEventListener("click", () => toggleLibrary(false));
    els.tabQueue.addEventListener("click", () => setActiveTab("queue"));
    els.tabFavs.addEventListener("click", () => setActiveTab("favorites"));
    els.tabHistory.addEventListener("click", () => setActiveTab("history"));
    els.clearQueue.addEventListener("click", clearQueue);

    // The panel is a sibling of the player rather than an overlay, so clicking
    // anywhere outside it closes it. Checked on the whole document because the
    // panel is opened from the title bar, not from inside itself.
    document.addEventListener("click", (event) => {
      if (els.libraryPanel.hidden) return;
      if (els.libraryPanel.contains(event.target)) return;
      if (els.libraryBtn.contains(event.target)) return;
      toggleLibrary(false);
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !els.libraryPanel.hidden) {
        toggleLibrary(false);
      }
    });

    els.progress.addEventListener("input", (event) => {
      state.seeking = true;
      els.currentTime.textContent = formatTime(event.target.value);
    });
    els.progress.addEventListener("change", (event) => {
      state.seeking = false;
      if (!audio.src) return;
      audio.currentTime = Number(event.target.value);
      if (audio.paused) play();
    });

    els.searchBtn.addEventListener("click", runSearch);
    els.searchInput.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" && resultItems.length) {
        event.preventDefault();
        highlightResult(resultCursor + 1);
        return;
      }
      if (event.key === "ArrowUp" && resultItems.length) {
        event.preventDefault();
        highlightResult(resultCursor - 1);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        // A highlighted result wins over starting a new search.
        if (resultCursor >= 0 && resultItems[resultCursor]) {
          resultItems[resultCursor].click();
        } else {
          runSearch();
        }
        return;
      }
      if (event.key === "Escape") {
        els.searchInput.value = "";
        hideResults();
        setStatus("");
        els.searchInput.blur();
      }
    });
    els.searchInput.addEventListener("input", () => {
      if (els.searchInput.value.trim()) setStatus("Press Enter to search");
    });

    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (!target.closest(".search-bar") && !target.closest(".search-results")) {
        hideResults();
      }
    });

    document.addEventListener("keydown", (event) => {
      const target = event.target;
      // The event target is not always an Element (it can be the document),
      // and Element.closest is the only thing that may be missing.
      const onFormField = target instanceof HTMLElement && target.tagName === "INPUT";
      if (onFormField || event.ctrlKey || event.metaKey || event.altKey) return;
      // A focused button already handles Space/Enter natively — acting on it
      // here too would toggle playback twice.
      const onControl =
        target instanceof HTMLElement && target.closest("button, a, [role='button']");
      if (event.code === "Space" || event.key === "Enter") {
        if (onControl) return;
        if (event.code === "Space") {
          event.preventDefault();
          togglePlay();
        }
        return;
      }
      if (els.searchResults.hidden && event.code === "ArrowRight") {
        next();
      } else if (els.searchResults.hidden && event.code === "ArrowLeft") {
        previous();
      }
    });

    // --- audio element: the only playback engine ---
    audio.addEventListener("loadedmetadata", () => {
      setLoading(false);
      paintProgress();
    });
    audio.addEventListener("canplay", () => setLoading(false));
    audio.addEventListener("play", () => {
      setLoading(false);
      renderPlayState(true);
      startFrameLoop();
    });
    audio.addEventListener("pause", () => {
      renderPlayState(false);
      stopFrameLoop();
    });

    // Buffering is distinct from "loading": the first is a stall mid-track, the
    // second is the initial resolve. They used to share one flag, so a stall
    // showed the same spinner as startup and the two states were impossible to
    // tell apart when debugging a stream that kept dying.
    audio.addEventListener("waiting", () => {
      state.buffering = true;
      setStatus("Buffering…");
    });
    const clearBuffering = () => {
      if (!state.buffering) return;
      state.buffering = false;
      if (current()) setStatus("");
    };
    audio.addEventListener("playing", clearBuffering);
    audio.addEventListener("canplay", clearBuffering);
    audio.addEventListener("seeked", clearBuffering);
    audio.addEventListener("pause", clearBuffering);
    audio.addEventListener("ended", clearBuffering);

    audio.addEventListener("ended", () => {
      stopFrameLoop();
      renderPlayState(false);
      // Repeat one is handled here rather than inside next(), because "restart
      // the same track" must only happen when a track finished on its own. A
      // manual Next skips regardless of the setting, or the listener gets stuck
      // on one song with no way out.
      if (state.autoplay) next({ manual: false, fromEnded: true });
    });
    audio.addEventListener("error", () => {
      stopFrameLoop();
      setLoading(false);
      renderPlayState(false);
      const track = current();
      if (!track) {
        toast("This track could not be played", true);
        return;
      }

      // A signed stream URL that the network rejects must not be handed out
      // again. Dropping it here is what lets the retry in loadTrack() resolve a
      // fresh one; retrying while the old URL is still cached would replay the
      // same dead URL and the track would never start.
      const mediaError = audio.error;
      const code = mediaError && mediaError.code;

      // Only meaningful while something is actually loaded. An error on an empty
      // element has no track to retry and no URL to forget.
      if (!audio.src) {
        setLoading(false);
        renderPlayState(false);
        return;
      }

      dropStream(track.videoId);
      if (bridge && typeof bridge.forgetStream === "function") {
        Promise.resolve(bridge.forgetStream(track.videoId)).catch(() => {});
      } else if (isWebsite) {
        // The server keeps the same signed-URL cache, so it has to be told too
        // — otherwise a retry would be handed the identical dead URL.
        webApi(`/api/forget-stream?videoId=${encodeURIComponent(track.videoId)}`).catch(() => {});
      }

      // MEDIA_ERR_SRC_NOT_SUPPORTED / MEDIA_ERR_DECODE / MEDIA_ERR_NETWORK are
      // the codes a dead signature produces. Anything else is a genuine playback
      // failure and is not worth a pointless second round trip.
      const retryable = code === 2 || code === 3 || code === 4;
      // The element can still be reporting the previous track's failure after
      // the user has already moved on. Retrying then would restart whatever the
      // user is listening to now, which is worse than the original problem.
      const stillCurrent = current() === track;
      if (retryable && stillCurrent && !track.retriedStream) {
        track.retriedStream = true;
        // loadTrack() sees the rejection marker and resolves a fresh URL, so the
        // retry lives in one place rather than being duplicated here.
        loadTrack(track, true);
        return;
      }

      if (retryable && !stillCurrent) {
        // The failure belonged to a track that is no longer loaded. Say nothing:
        // the user is listening to something else and an error about the old one
        // would be noise.
        return;
      }

      toast(mediaError && mediaError.message ? mediaError.message : "This track could not be played", true);
    });

    if ("mediaSession" in navigator) {
      const handler = (action, fn) => {
        try {
          navigator.mediaSession.setActionHandler(action, fn);
        } catch {
          /* the platform may not support every action */
        }
      };
      handler("play", togglePlay);
      handler("pause", togglePlay);
      handler("previoustrack", previous);
      handler("nexttrack", () => next());
    }
  }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  function init() {
    setupEvents();
    setupWindowControls();
    renderBuildBadge();
    renderAutoplay();
    // The saved shuffle and repeat modes have to be painted before the first
    // renderTrack(), which is also what puts the heart into its saved state.
    renderModes();

    buildSwiper(state.index);
    renderTrack();
    renderPlayState(false);
    setVolume(state.volume, { persist: false });

    if (isDesktop) {
      bridge
        .status()
        .then((status) => {
          if (!status.ytDlp) {
            toast("yt-dlp is missing — run setup.bat for YouTube playback", true);
          } else {
            // Warm the loaded track first, so the first press of play is
            // instant rather than a visible multi-second resolve.
    prewarmCurrent(700);
    prewarmUpcoming([4000, 9000]);
          }
        })
        .catch(() => {});

      bridge.desktop
        .state()
        .then(({ present }) => renderShortcutState(present))
        .catch((err) => console.warn("[sangeetha] could not read the desktop shortcut state:", err.message));
    } else {
      // The website has the same yt-dlp question to answer, but it asks the
      // server rather than the main process. It is only a warning: a missing
      // helper breaks playback, not the page, and saying so is better than
      // letting the first press fail with no explanation.
      setupInstallPanel();
      setupServiceWorker();

      if (isWebsite) {
        webApi("/api/health")
          .then((health) => {
            if (!health.ytDlp) {
              toast("Streaming is unavailable on the server right now", true);
            }
          })
          .catch(() => {
            // The API being unreachable must not stop the page from working;
            // search reports the real reason when it is used.
          });
      }
    }
  }

  init();

  /* ------------------------------------------------------------------ *
   * Test-only introspection
   * ------------------------------------------------------------------ */

  /**
   * A read-only view of the list, published only when the page was opened with
   * `?selftest=1` — which the smoke test does and the app never does.
   *
   * The player is a closed IIFE, so without this the test cannot observe the
   * list length, and the cap that stops a long session growing it without bound
   * could not be verified at all. Gating on the URL means a normal launch has
   * no extra surface on window at all.
   */
  if (/[?&]selftest=1\b/.test(location.search)) {
    window.__sangeethaTest = {
      queueLength: () => state.queue.length,
      index: () => state.index,
      limit: QUEUE_LIMIT,
      /** Adds a card the way a search result does, minus the playback. */
      addCard: (track) => {
        state.queue = [track].concat(state.queue);
        if (state.orderedQueue) state.orderedQueue = [track].concat(state.orderedQueue);
        buildSwiper(0);
        trimQueue();
        return state.queue.length;
      },
      /**
       * A read-only view of the state the new player features depend on.
       *
       * Exposed as a copy so a test cannot drive the player into a state the UI
       * cannot reach — the queue cap test above needs to add cards, but repeat
       * and shuffle have to be exercised the way a user would, by clicking.
       */
      modes: () => ({
        repeat: state.repeat,
        shuffle: state.shuffle,
        favorites: state.favorites.slice(),
        history: state.history.slice(),
        index: state.index,
        queueLength: state.queue.length,
        currentId: (state.queue[state.index] || {}).videoId || null,
        orderedLength: (state.orderedQueue || []).length,
      }),
      /** The index nextIndex() would choose, without playing it. */
      peekNext: (fromEnded) => nextIndex({ fromEnded }),
      removeAt: (index) => {
        removeFromQueue(index);
        return state.queue.length;
      },
    };
  }
})();
