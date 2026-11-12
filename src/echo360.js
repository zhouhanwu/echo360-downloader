/**
 * Echo360 data access. Runs as a content script on echo360.org.uk, so every fetch
 * carries the user's own Echo360 session cookies (the media CDN, content.echo360.org.uk,
 * only serves files to a signed-in browser).
 *
 *   GET /section/{sectionId}/syllabus      -> JSON list of lessons in the course
 *   GET /lesson/{lessonId}/classroom       -> HTML; embeds "playableMedias":[{uri, sourceIndex, trackType}]
 *       uri = .../1/s{N}_av.m3u8 (video N + audio), s{N}_v.m3u8 (video only), s0_a.m3u8 (audio only)
 */
(function (root) {
  'use strict';
  const Hls = root.Echo360Hls;

  const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

  class HttpError extends Error {
    constructor(status, what) {
      super(
        status === 401 || status === 403
          ? `Access denied (${status}) for ${what}. Your Echo360 session may have expired: reload the page (sign in again if asked) and retry.`
          : `HTTP ${status} for ${what}`
      );
      this.status = status;
    }
  }

  function describeUrl(u) {
    try {
      const x = new URL(u, location.href);
      return x.pathname.split('/').slice(-1)[0] || x.pathname;
    } catch (_) {
      return 'request';
    }
  }

  function looksLikeLogin(res) {
    return res.redirected && /\/\/login\.|\/login\b/i.test(res.url);
  }

  async function fetchText(url, what, signal) {
    const res = await fetch(url, { credentials: 'include', signal });
    if (!res.ok) throw new HttpError(res.status, what || describeUrl(url));
    if (looksLikeLogin(res)) throw new Error('Not signed in to Echo360. Reload the page, sign in, then try again.');
    return res.text();
  }

  // ---------------------------------------------------------------- page context

  /** Find the course section (and current lesson, if on a classroom page) for this page. */
  function detectContext() {
    const path = location.pathname;
    const sec = path.match(new RegExp('/section/(' + UUID + ')', 'i'));
    const les = path.match(/\/lesson\/([^/]+)\/classroom/);
    const lessonId = les ? decodeURIComponent(les[1]) : null;
    let sectionId = sec ? sec[1] : null;
    if (!sectionId && lessonId) {
      const embedded = findEmbeddedJsonValue(document.documentElement.innerHTML, 'sectionId');
      if (typeof embedded === 'string' && new RegExp('^' + UUID + '$', 'i').test(embedded)) sectionId = embedded;
    }
    if (!sectionId && lessonId) {
      const ids = lessonId.match(new RegExp(UUID, 'gi')); // G_{captureId}_{sectionId}_{start}_{end}
      if (ids && ids.length >= 2) sectionId = ids[1];
    }
    return { sectionId, lessonId };
  }

  // ---------------------------------------------------------------- embedded JSON

  /** Parse the JSON value that follows `marker` in `text` (object, array, string, number, bool, null). */
  function extractJsonValue(text, marker) {
    let from = 0;
    for (let tries = 0; tries < 20; tries++) {
      const i = text.indexOf(marker, from);
      if (i < 0) return undefined;
      from = i + marker.length;
      let s = from;
      while (/\s/.test(text.charAt(s))) s++;
      const open = text.charAt(s);
      let end = -1;
      if (open === '[' || open === '{') {
        let depth = 0;
        let inStr = false;
        for (let k = s; k < text.length; k++) {
          const c = text.charAt(k);
          if (inStr) {
            if (c === '\\') k++;
            else if (c === '"') inStr = false;
          } else if (c === '"') inStr = true;
          else if (c === '[' || c === '{') depth++;
          else if (c === ']' || c === '}') {
            depth--;
            if (depth === 0) {
              end = k + 1;
              break;
            }
          }
        }
      } else if (open === '"') {
        for (let k = s + 1; k < text.length; k++) {
          const c = text.charAt(k);
          if (c === '\\') k++;
          else if (c === '"') {
            end = k + 1;
            break;
          }
        }
      } else {
        const m = /^(-?[\d.eE+-]+|true|false|null)/.exec(text.slice(s, s + 40));
        if (m) end = s + m[0].length;
      }
      if (end > s) {
        try {
          return JSON.parse(text.slice(s, end));
        } catch (_) {
          /* try the next occurrence */
        }
      }
    }
    return undefined;
  }

  /**
   * Echo360 pages embed their data as a JSON string inside a JS string literal (\"key\":...).
   * Try plain JSON first, then the same text with one level of \" \\ \/ escaping removed.
   */
  function findEmbeddedJsonValue(text, key) {
    const marker = '"' + key + '":';
    const plain = extractJsonValue(text, marker);
    if (plain !== undefined) return plain;
    if (text.indexOf('\\"' + key + '\\"') < 0) return undefined;
    return extractJsonValue(text.replace(/\\(["\\/])/g, '$1'), marker);
  }

  // ---------------------------------------------------------------- lessons

  function toLesson(w) {
    const l = w.lesson || {};
    return {
      id: l.id,
      name: l.displayName || l.name || 'Untitled lesson',
      start: (l.timing && l.timing.start) || w.startTimeUTC || null,
      isFuture: !!w.isFuture,
      isLive: !!w.isLive,
      medias: (w.medias || []).map((m) => ({
        id: m.id,
        type: m.mediaType || '',
        available: !!m.isAvailable,
        processing: !!m.isProcessing,
      })),
    };
  }

  /** All lessons in a course section, in syllabus order. */
  async function listLessons(sectionId, signal) {
    const res = await fetch('/section/' + sectionId + '/syllabus', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!res.ok) throw new HttpError(res.status, 'the course lesson list');
    if (looksLikeLogin(res)) throw new Error('Not signed in to Echo360. Reload the page, sign in, then try again.');
    const json = await res.json();
    const out = [];
    const seen = new Set();
    (function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(visit);
      if (node.lesson && node.lesson.lesson && node.lesson.lesson.id) {
        const lesson = toLesson(node.lesson);
        if (!seen.has(lesson.id)) {
          seen.add(lesson.id);
          out.push(lesson);
        }
        return;
      }
      ['data', 'lessons', 'children'].forEach((k) => node[k] && visit(node[k]));
    })(json && json.data);
    return out;
  }

  /** 'ready' | 'upcoming' | 'live' | 'processing' | 'none' */
  function lessonStatus(lesson) {
    if (lesson.isFuture) return 'upcoming';
    if (lesson.isLive) return 'live';
    if (lesson.medias.some((m) => m.available && /video|audio/i.test(m.type))) return 'ready';
    if (lesson.medias.some((m) => m.processing)) return 'processing';
    return 'none';
  }

  /**
   * Stream info for one lesson, read from its classroom page.
   * @returns {{sources: Map<number, {index, avUri, vUri}>, audioUri: string|null, restrictDownload: boolean}}
   */
  function parseClassroomHtml(html) {
    const playable = findEmbeddedJsonValue(html, 'playableMedias');
    if (!Array.isArray(playable)) {
      throw new Error('Could not find the stream list on the lesson page (has Echo360 changed its player?)');
    }
    const sources = new Map();
    let audioUri = null;
    for (const m of playable) {
      if (!m || typeof m.uri !== 'string' || !/\.m3u8(\?|$)/i.test(m.uri)) continue;
      const types = (m.trackType || []).map((t) => String(t).toLowerCase());
      const hasVideo = types.includes('video');
      const hasAudio = types.includes('audio');
      if (hasVideo) {
        const idx = Number(m.sourceIndex) || 0;
        const s = sources.get(idx) || { index: idx, avUri: null, vUri: null };
        if (hasAudio) s.avUri = s.avUri || m.uri;
        else s.vUri = s.vUri || m.uri;
        sources.set(idx, s);
      } else if (hasAudio) {
        audioUri = audioUri || m.uri;
      }
    }
    return {
      sources,
      audioUri,
      restrictDownload: findEmbeddedJsonValue(html, 'restrictDownload') === true,
    };
  }

  async function getLessonMedia(lessonId, signal) {
    const html = await fetchText('/lesson/' + encodeURIComponent(lessonId) + '/classroom', 'the lesson page', signal);
    return parseClassroomHtml(html);
  }

  // ---------------------------------------------------------------- playlists

  async function loadPlaylist(url, signal) {
    return Hls.parse(await fetchText(url, describeUrl(url), signal), url);
  }

  async function loadMediaPlaylist(url, signal) {
    const pl = await loadPlaylist(url, signal);
    if (pl.type !== 'media') throw new Error('Expected a media playlist at ' + describeUrl(url));
    return pl;
  }

  /** Audio media playlist URL from an audio-only master (s0_a.m3u8) or media playlist. */
  async function resolveAudioUrl(uri, quality, signal) {
    const pl = await loadPlaylist(uri, signal);
    if (pl.type === 'media') return uri;
    const audios = pl.media.filter((m) => m.type === 'AUDIO' && m.uri);
    if (pl.variants.length) {
      const v = Hls.pickVariant(pl.variants, quality);
      const grp = v.audioGroup && audios.filter((m) => m.groupId === v.audioGroup);
      return grp && grp.length ? (grp.find((m) => m.isDefault) || grp[0]).uri : v.uri;
    }
    if (audios.length) return (quality === 'lowest' ? audios[0] : audios[audios.length - 1]).uri;
    throw new Error('No audio rendition found');
  }

  /** Video + matching audio media playlists for one video source. */
  async function resolveSource(src, audioMasterUri, quality, signal) {
    const masterUri = src.avUri || src.vUri;
    const pl = await loadPlaylist(masterUri, signal);
    let video;
    let audioUrl = null;
    let width = 0;
    let height = 0;
    if (pl.type === 'master') {
      const v = Hls.pickVariant(pl.variants, quality);
      width = v.width;
      height = v.height;
      video = await loadMediaPlaylist(v.uri, signal);
      const grp = v.audioGroup && pl.media.filter((m) => m.type === 'AUDIO' && m.groupId === v.audioGroup && m.uri);
      if (grp && grp.length) audioUrl = (grp.find((m) => m.isDefault) || grp[0]).uri;
    } else {
      video = pl;
    }
    if (!audioUrl && audioMasterUri) audioUrl = await resolveAudioUrl(audioMasterUri, quality, signal);
    const audio = audioUrl ? await loadMediaPlaylist(audioUrl, signal) : null;
    return { video, audio, width, height };
  }

  // ---------------------------------------------------------------- downloading

  async function fetchBytes(url, { range, expected, onProgress, signal }) {
    const headers = range ? { Range: 'bytes=' + range[0] + '-' + range[1] } : undefined;
    const res = await fetch(url, { credentials: 'include', headers, signal });
    if (!res.ok) throw new HttpError(res.status, describeUrl(url));
    const total = Number(res.headers.get('Content-Length')) || expected || 0;
    let buf = new Uint8Array(total || 4 * 1024 * 1024);
    let n = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (n + value.length > buf.length) {
        const bigger = new Uint8Array(Math.max(buf.length * 2, n + value.length));
        bigger.set(buf.subarray(0, n));
        buf = bigger;
      }
      buf.set(value, n);
      n += value.length;
      if (onProgress) onProgress(n, total || null);
    }
    return n === buf.length ? buf : buf.slice(0, n);
  }

  function isRetryable(e) {
    if (e && e.name === 'AbortError') return false;
    if (e && e.status) return e.status >= 500 || e.status === 429;
    return true; // network error
  }

  async function withRetry(fn, attempts, signal) {
    for (let i = 1; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (i >= attempts || !isRetryable(e) || (signal && signal.aborted)) throw e;
        await new Promise((r) => setTimeout(r, 1500 * i));
      }
    }
  }

  /** Expected byte size of a media playlist's track (null if unknown). */
  function trackSize(pl) {
    if (pl.singleFile) return pl.singleFile.size;
    const pieces = (pl.init ? [pl.init] : []).concat(pl.segments);
    return pieces.every((p) => p.range) ? pieces.reduce((s, p) => s + p.range.length, 0) : null;
  }

  /**
   * Download a whole track described by a media playlist.
   * Echo360 tracks are one file (fetched in a single request); otherwise segments are concatenated.
   */
  async function downloadTrack(pl, onProgress, signal) {
    if (pl.singleFile) {
      const { uri, size } = pl.singleFile;
      const bytes = await withRetry(() => fetchBytes(uri, { range: [0, size - 1], expected: size, onProgress, signal }), 3, signal);
      if (bytes.length < size) throw new Error(`Download incomplete (${bytes.length} of ${size} bytes)`);
      return bytes.length > size ? bytes.subarray(0, size) : bytes;
    }
    const pieces = (pl.init ? [pl.init] : []).concat(pl.segments);
    const total = trackSize(pl);
    const chunks = [];
    let loaded = 0;
    for (const p of pieces) {
      const range = p.range ? [p.range.offset, p.range.offset + p.range.length - 1] : null;
      const bytes = await withRetry(() => fetchBytes(p.uri, { range, signal }), 3, signal);
      chunks.push(bytes);
      loaded += bytes.length;
      if (onProgress) onProgress(loaded, total);
    }
    const out = new Uint8Array(loaded);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }

  const api = {
    detectContext,
    listLessons,
    lessonStatus,
    getLessonMedia,
    parseClassroomHtml,
    findEmbeddedJsonValue,
    resolveSource,
    resolveAudioUrl,
    loadMediaPlaylist,
    downloadTrack,
    trackSize,
  };
  root.Echo360Api = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
