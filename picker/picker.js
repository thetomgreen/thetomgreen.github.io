/* StageRoll — the Google Picker, hosted.
 *
 * WHY THIS PAGE EXISTS AT ALL
 * ---------------------------
 * The app needs `drive.file` and nothing wider. `drive.readonly` is a
 * RESTRICTED scope: OAuth verification plus an annual paid CASA assessment,
 * and until that completes the consent screen is stuck in Testing — 100
 * hand-listed testers and refresh tokens that expire weekly. `drive.file`
 * grants access to files the user picks, which means a picker is not a nicety
 * here, it is the only way to open a document at all.
 *
 * Google's own picker-inside-OAuth flow (`trigger_onepick`) was tried first
 * and works from iOS, which was the real unknown. What it does not do is let
 * its action button be reached at phone width inside
 * `ASWebAuthenticationSession`: two device rounds, and the second was worse
 * than the first. The owner confirmed on 2026-09-23 that the button DOES
 * appear in landscape — so the picker can draw it, and the viewport it is
 * handed is the thing that is wrong. That viewport is exactly what
 * `ASWebAuthenticationSession` will not let us control and a `WKWebView`
 * will, which is what this page is for.
 *
 * WHY IT IS HOSTED RATHER THAN LOADED FROM A STRING
 * -------------------------------------------------
 * The Picker's `developerKey` is an API key restricted by HTTP referrer, so
 * the page needs a real origin. `loadHTMLString` has none worth the name and
 * a custom URL scheme is not something Google's referrer check accepts. We
 * already publish `lovedropsband.com` for the audience page, so this sits
 * beside it.
 *
 * WHAT IS AND IS NOT SECRET
 * -------------------------
 * The API key is public by design — it is referrer-restricted and every
 * client-side Picker integration ships one. The ACCESS TOKEN is not, and it
 * never appears in a URL: the app injects it as `window.__stageroll` through
 * a `WKUserScript` before this file runs, so it is in no history entry, no
 * `Referer` header and no log. It does reach Google's picker script, which
 * is the entire point of handing it over.
 */
