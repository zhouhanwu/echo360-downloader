#!/usr/bin/env node
/**
 * Tests for src/hls.js and src/fmp4.js using fixtures generated with the local ffmpeg,
 * laid out like Echo360's streams (single-file fragmented MP4 HLS, separate audio/video).
 *
 *   node test/merge.test.js            # needs ffmpeg + ffprobe on PATH
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const Hls = require('../src/hls.js');
const Fmp4 = require('../src/fmp4.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'echo360-test-'));
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const ffprobeJson = (file) => JSON.parse(run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]));

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log('ok   ' + name);
  } catch (e) {
    failures++;
    console.log('FAIL ' + name + '\n     ' + (e && e.stack || e).toString().split('\n').slice(0, 4).join('\n     '));
  }
}

// --- fixtures ---------------------------------------------------------------
const SECONDS = 35; // 3.5 HLS segments of 10 s, like Echo360's 10 s fragments
function makeRendition(name, inputArgs, codecArgs) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  run('ffmpeg', ['-v', 'error', ...inputArgs, '-t', String(SECONDS), ...codecArgs,
    '-f', 'hls', '-hls_time', '10', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4',
    '-hls_flags', 'single_file', '-hls_segment_filename', path.join(dir, name + '.mp4'),
    path.join(dir, name + '.m3u8')]);
  return dir;
}
const vDir = makeRendition('s1q1',
  ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30'],
  ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '300', '-bf', '2', '-an']);
const aDir = makeRendition('s0q1',
  ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100'],
  ['-c:a', 'aac', '-b:a', '128k', '-vn']);

const videoBytes = new Uint8Array(fs.readFileSync(path.join(vDir, 's1q1.mp4')));
const audioBytes = new Uint8Array(fs.readFileSync(path.join(aDir, 's0q1.mp4')));

// --- HLS --------------------------------------------------------------------
const MASTER = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS

#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="q0",NAME="Default",DEFAULT=YES,AUTOSELECT=YES,URI="s0q0.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="q1",NAME="Default",DEFAULT=YES,AUTOSELECT=YES,URI="s0q1.m3u8"

#EXT-X-STREAM-INF:BANDWIDTH=193208,AVERAGE-BANDWIDTH=28134,RESOLUTION=640x360,CODECS="avc1.640029",PROGRAM-ID=1,AUDIO="q0",CODECS="avc1.640029,mp4a.40.2",FRAME-RATE=30.0
s1q0.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=500095,AVERAGE-BANDWIDTH=72531,RESOLUTION=1280x720,CODECS="avc1.640029",PROGRAM-ID=1,AUDIO="q1",CODECS="avc1.640029,mp4a.40.2",FRAME-RATE=30.0
s1q1.m3u8
`;
const BASE = 'https://content.example/0000.inst/media/1/s1_av.m3u8?x=1';

test('master playlist: variants, audio groups, relative URIs drop the query string', () => {
  const m = Hls.parse(MASTER, BASE);
  assert.strictEqual(m.type, 'master');
  assert.strictEqual(m.variants.length, 2);
  const best = Hls.pickVariant(m.variants, 'highest');
  assert.strictEqual(best.height, 720);
  assert.strictEqual(best.audioGroup, 'q1');
  assert.strictEqual(best.uri, 'https://content.example/0000.inst/media/1/s1q1.m3u8');
  assert.strictEqual(best.codecs, 'avc1.640029,mp4a.40.2'); // duplicated CODECS: last wins
  assert.strictEqual(Hls.pickVariant(m.variants, 'lowest').height, 360);
  const audio = m.media.find((x) => x.type === 'AUDIO' && x.groupId === 'q1');
  assert.strictEqual(audio.uri, 'https://content.example/0000.inst/media/1/s0q1.m3u8');
});

test('media playlist (ffmpeg single_file) is detected as one contiguous file', () => {
  const text = fs.readFileSync(path.join(vDir, 's1q1.m3u8'), 'utf8');
  const pl = Hls.parse(text, 'https://content.example/a/s1q1.m3u8');
  assert.strictEqual(pl.type, 'media');
  assert.ok(pl.init && pl.init.range, 'has EXT-X-MAP with BYTERANGE');
  assert.ok(pl.singleFile, 'single file');
  assert.strictEqual(pl.singleFile.uri, 'https://content.example/a/s1q1.mp4');
  assert.strictEqual(pl.singleFile.size, videoBytes.length);
  assert.ok(Math.abs(pl.duration - SECONDS) < 0.5, 'duration ' + pl.duration);
});

test('media playlist with Echo360-style ranges', () => {
  const text = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:10\n#EXT-X-PLAYLIST-TYPE:VOD\n' +
    '#EXT-X-MAP:URI="s1q1.mp4",BYTERANGE="845@0"\n' +
    '#EXTINF:10.000000,\n#EXT-X-BYTERANGE:260642@845\ns1q1.mp4\n' +
    '#EXTINF:10.000000,\n#EXT-X-BYTERANGE:1000\ns1q1.mp4\n#EXT-X-ENDLIST\n';
  const pl = Hls.parse(text, 'https://c.example/x/s1q1.m3u8');
  assert.deepStrictEqual(pl.segments[1].range, { offset: 261487, length: 1000 }); // offset continues
  assert.deepStrictEqual(pl.singleFile, { uri: 'https://c.example/x/s1q1.mp4', size: 262487 });
});

test('non-contiguous ranges are not treated as a single file', () => {
  const text = '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-MAP:URI="a.mp4",BYTERANGE="10@0"\n' +
    '#EXTINF:10,\n#EXT-X-BYTERANGE:5@20\na.mp4\n';
  assert.strictEqual(Hls.parse(text, 'https://c.example/a.m3u8').singleFile, null);
});

// --- fMP4 -------------------------------------------------------------------
test('fixtures look like Echo360 files (single-track fragmented MP4)', () => {
  const v = Fmp4.describe(videoBytes, 'video');
  const a = Fmp4.describe(audioBytes, 'audio');
  assert.strictEqual(v.handler, 'vide');
  assert.strictEqual(a.handler, 'soun');
  assert.ok(v.fragments >= 4 && a.fragments >= 4, `fragments v=${v.fragments} a=${a.fragments}`);
});

const merged = Fmp4.mergeAV(videoBytes, audioBytes);
const outFile = path.join(tmp, 'merged.mp4');
fs.writeFileSync(outFile, Buffer.concat(merged.parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength))));

test('merged file has one H.264 and one AAC stream with the right duration', () => {
  const info = ffprobeJson(outFile);
  const kinds = info.streams.map((s) => s.codec_type + ':' + s.codec_name).sort();
  assert.deepStrictEqual(kinds, ['audio:aac', 'video:h264']);
  const dur = Number(info.format.duration);
  assert.ok(Math.abs(dur - SECONDS) < 0.6, 'format duration ' + dur);
  assert.ok(Math.abs(merged.duration - SECONDS) < 0.6, 'reported duration ' + merged.duration);
  for (const s of info.streams) {
    assert.ok(Math.abs(Number(s.start_time)) < 0.2, s.codec_type + ' start ' + s.start_time);
  }
});

test('merged file decodes completely without errors', () => {
  const errors = run('ffmpeg', ['-v', 'error', '-xerror', '-i', outFile, '-f', 'null', '-']);
  assert.strictEqual(errors.trim(), '');
});

test('merged file keeps every packet of both inputs', () => {
  const count = (file, sel) => Number(run('ffprobe', ['-v', 'error', '-select_streams', sel, '-count_packets',
    '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file]).trim());
  assert.strictEqual(count(outFile, 'v:0'), count(path.join(vDir, 's1q1.mp4'), 'v:0'));
  assert.strictEqual(count(outFile, 'a:0'), count(path.join(aDir, 's0q1.mp4'), 'a:0'));
});

test('fragments are interleaved by time (video and audio alternate)', () => {
  const top = Fmp4.parseBoxes(new Uint8Array(fs.readFileSync(outFile)), 0, fs.statSync(outFile).size);
  const types = top.map((b) => b.type);
  assert.deepStrictEqual(types.slice(0, 2), ['ftyp', 'moov']);
  assert.ok(!types.includes('sidx'), 'stale sidx removed');
  // read track ids of the first four fragments
  const buf = fs.readFileSync(outFile);
  const ids = [];
  for (const b of top.filter((x) => x.type === 'moof').slice(0, 4)) {
    const tfhd = buf.indexOf('tfhd', b.start);
    ids.push(buf.readUInt32BE(tfhd + 8));
  }
  assert.deepStrictEqual(ids, [1, 2, 1, 2]);
});

test('remux to a regular (non-fragmented) MP4 with ffmpeg -c copy works', () => {
  const flat = path.join(tmp, 'flat.mp4');
  run('ffmpeg', ['-v', 'error', '-i', outFile, '-c', 'copy', '-movflags', '+faststart', flat]);
  assert.ok(Math.abs(Number(ffprobeJson(flat).format.duration) - SECONDS) < 0.6);
});

test('truncated input is rejected with a clear error', () => {
  assert.throws(() => Fmp4.mergeAV(videoBytes.subarray(0, videoBytes.length - 1000), audioBytes), /incomplete|Truncated/i);
});

test('swapped inputs are rejected', () => {
  assert.throws(() => Fmp4.mergeAV(audioBytes, videoBytes), /Expected a video track/);
});

console.log(failures ? `\n${failures} test(s) failed (fixtures in ${tmp})` : `\nAll tests passed (fixtures in ${tmp})`);
if (!failures) fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
