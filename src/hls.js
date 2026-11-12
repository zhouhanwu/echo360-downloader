/**
 * Minimal HLS (.m3u8) parsing for Echo360 playlists.
 *
 * Echo360 lesson streams look like this:
 *   s1_av.m3u8  master: video variants (s1q0 = 360p, s1q1 = 720p) + audio groups (s0q0, s0q1)
 *   s1q1.m3u8   media playlist: EXT-X-MAP + ~10 s segments, all byte ranges of ONE file, s1q1.mp4
 *   s1q1.mp4    a complete single-track fragmented MP4
 */
(function (root) {
  'use strict';

  /** Parse an attribute list: KEY=VALUE,KEY="quoted, value". Later duplicates win. */
  function parseAttributes(s) {
    const attrs = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(s))) {
      let v = m[2];
      if (v.charAt(0) === '"') v = v.slice(1, -1);
      attrs[m[1]] = v;
    }
    return attrs;
  }

  function resolveUri(uri, base) {
    return new URL(uri, base).toString();
  }

  /** "length[@offset]" -> {offset, length}; a missing offset continues from the previous sub-range. */
  function parseByteRange(s, defaultOffset) {
    const [len, off] = String(s).split('@');
    return { length: Number(len), offset: off !== undefined ? Number(off) : defaultOffset };
  }

  function lines(text) {
    return String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }

  /**
   * Parse any playlist. Returns either
   *   {type: 'master', variants: [{uri, bandwidth, width, height, audioGroup, codecs}], media: [{type, groupId, name, isDefault, uri}]}
   * or
   *   {type: 'media', init: {uri, range}|null, segments: [{uri, range, duration}], duration, singleFile: {uri, size}|null}
   */
  function parse(text, baseUrl) {
    const ls = lines(text);
    if (ls[0] !== '#EXTM3U') throw new Error('Not an HLS playlist');
    const isMedia = ls.some((l) => l.startsWith('#EXTINF') || l.startsWith('#EXT-X-TARGETDURATION'));
    return isMedia ? parseMedia(ls, baseUrl) : parseMaster(ls, baseUrl);
  }

  function parseMaster(ls, baseUrl) {
    const variants = [];
    const media = [];
    for (let i = 0; i < ls.length; i++) {
      const line = ls[i];
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const a = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
        let j = i + 1;
        while (j < ls.length && ls[j].startsWith('#')) j++;
        if (j >= ls.length) break;
        const [w, h] = String(a.RESOLUTION || '0x0').split('x').map(Number);
        variants.push({
          uri: resolveUri(ls[j], baseUrl),
          bandwidth: Number(a.BANDWIDTH) || 0,
          width: w || 0,
          height: h || 0,
          audioGroup: a.AUDIO || null,
          codecs: a.CODECS || '',
        });
        i = j;
      } else if (line.startsWith('#EXT-X-MEDIA:')) {
        const a = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
        media.push({
          type: a.TYPE || '',
          groupId: a['GROUP-ID'] || '',
          name: a.NAME || '',
          isDefault: a.DEFAULT === 'YES',
          uri: a.URI ? resolveUri(a.URI, baseUrl) : null,
        });
      }
    }
    return { type: 'master', variants, media };
  }

  function parseMedia(ls, baseUrl) {
    let init = null;
    const segments = [];
    const nextOffset = {}; // per resource, for BYTERANGE without @offset
    let pendingRange = null;
    let pendingDuration = 0;
    for (const line of ls) {
      if (line.startsWith('#EXT-X-MAP:')) {
        const a = parseAttributes(line.slice('#EXT-X-MAP:'.length));
        const uri = resolveUri(a.URI, baseUrl);
        const range = a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null;
        if (range) nextOffset[uri] = range.offset + range.length;
        init = { uri, range };
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
        pendingRange = line.slice('#EXT-X-BYTERANGE:'.length);
      } else if (line.startsWith('#EXTINF:')) {
        pendingDuration = parseFloat(line.slice('#EXTINF:'.length)) || 0;
      } else if (!line.startsWith('#')) {
        const uri = resolveUri(line, baseUrl);
        let range = null;
        if (pendingRange) {
          range = parseByteRange(pendingRange, nextOffset[uri] || 0);
          nextOffset[uri] = range.offset + range.length;
        }
        segments.push({ uri, range, duration: pendingDuration });
        pendingRange = null;
        pendingDuration = 0;
      }
    }
    const duration = segments.reduce((s, x) => s + x.duration, 0);
    return { type: 'media', init, segments, duration, singleFile: findSingleFile(init, segments) };
  }

  /**
   * If init + every segment are consecutive byte ranges of one file starting at byte 0,
   * the whole track can be fetched with a single request.
   */
  function findSingleFile(init, segments) {
    const pieces = (init ? [init] : []).concat(segments);
    if (!pieces.length) return null;
    const uri = pieces[0].uri;
    let pos = 0;
    for (const p of pieces) {
      if (p.uri !== uri || !p.range || p.range.offset !== pos) return null;
      pos += p.range.length;
    }
    return { uri, size: pos };
  }

  /** Pick the highest (default) or lowest resolution variant. */
  function pickVariant(variants, quality) {
    if (!variants.length) throw new Error('Playlist has no variants');
    const sorted = variants.slice().sort((a, b) => (a.width * a.height - b.width * b.height) || (a.bandwidth - b.bandwidth));
    return quality === 'lowest' ? sorted[0] : sorted[sorted.length - 1];
  }

  const api = { parse, parseAttributes, parseByteRange, pickVariant };
  root.Echo360Hls = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
