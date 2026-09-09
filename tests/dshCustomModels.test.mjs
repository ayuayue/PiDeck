import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function asJson(value) {
	return JSON.parse(JSON.stringify(value));
}

function loadDshModelsModule() {
	const source = readFileSync("src/renderer/src/config/dshModels.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = {
		exports: {},
		require: (id) => {
			if (id === "./modelsUtils") {
				return {
					buildModelsFromFetchedSelection: (fetched, selectedIds, existing) => {
						const existingIds = new Set(existing.map((model) => model.id));
						const selected = new Set(selectedIds);
						return fetched
							.filter((model) => selected.has(model.id) && !existingIds.has(model.id))
							.map((model) => ({
								id: model.id,
								name: model.name ?? model.id,
								contextWindow: model.contextWindow,
								maxTokens: model.maxTokens,
								input: model.input,
							}));
					},
				};
			}
			if (id === "./providerHeaders") {
				return {
					KNOWN_PROVIDER_ENDPOINTS: {
						deepseek: { baseUrl: "https://api.deepseek.com/v1", apiType: "openai-completions" },
						openai: { baseUrl: "https://api.openai.com/v1", apiType: "openai-completions" },
					},
				};
			}
			// 模型展示顺序统一比较器（shared/modelOrder）：纯函数，真实加载保持与生产一致的排序。
			if (id === "../../../shared/modelOrder") return loadTsCommonJs("src/shared/modelOrder.ts");
			throw new Error(`Unexpected require: ${id}`);
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "dshModels.ts" });
	return sandbox.exports;
}

