---
name: noiz-lab-effects
description: Apply NOIZ LAB's WebGL effects, export image-transition videos, or capture a macOS app window for a demo clip. Use for emotional, cinematic, dreamy, retro, Y2K, VHS, glitchy, neon, film-like, slideshow, app-demo, or short-video treatments with this repository.
---

# NOIZ LAB Effects

Use the repository CLI so the output comes from NOIZ LAB's actual WebGL renderer:

```sh
node scripts/noizlab-effect.mjs INPUT OUTPUT.png --preset PRESET [--ratio RATIO] [--text 'TEXT']
```

For a transition video, pass 2–8 images in story order:

```sh
node scripts/noizlab-effect.mjs --video INPUT1 INPUT2 INPUT3 OUTPUT.mp4 \
  --preset PRESET --ratio 16:9 --transition TRANSITION --hold 1.4 --duration 0.8
```

Transitions are `fade`, `wipe`, `dissolve`, `glitch`, `punch`, `flash`, `push`, and `film-burn`. Prefer `dissolve` for dreamy sequences, `film-burn` for organic nostalgia, `glitch` for Y2K/NEON/VHS, `punch` or `flash` for beat-driven emphasis, `push` for story progression, `fade` for restrained cinematic work, and `wipe` for graphic motion. Alternating Ken Burns zoom is on by default; pass `--no-zoom` when stillness matters. Chrome may fall back from MP4 to WebM; use the actual path printed by the CLI.

When cuts need different effects and boundaries need different transitions, use the variety-video wrapper. It applies each `INPUT@PRESET`, creates transition pairs, then assembles a web-compatible H.264 MP4 with ffmpeg:

```sh
node scripts/noizlab-variety-video.mjs OUTPUT.mp4 \
  INPUT1@FILM INPUT2@DREAM INPUT3@NEON INPUT4@CINEMA \
  --transitions fade,glitch,dissolve --ratio 16:9
```

This mode requires `ffmpeg` in addition to Node.js and Chrome. Choose the effect and transition progression to support a visual story rather than maximizing variety arbitrarily.

When the source includes video clips, use the web editor's VIDEO panel instead of the image-only CLI. Add media with `＋ 画像・動画`, click a VIDEO thumbnail to set trim start/end, select the mood and transition, and export MP4. `▣ プロジェクト保存` stores the source blobs and edit settings locally in IndexedDB; `↻ 前回の続き` restores them. Source-video audio is not mixed in this version, so add the intended soundtrack through BGM. GIF export is image-cuts only.

For a real macOS app demo, compile the ScreenCaptureKit helper and record only the named app window:

```sh
swiftc -parse-as-library scripts/record-macos-window.swift -o /tmp/noiz-record-window
/tmp/noiz-record-window APP_NAME OUTPUT.mp4 12
```

The app window must be visible. This requires macOS 15+ and Screen Recording permission. Prefer this window-only capture over full-display recording so unrelated apps and private content cannot enter the source video. Keep an unprocessed demo master; apply effects only to a copy when stylization supports the story.

Run it from the repository root. It requires Node.js 22+ and Chrome or Chromium, but no npm install. Never overwrite the input image; choose a separate output path. Show or link the resulting PNG to the user.

Choose a preset from the user's intent:

- `CINEMA`: restrained cinematic grade; use for an unspecified “エモい” request.
- `FILM`: warm, faded, grainy, nostalgic or summer-memory feeling.
- `DREAM`: soft bloom, haze, dreamy or ethereal feeling.
- `NEON`: saturated night city, cyberpunk, club, or cool-toned mood.
- `VHS`: analog video, 80s/90s, camcorder, tracking noise.
- `Y2K`: digital glitch and chromatic aberration, late-90s/2000s web mood.
- `SORTED`: aggressive experimental pixel sorting.
- `PRINT`: halftone and print texture.
- `PIXEL`: pixel art / low-resolution treatment.
- `RESET`: no effects; useful only for cropping or text.

Use `--ratio original` unless the user requests `16:9`, `square`/`1:1`, or `9:16`. Use `--text` only when requested; `|` creates a line break. If the mood is ambiguous, pick `CINEMA` and state that choice instead of blocking on a question.

For multiple plausible interpretations, generate at most three clearly named variants unless the user requested a specific count. Only invoke the app's AI source-generation endpoint when the user explicitly asks for AI-generated source images; it consumes a shared daily quota. Keep a coherent subject, palette, and visual progression across generated cuts.
