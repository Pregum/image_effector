#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EFFECT_CLI = join(ROOT, "scripts/noizlab-effect.mjs");
const TRANSITIONS = new Set(["fade", "wipe", "dissolve", "glitch", "punch", "flash", "push", "film-burn"]);

function usage(code = 0) {
  console.log(`Usage:
  node scripts/noizlab-variety-video.mjs OUTPUT.mp4 INPUT@PRESET INPUT@PRESET [...] [options]

Options:
  --transitions <list>  Comma-separated fade,wipe,dissolve,glitch,punch,flash,push,film-burn
                        (default: fade,glitch,dissolve)
  --ratio <ratio>       original | 16:9 | square | 1:1 | 9:16 (default: 16:9)
  --hold <seconds>      Hold time per cut (default: 0.9)
  --duration <seconds>  Transition time (default: 0.9)

Example:
  node scripts/noizlab-variety-video.mjs ending.mp4 \
    night.jpg@FILM idea.jpg@DREAM making.jpg@NEON dawn.jpg@CINEMA \
    --transitions fade,glitch,dissolve`);
  process.exit(code);
}

function parse(argv) {
  if (!argv.length || argv.includes("-h") || argv.includes("--help")) usage();
  const opts = { transitions: "fade,glitch,dissolve", ratio: "16:9", hold: "0.9", duration: "0.9" };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (["--transitions", "--ratio", "--hold", "--duration"].includes(argv[i])) {
      if (argv[i + 1] == null) throw new Error(`${argv[i]} requires a value`);
      opts[argv[i].slice(2)] = argv[++i];
    } else if (argv[i].startsWith("-")) {
      throw new Error(`Unknown option: ${argv[i]}`);
    } else positional.push(argv[i]);
  }
  if (positional.length < 3 || positional.length > 9) usage(1);
  const output = resolve(positional.shift());
  if (extname(output).toLowerCase() !== ".mp4") throw new Error("Output must end in .mp4");
  const cuts = positional.map((spec) => {
    const at = spec.lastIndexOf("@");
    if (at < 1 || at === spec.length - 1) throw new Error(`Cut must use INPUT@PRESET: ${spec}`);
    const input = resolve(spec.slice(0, at));
    if (!existsSync(input)) throw new Error(`Input file not found: ${input}`);
    return { input, preset: spec.slice(at + 1).toUpperCase() };
  });
  const transitions = opts.transitions.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!transitions.length || transitions.some((x) => !TRANSITIONS.has(x))) {
    throw new Error(`Invalid --transitions: ${opts.transitions}`);
  }
  return { output, cuts, transitions, ratio: opts.ratio, hold: opts.hold, duration: opts.duration };
}

function run(command, args) {
  return new Promise((ok, fail) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: "inherit" });
    child.once("error", fail);
    child.once("exit", (code) => code === 0 ? ok() : fail(new Error(`${command} exited with ${code}`)));
  });
}

async function main() {
  const opts = parse(process.argv.slice(2));
  const work = await mkdtemp(join(tmpdir(), "noizlab-variety-"));
  try {
    const processed = [];
    for (let i = 0; i < opts.cuts.length; i++) {
      const output = join(work, `cut-${i}.png`);
      await run(process.execPath, [EFFECT_CLI, opts.cuts[i].input, output, "--preset", opts.cuts[i].preset, "--ratio", opts.ratio]);
      processed.push(output);
    }

    const clips = [];
    for (let i = 0; i < processed.length - 1; i++) {
      const output = join(work, `clip-${i}.mp4`);
      const transition = opts.transitions[i % opts.transitions.length];
      await run(process.execPath, [
        EFFECT_CLI, "--video", processed[i], processed[i + 1], output,
        "--preset", "RESET", "--ratio", opts.ratio, "--transition", transition,
        "--hold", opts.hold, "--duration", opts.duration,
      ]);
      clips.push(output);
    }

    const inputs = clips.flatMap((clip) => ["-i", clip]);
    const prep = clips.map((_, i) => `[${i}:v]setpts=PTS-STARTPTS[v${i}]`).join(";");
    const streams = clips.map((_, i) => `[v${i}]`).join("");
    const filter = `${prep};${streams}concat=n=${clips.length}:v=1:a=0,fps=30,format=yuv420p[v]`;
    await run("ffmpeg", [
      "-y", ...inputs, "-filter_complex", filter, "-map", "[v]",
      "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-level:v", "4.1",
      "-r", "30", "-video_track_timescale", "90000", "-movflags", "+faststart", opts.output,
    ]);
    console.log(`Created ${opts.output} (${opts.cuts.map((x) => x.preset).join(" → ")}; ${opts.transitions.join(" → ")})`);
  } finally {
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(`noizlab-variety-video: ${error.message}`);
  process.exitCode = 1;
});
