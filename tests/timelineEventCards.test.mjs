import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const surface = readFileSync("src/renderer/src/components/session/SurfaceComponents.tsx", "utf8");
const events = readFileSync("src/renderer/src/components/session/TimelineEventCards.tsx", "utf8");

test("timeline event cards retain the SurfaceComponents public facade", () => {
	for (const name of ["DiagnosticMessageCard", "ThinkingBlock", "RespondingIndicator"]) {
		assert.match(events, new RegExp(`(?:export const|export function) ${name}`));
		assert.match(surface, new RegExp(`\\b${name}\\b`));
	}
	assert.match(surface, /from "\.\/TimelineEventCards"/);
	assert.doesNotMatch(surface, /function getDiagnosticTone\(message/);
});
