/**
 * In-page downloader panel. Toggled by clicking the extension icon on an Echo360 course page
 * (class list) or lesson page. Lists the course's lessons; downloads the selected ones.
 */
(function () {
  'use strict';
  // If this runs again in the same page, the previous instance belongs to an extension
  // context that was reloaded/updated and can no longer receive messages: replace it.
  if (globalThis.__echo360dl) globalThis.__echo360dl.destroy();

  const Api = globalThis.Echo360Api;
  const Fmp4 = globalThis.Echo360Fmp4;
  const hasChrome = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
  const storage = hasChrome && chrome.storage && chrome.storage.local;

  // Act in the top frame, or in an Echo360 frame embedded in another site (e.g. Moodle).
  function isResponsibleFrame() {
    if (window.top === window) return true;
    const ao = location.ancestorOrigins;
    const topOrigin = ao && ao.length ? ao[ao.length - 1] : '';
    return !/echo360\./i.test(topOrigin);
  }

  const state = {
    host: null,
    ui: null,
    ctx: null,
    lessons: [],
    done: {},
    selected: new Set(),
    running: false,
    abort: null,
    opts: { sources: [1], quality: 'highest', audioOnly: false },
  };

  // ------------------------------------------------------------------ helpers

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : String(kid));
    return n;
  }

  const mb = (n) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(String(iso).replace(/(\.\d+)?Z?$/, '')); // Echo360 gives local wall-clock time
    if (isNaN(d)) return '';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' +
      d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function isoDay(iso) {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso || '');
    return m ? m[1] : '';
  }

  function safeName(s) {
    return String(s).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 150) || 'lecture';
  }

  function fileBase(lesson) {
    const day = isoDay(lesson.start);
    return safeName((day && !lesson.name.includes(day) ? day + ' ' : '') + lesson.name);
  }

  function saveFile(parts, filename, type) {
    const blob = new Blob(parts, { type });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename, style: 'display:none' });
    (document.body || document.documentElement).append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    return blob.size;
  }

  async function loadStored() {
    if (!storage) return;
    try {
      const all = await storage.get(null);
      if (all.opts) Object.assign(state.opts, all.opts);
      for (const [k, v] of Object.entries(all)) if (k.startsWith('done:')) state.done[k.slice(5)] = v;
    } catch (_) { /* storage unavailable */ }
  }

  function store(obj) {
    if (storage) storage.set(obj).catch(() => {});
  }

  // ------------------------------------------------------------------ UI

  const CSS = `
    :host { all: initial; }
    .panel { position: fixed; top: 12px; right: 12px; bottom: 12px; width: 420px; max-width: calc(100vw - 24px);
      display: flex; flex-direction: column; background: #fff; color: #1f2328; border: 1px solid #d0d7de;
      border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.22); font: 13px/1.4 system-ui, -apple-system, Segoe UI, sans-serif;
      z-index: 2147483647; overflow: hidden; }
    header { display: flex; align-items: flex-start; gap: 8px; padding: 12px 14px 10px; border-bottom: 1px solid #eaeef2; }
    header .t { flex: 1; min-width: 0; }
    header strong { font-size: 15px; }
    .sub { color: #59636e; font-size: 12px; margin-top: 2px; }
    .x { border: 0; background: none; font-size: 20px; line-height: 1; cursor: pointer; color: #59636e; padding: 0 2px; }
    .opts { padding: 10px 14px; border-bottom: 1px solid #eaeef2; display: grid; gap: 6px; }
    .row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; }
    .lbl { width: 54px; color: #59636e; }
    label { cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
    .hint { color: #59636e; font-size: 11.5px; }
    .sel { padding: 6px 14px; color: #59636e; font-size: 12px; border-bottom: 1px solid #eaeef2; }
    .sel a { color: #0969da; cursor: pointer; text-decoration: none; }
    .sel a:hover { text-decoration: underline; }
    ul { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1; }
    li { padding: 7px 14px; border-bottom: 1px solid #f3f4f6; }
    li.current { background: #fff8c5; }
    li .top { display: flex; align-items: center; gap: 8px; }
    li .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    li .date { color: #59636e; font-size: 11.5px; margin-left: 22px; }
    li .msg { font-size: 11.5px; margin-left: 22px; color: #59636e; }
    li .msg.err { color: #cf222e; }
    li .msg.ok { color: #1a7f37; }
    .pill { font-size: 11px; padding: 1px 7px; border-radius: 10px; background: #eaeef2; color: #59636e; white-space: nowrap; }
    .pill.ready { background: #ddf4ff; color: #0969da; }
    .pill.saved { background: #dafbe1; color: #1a7f37; }
    .bar { height: 4px; background: #eaeef2; border-radius: 2px; margin: 4px 0 0 22px; overflow: hidden; }
    .bar > div { height: 100%; width: 0; background: #0969da; transition: width .2s; }
    footer { padding: 10px 14px; border-top: 1px solid #eaeef2; display: grid; gap: 6px; }
    .btns { display: flex; gap: 8px; }
    button.go { flex: 1; padding: 8px 12px; border: 0; border-radius: 6px; background: #1f883d; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
    button.go:disabled { opacity: .55; cursor: default; }
    button.stop { padding: 8px 12px; border: 1px solid #d0d7de; border-radius: 6px; background: #f6f8fa; font: inherit; cursor: pointer; }
    .status { color: #59636e; font-size: 12px; min-height: 16px; }
    .status.err { color: #cf222e; }
    [hidden] { display: none !important; }
  `;

  function buildUi() {
    const host = el('div', { id: 'echo360-downloader-host' });
    const shadow = host.attachShadow({ mode: 'open' });
    const ui = {};
    ui.sub = el('div', { class: 'sub', text: 'Loading lessons…' });
    ui.src1 = el('input', { type: 'checkbox' });
    ui.src2 = el('input', { type: 'checkbox' });
    ui.audioOnly = el('input', { type: 'checkbox' });
    ui.qHigh = el('input', { type: 'radio', name: 'q', value: 'highest' });
    ui.qLow = el('input', { type: 'radio', name: 'q', value: 'lowest' });
    ui.count = el('span');
    ui.list = el('ul');
    ui.go = el('button', { class: 'go', text: 'Download selected', onclick: () => run() });
    ui.stop = el('button', { class: 'stop', text: 'Stop', hidden: true, onclick: () => state.abort && state.abort.abort() });
    ui.status = el('div', { class: 'status' });

    const onOpt = () => {
      state.opts = {
        sources: [ui.src1.checked && 1, ui.src2.checked && 2].filter(Boolean),
        quality: ui.qLow.checked ? 'lowest' : 'highest',
        audioOnly: ui.audioOnly.checked,
      };
      ui.src1.disabled = ui.src2.disabled = state.opts.audioOnly;
      store({ opts: state.opts });
      updateCount();
    };
    [ui.src1, ui.src2, ui.audioOnly, ui.qHigh, ui.qLow].forEach((i) => i.addEventListener('change', onOpt));

    const pick = (mode) => {
      state.selected.clear();
      for (const l of state.lessons) {
        if (Api.lessonStatus(l) !== 'ready') continue;
        if (mode === 'all' || (mode === 'new' && !state.done[l.id])) state.selected.add(l.id);
      }
      renderList();
    };

    shadow.append(
      el('style', { text: CSS }),
      el('div', { class: 'panel' },
        el('header', null,
          el('div', { class: 't' }, el('strong', { text: 'Echo360 Downloader' }), ui.sub),
          el('button', { class: 'x', title: 'Close', text: '×', onclick: () => toggle(false) })),
        el('div', { class: 'opts' },
          el('div', { class: 'row' }, el('span', { class: 'lbl', text: 'Video' }),
            el('label', { title: 'Echo360 source 1: the lecture PC screen' }, ui.src1, 'Slides'),
            el('label', { title: 'Echo360 source 2: the room camera' }, ui.src2, 'Camera'),
            el('label', null, ui.audioOnly, 'Audio only')),
          el('div', { class: 'row' }, el('span', { class: 'lbl', text: 'Quality' }),
            el('label', null, ui.qHigh, 'Highest'), el('label', null, ui.qLow, 'Smallest')),
          el('div', { class: 'hint', text: 'Each ticked source is saved as its own MP4 with the lecture audio. A one-hour lecture is about 135 MB (slides, 720p) or 32 MB (360p).' })),
        el('div', { class: 'sel' }, 'Select: ',
          el('a', { text: 'all', onclick: () => pick('all') }), ' · ',
          el('a', { text: 'none', onclick: () => pick('none') }), ' · ',
          el('a', { text: 'not yet downloaded', onclick: () => pick('new') }), ' ', ui.count),
        ui.list,
        el('footer', null, el('div', { class: 'btns' }, ui.go, ui.stop), ui.status)));

    ui.src1.checked = state.opts.sources.includes(1);
    ui.src2.checked = state.opts.sources.includes(2);
    ui.audioOnly.checked = !!state.opts.audioOnly;
    ui.src1.disabled = ui.src2.disabled = !!state.opts.audioOnly;
    (state.opts.quality === 'lowest' ? ui.qLow : ui.qHigh).checked = true;
    return { host, ui };
  }

  function setStatus(text, isError) {
    state.ui.status.textContent = text || '';
    state.ui.status.className = 'status' + (isError ? ' err' : '');
  }

  function updateCount() {
    const n = state.selected.size;
    state.ui.count.textContent = n ? `(${n} selected)` : '';
    const nothingToGet = !state.opts.audioOnly && !state.opts.sources.length;
    state.ui.go.disabled = state.running || !n || nothingToGet;
    state.ui.go.textContent = state.running ? 'Downloading…'
      : nothingToGet ? 'Choose a video source'
      : n ? `Download ${n} selected` : 'Select lectures to download';
  }

  const PILL = { ready: 'Ready', upcoming: 'Upcoming', live: 'Live now', processing: 'Processing', none: 'No recording' };
  const SOURCE_NAMES = { 1: 'Slides', 2: 'Camera' };

  function renderList() {
    const { list } = state.ui;
    list.textContent = '';
    state.rows = {};
    for (const l of state.lessons) {
      const status = Api.lessonStatus(l);
      const done = state.done[l.id];
      const cb = el('input', { type: 'checkbox', disabled: status !== 'ready' || state.running });
      cb.checked = state.selected.has(l.id);
      cb.addEventListener('change', () => {
        cb.checked ? state.selected.add(l.id) : state.selected.delete(l.id);
        updateCount();
      });
      const pill = done
        ? el('span', { class: 'pill saved', title: 'Downloaded ' + new Date(done.at).toLocaleString(), text: 'Downloaded' })
        : el('span', { class: 'pill ' + status, text: PILL[status] });
      const msg = el('div', { class: 'msg', hidden: true });
      const bar = el('div', { class: 'bar', hidden: true }, el('div'));
      const li = el('li', { class: state.ctx.lessonId === l.id ? 'current' : null },
        el('label', { class: 'top' }, cb, el('span', { class: 'name', title: l.name, text: l.name }), pill),
        el('div', { class: 'date', text: formatDate(l.start) }), msg, bar);
      state.rows[l.id] = { li, cb, msg, bar, pill };
      list.append(li);
    }
    updateCount();
  }

  function rowMsg(id, text, kind) {
    const r = state.rows[id];
    if (!r) return;
    r.msg.hidden = !text;
    r.msg.textContent = text || '';
    r.msg.className = 'msg' + (kind ? ' ' + kind : '');
  }

  function rowProgress(id, frac) {
    const r = state.rows[id];
    if (!r) return;
    r.bar.hidden = frac == null;
    if (frac != null) r.bar.firstChild.style.width = Math.round(Math.min(1, frac) * 100) + '%';
  }

  // ------------------------------------------------------------------ open / close

  function isShown() {
    return !!state.host && state.host.style.display !== 'none';
  }

  async function open() {
    if (!state.host) {
      await loadStored();
      const { host, ui } = buildUi();
      state.host = host;
      state.ui = ui;
      document.documentElement.append(host);
      await refresh();
      return;
    }
    state.host.style.display = '';
    const now = Api.detectContext();
    if (!state.running && (now.sectionId !== state.ctx.sectionId || now.lessonId !== state.ctx.lessonId)) await refresh();
  }

  async function refresh() {
    state.ctx = Api.detectContext();
    if (!state.ctx.sectionId) {
      state.ui.sub.textContent = 'Open a course’s class list (or a lecture) on Echo360, then click the icon again.';
      state.ui.go.disabled = true;
      return;
    }
    try {
      state.lessons = await Api.listLessons(state.ctx.sectionId);
    } catch (e) {
      state.ui.sub.textContent = 'Could not load lessons.';
      setStatus(e.message, true);
      return;
    }
    const ready = state.lessons.filter((l) => Api.lessonStatus(l) === 'ready');
    state.ui.sub.textContent = `${state.lessons.length} lessons in this course, ${ready.length} with recordings`;
    state.selected.clear();
    if (state.ctx.lessonId && ready.some((l) => l.id === state.ctx.lessonId)) {
      state.selected.add(state.ctx.lessonId);
    } else {
      ready.filter((l) => !state.done[l.id]).forEach((l) => state.selected.add(l.id));
    }
    renderList();
    const cur = state.ctx.lessonId && state.rows[state.ctx.lessonId];
    if (cur) cur.li.scrollIntoView({ block: 'center' });
  }

  function toggle(force) {
    const show = force != null ? force : !isShown();
    if (show) open();
    else if (state.host) state.host.style.display = 'none';
  }

  // ------------------------------------------------------------------ download

  async function downloadLesson(lesson, signal) {
    const id = lesson.id;
    const base = fileBase(lesson);
    rowMsg(id, 'Reading lesson…');
    const media = await Api.getLessonMedia(id, signal);
    if (media.restrictDownload) throw new Error('Downloads are disabled for this recording by the course staff.');

    const saved = [];
    const audioCache = new Map();

    if (state.opts.audioOnly) {
      let pl = null;
      if (media.audioUri) {
        const url = await Api.resolveAudioUrl(media.audioUri, state.opts.quality, signal);
        pl = await Api.loadMediaPlaylist(url, signal);
      } else if (media.sources.size) {
        pl = (await Api.resolveSource(media.sources.values().next().value, null, state.opts.quality, signal)).audio;
      }
      if (!pl) throw new Error('No audio stream found in this recording.');
      const bytes = await Api.downloadTrack(pl, (n, t) => progress(id, 'audio', n, t), signal);
      const name = base + (pl.init ? '.m4a' : '.aac');
      saveFile([bytes], name, 'audio/mp4');
      return [name];
    }

    const wanted = state.opts.sources.filter((n) => media.sources.has(n));
    if (!wanted.length) {
      const have = [...media.sources.keys()].join(', ') || 'none';
      throw new Error(`Selected video source not in this recording (available: ${have}).`);
    }
    const multi = media.sources.size > 1;

    for (const n of wanted) {
      rowMsg(id, `${SOURCE_NAMES[n] || 'Source ' + n}: finding streams…`);
      const t = await Api.resolveSource(media.sources.get(n), media.audioUri, state.opts.quality, signal);
      const vSize = Api.trackSize(t.video) || 0;
      const aSize = (t.audio && Api.trackSize(t.audio)) || 0;
      const label = `${SOURCE_NAMES[n] || 'Source ' + n}${t.height ? ' (' + t.height + 'p)' : ''}`;
      const prog = { v: 0, a: 0 };
      const report = () => {
        const total = vSize + aSize;
        const got = prog.v + prog.a;
        rowMsg(id, `${label}: downloading ${total ? Math.round((100 * got) / total) + '% · ' : ''}${mb(got)}${total ? ' of ' + mb(total) : ''}`);
        rowProgress(id, total ? got / total : null);
      };
      const audioKey = t.audio && (t.audio.singleFile ? t.audio.singleFile.uri : t.audio.segments[0] && t.audio.segments[0].uri);
      let audioPromise = null;
      if (t.audio) {
        if (audioCache.has(audioKey)) {
          audioPromise = Promise.resolve(audioCache.get(audioKey));
          prog.a = aSize;
        } else {
          audioPromise = Api.downloadTrack(t.audio, (got) => { prog.a = got; report(); }, signal);
        }
      }
      const [video, audio] = await Promise.all([
        Api.downloadTrack(t.video, (got) => { prog.v = got; report(); }, signal),
        audioPromise,
      ]);
      if (audio) audioCache.set(audioKey, audio);

      const suffix = multi ? ` [${(SOURCE_NAMES[n] || 'source ' + n).toLowerCase()}]` : '';
      if (!audio) {
        saveFile([video], base + suffix + ' (no audio).mp4', 'video/mp4');
        saved.push(base + suffix + ' (no audio).mp4');
        continue;
      }
      rowMsg(id, `${label}: merging video and audio…`);
      await new Promise((r) => setTimeout(r, 0));
      let merged = null;
      try {
        if (t.video.init && t.audio.init) merged = Fmp4.mergeAV(video, audio);
      } catch (e) {
        console.warn('[Echo360 Downloader] merge failed, saving separate files:', e);
      }
      if (merged) {
        saveFile(merged.parts, base + suffix + '.mp4', 'video/mp4');
        saved.push(base + suffix + '.mp4');
      } else {
        // Fallback: separate files that can be combined with:
        //   ffmpeg -i video.mp4 -i audio.m4a -c copy out.mp4
        saveFile([video], base + suffix + ' (video).mp4', 'video/mp4');
        saveFile([audio], base + suffix + ' (audio).m4a', 'audio/mp4');
        saved.push(base + suffix + ' (video).mp4', base + suffix + ' (audio).m4a');
      }
    }
    return saved;
  }

  function progress(id, what, got, total) {
    rowMsg(id, `Downloading ${what} ${total ? Math.round((100 * got) / total) + '% · ' : ''}${mb(got)}${total ? ' of ' + mb(total) : ''}`);
    rowProgress(id, total ? got / total : null);
  }

  function beforeUnload(e) {
    e.preventDefault();
    e.returnValue = '';
  }

  async function run() {
    if (state.running) return;
    const queue = state.lessons.filter((l) => state.selected.has(l.id));
    if (!queue.length) return;
    state.running = true;
    state.abort = new AbortController();
    const signal = state.abort.signal;
    state.ui.stop.hidden = false;
    Object.values(state.rows).forEach((r) => (r.cb.disabled = true));
    updateCount();
    window.addEventListener('beforeunload', beforeUnload);

    let ok = 0;
    let failed = 0;
    for (let i = 0; i < queue.length; i++) {
      const lesson = queue[i];
      if (signal.aborted) break;
      setStatus(`Lecture ${i + 1} of ${queue.length}: ${lesson.name}`);
      state.rows[lesson.id] && state.rows[lesson.id].li.scrollIntoView({ block: 'nearest' });
      try {
        const files = await downloadLesson(lesson, signal);
        state.done[lesson.id] = { at: Date.now(), files };
        store({ ['done:' + lesson.id]: state.done[lesson.id] });
        rowMsg(lesson.id, 'Saved: ' + files.join(', '), 'ok');
        const r = state.rows[lesson.id];
        if (r) {
          r.pill.className = 'pill saved';
          r.pill.textContent = 'Downloaded';
        }
        state.selected.delete(lesson.id);
        ok++;
      } catch (e) {
        if (signal.aborted) {
          rowMsg(lesson.id, 'Stopped.', 'err');
          break;
        }
        failed++;
        console.error('[Echo360 Downloader]', lesson.name, e);
        rowMsg(lesson.id, e.message || String(e), 'err');
      }
      rowProgress(lesson.id, null);
    }

    window.removeEventListener('beforeunload', beforeUnload);
    state.running = false;
    state.abort = null;
    state.ui.stop.hidden = true;
    for (const l of state.lessons) {
      const r = state.rows[l.id];
      if (r) {
        r.cb.disabled = Api.lessonStatus(l) !== 'ready';
        r.cb.checked = state.selected.has(l.id);
      }
    }
    updateCount();
    setStatus(
      signal.aborted ? `Stopped. ${ok} lecture(s) saved.` : `Done: ${ok} saved${failed ? `, ${failed} failed (see messages above)` : ''}. Files are in your Downloads folder.`,
      failed > 0 && !ok
    );
  }

  // ------------------------------------------------------------------ wiring

  function onMessage(msg, _sender, sendResponse) {
    if (!msg || msg.type !== 'ECHO360DL_TOGGLE' || !isResponsibleFrame()) return false;
    toggle();
    sendResponse({ ok: true });
    return false;
  }

  // Keyboard shortcut (also a fallback if the toolbar icon is hidden): Alt+Shift+D (⌥⇧D on a Mac).
  function onKeyDown(e) {
    if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyD') {
      e.preventDefault();
      toggle();
    }
  }

  function destroy() {
    if (state.abort) state.abort.abort();
    window.removeEventListener('beforeunload', beforeUnload);
    document.removeEventListener('keydown', onKeyDown, true);
    if (hasChrome) {
      try {
        chrome.runtime.onMessage.removeListener(onMessage);
      } catch (_) { /* extension context already gone */ }
    }
    if (state.host) state.host.remove();
    state.host = null;
  }

  globalThis.__echo360dl = { toggle, open, refresh, destroy, state };
  document.addEventListener('keydown', onKeyDown, true);
  if (hasChrome) chrome.runtime.onMessage.addListener(onMessage);
  console.info('[Echo360 Downloader] ready: click the extension icon or press Alt+Shift+D');
})();
