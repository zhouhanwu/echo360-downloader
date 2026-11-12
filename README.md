# Echo360 Lecture Downloader (Chrome extension)

Downloads Echo360 lecture recordings from **echo360.org.uk** as ordinary MP4 files: slides (screen) and/or camera, each with the lecture audio. You can download one lecture or a whole course in one go.

It uses your own signed-in Echo360 session. Nothing is sent anywhere else, and there's no FFmpeg or re-encoding.

## Install

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and select this `echo360-downloader` folder (the one with `manifest.json`).
3. Pin the extension so its icon is visible in the toolbar.

After changing any file here, click the ↻ reload button on the extension's card in `chrome://extensions`, then reload the Echo360 tab.

## Use

1. Open the course on Echo360, either from Moodle or directly, e.g. `https://echo360.org.uk/section/<id>/home` (the **Classes** list).
2. Click the extension icon. A panel opens on the right with every lesson in the course.
3. Choose what you want:
   - **Slides**: the lecture PC screen (Echo360 "source 1").
   - **Camera**: the room camera (source 2). Each ticked source becomes its own MP4.
   - **Audio only**: just the audio, as `.m4a`.
   - **Quality**: *Highest* (720p) or *Smallest* (360p).
4. Tick lectures (by default, everything not downloaded yet is ticked) and click **Download N selected**.
5. Keep the tab open until it says *Done*. Files go to your Downloads folder, named like
   `2026-09-28 EC2C3_2026-27 28092026 PT 14-00.mp4`.
   The first time, Chrome may ask whether echo360.org.uk may **download multiple files**. Click **Allow**.

Lectures you've downloaded are marked **Downloaded**. Next week, use *Select: not yet downloaded* to fetch only the new ones.

Opened on a single lecture's page, the panel pre-selects just that lecture.

Approximate sizes for a one-hour lecture: slides 720p + audio ≈ 135 MB, camera 720p + audio ≈ 170 MB, 360p ≈ 32–36 MB. A lecture takes roughly a minute to download.

## How it works

Echo360 (2026) plays lectures with HLS. The old version of this extension looked for `s0q1/s1q1/s2q1` request URLs and passed video data through Chrome messaging (which turns binary data into `{}`), so it couldn't work. This version reads Echo360's own data instead:

| Step | Request (made from the Echo360 page, with your cookies) |
| --- | --- |
| List lessons | `GET /section/{sectionId}/syllabus` (JSON) |
| Find streams | `GET /lesson/{lessonId}/classroom` (the HTML embeds `playableMedias`: `s1_av.m3u8`, `s2_av.m3u8`, `s0_a.m3u8`, …) |
| Pick quality | master playlist `s1_av.m3u8`, giving video `s1q1.m3u8` (720p) + audio `s0q1.m3u8` |
| Download | each media playlist is byte ranges of one single-track fragmented MP4 (`s1q1.mp4`, `s0q1.mp4`), fetched in one request each |
| Merge | `src/fmp4.js` combines the video and audio files into one MP4: a new `moov` with both tracks, then the fragments interleaved by time. No re-encoding; takes milliseconds. |

If a recording's `restrictDownload` flag is set by course staff, the extension refuses to download it.

Files:

```
manifest.json      MV3 manifest (permissions: activeTab, scripting, storage)
background.js      toolbar icon → toggle the panel (injects scripts if the tab predates the extension)
src/hls.js         m3u8 parsing
src/echo360.js     Echo360 endpoints, stream resolution, downloading
src/fmp4.js        fragmented-MP4 video+audio merger
src/panel.js       the in-page panel UI and download queue
test/merge.test.js tests for hls.js and fmp4.js (uses local ffmpeg to build fixtures)
```

## Troubleshooting

- **Icon shows a red "!"**: the current tab isn't an Echo360 page. Open the course's class list on echo360.org.uk.
- **"Not signed in" / "Access denied (403)"**: your Echo360 session expired. Reload the page (sign in via Moodle if asked) and press Download again. Already-saved lectures are skipped by "not yet downloaded".
- **Panel doesn't open after updating the extension**: reload the Echo360 tab.
- **Echo360 opened inside a Moodle page**: the panel opens inside the embedded Echo360 frame, which may be cramped. Opening Echo360 in its own tab works best.
- **A file came out as separate `(video).mp4` + `(audio).m4a`**: the merger hit a format it doesn't understand. Combine them with `ffmpeg -i "x (video).mp4" -i "x (audio).m4a" -c copy "x.mp4"`, and see the console for the reason.
- **Want a non-fragmented MP4** (e.g. for an old editor)? `ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4`.

## Tests

```bash
node test/merge.test.js   # needs ffmpeg/ffprobe on PATH
```

## Why not the Moodle API?

A Moodle web-service token (`/user/managetoken.php`) only covers Moodle's own data. Moodle knows the Echo360 *link* (an LTI activity), but the recordings live on Echo360 and are only served to a signed-in Echo360 browser session. So the extension works from the Echo360 page itself.
