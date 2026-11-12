# Echo360 Lecture Downloader

A Chrome extension that downloads your Echo360 lectures (echo360.org.uk) as MP4 files: slides or camera, with sound. Vibecoded with Claude Code.

## Install

1. On this page, click the green **Code** button, then **Download ZIP**.
2. Unzip it and move the folder somewhere permanent, such as Documents. Don't delete it later, because Chrome runs the extension from this folder.
3. In Chrome, go to `chrome://extensions`.
4. Turn on **Developer mode** (top right).
5. Click **Load unpacked** and select the unzipped folder (the one that contains `manifest.json`).
6. Click the puzzle-piece icon in Chrome's toolbar and pin **Echo360 Lecture Downloader**.

This also works in Edge and Brave. Use `edge://extensions` or `brave://extensions` instead.

## Use

1. Open your course's class list on echo360.org.uk. If you open it from Moodle, open it in its own tab.
2. Click the extension icon, or press **Alt+Shift+D** (**⌥⇧D** on a Mac).
3. Tick the lectures you want, choose **Slides** or **Camera**, then click **Download selected**.
4. Keep the tab open until it says **Done**. If Chrome asks whether to allow multiple downloads, click **Allow**.

Files are saved to your Downloads folder.

## Update

Download the new ZIP, replace the old folder with it, then click ↻ on the extension in `chrome://extensions`.

## Problems?

- **Nothing happens when I click the icon:** reload the Echo360 page and try again.
- **"Not signed in" or "Access denied":** sign in to Echo360 again (through Moodle), reload the page, and retry.



## Note

You can only download lectures your own account can already watch. It won't download recordings that staff have marked as not downloadable. Please follow your university's rules on lecture recordings.

Technical details are in [TECHNICAL.md](TECHNICAL.md).