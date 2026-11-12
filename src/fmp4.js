/**
 * Fragmented-MP4 merging for Echo360 streams (no re-encoding, no FFmpeg).
 *
 * Echo360 stores every track as its own single-track fragmented MP4:
 *   ftyp | moov(mvhd, trak, mvex/trex) | sidx | moof mdat | moof mdat | ...
 * mergeAV() turns one video file + one audio file into a single two-track fragmented MP4:
 *   - a new moov with both traks (audio renumbered to track 2) and an mvex/mehd with the total duration
 *   - every moof+mdat pair copied unchanged except the track id and fragment sequence number,
 *     interleaved by decode time so players can stream the result
 * This works because sample data offsets in each moof are relative to that moof
 * (no absolute base_data_offset), which parseTrackFile() verifies.
 */
(function (root) {
  'use strict';

  const TFHD_BASE_DATA_OFFSET = 0x000001;
  const TFHD_SAMPLE_DESC_INDEX = 0x000002;
  const TFHD_DEFAULT_DURATION = 0x000008;
  const TRUN_DATA_OFFSET = 0x000001;
  const TRUN_FIRST_SAMPLE_FLAGS = 0x000004;
  const TRUN_SAMPLE_FIELDS = [0x000100 /* duration */, 0x000200 /* size */, 0x000400 /* flags */, 0x000800 /* cto */];
  const TRUN_SAMPLE_DURATION = 0x000100;
  const U32_MAX = 0xffffffff;

  function dataView(u8) {
    return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  }

  function fourcc(u8, o) {
    return String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  }

  function readU64(dv, o) {
    return dv.getUint32(o) * 2 ** 32 + dv.getUint32(o + 4);
  }

  function writeU64(dv, o, v) {
    dv.setUint32(o, Math.floor(v / 2 ** 32));
    dv.setUint32(o + 4, v >>> 0);
  }

  /** Start of a full box's payload (its version byte). */
  function payload(box) {
    return box.start + box.hdr;
  }

  function fullBoxFlags(u8, p) {
    return (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3];
  }

  /** Parse sibling boxes in u8[start, end). Throws on truncated/corrupt data. */
  function parseBoxes(u8, start, end) {
    const dv = dataView(u8);
    const out = [];
    let o = start;
    while (o + 8 <= end) {
      let size = dv.getUint32(o);
      const type = fourcc(u8, o + 4);
      let hdr = 8;
      if (size === 1) {
        if (o + 16 > end) throw new Error(`Truncated '${type}' box at byte ${o}`);
        size = readU64(dv, o + 8);
        hdr = 16;
      } else if (size === 0) {
        size = end - o; // box extends to the end
      }
      if (size < hdr || o + size > end) {
        throw new Error(`Truncated or corrupt '${type}' box at byte ${o} (file incomplete?)`);
      }
      out.push({ type, start: o, size, hdr, end: o + size });
      o += size;
    }
    return out;
  }

  function children(u8, box) {
    return parseBoxes(u8, payload(box), box.end);
  }

  function child(u8, box, type) {
    return children(u8, box).find((b) => b.type === type) || null;
  }

  function requireChild(u8, box, type, label) {
    const c = child(u8, box, type);
    if (!c) throw new Error(`${label}: missing '${type}' inside '${box.type}'`);
    return c;
  }

  /** mvhd/mdhd share the layout of timescale/duration. */
  function timescaleOf(u8, dv, box) {
    const p = payload(box);
    return dv.getUint32(u8[p] === 1 ? p + 20 : p + 12);
  }

  /** Parse a single-track fragmented MP4 (one Echo360 rendition file). */
  function parseTrackFile(u8, label) {
    const dv = dataView(u8);
    const top = parseBoxes(u8, 0, u8.length);
    const ftyp = top.find((b) => b.type === 'ftyp') || null;
    const moov = top.find((b) => b.type === 'moov');
    if (!moov) throw new Error(`${label}: no 'moov' box (not an MP4 file?)`);
    const moovKids = children(u8, moov);
    const mvhd = moovKids.find((b) => b.type === 'mvhd');
    const traks = moovKids.filter((b) => b.type === 'trak');
    const mvex = moovKids.find((b) => b.type === 'mvex');
    if (!mvhd) throw new Error(`${label}: no 'mvhd' box`);
    if (traks.length !== 1) throw new Error(`${label}: expected 1 track, found ${traks.length}`);
    if (!mvex) throw new Error(`${label}: not a fragmented MP4 (no 'mvex')`);
    const trak = traks[0];
    const tkhd = requireChild(u8, trak, 'tkhd', label);
    const mdia = requireChild(u8, trak, 'mdia', label);
    const mdhd = requireChild(u8, mdia, 'mdhd', label);
    const hdlr = requireChild(u8, mdia, 'hdlr', label);
    const trex = requireChild(u8, mvex, 'trex', label);

    const info = {
      handler: fourcc(u8, payload(hdlr) + 8), // version/flags(4) + pre_defined(4), then handler_type
      timescale: timescaleOf(u8, dv, mdhd),
      movieTimescale: timescaleOf(u8, dv, mvhd),
      trexDefaultDuration: dv.getUint32(payload(trex) + 12),
    };

    const fragments = [];
    let nextTime = 0;
    for (let k = 0; k < top.length; k++) {
      if (top[k].type !== 'moof') continue;
      const moof = top[k];
      let m = k + 1;
      while (m < top.length && top[m].type !== 'mdat' && top[m].type !== 'moof') m++;
      if (m >= top.length || top[m].type !== 'mdat') {
        throw new Error(`${label}: fragment at byte ${moof.start} has no media data (file incomplete?)`);
      }
      const f = parseMoof(u8, dv, moof, info, label);
      const time = f.baseTime != null ? f.baseTime : nextTime;
      nextTime = time + f.duration;
      fragments.push({
        moofStart: moof.start,
        moofEnd: moof.end,
        spanEnd: top[m].end, // moof .. end of its mdat (copied verbatim, so relative offsets stay valid)
        time,
        duration: f.duration,
        seqPos: f.seqPos,
        trackIdPos: f.trackIdPos,
      });
      k = m;
    }
    if (!fragments.length) throw new Error(`${label}: no media fragments found`);
    const last = fragments[fragments.length - 1];

    return Object.assign(info, {
      u8, ftyp, mvhd, trak, tkhd, mdhd, trex, moovKids, fragments,
      mediaDuration: last.time + last.duration, // end of the last sample, in media timescale
    });
  }

  function parseMoof(u8, dv, moof, info, label) {
    const kids = children(u8, moof);
    const mfhd = kids.find((b) => b.type === 'mfhd');
    const trafs = kids.filter((b) => b.type === 'traf');
    if (!mfhd || trafs.length !== 1) throw new Error(`${label}: unsupported fragment layout at byte ${moof.start}`);
    const tkids = children(u8, trafs[0]);
    const tfhd = tkids.find((b) => b.type === 'tfhd');
    const tfdt = tkids.find((b) => b.type === 'tfdt');
    const truns = tkids.filter((b) => b.type === 'trun');
    if (!tfhd) throw new Error(`${label}: fragment without 'tfhd' at byte ${moof.start}`);

    const p = payload(tfhd);
    const flags = fullBoxFlags(u8, p);
    if (flags & TFHD_BASE_DATA_OFFSET) {
      throw new Error(`${label}: fragments use absolute data offsets, which this merger does not support`);
    }
    let q = p + 8; // version/flags + track_ID
    if (flags & TFHD_SAMPLE_DESC_INDEX) q += 4;
    const defaultDuration = (flags & TFHD_DEFAULT_DURATION) ? dv.getUint32(q) : info.trexDefaultDuration;

    let baseTime = null;
    if (tfdt) {
      const tp = payload(tfdt);
      baseTime = u8[tp] === 1 ? readU64(dv, tp + 4) : dv.getUint32(tp + 4);
    }

    let duration = 0;
    for (const trun of truns) {
      const r = payload(trun);
      const tf = fullBoxFlags(u8, r);
      const count = dv.getUint32(r + 4);
      let o = r + 8;
      if (tf & TRUN_DATA_OFFSET) o += 4;
      if (tf & TRUN_FIRST_SAMPLE_FLAGS) o += 4;
      if (tf & TRUN_SAMPLE_DURATION) {
        const stride = 4 * TRUN_SAMPLE_FIELDS.filter((f) => tf & f).length;
        for (let s = 0; s < count; s++) duration += dv.getUint32(o + s * stride);
      } else {
        duration += count * defaultDuration;
      }
    }
    return { baseTime, duration, seqPos: payload(mfhd) + 4, trackIdPos: p + 4 };
  }

  function makeBox(type, parts) {
    const size = 8 + parts.reduce((s, x) => s + x.length, 0);
    const out = new Uint8Array(size);
    const dv = dataView(out);
    dv.setUint32(0, size);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    let o = 8;
    for (const x of parts) {
      out.set(x, o);
      o += x.length;
    }
    return out;
  }

  function makeMehd(duration) {
    const v1 = duration > U32_MAX;
    const body = new Uint8Array(v1 ? 12 : 8);
    const dv = dataView(body);
    body[0] = v1 ? 1 : 0;
    if (v1) writeU64(dv, 4, duration);
    else dv.setUint32(4, duration);
    return makeBox('mehd', [body]);
  }

  function copyBox(u8, box) {
    return u8.slice(box.start, box.end);
  }

  /** Write a duration into an mvhd/mdhd-style box copy (timescale then duration). */
  function setHeaderDuration(boxBytes, boxHdr, duration) {
    const dv = dataView(boxBytes);
    const p = boxHdr;
    if (boxBytes[p] === 1) writeU64(dv, p + 24, duration);
    else if (duration <= U32_MAX) dv.setUint32(p + 16, duration);
  }

  /** Copy a trak, giving it a new track id and durations; rescale its edit list if needed. */
  function rebuildTrak(t, newId, durMovie, outMovieTimescale) {
    const out = copyBox(t.u8, t.trak);
    const dv = dataView(out);
    const base = t.trak.start;

    const p = payload(t.tkhd) - base;
    if (out[p] === 1) {
      dv.setUint32(p + 20, newId);
      writeU64(dv, p + 28, durMovie);
    } else {
      dv.setUint32(p + 12, newId);
      if (durMovie <= U32_MAX) dv.setUint32(p + 20, durMovie);
    }

    const m = payload(t.mdhd) - base;
    if (out[m] === 1) writeU64(dv, m + 24, t.mediaDuration);
    else if (t.mediaDuration <= U32_MAX) dv.setUint32(m + 16, t.mediaDuration);

    // Edit-list segment durations are in movie timescale; rescale if the output's differs.
    if (t.movieTimescale !== outMovieTimescale) {
      const edts = child(t.u8, t.trak, 'edts');
      const elst = edts && child(t.u8, edts, 'elst');
      if (elst) {
        const e = payload(elst) - base;
        const v1 = out[e] === 1;
        const count = dv.getUint32(e + 4);
        const entrySize = v1 ? 20 : 12;
        for (let i = 0; i < count; i++) {
          const o = e + 8 + i * entrySize;
          const d = v1 ? readU64(dv, o) : dv.getUint32(o);
          const scaled = Math.round((d * outMovieTimescale) / t.movieTimescale);
          if (v1) writeU64(dv, o, scaled);
          else dv.setUint32(o, Math.min(scaled, U32_MAX));
        }
      }
    }
    return out;
  }

  /**
   * Merge a video-only and an audio-only fragmented MP4 into one MP4.
   * @param {Uint8Array} videoU8
   * @param {Uint8Array} audioU8
   * @returns {{parts: Uint8Array[], duration: number, fragments: number}} parts to pass to new Blob(parts)
   */
  function mergeAV(videoU8, audioU8) {
    const v = parseTrackFile(videoU8, 'video');
    const a = parseTrackFile(audioU8, 'audio');
    if (v.handler !== 'vide') throw new Error(`Expected a video track, got '${v.handler}'`);
    if (a.handler !== 'soun') throw new Error(`Expected an audio track, got '${a.handler}'`);

    const VIDEO_ID = 1;
    const AUDIO_ID = 2;
    const movieTs = v.movieTimescale;
    const vDur = Math.round((v.mediaDuration * movieTs) / v.timescale);
    const aDur = Math.round((a.mediaDuration * movieTs) / a.timescale);
    const total = Math.max(vDur, aDur);

    const mvhd = copyBox(v.u8, v.mvhd);
    setHeaderDuration(mvhd, v.mvhd.hdr, total);
    dataView(mvhd).setUint32(mvhd.length - 4, 3); // next_track_ID

    const vtrex = copyBox(v.u8, v.trex);
    dataView(vtrex).setUint32(v.trex.hdr + 4, VIDEO_ID);
    const atrex = copyBox(a.u8, a.trex);
    dataView(atrex).setUint32(a.trex.hdr + 4, AUDIO_ID);

    const extras = v.moovKids
      .filter((b) => b.type !== 'mvhd' && b.type !== 'trak' && b.type !== 'mvex')
      .map((b) => copyBox(v.u8, b)); // e.g. udta

    const moov = makeBox('moov', [
      mvhd,
      rebuildTrak(v, VIDEO_ID, vDur, movieTs),
      rebuildTrak(a, AUDIO_ID, aDur, movieTs),
      makeBox('mvex', [makeMehd(total), vtrex, atrex]),
    ].concat(extras));

    const ftyp = v.ftyp ? copyBox(v.u8, v.ftyp) : copyBox(a.u8, a.ftyp);

    const queue = v.fragments.map((f) => ({ f, src: v, id: VIDEO_ID, t: f.time / v.timescale }))
      .concat(a.fragments.map((f) => ({ f, src: a, id: AUDIO_ID, t: f.time / a.timescale })))
      .sort((x, y) => (x.t - y.t) || (x.id - y.id));

    const parts = [ftyp, moov];
    let seq = 1;
    for (const { f, src, id } of queue) {
      const moof = src.u8.slice(f.moofStart, f.moofEnd);
      const dv = dataView(moof);
      dv.setUint32(f.seqPos - f.moofStart, seq++);
      dv.setUint32(f.trackIdPos - f.moofStart, id);
      parts.push(moof, src.u8.subarray(f.moofEnd, f.spanEnd));
    }
    return { parts, duration: total / movieTs, fragments: queue.length };
  }

  /** Quick check used before merging: is this a single-track fragmented MP4 we understand? */
  function describe(u8, label) {
    const t = parseTrackFile(u8, label || 'file');
    return { handler: t.handler, timescale: t.timescale, fragments: t.fragments.length, duration: t.mediaDuration / t.timescale };
  }

  const api = { mergeAV, describe, parseBoxes };
  root.Echo360Fmp4 = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
