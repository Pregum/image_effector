---
name: noiz-lab-effects
description: Apply NOIZ LAB's existing WebGL image effects to a local image and export a PNG. Use when the user asks to make an image emotional, cinematic, dreamy, retro, Y2K, VHS, glitchy, neon, film-like, pixelated, printed, or otherwise processed with this repository.
---

# NOIZ LAB Effects

Use the repository CLI so the output comes from NOIZ LAB's actual WebGL renderer:

```sh
node scripts/noizlab-effect.mjs INPUT OUTPUT.png --preset PRESET [--ratio RATIO] [--text 'TEXT']
```

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

For multiple plausible interpretations, generate at most three clearly named variants unless the user requested a specific count. Do not invoke the app's AI source generation endpoint: this skill processes an input image, and generation may consume a shared daily quota.
