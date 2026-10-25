import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = readFileSync("src/main/pi/historyMessages.ts", "utf8").replace('import type { ChatMessage } from "../../shared/types";\n\n', "");
const compiled = ts.transpileModule(source, {
	compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const out = join(tmpdir(), `pideck-history-messages-${Date.now()}.mjs`);
writeFileSync(out, compiled);
const { mergeHistoryWithPreservedMessages } = await import(pathToFileURL(out).href);

const history = [
	{ id: "h1", agentId: "a", role: "user", text: "old", timestamp: 100 },
	{ id: "h2", agentId: "a", role: "assistant", text: "old answer", timestamp: 200 },
];
const current = [
	{ id: "placeholder", agentId: "a", role: "system", text: "loading", timestamp: 1_050, meta: { historyLoading: true } },
	{ id: "new-user", agentId: "a", role: "user", text: "new", timestamp: 1_100 },
	{ id: "new-assistant", agentId: "a", role: "assistant", text: "stream", timestamp: 1_200 },
];

assert.deepEqual(
	mergeHistoryWithPreservedMessages(history, current, 1_000).map((message) => message.id),
	["h1", "h2", "new-user", "new-assistant"],
	"messages created while background history is loading should be preserved after loaded history",
);
assert.equal(mergeHistoryWithPreservedMessages(history, current, undefined), history, "without a preserve boundary the loaded history should be used as-is");
assert.deepEqual(
	mergeHistoryWithPreservedMessages(history, [{ ...history[0], timestamp: 1_100 }], 1_000).map((message) => message.id),
	["h1", "h2"],
	"duplicate loaded history ids should not be appended again",
);
console.log("historyMessages tests passed");
