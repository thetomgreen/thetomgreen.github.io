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

  // Hand-scroll detection, OUT OF PLAY MODE ONLY.
  //
  // Outside play mode nothing advances on its own, so the performer's
  // `scroll_fraction` moves only when a human drags the chart. That makes it
  // an unambiguous hand-scroll signal, and the page follows it at the flat
  // maximum rate in either direction.
  //
  // There is deliberately no in-play equivalent. Inferring a drag from a
  // jump in `elapsed` looked reasonable but is not sound: virtualElapsed
  // advances as `dt * multiplier` (speed nudges, audio-scroll tempo), so it
  // is not on wall-clock time and any wall-clock prediction mis-fires during
  // ordinary playback — which ran the page at 9.375x the base rate.
  /// Threshold on the fraction. Small: it exists to ignore rounding, not to
  /// distinguish a drag from anything else. 0.01 of a song is well under a
  /// line on any realistic chart.
  const SEEK_FRACTION_THRESHOLD = 0.01;

  // NOTE: there is no lead-in CONSTANT any more. The lead-in is geometry,
  // not a fixed number of seconds — see `leadInSeconds()`, which derives it
  // from this viewer's viewport height, font size and the song length the
  // same way the iOS player does. The old flat 2 s meant the page started
  // crawling from the first bar while the performer's screen was still
  // stationary.

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
  // Per-song detachment is cleared on song change. The per-viewer Follow
  // toggle is session-only — every page load starts in following mode.
  // -------------------------------------------------------------------

  /// Per-viewer toggle. Always starts ON, every load.
  ///
  /// This deliberately does NOT persist. It used to be remembered in
  /// localStorage, which meant one tap of Follow — to read back a verse at
  /// a gig, say — silently disabled tracking on every future visit, long
  /// after the moment had passed. The audience's expectation when they open
  /// the page is that it follows the performer; that's the whole point of
  /// scanning the code, and the performer's own "Followers track my
  /// position" switch being ON should not be contradicted by a stale
  /// preference the viewer set weeks ago. Detaching stays a within-session
  /// state, cleared by a reload.
  let trackingEnabled = true;
  // Drop the key any older build may have left behind, so a viewer who is
  // already carrying `false` isn't stuck with it.
  try { localStorage.removeItem(lsKey('trackMaster')); } catch {}
  /// Master-side override carried in every TickPayload. Default `true`
  /// for legacy iOS builds that don't include the field. When `false`,
  /// the master has paused live position-tracking for ALL followers —
  /// the per-viewer toggle becomes irrelevant until the master flips
  /// it back on.
  let masterFollowEnabled = true;
  /// Per-song runtime detachment. Goes true when the user manually
  /// scrolls, at any point — before play, mid-song, or while paused.
  /// Cleared on song change OR when the master leaves play mode
  /// (= "hit stop").
  let detachedDuringSong = false;
  /// True once the master has been seen playing at least once on the
  /// CURRENT song. Safe scroll mode creeps only after this — before the
  /// performer has started, a detached viewer's page holds still rather
  /// than crawling away from line 1. Reset on every song change.
  let songHasStarted = false;
  /// Safe scroll mode's own song clock, in seconds. Seeded from the
  /// performer's live elapsed at the moment the viewer detaches, so the
  /// page carries on at the phase of the song it was already at — including
  /// sitting still if the lead-in hasn't finished yet.
  let safeElapsed = 0;
  /// The viewer's explicit play/pause choice, or null if they haven't
  /// touched it. Null means "follow the song": the clock runs once the song
  /// has started. Once they press the button their choice holds for the
  /// rest of the song (cleared on song change), so the performer pausing
  /// between verses can't override a viewer who chose to keep reading.
  let safePlayOverride = null;
  function safeClockRunning() {
    return safePlayOverride !== null ? safePlayOverride : songHasStarted;
  }
  /// Safe scroll mode's own float position, in pixels. The DOM's scrollTop
  /// is integer-ish in most browsers, and the song-rate creep is a fraction
  /// of a pixel per frame (~0.3 px at 60 Hz for a 3-minute song), so
  /// accumulating directly into scrollTop would round to zero every frame
  /// and the page would never move. We integrate here and write the result.
  let safeScrollTop = 0;
  /// The scrollTop we last wrote ourselves. Any larger difference on the
  /// next frame means a human scrolled — that's the detach signal, and in
  /// safe mode it's also how we adopt their position instead of fighting
  /// it. `null` suppresses the check for one frame (after a render or an
  /// explicit repositioning, where we moved the page deliberately).
  let lastAppliedScrollTop = null;
  /// Edge-detection bookkeeping for rising-edge "master hit play" snap
  /// and falling-edge "master hit stop" detach-reset.
  let prevServerPlaying = false;
  let prevServerInPlay = false;
  /// Same idea for the OUT-OF-PLAY-MODE path, where the performer's
  /// position arrives as `scroll_fraction` rather than `elapsed`. This one
  /// needs no prediction: outside play mode nothing advances on its own, so
  /// the fraction changes ONLY when a human drags the chart. Any forward
  /// change is therefore an unambiguous hand-scroll.
  let prevSeekFraction = null;
  /// Sticky fast-catch-up flag. Set when target is >1.5 viewport heights
  /// ahead; stays set until displayed has actually reached target. This
  /// is what makes the catch-up "continue at this speed until the
  /// target is reached" rather than oscillating between tiers as the
  /// gap closes.
  let fastCatchUp = false;
  /// Sticky "the performer is hand-scrolling" latch. Armed by either
  /// seek detector — a discontinuity in elapsed, or a changed scroll
  /// fraction outside play mode — in EITHER direction, and released on
  /// arrival. While set, the page travels at the flat maximum
  /// reposition rate regardless of direction or distance.
  let repositioning = false;
  /// Threshold (in line-floats) for "target reached" when releasing the
  /// sticky catch-up state. Half a line is tight enough to feel like an
  /// arrival without flickering at the boundary on the next frame.
  const CATCH_UP_RELEASE_LINES = 0.5;
  /// Multiplier the catch-up tier applies on top of the base slew rate.
  /// 2.5× the existing "faster" tier of 1.5× per spec.
  const FAST_CATCH_UP_MULTIPLIER = 1.5 * 2.5;

  // --- Backward tracking -------------------------------------------------
  // When the master jumps BACKWARD (repeat a verse, restart a section) the
  // page is allowed to travel back faster than it ever travels forward:
  // the ceiling is 2.5× the fastest forward speed, i.e. 2.5× the catch-up
  // tier. Forward motion is what the audience reads along with, so it stays
  // gentle; backward motion is a reposition, and dawdling through it means
  // the audience is reading the wrong part of the song the whole time.
  const BACKWARD_MAX_MULTIPLIER = FAST_CATCH_UP_MULTIPLIER * 2.5;
  /// Backward approach is PROPORTIONAL, not constant-rate: speed is the
  /// remaining gap divided by this time constant, clamped to the ceiling
  /// above. So a small correction crawls while a big jump starts at the
  /// ceiling and eases in.
  ///
  /// 0.6 s chosen by simulation (60-line / 3-minute song). Proportional
  /// control has a long exponential tail, so a larger constant is much
  /// slower than the ceiling suggests — at 1.5 s a half-song jump needed
  /// 9.8 s to settle, which is not "rapid" by any reading. At 0.6 s:
  ///   back 30 lines → full ceiling, visually landed 3.4 s, settled 4.8 s
  ///   back  3 lines → peaks 5.0 lines/s, settled 2.4 s
  ///   back  1 line  → peaks 1.7 lines/s (5x natural), settled 1.8 s
  /// i.e. a half-song jump moves ~7.5x faster than a one-line nudge.
  const BACKWARD_TIME_CONSTANT_SEC = 0.6;
  /// Exponential approach never mathematically arrives — close the last
  /// sliver in one step rather than asymptoting forever. Keep this SMALL:
  /// the closing step lands in a single frame, so it travels at
  /// `BACKWARD_ARRIVE_LINES / dt` lines/sec — at 0.25 that's ~15 lines/s
  /// on a 60 Hz display, which would breach the ceiling above. At 0.05
  /// (≈1 px, invisible) the peak stays exactly on the ceiling.
  const BACKWARD_ARRIVE_LINES = 0.05;

  // --- Safe scroll mode --------------------------------------------------
  /// How far the DOM's scrollTop may drift from the value we last wrote
  /// before we conclude a human moved it. Covers sub-pixel rounding and
  /// browser scroll-anchoring jitter without swallowing a real gesture.
  const USER_SCROLL_TOLERANCE_PX = 2;

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

  /// Is this viewer ACTUALLY tracking the performer right now? All three
  /// conditions have to hold, and the button must reflect this rather than
  /// just the toggle's own value — otherwise scrolling into safe scroll
  /// mode leaves the button lit, and the page looks like it's still
  /// following when it isn't. That mismatch is unreadable to a viewer and
  /// undiagnosable to us.
  function effectivelyFollowing() {
    return trackingEnabled && masterFollowEnabled && !detachedDuringSong;
  }

  /// Return this viewer to following the performer.
  ///
  /// Several paths lead back here — tapping Follow, the performer
  /// re-enabling tracking — and every one of them has to clear the SAME
  /// set of state. Clearing it in each caller is how `safePlayOverride`
  /// got stranded: a viewer who paused, re-followed, then later scrolled
  /// to read back a verse found the page frozen, because their old pause
  /// was still in force with no visible cause and no obvious way out.
  function reattachToMaster() {
    detachedDuringSong = false;
    fastCatchUp = false;
    safePlayOverride = null;
    // TRAVEL to the performer's position rather than jumping to it. A snap
    // is disorienting: the viewer has been reading somewhere of their own
    // choosing, and teleporting them gives no sense of which way the song
    // moved or how far. Arming the reposition latch scrolls them there at
    // the flat maximum rate — the same speed a hand-scroll uses — in
    // whichever direction the performer happens to be, and the latch
    // releases itself on arrival.
    repositioning = true;
    needSnap = false;
  }

  const $togglePlay = document.getElementById('toggle-play');

  // Cache the rendered state: applyFollowToggle is called every frame, and
  // touching DOM attributes 60x/sec for no reason is wasteful.
  let renderedFollowOn = null;
  let renderedMasterOn = null;
  let renderedPlayVisible = null;
  let renderedPlayOn = null;
  function applyFollowToggle() {
    if (!$toggleFollow) return;
    const on = effectivelyFollowing();
    if (on !== renderedFollowOn) {
      $toggleFollow.setAttribute('aria-pressed', on ? 'true' : 'false');
      renderedFollowOn = on;
    }
    applyMasterStatus();
    applyPlayToggle();
  }
  function applyMasterStatus() {
    if (!$toggleFollow) return;
    if (masterFollowEnabled === renderedMasterOn) return;
    renderedMasterOn = masterFollowEnabled;
    // When the performer turns off "Followers track my position", REMOVE the
    // Follow button rather than dimming it. Tapping it cannot have any
    // effect in that state, so presenting it at all is misleading — the
    // viewer is simply in free-scroll now, and the play/pause transport
    // below is the control that actually does something for them.
    $toggleFollow.classList.toggle('hidden', !masterFollowEnabled);
    $toggleFollow.title = 'Follow the performer\'s position — tap to read at your own pace';
  }
  /// Play/pause is shown exactly when the viewer is NOT following: they
  /// tapped Follow off, they scrolled away, or the performer turned tracking
  /// off for everyone. While following, the performer's transport is in
  /// charge and a local one would be a lie.
  function applyPlayToggle() {
    if (!$togglePlay) return;
    // Never on a list view. The scroll loop returns early there, so the
    // button would be visible and completely inert — a control that can
    // never do anything is worse than no control.
    const isList = $body.dataset.mode === 'list';
    const visible = !isList && !effectivelyFollowing();
    if (visible !== renderedPlayVisible) {
      $togglePlay.classList.toggle('hidden', !visible);
      renderedPlayVisible = visible;
    }
    const playing = safeClockRunning();
    if (playing !== renderedPlayOn) {
      // aria-pressed tracks "is scrolling"; the label is the ACTION, so it
      // reads "Pause" while moving and "Play" while stopped.
      $togglePlay.setAttribute('aria-pressed', playing ? 'true' : 'false');
      $togglePlay.textContent = playing ? 'Pause' : 'Play';
      $togglePlay.title = playing ? 'Pause the scroll' : 'Resume scrolling at the song\'s pace';
      renderedPlayOn = playing;
    }
  }
  if ($togglePlay) {
    $togglePlay.addEventListener('click', () => {
      safePlayOverride = !safeClockRunning();
      applyPlayToggle();
    });
  }
  applyFollowToggle();
  if ($toggleFollow) {
    $toggleFollow.addEventListener('click', () => {
      // The button acts on the EFFECTIVE mode, not the raw toggle. If the
      // viewer has scrolled away (detachedDuringSong) the button already
      // reads "not following", so a tap must re-attach — under the old
      // toggle-only logic that same tap flipped `trackingEnabled` to false
      // and appeared to do nothing at all.
      // Session-only: intentionally not written to localStorage — see the
      // declaration of `trackingEnabled`.
      trackingEnabled = !effectivelyFollowing();
      applyFollowToggle();
      if (trackingEnabled) {
        // Re-engaging: snap on the next frame so the viewer lands on the
        // performer's current position instead of slewing across the song.
        reattachToMaster();
      } else {
        // Disengaging: this is request #3 — the Follow button drops the
        // viewer into exactly the same safe scroll mode a manual scroll
        // produces. Adopt the current position as the creep origin so the
        // page carries on from where they're looking, at the phase of the
        // song it was already at.
        safeScrollTop = $scroll.scrollTop;
        lastAppliedScrollTop = $scroll.scrollTop;
        safeElapsed = liveElapsed(performance.now());
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
    // Counts at ANY point in the song — before the master presses play,
    // mid-performance, or while they're paused. Scrolling is an explicit
    // "let me read at my own pace", and it shouldn't matter what the
    // performer's transport happens to be doing at that instant.
    //
    // Except on a list view: there is nothing to follow and nothing to
    // scroll at song pace, so detaching there would only strip the Follow
    // button and put a dead transport on screen over a static list.
    if ($body.dataset.mode === 'list') return;
    // Seed the safe-mode clock ONLY when arriving from a following state.
    // A viewer already in safe mode (they tapped Follow off) has their own
    // clock running, and re-seeding it from the performer would throw that
    // away — if the performer were still inside their lead-in, one nudge
    // of the page would stop it dead.
    if (effectivelyFollowing()) {
      safeElapsed = liveElapsed(performance.now());
    }
    if (detachedDuringSong) {
      // Already detached — still adopt the new position as the creep
      // origin, or the next frame drags the page back.
      safeScrollTop = $scroll.scrollTop;
      return;
    }
    detachedDuringSong = true;
    fastCatchUp = false;
    // Adopt wherever the viewer just put the page as safe mode's origin,
    // so the creep continues from their position rather than snapping
    // back to the tracked one.
    safeScrollTop = $scroll.scrollTop;
    // Reflect it on the button immediately rather than waiting for the
    // next frame — this is the viewer's only feedback that the scroll
    // took effect.
    applyFollowToggle();
  }
  $scroll.addEventListener('wheel', noteManualScroll, { passive: true });
  $scroll.addEventListener('touchmove', (e) => {
    // 2-finger touchmove is pinch-zoom, handled by the gesture block
    // above — never a scroll.
    if (e.touches && e.touches.length === 1) noteManualScroll();
  }, { passive: true });
  document.addEventListener('keydown', (e) => {
    if (SCROLL_KEYS.has(e.key)) noteManualScroll();
  });
  // NOTE: there is deliberately no `pointerdown` listener. It used to
  // stand in for "desktop scrollbar drag", but it fires on ANY click in
  // the scroll area — harmless while detachment required active playback,
  // a trap now that any scroll detaches (a viewer tapping the page would
  // silently stop following). The scroll-position delta check in the loop
  // catches scrollbar drags, and every other input method, by observing
  // the effect rather than guessing at the gesture.

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
    // Latch "this song is under way". Safe scroll mode creeps only after
    // this, and once set it stays set for the rest of the song no matter
    // what the master's transport does — a detached viewer keeps reading
    // at song pace through the performer's pauses and stops.
    if (serverPlaying) songHasStarted = true;

    // Did the performer REPOSITION rather than just play on? Compare this
    // tick's elapsed against what the previous tick plus wall time
    // predicted. A hand-scroll moves virtualElapsed discontinuously, and
    // slewing toward it takes seconds — snap instead so the page follows
    // the performer's scroll straight away, even before it has started
    // scrolling on its own.
    // FORWARD discontinuities only. A backward jump is also a reposition,
    // but it is deliberately NOT snapped: the proportional backward
    // controller (see BACKWARD_* above) exists precisely so the audience
    // can see where the performer went when they drop back to repeat a
    // verse, and it was tuned and confirmed on device. Snapping every
    // discontinuity would have silently thrown that away, because a
    // hand-scroll and a backward tracking correction are indistinguishable
    // on the wire — both arrive as nothing but a changed `elapsed`.
    //
    // Forward is the direction that was actually hurting: the page holding
    // at the top while the performer scrolls ahead, then crawling after
    // them at the forward cap for several seconds.
    // NOTE: an in-play hand-scroll is deliberately NOT detected here.
    // It would have to be inferred from a jump in `elapsed`, but the
    // performer's virtualElapsed advances as `dt * multiplier`, where the
    // multiplier carries their speed nudges and the audio-scroll tempo
    // (PlaybackSession.swift) — so it is not on wall-clock time. Predicting
    // it from wall time mis-fires during perfectly ordinary playback, which
    // armed the hand-scroll latch and ran the page at 9.375x the base rate
    // instead of 1x: the "much too rapid" forward scroll. Doing this
    // properly needs iOS to flag a drag explicitly rather than us guessing
    // from the numbers. Out of play mode the signal IS unambiguous — see
    // the scroll_fraction check below.

    // The out-of-play-mode hand-scroll. This is the case requirement #1 is
    // literally about — the performer flicking through the chart before
    // they have started the song — and it is the one the elapsed-based
    // detector above cannot see, because out of play mode `elapsed` does
    // not move at all: the position arrives as `scroll_fraction`.
    //
    // No prediction is needed here. Nothing advances by itself outside play
    // mode, so a changed fraction is always a human dragging. Forward-only,
    // matching the elapsed rule, so a backward drag still travels visibly
    // under the proportional backward controller.
    if (!serverInPlay && serverScrollFraction !== null) {
      if (prevSeekFraction !== null &&
          Math.abs(serverScrollFraction - prevSeekFraction) > SEEK_FRACTION_THRESHOLD &&
          effectivelyFollowing()) {
        repositioning = true;
        fastCatchUp = false;
      }
      prevSeekFraction = serverScrollFraction;
    }
    if (playingRose && effectivelyFollowing()) {
      needSnap = true;
      fastCatchUp = false;
    }
    if (inPlayFell) {
      // Master left play mode. Release the catch-up latch, but do NOT
      // clear the viewer's detachment: safe scroll mode is meant to
      // survive the performer stopping. Only a song change (or tapping
      // Follow) re-attaches them.
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
      `track:${trackingEnabled ? 'on' : 'off'} masterFollow:${masterFollowEnabled ? 'on' : 'off'} det:${detachedDuringSong ? 'Y' : 'n'} fc:${fastCatchUp ? 'Y' : 'n'} rep:${repositioning ? 'Y' : 'n'} sP:${serverPlaying ? 'Y' : 'n'} sI:${serverInPlay ? 'Y' : 'n'}\n` +
      `started:${songHasStarted ? 'Y' : 'n'} safeTop:${safeScrollTop.toFixed(1)} lf:${displayedLineFloat.toFixed(2)} sf:${serverScrollFraction === null ? '∅' : serverScrollFraction.toFixed(3)}\n` +
      `leadIn:${leadInSeconds().toFixed(1)}s elap:${serverElapsed.toFixed(1)} safeElap:${safeElapsed.toFixed(1)} run:${safeClockRunning() ? 'Y' : 'n'} ovr:${safePlayOverride === null ? '-' : (safePlayOverride ? 'play' : 'pause')}\n` +
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
      // A new song hasn't started until we see the master playing it —
      // even if the previous one was mid-flight. Cleared before the
      // transition helper runs so the incoming row's is_playing can
      // immediately re-latch it.
      songHasStarted = false;
      repositioning = false;
      // New song, new clock: drop the viewer's play/pause choice and the
      // seek baseline, both of which only made sense for the old song.
      safePlayOverride = null;
      safeElapsed = serverElapsed;
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
        // We just moved the page ourselves (to the top, or about to snap).
        // Re-baseline BOTH trackers to the value we wrote: excusing our own
        // write while leaving the detector armed. (Disarming it with `null`
        // instead opened a window where a scroll landing before the next
        // frame was silently swallowed.)
        safeScrollTop = $scroll.scrollTop;
        lastAppliedScrollTop = $scroll.scrollTop;
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
      repositioning,
      prevServerPlaying,
      prevServerInPlay,
      serverPlaying,
      serverInPlay,
      displayedLineFloat,
      songHasStarted,
      safeScrollTop,
      inSafeScrollMode: !effectivelyFollowing(),
      safeElapsed,
      safePlayOverride,
      safeClockRunning: safeClockRunning(),
      leadInSeconds: leadInSeconds(),
      geometry: scrollGeometry(),
      followVisible: $toggleFollow ? !$toggleFollow.classList.contains('hidden') : false,
      playVisible: $togglePlay ? !$togglePlay.classList.contains('hidden') : false,
    });
    window.__tapPlay = () => $togglePlay?.click();
    window.__setSafeElapsed = (e) => { safeElapsed = e; };
    window.__simulateManualScroll = () => noteManualScroll();
    /// Drive a real user-style scroll: move the DOM directly, exactly as a
    /// finger or wheel would, so the loop's position-delta detector is what
    /// notices — not a hand-called hook.
    window.__scrollBy = (px) => { $scroll.scrollTop = $scroll.scrollTop + px; };
    window.__setScrollFraction = (f) => { serverScrollFraction = f; };
    window.__tapFollow = () => $toggleFollow?.click();
    window.__setMasterFollow = (enabled) => {
      const prev = masterFollowEnabled;
      masterFollowEnabled = !!enabled;
      if (!prev && masterFollowEnabled && trackingEnabled && !detachedDuringSong) {
        reattachToMaster();
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
          reattachToMaster();
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
    const makeSyl = (chordText, lyricText, isRun) => {
      const syl = document.createElement('span');
      syl.className = 'syl';
      const ch = document.createElement('span');
      ch.className = chordText
        ? (isRun ? 'syl-chord syl-chord-run' : 'syl-chord')
        : 'syl-chord syl-chord-empty';
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

    // How many chords hang entirely past the end of the lyric? Syllable
    // pairing only makes sense while there is lyric text under the chords.
    // With a short lyric under a long chord line — "Coach" under
    // "G        D        Am        C        x4" — there is nothing to pair
    // most of them with, and forcing it produced a wide unbreakable segment
    // that wrapped onto its own row, so the chart read as three rows
    // (G / Coach / D Am C x4) instead of the two the performer sees.
    //
    // Two or more overhanging chords means the line is really a chord ROW
    // with a lyric under it, which is exactly how the iOS player draws it:
    // one chord line, columns preserved, lyric beneath. Fall back to that.
    // One overhanging chord is left to the run logic below, so an ordinary
    // line whose last chord tips a character past the lyric keeps its
    // chord-over-syllable alignment.
    const overhang = tokens.filter(t => t.col >= lyricRaw.length).length;
    if (overhang >= 2) {
      pair.classList.add('chord-row-pair');
      const chordRow = document.createElement('div');
      chordRow.className = 'line chords chord-row';
      chordRow.textContent = transposeChordLineString(chordRaw, currentTranspose);
      const lyricRow = document.createElement('div');
      lyricRow.className = 'line lyric chord-row-lyric';
      lyricRow.textContent = lyricRaw.length > 0 ? lyricRaw : ' ';
      pair.replaceChildren(chordRow, lyricRow);
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
      if (sub.length === 0) {
        // This chord starts past the end of the lyric, so there's no text to
        // hang it (or any chord after it) on — tokens are column-sorted, so
        // once one runs off the end they all do. Emitting them as separate
        // empty syllables butts them together ("DAmCx4"). Instead emit the
        // whole tail as ONE monospace segment that reproduces the source
        // column gaps (same padding rule as transposeChordLineString), so
        // "G     D   Am  C  x4" keeps the chart's shape. The gaps are drawn
        // in the chord font, so they're column-exact within the run; and
        // because the run lives in a .syl-chord it vanishes cleanly in
        // chords-off mode instead of leaving a hole in the lyric.
        const runStart = tok.col;
        let runText = '';
        for (let j = k; j < tokens.length; j++) {
          const rel = tokens[j].col - runStart;
          if (runText.length < rel) runText += ' '.repeat(rel - runText.length);
          runText += transposeChord(tokens[j].text, currentTranspose);
        }
        if (pair.lastChild) pair.appendChild(document.createTextNode(' '));
        pair.appendChild(makeSyl(runText, '', true));
        break;
      }
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

  /// Inverse of `lineFloatToScrollTop`: which line-float is currently under
  /// the viewport centre. Used when leaving safe scroll mode, so the gap the
  /// tracker has to close is measured from where the viewer actually
  /// scrolled to rather than from the stale tracked position.
  function scrollTopToLineFloat(top) {
    if (lineAnchors.length === 0) return 0;
    const centerY = top + $scroll.clientHeight / 2;
    const last = lineAnchors.length - 1;
    if (centerY <= lineAnchors[0].centerY) return 0;
    if (centerY >= lineAnchors[last].centerY) return last;
    // centerY is monotonically non-decreasing across anchors (they're laid
    // out top to bottom), so a binary search is valid and O(log n).
    let lo = 0, hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (lineAnchors[mid].centerY <= centerY) lo = mid; else hi = mid;
    }
    const span = Math.max(0.0001, lineAnchors[hi].centerY - lineAnchors[lo].centerY);
    return lo + (centerY - lineAnchors[lo].centerY) / span;
  }

  // -------------------------------------------------------------------
  // Scroll geometry — a JS port of the iOS player's curve
  // (SongPlayerView.restingOffset / middleOffset / leadInSeconds /
  // scrollPosition). The audience page now paces itself exactly the way
  // the performer's own screen does.
  //
  // The important property is the LEAD-IN: the page does not start moving
  // the instant the song starts. It holds at the top until the singer has
  // sung enough that the current lyric has reached the middle of the
  // visible area, and only then begins to scroll. Previously the page used
  // a flat 2-second lead-in and a linear line-index ramp, so it crawled
  // from the first bar while the performer's screen was still stationary.
  //
  // Everything is measured from THIS viewer's layout — their viewport
  // height, their font size, their zoom level — not the performer's. Two
  // viewers at different zoom levels genuinely need different lead-ins for
  // the text to reach the middle of their screens at the same moment in
  // the song, which is what "font-size aware and window-size aware" means.
  // -------------------------------------------------------------------

  function songSeconds() {
    return Math.max(0.0001, (row && row.length_seconds) || 180);
  }
  /// Per-song scroll acceleration, mirrored from the host row. 0 = linear.
  function tempoAcceleration() {
    const a = row && row.tempo_acceleration;
    return typeof a === 'number' && isFinite(a) ? a : 0;
  }

  /// Live layout measurements, in pixels. Recomputed per use rather than
  /// cached: zoom, the chords toggle and device rotation all change it, and
  /// the numbers are cheap reads of already-computed layout.
  function scrollGeometry() {
    const S = Math.max(1, $scroll.clientHeight);
    const maxTop = Math.max(0, $scroll.scrollHeight - S);
    // Bottom of the actual song text. NOT scrollHeight — the page carries a
    // #bottom-spacer whose height is deliberate padding, and folding that
    // into the song's extent would make the page pace as though the song
    // were longer than the lyrics.
    const contentBottom = $body.offsetTop + $body.offsetHeight;
    const lineH = lineAnchors.length > 0
      ? Math.max(1, $body.offsetHeight / lineAnchors.length)
      : 20;
    // Hard stop: last line sits at the bottom with a 2-line buffer.
    const resting = Math.min(maxTop, Math.max(0, contentBottom - S + 2 * lineH));
    // Pacing target: the offset that WOULD put the last line at the vertical
    // middle. Never actually reached (position is clamped to `resting`); it
    // exists so the song's last line arrives well after the eye has got to
    // the bottom, then rests there for the closing seconds.
    const middle = Math.max(resting, contentBottom - S / 2 - lineH / 2);
    return { S, maxTop, resting, middle, lineH };
  }

  /// Seconds of song that must elapse before the page starts scrolling.
  /// Pure geometry: screen height, total scroll distance, song length.
  function leadInSeconds() {
    const { S, middle } = scrollGeometry();
    const L = songSeconds();
    if (middle <= 0) return L;
    return L * S / (2 * middle + S);
  }

  /// Absolute scroll offset for a given elapsed time, under the same
  /// linear-tempo curve the iOS player uses. Reduces to a straight line
  /// when tempo_acceleration is 0.
  function scrollTopForElapsed(elapsed) {
    const { resting, middle } = scrollGeometry();
    const L = songSeconds();
    if (elapsed >= L) return resting;
    const lead = leadInSeconds();
    if (elapsed < lead) return 0;          // hold at the top through the lead-in
    const dur = Math.max(0.0001, L - lead);
    const tau = elapsed - lead;
    const a = tempoAcceleration();
    const vAvg = middle / dur;
    const v0 = 2 * vAvg / (2 + a);
    const v1 = (1 + a) * v0;
    return Math.min(resting, v0 * tau + (v1 - v0) * tau * tau / (2 * dur));
  }

  /// Instantaneous scroll SPEED (px/sec) of that curve. Safe scroll mode
  /// integrates this rather than jumping to the absolute position, so the
  /// viewer's own manual scrolling stays as an offset instead of being
  /// overwritten — they read where they like, at the song's pace.
  function scrollSpeedForElapsed(elapsed) {
    const L = songSeconds();
    if (elapsed >= L) return 0;
    const lead = leadInSeconds();
    if (elapsed < lead) return 0;
    const { middle } = scrollGeometry();
    const dur = Math.max(0.0001, L - lead);
    const tau = elapsed - lead;
    const a = tempoAcceleration();
    const vAvg = middle / dur;
    const v0 = 2 * vAvg / (2 + a);
    const v1 = (1 + a) * v0;
    return v0 + (v1 - v0) * tau / dur;
  }

  /// Compute the host's current line-float position from server state.
  /// Returns null when there's nothing meaningful to point at (host paused
  /// and hasn't reported a scroll position).
  /// The performer's live elapsed, extrapolated between the ~3 Hz ticks.
  function liveElapsed(now) {
    const sinceTick = (now - lastTickAt) / 1000;
    return serverPlaying ? serverElapsed + sinceTick : serverElapsed;
  }

  function targetLineFloat(now) {
    const lineCount = lineAnchors.length;
    if (lineCount === 0) return null;
    if (serverInPlay) {
      // Drive the same lead-in + tempo curve the performer's screen uses,
      // then express the result in line space so the existing slew and
      // backward controllers keep working unchanged. `scrollTopToLineFloat`
      // is the exact inverse of `lineFloatToScrollTop`, so this round-trips
      // to the pixel offset the curve asked for.
      return scrollTopToLineFloat(scrollTopForElapsed(liveElapsed(now)));
    }
    if (serverScrollFraction !== null) {
      // Performer is hand-scrolling outside play mode. Their fraction is of
      // their own scrollable range; map it onto ours.
      //
      // Against `resting`, NOT `maxTop`. iOS divides by its restingOffset
      // (contentHeight - containerHeight + 2*lineHeight), whereas our
      // scrollHeight also contains the 80vh #bottom-spacer. Using maxTop
      // inflated every fraction — at f=0.75 the audience sat about 17 lines
      // ahead of the performer.
      const f = Math.max(0, Math.min(1, serverScrollFraction));
      return scrollTopToLineFloat(f * scrollGeometry().resting);
    }
    return null;
  }

  let lastFrameAt = performance.now();

  function loop(now) {
    const dt = Math.min(0.1, (now - lastFrameAt) / 1000);  // cap dt for tab-sleep recovery
    lastFrameAt = now;
    requestAnimationFrame(loop);

    if (!row) return;
    // Keep the Follow button honest about the effective mode. Detachment
    // can be set from a gesture listener or from the scroll-delta check
    // below, and the master override arrives on ticks, so the single
    // reliable place to reconcile the UI is once per frame. Cheap — it
    // only touches the DOM when the state actually changes.
    applyFollowToggle();
    if ($body.dataset.mode === 'list') return;
    if (lineAnchors.length === 0) return;

    // Same song-length source as the scroll curve. These used to disagree
    // (a 30 s floor here vs songSeconds() there), so on any song under
    // 30 s the slew cap was paced against a different song than the
    // position it was chasing.
    const baseLinesPerSec = lineAnchors.length / songSeconds();

    // Did a human move the page since our last write? Observing the effect
    // beats guessing at the gesture: this catches wheel, touch drag,
    // scrollbar drag, keyboard, momentum fling and browser find-in-page
    // alike. `null` means we deliberately repositioned and should skip one
    // frame. The gesture listeners above still fire first where they can —
    // they detach a frame earlier, which is imperceptible but free.
    if (lastAppliedScrollTop !== null &&
        Math.abs($scroll.scrollTop - lastAppliedScrollTop) > USER_SCROLL_TOLERANCE_PX) {
      noteManualScroll();
    }

    // SAFE SCROLL MODE: tracking toggled off (request #3), OR this viewer
    // scrolled the page themselves (request #2), OR the performer has
    // paused tracking for everyone. The page keeps creeping forward at the
    // song's own rate — regardless of what the master's transport is doing,
    // once the song has been seen playing — and the viewer can scroll
    // wherever they like without being dragged back.
    //
    // The critical difference from the old detached branch: we do NOT
    // recompute scrollTop from a tracked line position every frame. That
    // overwrote the viewer's gesture ~16 ms after they made it, which is
    // what made "free scrolling" impossible. Here we integrate a float in
    // pixel space and add to it, so a manual scroll simply moves the
    // origin and the creep carries on from there.
    const inSafeScrollMode = !effectivelyFollowing();
    if (inSafeScrollMode) {
      const maxTop = Math.max(0, $scroll.scrollHeight - $scroll.clientHeight);
      // Re-adopt the live position ONLY when someone else moved it (the
      // viewer scrolling, momentum settling, reflow). Adopting every frame
      // would round our sub-pixel accumulator away each time and the creep
      // would never advance.
      if (lastAppliedScrollTop === null ||
          Math.abs($scroll.scrollTop - lastAppliedScrollTop) > USER_SCROLL_TOLERANCE_PX) {
        safeScrollTop = clamp($scroll.scrollTop, 0, maxTop);
      }
      if (safeClockRunning()) {
        safeElapsed += dt;
        // Integrate the SPEED of the performer's curve rather than jumping
        // to its absolute position. That keeps the viewer's own scrolling
        // as an offset — they read wherever they like, and the page still
        // advances at the song's pace under them. It also inherits the
        // lead-in for free: speed is zero until the lead-in elapses, so a
        // viewer who detaches before the song gets going sits still until
        // the song's timing says to move, exactly as the performer does.
        const v = scrollSpeedForElapsed(safeElapsed);
        if (v > 0) {
          safeScrollTop = Math.min(maxTop, safeScrollTop + v * dt);
          $scroll.scrollTop = safeScrollTop;
        }
      }
      lastAppliedScrollTop = $scroll.scrollTop;
      // Keep the tracked position aligned with where the viewer actually
      // is, so tapping Follow measures its catch-up from reality.
      displayedLineFloat = scrollTopToLineFloat($scroll.scrollTop);
      if ((now - lastTickAt) < 4000) lastSeenTickAt = now;
      return;
    }

    // NORMAL tracking: chase the master's target position.
    const target = targetLineFloat(now);
    if (target === null) {
      // Master paused with no scroll signal — hold position. Still arm the
      // user-scroll detector against the CURRENT position: this is the
      // state the page sits in before the performer ever presses play, and
      // leaving it unarmed here meant a pre-play scroll was never noticed.
      lastAppliedScrollTop = $scroll.scrollTop;
      safeScrollTop = $scroll.scrollTop;
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
      // Arm the catch-up latch on FORWARD gaps only. Backward motion is
      // governed by its own proportional controller below, which is
      // already faster than any forward tier — letting a backward gap
      // arm the forward latch would just leave it stuck on afterwards.
      if (delta > 0 && screensAhead > 1.5) {
        fastCatchUp = true;
      } else if (Math.abs(delta) < CATCH_UP_RELEASE_LINES) {
        fastCatchUp = false;
      }
      // Release the hand-scroll latch once we have arrived, so the page
      // drops back to ordinary reading pace instead of staying hot.
      if (repositioning && Math.abs(delta) < CATCH_UP_RELEASE_LINES) {
        repositioning = false;
      }

      const baseMaxStep = baseLinesPerSec * 4 * dt;
      /// The flat maximum: 2.5x the fastest forward reading speed. This is
      /// the ceiling the backward controller is allowed to reach, and a
      /// hand-scroll travels AT it — not proportionally up to it.
      const repositionRate = baseLinesPerSec * 4 * BACKWARD_MAX_MULTIPLIER;

      let step;
      if (repositioning) {
        // HAND-SCROLL. The performer is dragging the chart, and the page
        // follows at the flat maximum rate whichever way they went and
        // however far — a drag is a deliberate "look here now", so there
        // is nothing to be gained by easing into it. Distinct from the
        // proportional controller below, which shapes the page's response
        // to the song's own position moving.
        const gap = Math.abs(delta);
        step = gap <= BACKWARD_ARRIVE_LINES
          ? delta                                  // land the last sliver
          : Math.sign(delta) * Math.min(gap, repositionRate * dt);
      } else if (delta >= 0) {
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
        step = Math.min(delta, baseMaxStep * boost);
      } else {
        // BACKWARD: the master jumped back (repeated a verse, restarted a
        // section). Speed is PROPORTIONAL to the remaining gap and capped
        // at 2.5× the fastest forward speed, so a two-line correction
        // crawls while a half-song jump moves right away and eases in as
        // it lands — rather than every backward move travelling at one
        // flat rate.
        const gap = -delta;
        if (gap <= BACKWARD_ARRIVE_LINES) {
          step = delta;                       // close the last sliver outright
        } else {
          const ceiling = baseLinesPerSec * 4 * BACKWARD_MAX_MULTIPLIER;
          const rate = Math.min(gap / BACKWARD_TIME_CONSTANT_SEC, ceiling);
          step = -Math.min(gap, rate * dt);
        }
      }
      displayedLineFloat += step;
    }

    // The line-space slew above already produces a smoothly-advancing
    // displayedLineFloat — applying the derived scrollTop directly is
    // smooth by construction. No pixel-space slew or snap branch needed.
    $scroll.scrollTop = lineFloatToScrollTop(displayedLineFloat);
    // Record what we wrote so next frame can tell our own motion apart
    // from the viewer's, and keep safe mode's origin warm in case they
    // scroll (or tap Follow off) between now and then.
    lastAppliedScrollTop = $scroll.scrollTop;
    safeScrollTop = $scroll.scrollTop;

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
