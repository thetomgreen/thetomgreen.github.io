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
  const $title    = document.getElementById('song-title');
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

  $zoomIn.addEventListener('click', () => { zoom = clamp(zoom + 2, 12, 64); applyZoom(); localStorage.setItem(lsKey('zoom'), String(zoom)); });
  $zoomOut.addEventListener('click', () => { zoom = clamp(zoom - 2, 12, 64); applyZoom(); localStorage.setItem(lsKey('zoom'), String(zoom)); });
  $toggle.addEventListener('click', () => {
    showChords = !showChords;
    localStorage.setItem(lsKey('showChords'), String(showChords));
    applyChordsToggle();
  });

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

  /** Sentinel set by the iOS app in song_subtitle when the host is on a
   *  list view (set list overview, songs tab, etc.) rather than a song. */
  const LIST_SENTINEL = '__list__';

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

    const isList = (data.song_subtitle === LIST_SENTINEL);
    if (data.song_raw_text !== renderedSongRawText || isList !== ($body.dataset.mode === 'list')) {
      if (isList) {
        renderList(data.song_raw_text || '');
        $body.dataset.mode = 'list';
      } else {
        renderSong(data.song_raw_text || '');
        $body.dataset.mode = 'song';
      }
      renderedSongRawText = data.song_raw_text || '';
      // Re-measure DOM line positions and snap to the host's current
      // line on next frame (rather than starting at top and slewing
      // there — which made joining mid-song feel like the page was
      // "racing to catch up").
      rebuildLineAnchors();
      needSnap = true;
    }
    // Show/hide the chord toggle — pointless in list mode.
    $toggle.style.visibility = isList ? 'hidden' : 'visible';

    // Empty state: title and raw text are both empty. Shouldn't happen in
    // normal use but covers the case where a row gets cleared.
    const isEmpty = !data.song_title && !data.song_raw_text;
    $empty.classList.toggle('hidden', !isEmpty);
    $body.style.display = isEmpty ? 'none' : '';
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
      lastTickAt = performance.now();
      hideBanner();
      setStatus('live', 'Live');
    })
    .on('broadcast', { event: 'row' }, (msg) => {
      if (msg.payload) applyRow(msg.payload);
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

    // One syllable: an inline-block holding a single word of lyric and
    // optionally an absolutely-positioned chord above it.
    const makeSyl = (chordText, lyricText) => {
      const syl = document.createElement('span');
      syl.className = 'syl';
      if (chordText) {
        const ch = document.createElement('span');
        ch.className = 'syl-chord';
        ch.textContent = chordText;
        syl.appendChild(ch);
      }
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
      appendChunk(tok.text, sub);
    }
    return pair;
  }

  function renderSong(rawText) {
    const rawLines = rawText.split('\n');
    const parsed = rawLines.map(raw => ({ raw, kind: classify(raw) }));
    const frag = document.createDocumentFragment();
    let i = 0;
    while (i < parsed.length) {
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
        div.textContent = cur.kind === 'blank' ? ' ' : cur.raw;
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

    const target = targetLineFloat(now);
    if (target === null) {
      // Nothing to follow — hold whatever position we're at.
      return;
    }

    if (needSnap) {
      displayedLineFloat = target;
      needSnap = false;
    } else {
      const delta = target - displayedLineFloat;
      // Snap rather than slew when the gap is large (seek, song switch,
      // late join). The slew is for "follow at natural speed within a
      // line or two of the host"; bigger jumps need to land immediately.
      if (Math.abs(delta) > 4) {
        displayedLineFloat = target;
      } else {
        // Max lines per second the slew can close at. Big enough to catch
        // up after a small drift but capped so the page never feels like
        // it's racing. Roughly 2× the natural song-line speed.
        const linesPerSec = lineAnchors.length / Math.max(30, row.length_seconds || 180);
        const maxStep = linesPerSec * 4 * dt;
        const step = delta >= 0 ? Math.min(delta, maxStep) : Math.max(delta, -maxStep);
        displayedLineFloat += step;
      }
    }

    const targetTop = lineFloatToScrollTop(displayedLineFloat);
    const currentTop = $scroll.scrollTop;
    const topDelta = targetTop - currentTop;
    // The line-space slew already handles smoothness; we can apply the
    // scroll position directly without an additional pixel-space slew.
    // But if the line layout shifted (resize, font change), snap so the
    // user doesn't see a slow drift.
    if (Math.abs(topDelta) > $scroll.clientHeight * 2) {
      $scroll.scrollTop = targetTop;
    } else {
      $scroll.scrollTop = targetTop;
    }

    // Track "fresh" state for the warning indicator.
    if ((now - lastTickAt) < 4000) lastSeenTickAt = now;
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
