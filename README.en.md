# NOIZ LAB — Image Effect Studio

A browser-based glitch / Y2K image effect studio. Add effects to photos and
illustrations, then export thumbnails or vertical videos for Reels and Shorts.

All image processing runs in **WebGL2 on the client**. The backend is optional and
fits in a single Cloudflare Worker. **No dependencies** — the pixel sorter, the GIF
encoder and the force-directed graph are all written from scratch. MIT licensed.

[日本語版 README](README.md) ／ **Live instance**: https://image-effector.pregum-dev.workers.dev
（[about page](https://image-effector.pregum-dev.workers.dev/about-en)）

![demo](docs/demo.gif)

## Examples (AI scene generation)

A prompt in any language → an LLM designs a scene spec (JSON) → the browser draws it
as flat vector art on a canvas.

![scenes](docs/scenes.gif)

| “Cherry blossoms at a shrine path, dusk” | “Fireworks over a lake at a summer festival” |
|---|---|
| ![sakura](docs/scene-sakura.png) | ![fireworks](docs/scene-fireworks.png) |
| **“A rainy neon street, signs reading 深夜 and ラーメン”** | **“Snowfield and mountains under an aurora”** |
| ![neon](docs/scene-neon.png) | ![aurora](docs/scene-aurora.png) |

---

## Three ways to run it

Enable only what you need. The UI for unavailable features hides itself, so every
configuration just works.

| | Requires | Features |
|---|---|---|
| **Tier 1**<br>Static hosting | Nothing<br>(GitHub Pages works) | Effects, sample images, text overlay, overlay image, video (MP4/GIF), export |
| **Tier 2**<br>Cloudflare | Workers + Workers AI<br>+ D1 + R2 + Durable Objects | ＋ AI image generation, AI scene generation, gallery, knowledge graph, share links |
| **Tier 3**<br>Your own AI | Tier 2, with the AI<br>provider swapped out | ＋ Any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, …) |

### Tier 1: just run it

```sh
git clone https://github.com/<you>/image_effector.git
cd image_effector/public
python3 -m http.server 8000   # → http://localhost:8000
```

`public/` is all you need, so GitHub Pages or Netlify will serve it as-is. Without a
backend the `/api/config` request fails and the AI and gallery UI hide automatically.

### Tier 2: deploy to Cloudflare

```sh
# 1. Create the resources (note the database_id it prints)
npx wrangler d1 create noiz-lab
npx wrangler r2 bucket create noiz-lab-works

# 2. Replace name / database_id / bucket_name in wrangler.jsonc with your own

# 3. Apply the schema
npx wrangler d1 execute noiz-lab --remote --file schema.sql

# 4. Set the gallery access key (any long random string)
npx wrangler secret put GALLERY_KEY

# 5. Deploy
npx wrangler deploy
```

If you skip `GALLERY_KEY` the gallery stays disabled and only the AI features run.

### Tier 3: swap in your own AI

The app needs exactly four AI operations — text generation, text→image, image→text and
embeddings — which map onto the standard OpenAI-compatible endpoints. Switch with
environment variables:

```sh
# .dev.vars (local) or `wrangler secret put` (production)
AI_PROVIDER=openai
AI_BASE_URL=http://localhost:11434/v1   # Ollama, for example
AI_API_KEY=ollama
AI_MODEL_CHAT=llama3.3
AI_MODEL_VISION=llava
AI_MODEL_EMBED=bge-m3
```

> **Note**: Cloudflare Workers run at the edge and cannot reach `localhost`. To use a
> local model, run `npx wrangler dev`, or expose the endpoint with something like
> Cloudflare Tunnel.
>
> Only the `workers-ai` provider has been exercised in practice. The `openai` provider
> follows the documented API shape, but differences between individual implementations
> (Ollama / LM Studio / vLLM …) have not been verified.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `GALLERY_KEY` | none | Gallery access key. Without it the gallery is disabled |
| `AI_PROVIDER` | `workers-ai` | `workers-ai` / `openai` / `none` |
| `AI_BASE_URL` | OpenAI | Endpoint used by the `openai` provider |
| `AI_API_KEY` | none | Key for the `openai` provider (often unnecessary for local models) |
| `AI_MODEL_CHAT` etc. | provider default | Model names (`_CHAT_SMALL` / `_IMAGE` / `_VISION` / `_EMBED`) |
| `AI_DAILY_CAP` | `8000` | Daily AI budget. Requests return 503 once exceeded |

