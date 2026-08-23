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
| `WEB_ANALYTICS_TOKEN` | none | Cloudflare Web Analytics token. The beacon loads only when set |
| `GA_MEASUREMENT_ID` | none | GA4 measurement ID. gtag loads only when set |
| `PLAUSIBLE_DOMAIN` / `PLAUSIBLE_SRC` | none | Domain registered with Plausible (or a compatible script) and its script URL |

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
| Usage analytics | Per-feature counters in Analytics Engine. No cookies, no visitor IDs, fully disabled unless configured ([details](#usage-analytics)) |

## Layout

```
public/          Static assets (this alone runs as Tier 1)
  app.js         WebGL2 pipeline, UI, pixel sort, GIF encoder, graph
  project-format.js  Shared Project JSON builder, validator and parser
  i18n.js        Japanese/English strings
  analytics.js   Usage event sender (a no-op when there is no endpoint)
  about.html     About page (about-en.html for English)
src/
  worker.js      API routing, gallery, sharing, rate limiting
  ai.js          AI provider abstraction (workers-ai / openai / none)
mcp/
  server.mjs     MCP server (stdio JSON-RPC, no dependencies)
  tools.mjs      The tools that assemble a Project JSON
schema.sql       D1 schema
schemas/         JSON Schema shared by Web / Desktop / Mobile / MCP
wrangler.jsonc   Workers config (change name / database_id / bucket_name when forking)
```

### MCP server

Drive the planning, editing, review and export steps from an MCP client such as
Claude Code. It has no dependencies — `node mcp/server.mjs` is the whole thing.

```sh
claude mcp add noiz-lab -- node /path/to/image_effector/mcp/server.mjs
```

| Tool | Role |
|---|---|
| `create_project_from_brief` | Turn an objective, audience, duration and platform into a project plus a cut plan |
| `generate_storyboard` | Write a storyboard with a hook, a middle and a close |
| `generate_missing_assets` | Generate the images a storyboard calls for, via Workers AI |
| `apply_style_bible` | Push colour, lighting, framing and a preset across every cut |
| `build_short_video` | Lay assets onto the timeline with BPM-aware pacing and transitions |
| `review_hook_and_pacing` | Check the hook, pacing, duration, captions and aspect ratio; return findings and a score |
| `render_project` | Export the timeline to MP4 (needs headless Chrome and ffmpeg) |
| `read_project` / `write_project` | Read and write Project JSON, interchangeable with the web app |
| `validate_project` | Check a project against the shared schema |

`generate_storyboard` works two ways. The MCP client is itself an LLM, so it can write
the storyboard and pass it as `storyboard` — **no backend required**. Or pass `endpoint`,
a deployed NOIZ LAB instance, and its `/api/storyboard` writes one. A storyboard carries
a purpose, duration, shot, caption, image prompt, motion and transition per cut; hand it
to `build_short_video` and that pacing lands on the timeline as written.

Pass the `project` from each result straight into the next tool:

```text
create_project_from_brief → generate_storyboard → generate_missing_assets
  → apply_style_bible → build_short_video → review_hook_and_pacing → render_project
```

`generate_missing_assets` generates the cuts a storyboard calls for from their
`imagePrompt`, so it needs an `endpoint` (a Tier 2+ deployment) for Workers AI. It appends
the same style-bible wording to every prompt, so separately generated cuts still look like
one piece. Up to 8 images per call; a partial batch still returns what succeeded, so you
can retry only the cuts that failed.

Posting (`export_for_tiktok`) is not implemented. `render_project` currently handles only
assets whose `source.kind` is `local`, up to 8 cuts, holding each 0.3–3s.

Rendering is a multi-pass pipeline: source (＋ CPU pixel sort) → separable Gaussian
blur → luminance extraction + blur (halation) → a final composite shader handling
glitch, aberration, dithering, grading, CRT, text and grain.

## Usage analytics

Only there to answer "which features do people actually use". All three parts are
**optional**: with nothing configured, not a single byte of analytics code is served,
so a fork never reports to the original author.

| What | Where to read it | Enabled by |
|---|---|---|
| Page views, referrers, country, Core Web Vitals | Cloudflare Web Analytics | `WEB_ANALYTICS_TOKEN` |
| Per-feature usage counts | Workers Analytics Engine | `analytics_engine_datasets` in `wrangler.jsonc` |
| (optional) third-party SaaS | GA4 / Plausible | `GA_MEASUREMENT_ID` / `PLAUSIBLE_DOMAIN` |

The recorded events are below. Client-sent event names are allowlisted in
`CLIENT_EVENTS` (`src/worker.js`); anything else is dropped.

| Event | Label | Meaning |
|---|---|---|
| `app_open` | language | The editor actually started |
| `effect_on` | effect id | An effect was switched on |
| `preset` | preset name | A preset was picked (the initial one is not counted) |
| `random` / `sample` / `open_image` | — | Randomize / sample switch / opened own image |
| `export` | `png` `mp4` `webm` `gif` | Exported |
| `share` | `image` `url` | Shared on X (image share link, or recipe URL) |
| `ai_image` / `ai_scene` / `ai_suggest` | `ok` / HTTP status | AI calls and their outcome |
| `work_save` / `work_share` | same | Saved to gallery / share link issued |
| `share_view` | `ok` / `expired` | A share page was opened (cached hits are not counted, so it is a lower bound) |

**Never recorded**: IP, User-Agent, cookies, visitor IDs, images, prompt text, recipe
contents. Location is rounded to the country code.

Query it through the Analytics Engine SQL API:

```sh
curl "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d "SELECT blob1 AS event, blob2 AS label, sum(_sample_interval) AS n
      FROM noiz_lab_events
      WHERE timestamp > now() - INTERVAL '7' DAY
      GROUP BY event, label ORDER BY n DESC"
```

## Development

```sh
npx wrangler dev      # local (can reach a localhost AI endpoint)
npx wrangler deploy

node scripts/test-project-format.mjs   # Project JSON round-trip
node scripts/test-mcp-server.mjs       # MCP tools and JSON-RPC over stdio
```

## About cost

The author's instance runs inside Cloudflare's free tier. Requests that exceed a free
allowance return an error and stop rather than generating a bill, and there is an extra
guard that halts at 80% of the Workers AI daily free allowance (10,000 neurons).

That applies to **the Workers Free plan**. A paid plan, or pointing `AI_PROVIDER=openai`
at a commercial API, will bill you according to that provider's pricing.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License and rights

MIT License ([LICENSE](LICENSE)).

- Sample images and generated scenes are drawn entirely in code; no third-party assets
- Fonts are loaded from Google Fonts (SIL Open Font License)
- AI model licenses follow whichever provider you configure
