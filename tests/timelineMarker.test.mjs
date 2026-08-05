import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const marker = readFileSync(
  "src/renderer/src/components/session/TimelineMarker.tsx",
  "utf8",
);
const toolCard = readFileSync(
  "src/renderer/src/components/session/ToolCallComponents.tsx",
  "utf8",
);
const events = readFileSync(
  "src/renderer/src/components/session/TimelineEventCards.tsx",
  "utf8",
);

test("TimelineMarker keeps event kinds and tones explicit", () => {
  assert.match(marker, /TimelineMarkerKind = "thinking" \| "tool" \| "compaction" \| "diagnostic" \| "ask"/);
  assert.match(marker, /TimelineMarkerTone = "neutral" \| "active" \| "success" \| "warning" \| "error"/);
  assert.match(marker, /data-marker-kind=\{props\.kind\}/);
  assert.match(marker, /data-marker-tone=\{tone\}/);
  assert.match(marker, /bg-border-subtle/);
});

test("tool cards map execution status to marker tone without changing detail behavior", () => {
  assert.match(toolCard, /kind="tool"/);
  assert.match(toolCard, /tone=\{tone === "error" \? "error" : tone === "running" \? "active" : "success"\}/);
  assert.match(toolCard, /aria-expanded=\{expanded\}/);
  assert.match(toolCard, /getToolDetailText/);
  assert.match(toolCard, /tool-card-copy/);
});

test("thinking, compaction, diagnostic, and ask cards use the same marker rail", () => {
  for (const kind of ["thinking", "compaction", "diagnostic", "ask"]) {
    assert.match(events, new RegExp(`kind=\\"${kind}\\"`));
  }
  assert.match(events, /setExpanded\(\(v\) => !v\)/);
  assert.match(events, /setExpanded\(!expanded\)/);
  assert.match(events, /data-message-id=\{props\.message\.id\}/);
});