Copy `.dev.vars.example` to `.dev.vars` to get started.

## Features

| Area | Details |
|---|---|
| Effects | Blur / pixel sort / glitch / chromatic aberration / halation / color grade / light leak / pixelate / Bayer dither, halftone & ASCII art / CRT curvature, scanlines, VHS tracking & wobble / grain & vignette |
| Presets | Y2K / VHS / DREAM / PRINT / PIXEL / SORTED / CINEMA / FILM / NEON + randomize. Deep-linkable via `/#preset=CINEMA` |
| AI (photo) | Text→image. Non-English prompts are translated by an LLM first |
| AI (scene) | An LLM designs a scene spec (JSON) and the browser draws it as flat vector art. Motifs: sky, sun, moon, stars, clouds, sea, perspective grid, mountains, city, rain, snow, cherry petals, fireworks, aurora, torii gate, neon signs, birds |
| Text overlay | Title text with 3 fonts, 4 colors, free placement and drag-to-move. Composited so glitch does not break it while CRT and grain still apply |
| Overlay image | Composite a second image into the source; effects then apply to the whole result |
| Short video | Up to 8 cuts, 4 transitions, Ken Burns zoom, ratio crop (9:16 etc.), 1280px long edge, MP4 (H.264) preferred. Each cut remembers its own effects |
| Music & BPM | Audio is muxed in as an AAC track. BPM is auto-detected and cuts land on the beat |
| GIF export | Hand-written GIF89a encoder (median cut + dithering + LZW) |
| Gallery | Saves the source image and its recipe to R2 + D1. **Images are private by default** and readable only through expiring signed URLs |
| Share links | Per-work `/w/<id>` pages whose OGP card shows **the edited image itself** (1200px long-edge JPEG). **Expire after about a day** |
| Share on X | With a gallery backend, creates a share link first so the card shows the image. Without one, posts the recipe URL |
| Knowledge graph | A 2D/3D force-directed graph of saved works, linked by semantic similarity (caption + embedding) and recipe similarity |
| Crossbreeding | Blend two works' recipes into a child work, visualised with lineage edges |
| What's next | Detects structural gaps in the graph and has an LLM suggest works that would fill them, creatable in one click |
| Protection | Per-IP rate limiting (Durable Objects) and a daily AI budget guard |
| i18n | Japanese and English UI. Auto-detected, switchable, and deep-linkable via `/#lang=en` |
| PWA | Manifest + service worker (network-first) |

## Layout

```
public/          Static assets (this alone runs as Tier 1)
  app.js         WebGL2 pipeline, UI, pixel sort, GIF encoder, graph
  i18n.js        Japanese/English strings
  about.html     About page (about-en.html for English)
src/
  worker.js      API routing, gallery, sharing, rate limiting
  ai.js          AI provider abstraction (workers-ai / openai / none)
schema.sql       D1 schema
wrangler.jsonc   Workers config (change name / database_id / bucket_name when forking)
```

Rendering is a multi-pass pipeline: source (＋ CPU pixel sort) → separable Gaussian
blur → luminance extraction + blur (halation) → a final composite shader handling
glitch, aberration, dithering, grading, CRT, text and grain.

## Development

```sh
npx wrangler dev      # local (can reach a localhost AI endpoint)
npx wrangler deploy
```

## About cost

The author's instance runs inside Cloudflare's free tier. Requests that exceed a free
allowance return an error and stop rather than generating a bill, and there is an extra
guard that halts at 80% of the Workers AI daily free allowance (10,000 neurons).

That applies to **the Workers Free plan**. A paid plan, or pointing `AI_PROVIDER=openai`
at a commercial API, will bill you according to that provider's pricing.

## License and rights

MIT License ([LICENSE](LICENSE)).

- Sample images and generated scenes are drawn entirely in code; no third-party assets
- Fonts are loaded from Google Fonts (SIL Open Font License)
- AI model licenses follow whichever provider you configure