(() => {
  'use strict';

  const $card     = document.getElementById('card');
  const $headline = document.getElementById('headline');
  const $detail   = document.getElementById('detail');
  const $retry    = document.getElementById('retry');
  const $cancel   = document.getElementById('cancel');

  /// Injected by the app before this script runs. Absent when someone has
  /// simply opened the URL, which is a perfectly ordinary thing to happen to
  /// a public page and must not look like a fault.
  const cfg = window.__stageroll || null;

  /// The app's end of the bridge. The name must match `messageName` in
  /// `GooglePickerSheet.swift`; nothing checks that at compile time on either
  /// side, so it is checked HERE, once, at startup — see `bridgeMissing`.
  const BRIDGE = 'stagerollPicker';

  function bridge() {
    const h = window.webkit && window.webkit.messageHandlers;
    return (h && h[BRIDGE]) || null;
  }

  /// Tell the app what happened. In a browser there is no bridge and these
  /// are no-ops, which is why every one of them is also reflected on the page
  /// itself — the page has to read correctly with nothing listening.
  function send(payload) {
    const h = bridge();
    if (!h) return;
    try { h.postMessage(payload); }
    catch (e) { /* the page is still the UI; nothing useful to do here */ }
  }

  function show(headline, detail, opts = {}) {
    $headline.textContent = headline;
    $detail.textContent = detail;
    $retry.classList.toggle('hidden', !opts.retry);
    $cancel.classList.toggle('hidden', !opts.cancel);
    $card.classList.remove('hidden');
  }

  /// One place for "this did not work", so the app is never left waiting on a
  /// picker that is not coming AND the page never sits on a dead "Opening…".
  function fail(code, detail) {
    send({ status: 'error', code, detail: String(detail || '') });
    show('Couldn’t open Google Drive', detail || 'Something went wrong.',
         { retry: true, cancel: true });
  }

  $retry.addEventListener('click', () => { window.location.reload(); });
  $cancel.addEventListener('click', () => send({ status: 'cancelled' }));

  // A config but no bridge means the app opened this page and the handler
  // name does not match — a typo on either side, in a string two files apart
  // that no compiler checks. Without this the failure is SILENT and horrible:
  // the picker works, the person picks their song, `postMessage` throws into
  // a swallowed catch, and the sheet sits there for ever having apparently
  // done nothing. Say it instead.
  if (cfg && !bridge()) {
    show('Couldn\u2019t hand the file back',
         'StageRoll opened this page but isn\u2019t listening for the result. '
       + 'This is a bug in the app, not something you did.',
         { cancel: true });
    return;
  }

  if (!cfg || !cfg.token) {
    // Not an error. This is the page doing its job for a browser visitor.
    show('StageRoll', 'This page is opened by the StageRoll app when you '
       + 'import a song from Google Docs. There is nothing to do here.');
    return;
  }

  // ------------------------------------------------------------------
  // Viewport
  //
  // The whole reason for the rewrite, so it is a CONFIG rather than a
  // constant: if the first device run still hides the action button at phone
  // width, the fix is the app passing a bigger number, not another redesign.
  // `width=device-width` is the default because a picker that fits the phone
  // honestly is better than one scaled down, and the evidence that it does
  // not fit is device evidence we do not have yet.
  // ------------------------------------------------------------------
  if (cfg.viewportWidth && cfg.viewportWidth !== 'device-width') {
    const vp = document.querySelector('meta[name=viewport]');
    if (vp) vp.content = `width=${cfg.viewportWidth}, viewport-fit=cover`;
  }

  // ------------------------------------------------------------------
  // The picker itself
  // ------------------------------------------------------------------
  let picker = null;

  /// `gapi` arrives from Google's CDN with `defer`, so it may not be there
  /// yet — and it may never arrive, on a hotel wifi that intercepts requests
  /// or a network that is simply down. Poll briefly, then say so rather than
  /// spinning for ever.
  function whenGapiReady(cb) {
    const deadline = Date.now() + 15000;
    (function poll() {
      if (window.gapi && window.gapi.load) return cb();
      if (Date.now() > deadline) {
        return fail('gapi-timeout',
          'Couldn’t load Google’s file picker. Check your internet connection.');
      }
      setTimeout(poll, 100);
    })();
  }

  function buildPicker() {
    const P = window.google && window.google.picker;
    if (!P) return fail('picker-missing', 'Google’s file picker didn’t load.');

    // DOCS, not DOCUMENTS: the latter is Google Docs only, and a folder is
    // not a Google Doc — filtering to Docs is what hid every folder in the
    // first device round and produced the "no way to browse folders" report.
    // Include folders so they can be navigated INTO; selecting a folder
    // itself is off, because `drive.file` grants access per picked file and
    // whether it reaches inside a picked folder is undocumented and
    // contradicted in Google's own forums. Navigating in and picking the
    // documents sidesteps the question entirely — they come back as ordinary
    // per-file grants.
    const view = new P.DocsView(P.ViewId.DOCUMENTS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false)
      .setMode(P.DocsViewMode.LIST);

    const builder = new P.PickerBuilder()
      .setOAuthToken(cfg.token)
      .setDeveloperKey(cfg.apiKey)
      .setAppId(cfg.appId)
      .setOrigin(window.location.protocol + '//' + window.location.host)
      .addView(view)
      .addView(new P.DocsView(P.ViewId.RECENTLY_PICKED))
      .setSize(Math.max(320, window.innerWidth), Math.max(320, window.innerHeight))
      .setCallback(onPicked);

    if (cfg.multiple) builder.enableFeature(P.Feature.MULTISELECT_ENABLED);
    // Support files living in a shared drive — a band's lyric folder is
    // exactly the kind of thing that ends up in one.
    builder.enableFeature(P.Feature.SUPPORT_DRIVES);

    picker = builder.build();
    picker.setVisible(true);
    // The fallback card would otherwise sit behind a picker that does not
    // fill the screen, reading "Opening your Google Drive…" underneath an
    // open Google Drive.
    show('Choose a document', 'Pick the song you want to import.');
    $card.classList.add('hidden');
  }

  function onPicked(data) {
    const P = window.google.picker;
    if (data.action === P.Action.PICKED) {
      const docs = data[P.Response.DOCUMENTS] || [];
      send({
        status: 'picked',
        files: docs.map(d => ({
          id: d[P.Document.ID],
          name: d[P.Document.NAME] || '',
          mimeType: d[P.Document.MIME_TYPE] || '',
        })),
      });
      show('Importing…', 'Bringing your song into StageRoll.');
      $card.classList.remove('hidden');
      return;
    }
    if (data.action === P.Action.CANCEL) {
      send({ status: 'cancelled' });
      show('Nothing chosen', 'You can close this and try again whenever you like.',
           { cancel: true });
      $card.classList.remove('hidden');
    }
  }

  show('Choose a document', 'Opening your Google Drive…');
  whenGapiReady(() => {
    window.gapi.load('picker', {
      callback: buildPicker,
      onerror: () => fail('gapi-load', 'Google’s file picker didn’t load.'),
      timeout: 15000,
      ontimeout: () => fail('gapi-load-timeout',
        'Google’s file picker took too long to load.'),
    });
  });

  // The picker sizes itself once. A rotation, or the keyboard coming and
  // going, changes the window underneath it — and a picker laid out for the
  // old size is how the action button ends up out of reach, which is the bug
  // this page exists to fix.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (!picker) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      try {
        picker.setVisible(false);
        buildPicker();
      } catch (e) { /* a picker mid-teardown is not worth a visible error */ }
    }, 150);
  });
})();