test("first custom add while inheriting catalog keeps catalog then appends blank", () => {
	const { appendBlankDshModel } = loadDshModelsModule();
	const next = appendBlankDshModel({
		catalog: [
			{ id: "deepseek-chat", name: "DeepSeek Chat" },
			{ id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
		],
	});
	assert.deepEqual(asJson(next), [
		{ id: "deepseek-chat", name: "DeepSeek Chat" },
		{ id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
		{ id: "" },
	]);
});

test("adding onto saved custom models does not wipe them", () => {
	const { appendBlankDshModel } = loadDshModelsModule();
	const next = appendBlankDshModel({
		savedModels: [{ id: "grok-4", name: "Grok 4", contextWindow: 200000 }],
		catalog: [{ id: "should-not-replace", name: "Catalog" }],
	});
	assert.equal(next.length, 2);
	assert.deepEqual(asJson(next[0]), { id: "grok-4", name: "Grok 4", contextWindow: 200000 });
	assert.deepEqual(asJson(next[1]), { id: "" });
});

test("empty draft falls back to saved or catalog instead of wiping them", () => {
	const { seedDshModelsForCustomEdit, appendBlankDshModel } = loadDshModelsModule();
	assert.deepEqual(
		asJson(seedDshModelsForCustomEdit({
			draftModels: [],
			savedModels: [{ id: "saved", name: "Saved" }],
			catalog: [{ id: "catalog" }],
		})),
		[{ id: "saved", name: "Saved" }],
	);
	assert.deepEqual(
		asJson(appendBlankDshModel({
			draftModels: [],
			catalog: [{ id: "catalog", name: "Catalog" }],
		})),
		[
			{ id: "catalog", name: "Catalog" },
			{ id: "" },
		],
	);
});

test("an explicit empty official DeepSeek override stays empty before adding a model", () => {
	const { appendBlankDshModel } = loadDshModelsModule();
	const next = appendBlankDshModel({
		draftModels: [],
		catalog: [{ id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash" }],
		emptyDraftIsOverride: true,
	});
	assert.deepEqual(asJson(next), [{ id: "" }]);
});

test("official DeepSeek capacity shorthand and model validation match DSH Web", () => {
	const { formatDshModelCapacity, parseDshModelCapacity, validateDshDeepseekModels } = loadDshModelsModule();
	assert.equal(formatDshModelCapacity(1_000_000), "1M");
	assert.equal(formatDshModelCapacity(256_000), "256K");
	assert.equal(parseDshModelCapacity("1M"), 1_000_000);
	assert.equal(parseDshModelCapacity("256K"), 256_000);
	assert.ok(Number.isNaN(parseDshModelCapacity("not-a-capacity")));
	assert.equal(validateDshDeepseekModels(undefined), undefined);
	assert.equal(validateDshDeepseekModels([]), undefined);
	assert.deepEqual(asJson(validateDshDeepseekModels([{ id: "same" }, { id: "same" }])), {
		index: 1,
		issue: "idDuplicate",
	});
	assert.equal(validateDshDeepseekModels([{ id: "valid", inputModalities: ["text", "image"] }]), undefined);
});

test("editing a saved custom row does not drop sibling models", () => {
	const { updateDshModelAt } = loadDshModelsModule();
	const next = updateDshModelAt({
		savedModels: [
			{ id: "a", name: "A" },
			{ id: "b", name: "B" },
		],
		index: 1,
		field: "name",
		value: "Bee",
	});
	assert.deepEqual(asJson(next), [
		{ id: "a", name: "A" },
		{ id: "b", name: "Bee" },
	]);
});

test("removing from inherited catalog keeps the remaining catalog rows", () => {
	const { removeDshModelAt } = loadDshModelsModule();
	const next = removeDshModelAt({
		catalog: [
			{ id: "keep", name: "Keep" },
			{ id: "drop", name: "Drop" },
		],
		index: 1,
	});
	assert.deepEqual(asJson(next), [{ id: "keep", name: "Keep" }]);
});

test("appending fetched models keeps existing rows, skips duplicates, and copies listing capacities", () => {
	const { appendFetchedDshModels } = loadDshModelsModule();
	const next = appendFetchedDshModels({
		savedModels: [{ id: "already", name: "Already" }],
		catalog: [{ id: "catalog-only" }],
		fetched: [
			{ id: "already", name: "Already Remote" },
			{ id: "new-a", name: "New A", contextWindow: 256000, maxTokens: 32000, input: ["text", "image"] },
			{ id: "new-b", name: "New B" },
		],
		selectedIds: ["already", "new-a"],
	});
	assert.deepEqual(asJson(next), [
		{ id: "already", name: "Already" },
		{ id: "new-a", name: "New A", contextWindow: 256000, maxTokens: 32000, input: ["text", "image"] },
	]);
});

test("DSH model fetching delegates draft discovery to the host API", () => {
	const editor = readFileSync("src/renderer/src/config/DshModelsEditor.tsx", "utf8");
	assert.match(editor, /desktopApi\.sessions\.discoverDshModels/);
	assert.match(editor, /canDiscoverModels = props\.settingsNs === "llm-pi-ai"/);
	assert.doesNotMatch(editor, /desktopApi\.config\.fetchModels/);
	assert.doesNotMatch(editor, /readDshCredential/);
});

test("DSH cards seed custom models instead of starting from an empty draft array", () => {
	const cards = readFileSync("src/renderer/src/config/DshProviderCards.tsx", "utf8");
	const editor = readFileSync("src/renderer/src/config/DshModelsEditor.tsx", "utf8");
	assert.match(cards, /DshModelsEditor/);
	assert.match(editor, /appendBlankDshModel/);
	assert.match(editor, /appendFetchedDshModels/);
	assert.match(editor, /desktopApi\.sessions\.discoverDshModels/);
	assert.doesNotMatch(
		cards,
		/const models = Array.isArray\((?:provider|next)\.models\) \? \[\.\.\.(?:provider|next)\.models\] : \[\];\s*models\.push\(\{ id: ""/,
	);
});

test("official DeepSeek lets inherited catalog rows materialize a model override", () => {
	const cards = readFileSync("src/renderer/src/config/DshProviderCards.tsx", "utf8");
	const editor = readFileSync("src/renderer/src/config/DshModelsEditor.tsx", "utf8");
	const table = readFileSync("src/renderer/src/config/DshModelsTable.tsx", "utf8");
	assert.match(cards, /editableInherited/);
	assert.match(editor, /emptyDraftIsOverride: props\.modelsOverridden === true/);
	assert.match(table, /const canEditRows = !inherited \|\| props\.editableInherited === true/);
	assert.match(table, /defaultContextWindow/);
});

test("official DeepSeek inherits catalog rows from DSH composition base through IPC", () => {
	const host = readFileSync("src/main/dsh/DshHost.ts", "utf8");
	const ipc = readFileSync("src/main/ipc/sessionIpc.ts", "utf8");
	const preload = readFileSync("src/preload/index.ts", "utf8");
	const cards = readFileSync("src/renderer/src/config/DshProviderCards.tsx", "utf8");
	assert.match(host, /base: ns\.base/);
	assert.match(ipc, /base\?: unknown/);
	assert.match(preload, /base\?: unknown/);
	assert.match(cards, /readPath\(namespace\.base, \["models"\]\)/);
	assert.match(cards, /schemaDefaultModels/);
});
