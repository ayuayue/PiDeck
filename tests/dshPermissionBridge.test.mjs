import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const hostEntry = readFileSync(join(repoRoot, "src/main/dsh/hostEntry.ts"), "utf8");

test("DSH slash bridge consumes known permission commands before model dispatch", () => {
	// This bridge is generated into ~/.dsh at host startup. Keep the contract test
	// close to the source because a stale/wrong bridge turns /permission into chat.
	assert.match(hostEntry, /writeFileSync\(\s*slashBridgePath/);
	assert.match(hostEntry, /commandCtx\.commands\.execute\(agent, line, \[\], signal\)/);
	assert.match(hostEntry, /if \(result === undefined\) return next\(\);/);
	assert.match(hostEntry, /return \{ kind: 'reject' \};/);
	assert.doesNotMatch(
		hostEntry,
		/catch \(error\) \{\s*return next\(\);/,
		"known command failures must not fall through as ordinary prompts",
	);
});
