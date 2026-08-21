#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createProject, parseProjectJson, stringifyProject, validateProject } from "../public/project-format.js";

JSON.parse(await readFile(new URL("../schemas/project.schema.json", import.meta.url), "utf8"));

const project = createProject({
  id: "project-test",
  title: "Round-trip test",
  assets: [{
    id: "asset-1", type: "image", name: "frame.webp", mime: "image/webp",
    source: { kind: "embedded", data: "AA==" },
    metadata: { width: 1200, height: 800, duration: 0 }, generation: null,
  }],
  timeline: { bpm: 120, beatDivision: 2, tracks: [{
    id: "visual-main", type: "visual", clips: [{
      id: "clip-1", assetId: "asset-1", purpose: "hook", start: 0, duration: 1,
      trim: { in: 0, out: 1 }, recipe: null, motion: [], transitionOut: null,
    }],
  }] },
});

assert.deepEqual(validateProject(project), { valid: true, errors: [] });
assert.equal(parseProjectJson(stringifyProject(project)).id, "project-test");

const broken = structuredClone(project);
broken.timeline.tracks[0].clips[0].assetId = "missing";
const invalid = validateProject(broken);
assert.equal(invalid.valid, false);
assert.match(invalid.errors.join("\n"), /does not reference an asset/);

console.log("NOIZ LAB project format tests passed");
