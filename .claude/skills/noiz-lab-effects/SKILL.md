---
name: noiz-lab-effects
description: Apply NOIZ LAB's WebGL effects, export image-transition videos, or capture a macOS app window for a demo clip. Use for emotional, cinematic, dreamy, retro, Y2K, VHS, glitchy, neon, film-like, slideshow, app-demo, or short-video treatments.
---

# NOIZ LAB Effects

Run the repository's dependency-free automation CLI from the repository root:

```sh
node scripts/noizlab-effect.mjs INPUT OUTPUT.png --preset PRESET [--ratio RATIO] [--text 'TEXT']
```

For a video, pass 2–8 images in story order:

```sh
node scripts/noizlab-effect.mjs --video INPUT1 INPUT2 INPUT3 OUTPUT.mp4 --preset FILM --ratio 16:9 --transition dissolve
```

Available transitions are `fade`, `wipe`, `dissolve`, `glitch`, `punch`, `flash`, `push`, and `film-burn`; optional timing flags are `--hold` and `--duration`, and `--no-zoom` disables Ken Burns motion. Prefer dissolve for dreamy work, film-burn for organic nostalgia, glitch for Y2K/NEON/VHS, punch or flash for beat-driven emphasis, push for story progression, and fade for restrained cinematic work. Chrome may fall back to WebM, so use the actual path printed by the CLI.

For different effects per cut and different transitions per boundary, use the ffmpeg-backed wrapper:

```sh
node scripts/noizlab-variety-video.mjs OUTPUT.mp4 INPUT1@FILM INPUT2@DREAM INPUT3@NEON INPUT4@CINEMA --transitions fade,glitch,dissolve
```

This requires ffmpeg. Pick the progression to support a visual story instead of adding variety without purpose.

For source video clips, use the web editor's VIDEO panel because the CLI accepts image cuts only. Add media with `＋ 画像・動画`, select a VIDEO thumbnail to trim it, then preview or export MP4. `▣ プロジェクト保存` and `↻ 前回の続き` persist source blobs and editing state in local IndexedDB. Source-video audio is replaced by the selected BGM in this version, and GIF export remains image-only.

For a real macOS app demo, compile the ScreenCaptureKit helper and record only the named app window:

```sh
swiftc -parse-as-library scripts/record-macos-window.swift -o /tmp/noiz-record-window
/tmp/noiz-record-window APP_NAME OUTPUT.mp4 12
```

The app window must be visible. This requires macOS 15+ and Screen Recording permission. Prefer window-only capture over full-display recording so unrelated apps and private content cannot enter the source video. Keep an unprocessed demo master; apply effects only to a copy when stylization supports the story.

It uses Chrome/Chromium to run NOIZ LAB's actual WebGL renderer. Node.js 22+ is required. Never overwrite the input image, and present the resulting PNG to the user.

Map the requested mood to a preset: `CINEMA` for unspecified “エモい”, `FILM` for warm nostalgic grain, `DREAM` for soft bloom, `NEON` for saturated night/cyberpunk, `VHS` for analog video, `Y2K` for digital glitch, `SORTED` for aggressive pixel sorting, `PRINT` for halftone, and `PIXEL` for low-resolution treatment. Use `--ratio original` unless the user requests `16:9`, `square`/`1:1`, or `9:16`. Use `--text` only when requested; `|` creates a line break.

If the mood is ambiguous, use `CINEMA`. Generate no more than three variants unless the user asks for a specific count. Use the app's AI source-generation endpoint only when explicitly requested because it consumes a shared daily quota; keep generated video cuts visually coherent.
