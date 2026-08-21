---
name: noiz-lab-effects
description: Apply NOIZ LAB's existing WebGL image effects to a local image and export a PNG. Use when the user asks to make an image emotional, cinematic, dreamy, retro, Y2K, VHS, glitchy, neon, film-like, pixelated, printed, or otherwise processed with this repository.
---

# NOIZ LAB Effects

Run the repository's dependency-free automation CLI from the repository root:

```sh
node scripts/noizlab-effect.mjs INPUT OUTPUT.png --preset PRESET [--ratio RATIO] [--text 'TEXT']
```

It uses Chrome/Chromium to run NOIZ LAB's actual WebGL renderer. Node.js 22+ is required. Never overwrite the input image, and present the resulting PNG to the user.

Map the requested mood to a preset: `CINEMA` for unspecified “エモい”, `FILM` for warm nostalgic grain, `DREAM` for soft bloom, `NEON` for saturated night/cyberpunk, `VHS` for analog video, `Y2K` for digital glitch, `SORTED` for aggressive pixel sorting, `PRINT` for halftone, and `PIXEL` for low-resolution treatment. Use `--ratio original` unless the user requests `16:9`, `square`/`1:1`, or `9:16`. Use `--text` only when requested; `|` creates a line break.

If the mood is ambiguous, use `CINEMA`. Generate no more than three variants unless the user asks for a specific count. Do not use the app's AI source-generation endpoint because this skill processes an existing image and the endpoint may consume a shared daily quota.
