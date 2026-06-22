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
    showCodeEntry();
    return;
  }

  // -------------------------------------------------------------------
  // Recents — persisted across visits so repeat audience members can
  // re-enter a band's session in one tap from the code-entry screen.
  // Written on successful load (see applyRow), read on no-code visits.
  // -------------------------------------------------------------------
  function loadRecents() {
    try {
      const raw = localStorage.getItem('instant.recents');
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter(s => typeof s === 'string') : [];
    } catch { return []; }
  }
  function rememberRecent(c) {
    if (!c) return;
    const cur = loadRecents().filter(x => x !== c);
    cur.unshift(c);
    localStorage.setItem('instant.recents', JSON.stringify(cur.slice(0, 5)));
  }
  function showCodeEntry() {
    // Hide the live-mirror chrome — this is a different screen.
    document.querySelector('.topbar')?.classList.add('hidden');
    document.getElementById('scroll-area')?.classList.add('hidden');

    const $entry   = document.getElementById('code-entry');
    const $form    = document.getElementById('code-entry-form');
    const $input   = document.getElementById('code-entry-input');
    const $go      = document.getElementById('code-entry-go');
    const $err     = document.getElementById('code-entry-error');
    const $recents = document.getElementById('code-entry-recents');
    const $list    = document.getElementById('code-entry-recents-list');

    // Accept only the unambiguous Crockford-base32 alphabet the host uses
    // (no 0/o/1/l/i). Anything else is silently stripped as the user types
    // so they can't submit something the server will never accept.
    const ALPHA_RE = /[^23456789abcdefghjkmnpqrstuvwxyz]/g;
    const VALID_RE = /^[23456789abcdefghjkmnpqrstuvwxyz]{5}$/;

    function setError(msg) {
      if (msg) { $err.textContent = msg; $err.classList.remove('hidden'); }
      else { $err.textContent = ''; $err.classList.add('hidden'); }
    }
    function updateGo() {
      $go.disabled = !VALID_RE.test($input.value);
    }
    function go(c) {
      if (!VALID_RE.test(c)) {
        setError('Codes are 5 characters (letters/numbers, no 0/o/1/l/i).');
        return;
      }
      // Navigate into the live mirror using the same `/instant/?b=…#code`
      // URL shape the iOS app generates: hash for the code (so GH Pages
      // doesn't need a path-rewrite rule), query for cache-busting (and
      // also so a same-page submit causes a real reload rather than just
      // a no-op hash change). Don't rememberRecent yet — wait until the
      // load succeeds, so a typo'd code doesn't pollute recents.
      location.assign('/instant/?b=' + Date.now() + '#' + c);
    }

    $input.addEventListener('input', () => {
      const cleaned = $input.value.toLowerCase().replace(ALPHA_RE, '').slice(0, 5);
      if (cleaned !== $input.value) $input.value = cleaned;
      setError(null);
      updateGo();
    });
    $form.addEventListener('submit', (e) => {
      e.preventDefault();
      go($input.value);
    });

    const recents = loadRecents();
    if (recents.length > 0) {
      $recents.classList.remove('hidden');
      $list.replaceChildren();
      recents.forEach(c => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'code-entry-recent-chip';
        btn.textContent = c;
        btn.addEventListener('click', () => go(c));
        $list.appendChild(btn);
      });
    }

    updateGo();
    $entry.classList.remove('hidden');
    // iOS Safari respects focus-on-load only after a user gesture; harmless
    // on desktop where it just places the caret in the input.
    setTimeout(() => $input.focus(), 0);
  }

  // -------------------------------------------------------------------
  // DOM refs + per-viewer state
  // -------------------------------------------------------------------
  const $title    = document.getElementById('song-title');
  const $subtitle = document.getElementById('song-subtitle');
  const $body     = document.getElementById('song-body');
  const $empty    = document.getElementById('empty-state');
  const $scroll   = document.getElementById('scroll-area');
  const $dot      = document.getElementById('status-dot');
  const $banner   = document.getElementById('banner');
  const $toggle   = document.getElementById('toggle-chords');
  const $zoomIn   = document.getElementById('zoom-in');
  const $zoomOut  = document.getElementById('zoom-out');
  const $showQR   = document.getElementById('show-qr');
  const $qrOverlay = document.getElementById('qr-overlay');
  const $qrTarget  = document.getElementById('qr-target');
  const $qrUrl     = document.getElementById('qr-url');
  const $qrClose   = document.getElementById('qr-close');

  // Local UI state (per viewer, persisted in localStorage).
  const lsKey = (k) => `instant.${k}`;
  let zoom = clamp(parseFloat(localStorage.getItem(lsKey('zoom'))) || 18, 12, 64);
  let showChords = localStorage.getItem(lsKey('showChords')) === 'true';
  applyZoom();
  applyChordsToggle();

  // -------------------------------------------------------------------
  // Follow-master state machine
  //
  // Three modes for the scroll loop:
  //
  //   1. NORMAL    — toggle on, no manual override. Chase the master's
  //                  target position via slew with two boost tiers (see
  //                  the loop for thresholds).
  //   2. CATCH-UP  — sub-mode of NORMAL. Sticky once activated: when the
  //                  master is >1.5 screens ahead, slew at 3.75x the
  //                  base rate (= 2.5x the existing "faster" tier of
  //                  1.5x) until the target is reached.
  //   3. DETACHED  — toggle off OR per-song "user scrolled mid-play"
  //                  state. Ignore master target; advance at the
  //                  autonomous time-based rate while the master is
  //                  playing. Hold position when paused.
  //
  // Per-song detachment is cleared on song change and on master "stop"
  // (i.e. when serverInPlay falls). Per-viewer toggle persists across
  // sessions (localStorage).
  // -------------------------------------------------------------------

  /// Per-viewer toggle. Default ON. Persists across visits so a viewer
  /// who wants to read at their own pace doesn't have to re-flip it
  /// every time they reopen the page.
  let trackingEnabled = localStorage.getItem(lsKey('trackMaster')) !== 'false';
  /// Master-side override carried in every TickPayload. Default `true`
  /// for legacy iOS builds that don't include the field. When `false`,
  /// the master has paused live position-tracking for ALL followers —
  /// the per-viewer toggle becomes irrelevant until the master flips
  /// it back on.
  let masterFollowEnabled = true;
  /// Per-song runtime detachment. Goes true when the user manually
  /// scrolls during master playback. Cleared on song change OR when
  /// the master leaves play mode (= "hit stop").
  let detachedDuringSong = false;
  /// Edge-detection bookkeeping for rising-edge "master hit play" snap
  /// and falling-edge "master hit stop" detach-reset.
  let prevServerPlaying = false;
  let prevServerInPlay = false;
  /// Sticky fast-catch-up flag. Set when target is >1.5 viewport heights
  /// ahead; stays set until displayed has actually reached target. This
  /// is what makes the catch-up "continue at this speed until the
  /// target is reached" rather than oscillating between tiers as the
  /// gap closes.
  let fastCatchUp = false;
  /// Threshold (in line-floats) for "target reached" when releasing the
  /// sticky catch-up state. Half a line is tight enough to feel like an
  /// arrival without flickering at the boundary on the next frame.
  const CATCH_UP_RELEASE_LINES = 0.5;
  /// Multiplier the catch-up tier applies on top of the base slew rate.
  /// 2.5× the existing "faster" tier of 1.5× per spec.
  const FAST_CATCH_UP_MULTIPLIER = 1.5 * 2.5;

  $zoomIn.addEventListener('click', () => { zoom = clamp(zoom + 2, 12, 64); applyZoom(); localStorage.setItem(lsKey('zoom'), String(zoom)); });
  $zoomOut.addEventListener('click', () => { zoom = clamp(zoom - 2, 12, 64); applyZoom(); localStorage.setItem(lsKey('zoom'), String(zoom)); });

  // -------------------------------------------------------------------
  // Pinch-zoom — translate two-finger gestures into our zoom commands.
  // The viewport meta already disables native browser pinch (so it doesn't
  // double-scale the page); we drive the same `--font-size` variable here
  // so text-wrap reflows as the user zooms.
  // -------------------------------------------------------------------
  (() => {
    let initialDist = 0;
    let initialZoom = 0;
    function dist(t) {
      const dx = t[0].clientX - t[1].clientX;
      const dy = t[0].clientY - t[1].clientY;
      return Math.hypot(dx, dy);
    }
    document.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        initialDist = dist(e.touches);
        initialZoom = zoom;
      }
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && initialDist > 0) {
        e.preventDefault();
        const d = dist(e.touches);
        const ratio = d / initialDist;
        zoom = clamp(initialZoom * ratio, 12, 64);
        applyZoom();
      }
    }, { passive: false });
    document.addEventListener('touchend', () => {
      if (initialDist > 0) {
        initialDist = 0;
        localStorage.setItem(lsKey('zoom'), String(zoom));
      }
    });
    // Safari (macOS trackpad pinch + iPad with hardware kbd) emits
    // gesture-* events instead of multitouch touchmove. Handle both.
    let gestureStartZoom = 0;
    document.addEventListener('gesturestart', (e) => { e.preventDefault(); gestureStartZoom = zoom; }, { passive: false });
    document.addEventListener('gesturechange', (e) => {
      e.preventDefault();
      zoom = clamp(gestureStartZoom * e.scale, 12, 64);
      applyZoom();
    }, { passive: false });
    document.addEventListener('gestureend', () => {
      localStorage.setItem(lsKey('zoom'), String(zoom));
    });
  })();
  $toggle.addEventListener('click', () => {
    showChords = !showChords;
    localStorage.setItem(lsKey('showChords'), String(showChords));
    applyChordsToggle();
  });

  // Follow-master toggle. When ON, the page chases the master's
  // position in the song; when OFF, it scrolls at the autonomous time-
  // based rate and ignores master ticks. Flipping back ON re-snaps so
  // the viewer doesn't slowly slew across the song to catch up.
  //
  // The master can ALSO override this from their side — when their
  // toggle is off, every follower behaves as if detached regardless
  // of the per-viewer setting. `applyMasterStatus` surfaces that
  // state on the toggle button (dimmed) and as a small note next to
  // the song title so the viewer knows why their toggle isn't taking
  // effect.
  const $toggleFollow = document.getElementById('toggle-follow');
  function applyFollowToggle() {
    if (!$toggleFollow) return;
    $toggleFollow.setAttribute('aria-pressed', trackingEnabled ? 'true' : 'false');
    applyMasterStatus();
  }
  function applyMasterStatus() {
    if (!$toggleFollow) return;
    // Dim the per-viewer toggle when the master has paused tracking
    // — the personal preference is still stored, just not in effect.
    $toggleFollow.style.opacity = masterFollowEnabled ? '' : '0.5';
    $toggleFollow.title = masterFollowEnabled
      ? 'Follow the master\'s position in the song'
      : 'Performer paused live position-tracking';
  }
  applyFollowToggle();
  if ($toggleFollow) {
    $toggleFollow.addEventListener('click', () => {
      trackingEnabled = !trackingEnabled;
      localStorage.setItem(lsKey('trackMaster'), String(trackingEnabled));
      applyFollowToggle();
      if (trackingEnabled) {
        // Re-engaging: clear any runtime detach + the catch-up latch,
        // then snap on the next frame so the viewer lands on the
        // master's current position instead of slewing across the song.
        detachedDuringSong = false;
        fastCatchUp = false;
        needSnap = true;
      }
    });
  }

  // Manual-scroll detector. While the master is playing, any user-
  // initiated scroll gesture flips this viewer into the per-song
  // detached state (autonomous rate, no master tracking) until the
  // song changes or the master leaves play mode. Only events that
  // can ONLY come from a real user gesture count — `scroll` events
  // also fire from our own scrollTop assignment in the loop, so we
  // never listen for those directly.
  const SCROLL_KEYS = new Set([
    'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar',
  ]);
  function noteManualScroll() {
    // Only counts during actual playback per spec ("if a follower
    // scrolls the song manually during playback"). Pre-play /
    // paused scrolls are no-ops here.
    if (!serverPlaying) return;
    if (!trackingEnabled) return;       // already in autonomous mode
    if (detachedDuringSong) return;     // already detached
    detachedDuringSong = true;
    fastCatchUp = false;
  }
  $scroll.addEventListener('wheel', noteManualScroll, { passive: true });
  $scroll.addEventListener('touchmove', (e) => {
    // 2-finger touchmove is pinch-zoom, handled by the gesture block
    // above — never a scroll.
    if (e.touches && e.touches.length === 1) noteManualScroll();
  }, { passive: true });
  $scroll.addEventListener('pointerdown', (e) => {
    // Catches scrollbar drag on desktop. Touch is handled above; we
    // only react to genuine mouse/pen pointer-downs.
    if (e.pointerType && e.pointerType !== 'touch') noteManualScroll();
  }, { passive: true });
  document.addEventListener('keydown', (e) => {
    if (SCROLL_KEYS.has(e.key)) noteManualScroll();
  });

  /// Called after every server-state update (tick OR applyRow). Rising
  /// edge of serverPlaying ⇒ master just hit play; snap this viewer to
  /// the live position (unless they're already detached). Falling edge
  /// of serverInPlay ⇒ master left play mode ("hit stop"); clear the
  /// per-song detach so the viewer rejoins normal tracking next time.
  function noteServerPlaybackTransition() {
    const playingRose  = !prevServerPlaying && serverPlaying;
    const inPlayFell   =  prevServerInPlay && !serverInPlay;
    prevServerPlaying = serverPlaying;
    prevServerInPlay  = serverInPlay;
    if (playingRose && trackingEnabled && !detachedDuringSong) {
      needSnap = true;
      fastCatchUp = false;
    }
    if (inPlayFell) {
      detachedDuringSong = false;
      fastCatchUp = false;
    }
    // Late-joiner: the first live tick after join carries the master's
    // real elapsed, not the row's stale virtual_elapsed. Snap again so
    // the viewer lands on the live position rather than slewing across
    // potentially minutes of song.
    if (awaitingFirstLiveTick && lastTickAt > 0) {
      awaitingFirstLiveTick = false;
      if (trackingEnabled && !detachedDuringSong) {
        needSnap = true;
      }
    }
  }

  // QR overlay — viewer-side "show this to a friend" affordance.
  // QRious is small (~20KB) and ships a self-contained canvas QR
  // renderer; lazy-loaded the first time the user taps the QR button
  // so first paint isn't slowed down for the ~99% of viewers who'll
  // never need it.
  let qrLibPromise = null;
  function loadQRLib() {
    if (qrLibPromise) return qrLibPromise;
    qrLibPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/qrious@4.0.2/dist/qrious.min.js';
      s.onload = () => resolve(window.QRious);
      s.onerror = () => { qrLibPromise = null; reject(new Error('QR library failed to load')); };
      document.head.appendChild(s);
    });
    return qrLibPromise;
  }
  $showQR.addEventListener('click', async () => {
    const url = location.href;
    $qrUrl.textContent = url;
    $qrOverlay.classList.remove('hidden');
    $qrTarget.replaceChildren();           // clear any prior render
    try {
      const QRious = await loadQRLib();
      const canvas = document.createElement('canvas');
      $qrTarget.appendChild(canvas);
      // 600px backing canvas → crisp at any rendered size thanks to
      // image-rendering: pixelated in the CSS.
      new QRious({ element: canvas, value: url, size: 600, level: 'M', backgroundAlpha: 1, background: '#fff', foreground: '#000' });
    } catch (e) {
      $qrTarget.textContent = 'Couldn’t render the QR — copy the link instead.';
    }
  });
  $qrClose.addEventListener('click', () => { $qrOverlay.classList.add('hidden'); });
  $qrOverlay.addEventListener('click', (e) => {
    // Click on the dark area outside the card also dismisses.
    if (e.target === $qrOverlay) $qrOverlay.classList.add('hidden');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$qrOverlay.classList.contains('hidden')) {
      $qrOverlay.classList.add('hidden');
    }
  });

  // -------------------------------------------------------------------
  // Debug HUD — opt-in via `?debug=1` in the URL. Hidden by default so
  // actual audience members see a clean page; still available to us for
  // diagnostics when explicitly enabled.
  // -------------------------------------------------------------------
  const debugEnabled = new URLSearchParams(location.search).get('debug') === '1';
  const $debugHud = (() => {
    if (!debugEnabled) return { textContent: '' };  // no-op stub
    const d = document.createElement('div');
    d.id = 'debug-hud';
    d.style.cssText = 'position:fixed;left:6px;bottom:env(safe-area-inset-bottom,4px);max-width:95vw;background:rgba(0,0,0,0.78);color:#9fe;font:10px/1.25 ui-monospace,monospace;padding:6px 8px;border-radius:6px;z-index:50;pointer-events:none;white-space:pre;max-height:60vh;overflow:hidden;';
    document.body.appendChild(d);
    return d;
  })();
  let debugCounts = { tick: 0, row_bcast: 0, pg_change: 0, refetch: 0, applyRow: 0, ios_dbg: 0 };
  let iosLastLines = [];
  function bumpDebug(kind, info) {
    debugCounts[kind] = (debugCounts[kind] || 0) + 1;
    const r = row || {};
    $debugHud.textContent =
      `t:${debugCounts.tick} rB:${debugCounts.row_bcast} pg:${debugCounts.pg_change} rF:${debugCounts.refetch} aR:${debugCounts.applyRow} iD:${debugCounts.ios_dbg}\n` +
      `last: ${kind}${info ? ' ' + info : ''}\n` +
      `sub: ${(r.song_subtitle ?? '∅').slice(0,30)} | title: ${(r.song_title ?? '∅').slice(0,30)}\n` +
      `mode: ${$body.dataset.mode || '?'} | lines: ${lineAnchors.length}\n` +
      `track:${trackingEnabled ? 'on' : 'off'} masterFollow:${masterFollowEnabled ? 'on' : 'off'} det:${detachedDuringSong ? 'Y' : 'n'} fc:${fastCatchUp ? 'Y' : 'n'} sP:${serverPlaying ? 'Y' : 'n'} sI:${serverInPlay ? 'Y' : 'n'}\n` +
      `iOS:\n${iosLastLines.slice(-6).join('\n')}`;
  }

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
  let currentTranspose = 0;            // semitone shift applied to chords
  let serverElapsed = 0;
  let serverPlaying = false;
  let serverInPlay = false;
  let serverScrollFraction = null;     // non-null only when out of play mode
  let lastTickAt = 0;                  // performance.now() of last server tick
  let lastRowAt = 0;                   // performance.now() of last row event/refetch
  // The row's expires_at is a 4-hour TTL that only gets bumped on row
  // WRITES (song change / list view / transpose change) — ticks don't
  // refresh it. So on a session that's been on the same song for >4 hours
  // the row goes stale even though the host is actively pushing ticks.
  // Treat any activity (tick OR row event) within this window as proof
  // the session is alive, regardless of what expires_at says.
  const ACTIVITY_LIVE_WINDOW_MS = 90_000;  // 90s of silence ⇒ might be dead
  function sessionLooksLive() {
    const now = performance.now();
    return (now - lastTickAt) < ACTIVITY_LIVE_WINDOW_MS
        || (now - lastRowAt)  < ACTIVITY_LIVE_WINDOW_MS;
  }
  let renderedSongRawText = null;      // re-render only when this changes
  /// Line-anchor positions in the rendered DOM. One entry per host-side
  /// rawText line. centerY = the y coordinate to put under the viewport
  /// center when "currently on this line". height = used for sub-line
  /// fraction interpolation. Recomputed after every renderSong/renderList
  /// and on viewport resize / font-size change.
  let lineAnchors = [];
  /// Position the audience is "looking at" in line-float units (e.g. 12.4
  /// = 40% of the way past line 12 toward line 13). Slews toward
  /// `targetLineFloat` on each frame; snapped on song change.
  let displayedLineFloat = 0;
  /// If true, the next frame snaps displayedLineFloat to the target instead
  /// of slewing. Set on initial load and on song switch so a freshly-arrived
  /// viewer doesn't start at the top and slowly catch up.
  let needSnap = true;
  /// False until the first applyRow with content lands. The initial join
  /// snaps to the host's mid-song position (so a late joiner doesn't see a
  /// scroll-from-top animation). Every subsequent song change starts at
  /// the top — when the master picks a new song, the audience reads from
  /// line 1, not from wherever the previous song's scroll happened to be
  /// or from wherever the host is mid-performance.
  let hasReceivedFirstRow = false;
  /// True between initial applyRow and the first live broadcast tick.
  /// The row's `virtual_elapsed` is only refreshed on song-change writes,
  /// so a late joiner's first snap uses stale data — they'd land near
  /// 0:00 on a song the master started five minutes ago. Setting this
  /// flag forces a second snap on the first real tick, which carries
  /// the master's live elapsed.
  let awaitingFirstLiveTick = false;
  /// Raw-text line index of the host song's "based on …" line, if any.
  /// Surfaced as a subtitle above the body and skipped from renderSong's
  /// output (the iOS player handles it the same way).
  let basedOnLineIndex = -1;

  // Follow-master state declarations live higher up — see the block
  // right after `let showChords = ...` so the toggle handler can read
  // them at module-evaluation time without hitting a TDZ.

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
      rememberRecent(code);
      bumpDebug('refetch', 'sub=' + (data.song_subtitle ?? '∅'));
    } catch (e) {
      console.error('initial load failed', e);
      showBanner('error', 'Couldn’t load the share session.');
      setStatus('error', 'Offline');
    }
  }

  /** Sentinel set by the iOS app in song_subtitle when the host is on a
   *  list view (set list overview, songs tab, etc.) rather than a song. */
  const LIST_SENTINEL = '__list__';

  function applyRow(data) {
    // Live ticks are the authoritative real-time signal. If we've seen a tick
    // within the last ~8 s saying the host is in play mode, ignore any row
    // that claims list mode — that's a stale write (e.g. a tab change pushed
    // during a navigation blip, or a 20-s refetch returning a pre-play
    // snapshot). Without this guard the page flipped into list view and
    // jumped to scrollTop=0 mid-playback until the next song row arrived,
    // which the host saw as the audience "jumping to the top, then catching
    // up". Don't touch `row` either — its length_seconds=0 would break the
    // playback target calculation.
    const rowSaysList = (data.song_subtitle === LIST_SENTINEL);
    const liveSongTick = (lastTickAt > 0)
      && (performance.now() - lastTickAt < 8000)
      && serverInPlay;
    if (rowSaysList && liveSongTick) {
      bumpDebug('applyRow', 'IGNORED stale list-mode row during live play');
      return;
    }
    row = data;
    lastRowAt = performance.now();
    bumpDebug('applyRow', 'sub=' + (data.song_subtitle ?? '∅'));
    // expires_at past is NOT a reliable "ended" signal — it just means
    // no row WRITE has happened in ~4 hours. Two distinct cases:
    //   (a) Host explicitly stopped sharing → expires_at is forced to
    //       epoch 0 (1970). Definitely ended.
    //   (b) Natural staleness on a long-running session → expires_at is
    //       past but recent-ish. Host may still be pushing ticks.
    // Treat (a) as immediately ended. For (b), suppress the banner if
    // we've seen any tick/row activity recently — only show "ended"
    // when both expires_at is past AND the session has gone silent.
    const expiresAt = new Date(data.expires_at);
    const stoppedExplicitly = expiresAt.getTime() < 1_000_000;  // ≈ epoch 0
    const naturallyExpired = expiresAt < new Date();
    if (stoppedExplicitly || (naturallyExpired && !sessionLooksLive())) {
      showBanner('info', 'Session ended.');
      setStatus('idle', 'Ended');
    } else {
      hideBanner();
      setStatus('live', 'Live');
    }
    $title.textContent = data.song_title || ' ';

    const isList = (data.song_subtitle === LIST_SENTINEL);
    const newTranspose = data.transpose_semitones || 0;
    const transposeChanged = newTranspose !== currentTranspose;
    currentTranspose = newTranspose;
    const contentChanged = (data.song_raw_text !== renderedSongRawText) ||
                           (isList !== ($body.dataset.mode === 'list'));

    // Only adopt the row's transport snapshot when this is a NEW song/view.
    // On a refetch of the same song, the row's virtual_elapsed is stale
    // (it only gets updated on song-change writes, not every tick) — letting
    // it overwrite live tick state would rewind the page every 20 s and
    // produce the "scrolling stops" symptom the user reported.
    if (contentChanged) {
      serverElapsed = data.virtual_elapsed || 0;
      serverPlaying = !!data.is_playing;
      serverInPlay  = !!data.is_in_play_mode;
      lastTickAt = performance.now();
      // Song / view change resets the per-song "user scrolled" state
      // per spec — a new song starts everyone fresh in tracking mode
      // until they scroll on this song. The catch-up latch is per-
      // song too. The transition helper below sees the new state vs
      // the prior song's prev* and only fires a rising-edge snap if
      // the master genuinely went paused→playing across the change.
      detachedDuringSong = false;
      fastCatchUp = false;
      noteServerPlaybackTransition();
    }

    // Re-render on a new song/view, or when only the transpose changed
    // (same text, different key — the audience must follow the performer's
    // live key change without a song switch).
    if (contentChanged || (transposeChanged && !isList)) {
      if (isList) {
        renderList(data.song_raw_text || '');
        $body.dataset.mode = 'list';
        updateSubtitle('');
        // Lists are static — show them from the top, not wherever the
        // previous song's scrollTop happened to leave us.
        $scroll.scrollTop = 0;
      } else {
        const basedOn = extractBasedOn(data.song_raw_text || '');
        basedOnLineIndex = basedOn.index;
        renderSong(data.song_raw_text || '');
        $body.dataset.mode = 'song';
        updateSubtitle(basedOn.text);
      }
      renderedSongRawText = data.song_raw_text || '';
      // Re-measure DOM line positions before deciding scroll position.
      // A transpose-only re-render keeps the viewer's current position.
      rebuildLineAnchors();
      if (contentChanged) {
        if (!hasReceivedFirstRow) {
          // Initial join: snap to host's mid-song position so a late
          // joiner doesn't see the page race down from the top. The
          // row's elapsed may be stale (it only refreshes on song-
          // change writes), so re-snap on the first live tick too.
          needSnap = true;
          awaitingFirstLiveTick = true;
        } else {
          // Subsequent song change: start at the top regardless of
          // where the host's elapsed maps to. When the master picks a
          // new song mid-performance, the audience reads from line 1.
          $scroll.scrollTop = 0;
          displayedLineFloat = 0;
          needSnap = false;
          awaitingFirstLiveTick = false;  // not a late-joiner anymore
        }
        hasReceivedFirstRow = true;
      }
    }
    // Show/hide the chord toggle — pointless in list mode.
    $toggle.style.visibility = isList ? 'hidden' : 'visible';

    // Empty state: title and raw text are both empty. Shouldn't happen in
    // normal use but covers the case where a row gets cleared.
    const isEmpty = !data.song_title && !data.song_raw_text;
    $empty.classList.toggle('hidden', !isEmpty);
    $body.style.display = isEmpty ? 'none' : '';
  }

  // Test hook — only when ?debug=1. Lets Playwright drive applyRow with
  // synthetic rows without standing up a Supabase fixture, so we can
  // verify scroll-to-top on song change, subtitle extraction, and
  // no-jump slew behavior end-to-end.
  if (debugEnabled) {
    window.__applyRow = applyRow;
    window.__getScrollTop = () => $scroll.scrollTop;
    window.__getSubtitle = () => ({
      hidden: $subtitle?.classList.contains('hidden'),
      text: $subtitle?.textContent,
    });
    window.__setServerTick = (elapsed, playing = true, inPlay = true) => {
      serverElapsed = elapsed;
      serverPlaying = !!playing;
      serverInPlay = !!inPlay;
      lastTickAt = performance.now();
      noteServerPlaybackTransition();
    };
    window.__getFollowState = () => ({
      trackingEnabled,
      masterFollowEnabled,
      detachedDuringSong,
      fastCatchUp,
      prevServerPlaying,
      prevServerInPlay,
      serverPlaying,
      serverInPlay,
      displayedLineFloat,
    });
    window.__simulateManualScroll = () => noteManualScroll();
    window.__setMasterFollow = (enabled) => {
      const prev = masterFollowEnabled;
      masterFollowEnabled = !!enabled;
      if (!prev && masterFollowEnabled && trackingEnabled && !detachedDuringSong) {
        needSnap = true;
        fastCatchUp = false;
      }
      applyMasterStatus();
    };
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
      bumpDebug('pg_change', 'has new=' + !!payload.new);
      if (payload.new) applyRow(payload.new);
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') setStatus('live', 'Live');
    });

  // Subscribe to high-frequency broadcast ticks AND `row` events (which
  // iOS broadcasts after every row update — far more reliable than
  // postgres_changes which has been observed to skip events).
  supabase
    .channel('share:' + code, { config: { broadcast: { self: false } } })
    .on('broadcast', { event: 'tick' }, (msg) => {
      const p = msg.payload || {};
      serverElapsed = typeof p.elapsed === 'number' ? p.elapsed : serverElapsed;
      serverPlaying = !!p.playing;
      serverInPlay  = !!p.in_play_mode;
      serverScrollFraction = (typeof p.scroll_fraction === 'number') ? p.scroll_fraction : null;
      // Master-side follow toggle. Absent ⇒ legacy iOS, default true.
      // A false→true rising edge re-snaps tracking followers so they
      // land cleanly on the master's current position instead of
      // slewing across whatever drift accumulated while detached.
      if (typeof p.follow_master_position === 'boolean') {
        const prevMaster = masterFollowEnabled;
        masterFollowEnabled = p.follow_master_position;
        if (!prevMaster && masterFollowEnabled && trackingEnabled && !detachedDuringSong) {
          needSnap = true;
          fastCatchUp = false;
        }
        applyMasterStatus();
      }
      lastTickAt = performance.now();
      hideBanner();
      setStatus('live', 'Live');
      bumpDebug('tick', 'play=' + serverPlaying);
      noteServerPlaybackTransition();
    })
    .on('broadcast', { event: 'row' }, (msg) => {
      bumpDebug('row_bcast', 'sub=' + (msg.payload?.song_subtitle ?? '∅'));
      if (msg.payload) applyRow(msg.payload);
    })
    .on('broadcast', { event: 'debug' }, (msg) => {
      const p = msg.payload || {};
      const line = `[${p.state || '?'}] ${p.msg || ''}`;
      iosLastLines.push(line);
      if (iosLastLines.length > 20) iosLastLines.shift();
      bumpDebug('ios_dbg', '');
    })
    .subscribe();

  // Belt-and-braces: re-fetch every 20s in case both postgres_changes AND
  // broadcast missed a row change (e.g. WS reconnect window).
  setInterval(() => { loadInitial(); }, 20000);

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

  // -------------------------------------------------------------------
  // Chord transposition — JS port of iOS ChordTransposer.swift. Shifts a
  // chord token by N semitones, preserving the quality/extension/bass and
  // the accidental flavour (sharps stay sharp, flats stay flat; naturals
  // default to sharps). `transpose_semitones` arrives in the share row so
  // the audience sees the same key the performer is displaying.
  // -------------------------------------------------------------------
  const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLAT_NAMES  = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

  function pitchClass(root) {
    let i = SHARP_NAMES.indexOf(root);
    if (i >= 0) return i;
    i = FLAT_NAMES.indexOf(root);
    return i >= 0 ? i : null;
  }

  function shiftedRoot(chord, semitones, preferFlats) {
    const first = chord[0];
    if (!first || first < 'A' || first > 'G') return null;
    let rootLen = 1, rootName = first;
    if (chord.length >= 2 && (chord[1] === '#' || chord[1] === 'b')) {
      rootName += chord[1];
      rootLen = 2;
    }
    const pc = pitchClass(rootName);
    if (pc === null) return null;
    const shifted = ((pc + semitones) % 12 + 12) % 12;
    const newName = (preferFlats ? FLAT_NAMES : SHARP_NAMES)[shifted];
    return { newName, suffix: chord.slice(rootLen) };
  }

  /** Transpose a single chord token. Non-chord tokens returned unchanged. */
  function transposeChord(token, semitones) {
    if (!semitones || !token) return token;
    if (token === 'NC' || token === 'N.C.') return token;
    const slash = token.indexOf('/');
    const main = slash >= 0 ? token.slice(0, slash) : token;
    const bass = slash >= 0 ? token.slice(slash + 1) : null;
    const preferFlats = token.includes('b') && !token.startsWith('b');
    const m = shiftedRoot(main, semitones, preferFlats);
    if (!m) return token;
    let out = m.newName + m.suffix;
    if (bass !== null) {
      const b = shiftedRoot(bass, semitones, preferFlats);
      out += '/' + (b ? b.newName + b.suffix : bass);
    }
    return out;
  }

  /** Transpose a whole chord-only line, preserving each chord's start column
   *  (chord-only lines render in column alignment with no lyric beneath). */
  function transposeChordLineString(raw, semitones) {
    if (!semitones) return raw;
    const tokens = tokenizeChordLineFull(raw);
    if (tokens.length === 0) return raw;
    let out = '';
    for (const t of tokens) {
      if (out.length < t.col) out += ' '.repeat(t.col - out.length);
      out += transposeChord(t.text, semitones);
    }
    return out;
  }

  // -------------------------------------------------------------------
  // Section-header rules (port of iOS SongTextHeuristics.swift).
  //
  // A line counts as a section header when it's one of:
  //   1. [Anything]                — always a header.
  //   2. (Keyword)                 — parens around a known section keyword.
  //   3. Keyword:                  — trailing colon.
  //   4. Keyword + short tag       — e.g. "Verse 1", "Verse 2a".
  //   5. A bare keyword on its own — "Bridge", "Chorus", "Intro", etc.
  //      In practice songs don't use those words as lyrics, and a false
  //      positive only renders italic with a small gap, not destructive.
  //
  // In lyrics-only mode, bracketed headers and the Verse/Chorus family are
  // suppressed (the lyrics imply the structure) while keeping a visual
  // section-gap. Bridge / Intro / Outro / etc. stay visible as italic
  // navigational landmarks the singer/audience cues off.
  // -------------------------------------------------------------------
  const SECTION_KEYWORDS = [
    'verse', 'chorus', 'bridge', 'intro', 'outro',
    'pre-chorus', 'pre chorus', 'prechorus',
    'tag', 'coda', 'interlude', 'instrumental', 'solo',
    'refrain', 'hook', 'vamp', 'ending', 'break', 'turnaround',
  ];
  // Longest-first so "pre-chorus" wins over "chorus" / "pre".
  const SECTION_KEYWORDS_SORTED = [...SECTION_KEYWORDS].sort((a, b) => b.length - a.length);
  const LYRICS_HIDDEN_KEYWORDS = new Set([
    'verse', 'chorus', 'pre-chorus', 'pre chorus', 'prechorus',
    'post-chorus', 'post chorus', 'postchorus',
  ]);

  function splitOnSpacedDashes(s) {
    let parts = [s];
    for (const sep of [' -- ', ' - ', ' – ', ' — ']) {
      parts = parts.flatMap(p => p.split(sep));
    }
    return parts.map(p => p.trim()).filter(p => p.length > 0);
  }
  function keywordAndTag(part) {
    const lower = part.toLowerCase();
    for (const kw of SECTION_KEYWORDS_SORTED) {
      if (lower === kw) return { keyword: kw, tag: '' };
      if (lower.startsWith(kw)) {
        const remainder = lower.slice(kw.length).trim();
        if (remainder === '') return { keyword: kw, tag: '' };
        if (remainder.length <= 6 && /^[\p{L}\p{N}\s]+$/u.test(remainder)) {
          return { keyword: kw, tag: remainder };
        }
      }
    }
    return { keyword: '', tag: '' };
  }
  function isSectionPart(s) {
    return keywordAndTag(s).keyword !== '';
  }
  function isSectionHeader(raw) {
    const trimmed = raw.trim();
    if (trimmed === '') return false;
    // Rule 1: bracketed.
    if (trimmed.startsWith('[') && trimmed.endsWith(']') && trimmed.length >= 2) return true;
    // Strip parens for keyword check.
    let core = trimmed;
    if (core.startsWith('(') && core.endsWith(')') && core.length >= 2) {
      core = core.slice(1, -1).trim();
    }
    if (core.endsWith(':')) core = core.slice(0, -1).trim();
    if (isSectionPart(core)) return true;
    // Compound like "Verse 1 - Verse 1" — every dash-part is a header.
    const parts = splitOnSpacedDashes(core);
    if (parts.length > 1 && parts.every(isSectionPart)) return true;
    return false;
  }
  function normalizeSectionHeader(trimmed) {
    let core = trimmed;
    if (core.startsWith('[') && core.endsWith(']') && core.length >= 2) {
      core = core.slice(1, -1).trim();
    } else if (core.startsWith('(') && core.endsWith(')') && core.length >= 2) {
      core = core.slice(1, -1).trim();
    }
    if (core.endsWith(':')) core = core.slice(0, -1).trim();

    const parts = splitOnSpacedDashes(core);
    if (parts.length <= 1) return core;

    // Dedup "Verse 1 - Verse 1" → "Verse 1", "Pre-chorus - Pre-chorus 1" →
    // "Pre-chorus 1". Keep distinct-tag compounds ("Verse 1 - Verse 2") as-is.
    const infos = parts.map(keywordAndTag);
    const firstKw = infos[0].keyword;
    if (!firstKw) return core;
    if (!infos.every(i => i.keyword === firstKw)) return core;
    const nonEmptyTags = new Set(infos.map(i => i.tag).filter(t => t !== ''));
    if (nonEmptyTags.size > 1) return core;
    // Prefer the tagged part (more informative).
    const tagged = infos.findIndex(i => i.tag !== '');
    return tagged >= 0 ? parts[tagged] : parts[0];
  }
  function isHiddenInLyricsView(normalized) {
    const parts = splitOnSpacedDashes(normalized);
    const candidates = parts.length === 0 ? [normalized] : parts;
    const keywords = candidates.map(c => keywordAndTag(c).keyword);
    if (keywords.some(k => k === '')) return false;
    return keywords.every(k => LYRICS_HIDDEN_KEYWORDS.has(k));
  }
  /** Returns { text, hideInLyricsMode } for a recognized section header. */
  function sectionDisplayInfo(raw) {
    const trimmed = raw.trim();
    const isBracketed = trimmed.startsWith('[') && trimmed.endsWith(']') && trimmed.length >= 2;
    const normalized = normalizeSectionHeader(trimmed);
    const hideInLyricsMode = isBracketed || isHiddenInLyricsView(normalized);
    return { text: normalized, hideInLyricsMode };
  }

  /// Scan the raw text for the song's "based on …" line and return its
  /// text + raw-line index. Matches the iOS-app heuristic: the first
  /// non-blank, non-section lyric line. If it begins with "based on"
  /// (case-insensitive), surface it as a subtitle above the body and
  /// skip it from renderSong's output. Returns {text:'', index:-1}
  /// when no based-on line is present (e.g. song begins with a chord
  /// line or a regular lyric).
  function extractBasedOn(rawText) {
    const lines = rawText.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const kind = classify(lines[i]);
      if (kind === 'blank' || kind === 'section') continue;
      if (kind === 'chords') return { text: '', index: -1 };
      const trimmed = lines[i].trim();
      if (trimmed.toLowerCase().startsWith('based on')) {
        return { text: trimmed, index: i };
      }
      return { text: '', index: -1 };
    }
    return { text: '', index: -1 };
  }

  function updateSubtitle(text) {
    if (!$subtitle) return;
    if (text) {
      $subtitle.textContent = text;
      $subtitle.classList.remove('hidden');
    } else {
      $subtitle.textContent = '';
      $subtitle.classList.add('hidden');
    }
  }

  /** Returns 'chords' | 'lyrics' | 'blank' | 'section'. */
  function classify(line) {
    const trimmed = line.trim();
    if (trimmed === '') return 'blank';
    // Section headers — bracketed plus the broader iOS heuristic
    // (Verse/Chorus/Pre-chorus/... with tags, parens, or trailing colon).
    if (isSectionHeader(trimmed)) return 'section';

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

  /** Tokenise a chord line into [{col, text}] preserving column positions.
   *  Used by renderChordLyricPair so the rendered chord-over-syllable
   *  alignment matches the host's source spacing. */
  function tokenizeChordLineFull(line) {
    const out = [];
    let i = 0;
    while (i < line.length) {
      if (line[i] === ' ' || line[i] === '\t') { i++; continue; }
      if (line[i] === '(') {
        const start = i;
        while (i < line.length && line[i] !== ')') i++;
        if (i < line.length) i++;
        while (i < line.length && line[i] !== ' ' && line[i] !== '\t') i++;
        out.push({ col: start, text: line.slice(start, i) });
        continue;
      }
      const start = i;
      while (i < line.length && line[i] !== ' ' && line[i] !== '\t') i++;
      out.push({ col: start, text: line.slice(start, i) });
    }
    return out;
  }

  /** Render a chord+lyric pair as a single block of inline syllables.
   *  Each syllable holds its chord absolutely-positioned above; when the
   *  lyric wraps, the chord wraps with it — same approach the iOS
   *  ChordLyricWrapper uses to keep chord-over-syllable alignment intact
   *  under narrow-window reflow. */
  function renderChordLyricPair(chordRaw, lyricRaw) {
    const pair = document.createElement('div');
    pair.className = 'line chord-pair';
    const tokens = tokenizeChordLineFull(chordRaw);
    tokens.sort((a, b) => a.col - b.col);

    // One syllable: an inline-block whose two block-level children stack
    // chord-above-lyric. Even a chordless syllable emits a chord row with
    // a non-breaking space, so all syllables in a chord-pair share the
    // same height and their lyric baselines align horizontally. Without
    // this, chordless syllables float 1em higher than their chord-bearing
    // siblings on the same visual line.
    const makeSyl = (chordText, lyricText) => {
      const syl = document.createElement('span');
      syl.className = 'syl';
      const ch = document.createElement('span');
      ch.className = chordText ? 'syl-chord' : 'syl-chord syl-chord-empty';
      ch.textContent = chordText || ' ';
      syl.appendChild(ch);
      const ly = document.createElement('span');
      ly.className = 'syl-lyric';
      ly.textContent = lyricText.length > 0 ? lyricText : ' ';
      syl.appendChild(ly);
      return syl;
    };

    // Append one chord-pair "chunk" (the lyric span belonging to one chord
    // column) as per-word inline-block syllables separated by real text-node
    // spaces. Per-word splitting is what makes the line wrap on narrow
    // viewports: each .syl is atomic, so wrap only happens between them.
    const appendChunk = (chordText, chunk) => {
      if (chunk.length === 0) {
        if (chordText) pair.appendChild(makeSyl(chordText, ''));
        return;
      }
      const parts = chunk.split(/(\s+)/).filter(s => s.length > 0);
      let assignedChord = false;
      for (const part of parts) {
        if (/^\s+$/.test(part)) {
          pair.appendChild(document.createTextNode(part));
        } else {
          const useChord = !assignedChord ? (chordText || '') : '';
          assignedChord = true;
          pair.appendChild(makeSyl(useChord, part));
        }
      }
      if (!assignedChord && chordText) {
        pair.appendChild(makeSyl(chordText, ''));
      }
    };

    if (tokens.length === 0) {
      appendChunk('', lyricRaw);
      return pair;
    }
    if (tokens[0].col > 0) {
      appendChunk('', lyricRaw.substring(0, tokens[0].col));
    }
    for (let k = 0; k < tokens.length; k++) {
      const tok = tokens[k];
      const next = tokens[k + 1];
      const endCol = next ? next.col : Math.max(lyricRaw.length, tok.col + tok.text.length);
      const sub = lyricRaw.substring(tok.col, endCol);
      appendChunk(transposeChord(tok.text, currentTranspose), sub);
    }
    return pair;
  }

  function renderSong(rawText) {
    const rawLines = rawText.split('\n');
    const parsed = rawLines.map(raw => ({ raw, kind: classify(raw) }));
    const frag = document.createDocumentFragment();
    let i = 0;
    while (i < parsed.length) {
      // Skip the "based on …" line — surfaced as a subtitle above.
      if (i === basedOnLineIndex) { i += 1; continue; }
      const cur = parsed[i];
      const next = parsed[i + 1];
      // Pair a chord line with the lyric line immediately under it.
      if (cur.kind === 'chords' && next && next.kind === 'lyrics') {
        const pair = renderChordLyricPair(cur.raw, next.raw);
        pair.dataset.rawLineStart = String(i);
        pair.dataset.rawLineEnd = String(i + 1);
        frag.appendChild(pair);
        i += 2;
      } else {
        const div = document.createElement('div');
        div.className = 'line ' + cur.kind;
        div.dataset.rawLineStart = String(i);
        div.dataset.rawLineEnd = String(i);
        if (cur.kind === 'section') {
          const info = sectionDisplayInfo(cur.raw);
          div.textContent = info.text || ' ';
          // Drives the CSS rule that collapses the label into a blank-line
          // gap in lyrics-only mode. Bridge / Intro / Outro / Instrumental
          // etc. don't get the flag and stay visible.
          if (info.hideInLyricsMode) div.dataset.sectionHiddenInLyrics = 'true';
        } else if (cur.kind === 'chords') {
          div.textContent = transposeChordLineString(cur.raw, currentTranspose);
        } else {
          div.textContent = cur.kind === 'blank' ? ' ' : cur.raw;
        }
        frag.appendChild(div);
        i += 1;
      }
    }
    $body.replaceChildren(frag);
  }

  /** List view — one title per line, simple stacked rendering. No chord
   *  classification, no chord-line styling: this is just a list of songs
   *  the host is looking at. */
  function renderList(rawText) {
    const titles = rawText.split('\n').map(t => t.trim()).filter(Boolean);
    const frag = document.createDocumentFragment();
    titles.forEach((t, i) => {
      const div = document.createElement('div');
      div.className = 'list-item';
      const idx = document.createElement('span');
      idx.className = 'list-idx';
      idx.textContent = String(i + 1) + '.';
      const lbl = document.createElement('span');
      lbl.className = 'list-title';
      lbl.textContent = t;
      div.append(idx, lbl);
      frag.appendChild(div);
    });
    if (titles.length === 0) {
      const div = document.createElement('div');
      div.className = 'list-empty';
      div.textContent = '(no songs)';
      frag.appendChild(div);
    }
    $body.replaceChildren(frag);
  }

  // -------------------------------------------------------------------
  // Scroll loop — line-anchored scroll
  // -------------------------------------------------------------------
  //
  // What "where am I in the song" means:
  //   - In play mode (host is playing): convert elapsed → progress fraction
  //     of the song's duration → line index float. The audience always
  //     centres the same raw-line as the host, regardless of font-size
  //     differences. Smooth between ~3 Hz ticks via local extrapolation.
  //   - In scroll mode (host hand-scrolling out of play): the host sends
  //     a 0..1 scroll fraction; we treat it as a progress fraction over
  //     the line count.
  //   - When the host has neither a playing position nor a scroll
  //     update (paused, just opened a song, etc.): hold the current
  //     position. NEVER auto-scroll based on stale state.
  //
  // Line anchors: every .line/.list-item gets measured once after each
  // render, giving us each line's centre y and height in the rendered
  // DOM. We interpolate between anchors to handle sub-line positions.

  /// Rebuild lineAnchors from the current DOM. Each entry covers one host-
  /// side raw-line index range (rawLineStart..rawLineEnd inclusive); a
  /// chord-pair DOM block covers two host lines so we double-count it for
  /// alignment. anchor.centerY is the y position to put under viewport
  /// center when the audience is on that line.
  function rebuildLineAnchors() {
    lineAnchors = [];
    const elems = $body.querySelectorAll('[data-raw-line-start]');
    if (elems.length === 0) return;
    elems.forEach(el => {
      const start = parseInt(el.dataset.rawLineStart, 10);
      const endL  = parseInt(el.dataset.rawLineEnd, 10);
      const top = el.offsetTop;
      const height = el.offsetHeight;
      // Distribute the block's vertical extent across however many host
      // lines it represents, so a chord-pair (2 host lines) gives 2
      // distinct anchor centers spaced across its height.
      const count = (endL - start + 1);
      const sub = height / count;
      for (let k = 0; k < count; k++) {
        lineAnchors[start + k] = { centerY: top + sub * (k + 0.5), height: sub };
      }
    });
    // Fill any gaps (defensive) with the last valid anchor.
    let last = lineAnchors.find(Boolean);
    for (let i = 0; i < lineAnchors.length; i++) {
      if (!lineAnchors[i]) lineAnchors[i] = last;
      else last = lineAnchors[i];
    }
  }

  window.addEventListener('resize', () => {
    // Recompute on viewport size change so wrap reflow doesn't desync.
    rebuildLineAnchors();
  });
  // Recompute also when the user toggles chords / zooms — both change the
  // layout. Use a ResizeObserver on the body for completeness.
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => rebuildLineAnchors()).observe($body);
  }

  /// Convert a line-float index to a target scrollTop that puts that line
  /// at the viewport centre.
  function lineFloatToScrollTop(lf) {
    if (lineAnchors.length === 0) return 0;
    const i = Math.max(0, Math.min(lineAnchors.length - 1, Math.floor(lf)));
    const frac = Math.max(0, Math.min(1, lf - i));
    const a = lineAnchors[i];
    const b = lineAnchors[i + 1] || a;
    const centerY = a.centerY * (1 - frac) + b.centerY * frac;
    const viewportH = $scroll.clientHeight;
    return Math.max(0, centerY - viewportH / 2);
  }

  /// Compute the host's current line-float position from server state.
  /// Returns null when there's nothing meaningful to point at (host paused
  /// and hasn't reported a scroll position).
  function targetLineFloat(now) {
    const lineCount = lineAnchors.length;
    if (lineCount === 0) return null;
    const songDur = Math.max(0.0001, (row && row.length_seconds) || 0);
    if (serverInPlay && songDur > 0) {
      // Time-based: extrapolate elapsed forward if playing, hold if paused.
      const sinceTick = (now - lastTickAt) / 1000;
      const live = serverPlaying ? serverElapsed + sinceTick : serverElapsed;
      const tAfter = Math.max(0, live - LEAD_IN_SEC);
      const dur = Math.max(0.0001, songDur - LEAD_IN_SEC);
      const progress = Math.max(0, Math.min(1, tAfter / dur));
      return progress * (lineCount - 1);
    }
    if (serverScrollFraction !== null) {
      const f = Math.max(0, Math.min(1, serverScrollFraction));
      return f * (lineCount - 1);
    }
    return null;
  }

  let lastFrameAt = performance.now();

  function loop(now) {
    const dt = Math.min(0.1, (now - lastFrameAt) / 1000);  // cap dt for tab-sleep recovery
    lastFrameAt = now;
    requestAnimationFrame(loop);

    if (!row) return;
    if ($body.dataset.mode === 'list') return;
    if (lineAnchors.length === 0) return;

    const baseLinesPerSec = lineAnchors.length / Math.max(30, row.length_seconds || 180);

    // DETACHED: tracking toggled off, OR this viewer scrolled
    // manually during the current song's playback. Advance at the
    // autonomous time-based rate while the master is playing; hold
    // position when paused so we don't drift forward over a long
    // pause. Per-song detachment is reset on song change and on
    // master "stop" (handled in the transition helper).
    // Master-side override wins over the per-viewer toggle: when the
    // performer's "Followers track my position" is off, every viewer
    // is detached regardless of their personal Follow button.
    const inDetachedMode = !masterFollowEnabled || !trackingEnabled || detachedDuringSong;
    if (inDetachedMode) {
      if (serverPlaying) {
        displayedLineFloat = Math.min(
          lineAnchors.length - 1,
          displayedLineFloat + baseLinesPerSec * dt
        );
      }
      $scroll.scrollTop = lineFloatToScrollTop(displayedLineFloat);
      if ((now - lastTickAt) < 4000) lastSeenTickAt = now;
      return;
    }

    // NORMAL tracking: chase the master's target position.
    const target = targetLineFloat(now);
    if (target === null) {
      // Master paused with no scroll signal — hold position.
      return;
    }

    if (needSnap) {
      displayedLineFloat = target;
      needSnap = false;
      fastCatchUp = false;
    } else {
      const delta = target - displayedLineFloat;
      const pixelDelta = Math.abs(
        lineFloatToScrollTop(target) - lineFloatToScrollTop(displayedLineFloat)
      );
      const screenH = Math.max(1, $scroll.clientHeight);
      const screensAhead = pixelDelta / screenH;

      // Sticky catch-up: when the master is >1.5 screens ahead, the
      // slew clamps to 3.75× base (= 2.5× the existing "faster"
      // tier) and stays there until we've actually reached the
      // target. Without the latch, the rate would oscillate back to
      // the slower tier as the gap closes through the 1.5-screen
      // threshold and the chase would feel uneven.
      if (screensAhead > 1.5) {
        fastCatchUp = true;
      } else if (Math.abs(delta) < CATCH_UP_RELEASE_LINES) {
        fastCatchUp = false;
      }

      const baseMaxStep = baseLinesPerSec * 4 * dt;
      let boost;
      if (fastCatchUp) {
        boost = FAST_CATCH_UP_MULTIPLIER;
      } else if (screensAhead > 1.0) {
        // Existing "faster" tier — same threshold and multiplier as
        // before, kept so behavior on modest deltas (1-1.5 screens)
        // is unchanged.
        boost = 1.5;
      } else {
        boost = 1.0;
      }
      const maxStep = baseMaxStep * boost;
      const step = delta >= 0 ? Math.min(delta, maxStep) : Math.max(delta, -maxStep);
      displayedLineFloat += step;
    }

    // The line-space slew above already produces a smoothly-advancing
    // displayedLineFloat — applying the derived scrollTop directly is
    // smooth by construction. No pixel-space slew or snap branch needed.
    $scroll.scrollTop = lineFloatToScrollTop(displayedLineFloat);

    // Track "fresh" state for the warning indicator.
    if ((now - lastTickAt) < 4000) lastSeenTickAt = now;
  }
  requestAnimationFrame(loop);

  // -------------------------------------------------------------------
  // Expiry watchdog — flip to "session ended" once we're confident the
  // session is dead. See applyRow for the (explicit-stop vs natural-
  // staleness) distinction.
  // -------------------------------------------------------------------
  setInterval(() => {
    if (!row) return;
    const expiresAt = new Date(row.expires_at);
    const stoppedExplicitly = expiresAt.getTime() < 1_000_000;
    const naturallyExpired = expiresAt < new Date();
    if (stoppedExplicitly || (naturallyExpired && !sessionLooksLive())) {
      showBanner('info', 'Session ended.');
      setStatus('idle', 'Ended');
    }
  }, 30000);
})();
