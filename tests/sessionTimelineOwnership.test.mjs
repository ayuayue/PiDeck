import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const timelineSource = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");
const ownedTimelineSource = readFileSync("src/renderer/src/components/session/OwnedSessionMessageTimeline.tsx", "utf8");
const stageSource = readFileSync("src/renderer/src/components/session/SessionSurfaceStage.tsx", "utf8");
const askPanelSource = readFileSync("src/renderer/src/components/overlays/AskPanelOverlay.tsx", "utf8");

test("each session timeline has exactly one explicit controller owner", () => {
	// The content component must only consume an injected controller. Creating a
	// fallback hook here previously registered a second cleanup that could erase
	// the real owner's saved scroll anchor during a keyed session unmount.
	assert.match(timelineSource, /controller: SessionTimelineController;/);
	assert.doesNotMatch(timelineSource, /controller\?: SessionTimelineController;/);
	assert.doesNotMatch(timelineSource, /\buseSessionTimelineController\s*\(/);
	assert.doesNotMatch(timelineSource, /internalController/);

	// Standalone surfaces own their controller in a separate wrapper and forward
	// the same instance to the content component.
	assert.match(ownedTimelineSource, /const controller = useSessionTimelineController\(\{ sessionId \}\);/);
	assert.match(ownedTimelineSource, /controller=\{controller\}/);

	// Main panes keep their existing controller as the sole owner, while Ask uses
	// the dedicated standalone owner instead of relying on an optional prop.
	assert.match(stageSource, /controller=\{sessionTimeline\}/);
	assert.match(askPanelSource, /<OwnedSessionMessageTimeline/);
	assert.doesNotMatch(askPanelSource, /<SessionMessageTimeline/);
});
