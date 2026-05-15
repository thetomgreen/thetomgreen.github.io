// SetList audience-share — live mirror.
//
// Architecture:
//   1. Resolve the share code from the URL path (e.g. /instant/k4m9pz).
//   2. Fetch the share_sessions row once for initial render.
//   3. Subscribe to:
//        a. `postgres_changes` on that row id     — so song switches refresh
//           the rendered text without a page reload.
//        b. Realtime broadcast channel "share:<code>" — high-frequency
//           ticks carrying elapsed/playing/scroll_fraction.
//   4. Drive scroll either from `elapsed` (play mode) or `scroll_fraction`
//      (hand-scroll mode). Local rAF loop slews `displayedElapsed` toward
//      the latest server value at a rate cap so the page never jumps.

(() => {
  // -------------------------------------------------------------------
  // Config (kept in sync with iOS-side AudienceShareConfig.swift).
  // The anon key is intentionally embedded — RLS gates writes, and reads
  // are explicitly allowed for anon role.
  // -------------------------------------------------------------------
  const SUPABASE_URL = "https://srneydgbhpovhhkkvkvi.supabase.co";
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNybmV5ZGdiaHBvdmhoa2t2a3ZpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg4MjQ2NTEsImV4cCI6MjA5NDQwMDY1MX0.rKVlG2Thgcl28jv0V9VQB6Y0visIMVoBeJ_V1RkjHCM";

  // Scroll slew rate: max viewport-fraction-per-second the displayed
  // position is allowed to advance toward the server target. Matches
  // the iOS slave's slew constant.
  const SLEW_VIEWPORT_FRACTION_PER_SEC = 0.20;
  // If the server-vs-local elapsed delta is larger than this, snap
  // (it's almost certainly a seek, not slow drift).
  const SNAP_THRESHOLD_SEC = 4.0;

  // Lead-in (matches the iOS player). The first 2 seconds of `elapsed`
  // are spent at the resting position; scroll begins thereafter.
  const LEAD_IN_SEC = 2.0;

  // -------------------------------------------------------------------
  // Resolve share code from URL
  // -------------------------------------------------------------------
  const code = (() => {
    // Path is /instant/<code>, but support hash-only fallback (e.g. for
    // simpler hosts that don't rewrite to index.html).
    const parts = location.pathname.split('/').filter(Boolean);
    const fromPath = parts[parts.indexOf('instant') + 1];
    if (fromPath) return fromPath;
    if (location.hash) return location.hash.replace(/^#/, '');
    return null;
  })();

  if (!code) {
    document.getElementById('song-title').textContent = 'No share code';
    showBanner('error', 'This page needs a share code in the URL.');
    return;
  }

  // -------------------------------------------------------------------
  // DOM refs + per-viewer state
  // -------------------------------------------------------------------
  const $title   = document.getElementById('song-title');
  const $body    = document.getElementById('song-body');
  const $scroll  = document.getElementById('scroll-area');
  const $dot     = document.getElementById('status-dot');
  const $banner  = document.getElementById('banner');
  const $toggle  = document.getElementById('toggle-chords');
  const $zoomIn  = document.getElementById('zoom-in');
  const $zoomOut = document.getElementById('zoom-out');

  // Local UI state (per viewer, persisted in localStorage).
  const lsKey = (k) => `instant.${k}`;
  let zoom = clamp(parseFloat(localStorage.getItem(lsKey('zoom'))) || 18, 12, 64);
  let showChords = localStorage.getItem(lsKey('showChords')) === 'true';
  applyZoom();
  applyChordsToggle();

  $zoomIn.addEventListener('click', () => { zoom = clamp(zoom + 2, 12, 64); applyZoom(); localStorage.setItem(lsKey('zoom'), String(zoom)); });
  $zoomOut.addEventListener('click', () => { zoom = clamp(zoom - 2, 12, 64); applyZoom(); localStorage.setItem(lsKey('zoom'), String(zoom)); });
  $toggle.addEventListener('click', () => {
    showChords = !showChords;
    localStorage.setItem(lsKey('showChords'), String(showChords));
    applyChordsToggle();
  });

  function applyZoom()        { document.documentElement.style.setProperty('--font-size', zoom + 'px'); }
  function applyChordsToggle() {
    $body.dataset.showChords = showChords ? 'true' : 'false';
    $toggle.setAttribute('aria-pressed', showChords ? 'true' : 'false');
  }
  function clamp(n, lo, hi)   { return Math.max(lo, Math.min(hi, n)); }

  function setStatus(level /* 'live'|'warn'|'error'|'idle' */, title) {
    $dot.classList.remove('live', 'warn', 'error');
    if (level !== 'idle') $dot.classList.add(level);
    $dot.title = title || '';
  }
  function showBanner(kind /* 'info'|'warn'|'error' */, msg) {
    $banner.className = 'banner ' + kind;
    $banner.textContent = msg;
  }
  function hideBanner() { $banner.className = 'banner hidden'; $banner.textContent = ''; }

  // -------------------------------------------------------------------
  // Server state we mirror
  // -------------------------------------------------------------------
  /** @type {{ id: string, song_title: string|null, song_raw_text: string|null, length_seconds: number, tempo_acceleration: number, expires_at: string } | null} */
  let row = null;
  let serverElapsed = 0;
  let serverPlaying = false;
  let serverInPlay = false;
  let serverScrollFraction = null;     // non-null only when out of play mode
  let lastTickAt = 0;                  // performance.now() of last server tick
  let displayedElapsed = 0;            // slewed value driving scroll position
  let renderedSongRawText = null;      // re-render only when this changes

  // -------------------------------------------------------------------
  // Supabase client + subscriptions
  // -------------------------------------------------------------------
  const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false }
  });

  setStatus('idle', 'Connecting…');

  async function loadInitial() {
    try {
      const { data, error } = await supabase
        .from('share_sessions')
        .select('*')
        .eq('id', code)
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        showBanner('error', 'This share session doesn’t exist. Ask the performer for a fresh link.');
        setStatus('error', 'Not found');
        return;
      }
      applyRow(data);
    } catch (e) {
      console.error('initial load failed', e);
      showBanner('error', 'Couldn’t load the share session.');
      setStatus('error', 'Offline');
    }
  }

  function applyRow(data) {
    row = data;
    if (new Date(data.expires_at) < new Date()) {
      showBanner('info', 'Session ended.');
      setStatus('idle', 'Ended');
    } else {
      hideBanner();
      setStatus('live', 'Live');
    }
    $title.textContent = data.song_title || ' ';
    serverElapsed = data.virtual_elapsed || 0;
    serverPlaying = !!data.is_playing;
    serverInPlay  = !!data.is_in_play_mode;
    lastTickAt = performance.now();
    if (data.song_raw_text !== renderedSongRawText) {
      renderSong(data.song_raw_text || '');
      renderedSongRawText = data.song_raw_text || '';
      displayedElapsed = serverElapsed;
      // Reset scroll on song switch.
      requestAnimationFrame(() => $scroll.scrollTo({ top: 0, behavior: 'auto' }));
    }
  }

  // Subscribe to row-level changes (song switches, start/stop).
  supabase
    .channel('row:' + code)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'share_sessions',
      filter: 'id=eq.' + code
    }, (payload) => {
      if (payload.new) applyRow(payload.new);
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') setStatus('live', 'Live');
    });

  // Subscribe to high-frequency broadcast ticks.
  supabase
    .channel('share:' + code, { config: { broadcast: { self: false } } })
    .on('broadcast', { event: 'tick' }, (msg) => {
      const p = msg.payload || {};
      serverElapsed = typeof p.elapsed === 'number' ? p.elapsed : serverElapsed;
      serverPlaying = !!p.playing;
      serverInPlay  = !!p.in_play_mode;
      serverScrollFraction = (typeof p.scroll_fraction === 'number') ? p.scroll_fraction : null;
      lastTickAt = performance.now();
      hideBanner();
      setStatus('live', 'Live');
    })
    .subscribe();

  // Reconnect indicator. supabase-js auto-reconnects; we just notice the gap.
  let lastSeenTickAt = performance.now();
  setInterval(() => {
    const sinceTick = (performance.now() - lastSeenTickAt) / 1000;
    if (sinceTick > 8 && serverPlaying) {
      // Performer was playing but we haven't heard anything in 8s.
      // Either they paused without telling us, or our WS dropped.
      setStatus('warn', 'No recent updates');
    }
  }, 2000);

  loadInitial();

  // -------------------------------------------------------------------
  // Render: chord/lyric line classification (port of iOS ChordParser)
  // -------------------------------------------------------------------
  const CHORD_RE = /^(?:NC|N\.C\.|[A-G](?:#|b)?(?:maj|min|m|dim|aug|sus|add|Maj|Min|Add|Sus|Dim|Aug|MAJ|MIN|ADD|SUS|DIM|AUG)?\d*(?:\/[A-G](?:#|b)?)?)$/;
  const TRIM_PUNCT = /^[.,;:!?*()\[\]"'-]+|[.,;:!?*()\[\]"'-]+$/g;

  /** Returns 'chords' | 'lyrics' | 'blank' | 'section'. */
  function classify(line) {
    const trimmed = line.trim();
    if (trimmed === '') return 'blank';
    // Bracketed section labels like [Verse 1] / [Chorus] / [Guitar Solo].
    if (/^\[[^\]]+\]$/.test(trimmed)) return 'section';

    // Tokenize; collapse "(...)" groups to one token.
    const tokens = [];
    let i = 0;
    while (i < line.length) {
      if (line[i] === ' ' || line[i] === '\t') { i++; continue; }
      if (line[i] === '(') {
        const start = i;
        while (i < line.length && line[i] !== ')') i++;
        if (i < line.length) i++;
        while (i < line.length && line[i] !== ' ' && line[i] !== '\t') i++;
        tokens.push({ text: line.slice(start, i), isChord: false });
        continue;
      }
      const start = i;
      while (i < line.length && line[i] !== ' ' && line[i] !== '\t') i++;
      const tok = line.slice(start, i);
      const stripped = tok.replace(TRIM_PUNCT, '');
      tokens.push({ text: tok, isChord: stripped !== '' && CHORD_RE.test(stripped) });
    }
    const chords = tokens.filter(t => t.isChord).length;
    const extras = tokens.length - chords;
    return (chords > 0 && chords >= extras) ? 'chords' : 'lyrics';
  }

  function renderSong(rawText) {
    const lines = rawText.split('\n');
    const frag = document.createDocumentFragment();
    for (const raw of lines) {
      const kind = classify(raw);
      const div = document.createElement('div');
      div.className = 'line ' + kind;
      div.textContent = kind === 'blank' ? ' ' : raw;
      frag.appendChild(div);
    }
    $body.replaceChildren(frag);
  }

  // -------------------------------------------------------------------
  // Scroll loop — convert displayedElapsed into scrollTop
  // -------------------------------------------------------------------
  let lastFrameAt = performance.now();

  function loop(now) {
    const dt = Math.min(0.1, (now - lastFrameAt) / 1000);  // cap dt for tab-sleep recovery
    lastFrameAt = now;

    if (!row) {
      requestAnimationFrame(loop);
      return;
    }

    // Compute server's "live" elapsed estimate. While serverPlaying, the
    // server's elapsed advances at 1× even between ticks; we extrapolate
    // locally so motion is smooth at 60 fps despite ~3 Hz ticks.
    const sinceTick = (now - lastTickAt) / 1000;
    const liveServerElapsed = serverPlaying
      ? serverElapsed + sinceTick
      : serverElapsed;

    // Slew displayedElapsed toward liveServerElapsed.
    const target = liveServerElapsed;
    const delta = target - displayedElapsed;
    if (Math.abs(delta) > SNAP_THRESHOLD_SEC) {
      displayedElapsed = target;          // big jump → snap
    } else {
      // Max change per frame in seconds = (viewport fraction per sec) × (visible time per viewport).
      // visibleTimePerViewport ≈ viewport height / scroll speed; we approximate by capping
      // the rate at a fraction of the song length-per-second.
      const songDur = Math.max(30, row.length_seconds || 180);
      const maxStep = (SLEW_VIEWPORT_FRACTION_PER_SEC * songDur * 0.5) * dt;
      const step = delta >= 0 ? Math.min(delta, maxStep) : Math.max(delta, -maxStep);
      displayedElapsed += step;
    }

    // Convert to scrollTop.
    const scrollMax = Math.max(0, $body.scrollHeight - $scroll.clientHeight + window.innerHeight * 0.8);
    const songDur = Math.max(30, row.length_seconds || 180);
    let targetTop;
    if (!serverInPlay && serverScrollFraction !== null) {
      // Out-of-play-mode: server tells us a 0..1 scroll fraction.
      targetTop = scrollMax * Math.max(0, Math.min(1, serverScrollFraction));
    } else {
      // Play mode: time → position curve. Use constant tempo (v1) — the
      // tempo_acceleration field is available on the row for a future
      // iteration that wants to match the curved iOS player exactly.
      const tAfterLeadIn = Math.max(0, displayedElapsed - LEAD_IN_SEC);
      const dur = Math.max(0.0001, songDur - LEAD_IN_SEC);
      targetTop = scrollMax * Math.min(1, tAfterLeadIn / dur);
    }

    // Slew scrollTop the same way (CSS scroll-behavior:smooth would be
    // jankier — we want continuous interpolation).
    const currentTop = $scroll.scrollTop;
    const topDelta = targetTop - currentTop;
    const maxPx = window.innerHeight * SLEW_VIEWPORT_FRACTION_PER_SEC * dt * 5; // 5× because we're closing position fast
    if (Math.abs(topDelta) > window.innerHeight * 2) {
      $scroll.scrollTop = targetTop;       // big jump → snap
    } else {
      const pxStep = topDelta >= 0 ? Math.min(topDelta, maxPx) : Math.max(topDelta, -maxPx);
      $scroll.scrollTop = currentTop + pxStep;
    }

    // Track "fresh" state for the warning indicator.
    if ((now - lastTickAt) < 4000) lastSeenTickAt = now;

    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // -------------------------------------------------------------------
  // Expiry watchdog — flip to "session ended" once expires_at passes.
  // -------------------------------------------------------------------
  setInterval(() => {
    if (!row) return;
    if (new Date(row.expires_at) < new Date()) {
      showBanner('info', 'Session ended.');
      setStatus('idle', 'Ended');
    }
  }, 30000);
})();
