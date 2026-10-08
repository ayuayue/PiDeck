import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { convertPiContext } from "../scripts/convert-pi-context-host-plugin.mjs";
import { PiContextData, HISTORY_LIMITS } from "../resources/host-plugin-adapters/pi-context/data.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { readHostPluginPackage } = loadTsCommonJs("src/main/plugins/hostPluginFiles.ts");
function snapshot(entries) {
	return { requests: [], userMsgs: entries.map((entry) => ({ text: entry.id })), promptSections: [], toolDefs: [], counts: { turns: entries.length, steps: 0, toolCalls: 0, compactions: 0 }, composition: { system: 0, tools: 0, user: 1, assistant: 0, tool: 0, total: 1 }, totalTokens: 0 };
}
const context = { projectId: "project-a", locale: "en-US", theme: "dark" };
const noWait = async () => undefined;

test("pi-context adapter restores chronological pages and reuses analysis for viewer interactions", async () => {
	let calls = 0;
	const received = [];
	const api = {
		sessions: {
			entries: async (_id, cursor) => {
				calls += 1;
				return cursor ? { entries: [{ id: "first", timestamp: "2026-01-01", type: "message" }], version: "v1", nextCursor: null, truncated: false } : { entries: [{ id: "last", timestamp: "2026-01-02", type: "message" }], version: "v1", nextCursor: { before: 1, version: "v1" }, truncated: false };
			},
		},
	};
	const data = new PiContextData(
		api,
		async (entries) => {
			received.push(entries.map((entry) => entry.id));
			return snapshot(entries);
		},
		context,
		noWait,
	);
	await data.snapshot("history");
	await data.snapshot("history");
	assert.deepEqual(received, [["first", "last"]]);
	assert.equal(calls, 2);
	data.invalidate();
	await data.snapshot("history");
	assert.equal(calls, 4);
});

test("pi-context adapter never exposes results started in a different project", async () => {
	let release;
	const api = {
		sessions: {
			entries: () =>
				new Promise((resolve) => {
					release = resolve;
				}),
		},
	};
	const data = new PiContextData(api, async (entries) => snapshot(entries), context, noWait);
	const pending = data.snapshot("history");
	while (!release) await new Promise((resolve) => setImmediate(resolve));
	data.updateContext({ ...context, projectId: "project-b" });
	release({ entries: [{ id: "private", timestamp: "2026-01-01" }], version: "v1", nextCursor: null, truncated: false });
	await assert.rejects(pending, /plugin-context-changed/);
});

test("pi-context adapter explicitly marks bounded histories and omits oversized entries", async () => {
	let calls = 0;
	const api = {
		sessions: {
			entries: async () => {
				calls += 1;
				return { entries: [{ id: "too-large", omitted: "entry-too-large" }, ...Array.from({ length: 99 }, (_, i) => ({ id: `${i}`, timestamp: "2026-01-01" }))], version: "v1", nextCursor: { before: 1000 - calls * 100, version: "v1" }, truncated: true };
			},
		},
	};
	const data = new PiContextData(api, async (entries) => snapshot(entries), context, noWait);
	const result = await data.history("history", 0, 200, 2 * 1024 * 1024);
	assert.equal(calls, 2);
	assert.equal(result.entries.length, 198);
	assert.equal(result.partial, true);
	assert.equal(data.status.partial, true);
});

test("pi-context overview bounds session discovery, reports missing histories and keeps IDs opaque", async () => {
	let reads = 0;
	const sessions = Array.from({ length: 60 }, (_, i) => ({ id: `id-${i}`, projectId: "project-a", title: "Saved", createdAt: 1, updatedAt: 2, readable: i !== 1 }));
	const api = {
		sessions: {
			list: async () => ({ sessions, nextOffset: null }),
			entries: async () => {
				reads += 1;
				return { entries: [], nextCursor: null, version: "v1", truncated: false };
			},
		},
	};
	const data = new PiContextData(api, async (entries) => snapshot(entries), context, noWait);
	const rows = await data.list();
	await data.list();
	assert.equal(rows.length, HISTORY_LIMITS.sessions - 1);
	assert.equal(reads, HISTORY_LIMITS.sessions - 1);
	assert.equal(data.status.partial, true);
	assert.equal(data.status.unavailable, 1);
	assert.equal(rows[0].file, "id-0");
	assert.equal(rows[0].cwd, "project-a");
});

test("pi-context adapter rejects mixed file revisions instead of publishing a misleading snapshot", async () => {
	const api = { sessions: { entries: async (_id, cursor) => (cursor ? { entries: [], version: "v2", nextCursor: null, truncated: false } : { entries: [{ id: "one", timestamp: "2026-01-01" }], version: "v1", nextCursor: { before: 1, version: "v1" }, truncated: false }) } };
	const data = new PiContextData(api, async (entries) => snapshot(entries), context, noWait);
	await assert.rejects(data.snapshot("history"), /history-changed/);
});

test("pi-context locate maps viewer rows onto timeline entries via workbench.navigate", async () => {
	const navigated = [];
	const api = {
		sessions: {
			entries: async () => ({
				entries: [
					{ id: "m1", timestamp: "2026-01-01" },
					{ id: "m2", timestamp: "2026-01-02" },
				],
				version: "v1",
				nextCursor: null,
				truncated: false,
			}),
		},
		workbench: { navigate: async (sessionId, entryId) => void navigated.push([sessionId, entryId]) },
	};
	const data = new PiContextData(api, async (entries) => ({ ...snapshot(entries), userMsgs: [{ text: "first", id: "m2" }], asstMsgs: [{ text: "reply", id: undefined }] }), context, noWait);
	await data.locate("history", "user", 0);
	assert.deepEqual(navigated, [["history", "m2"]]);
	// 无 entry id（旧模型或非消息行）与未知 kind 都不得触发导航，也不得静默导航到错误目标。
	await assert.rejects(data.locate("history", "asst", 0), /entry-not-navigable/);
	await assert.rejects(data.locate("history", "unknown", 0), /entry-not-navigable/);
	assert.deepEqual(navigated, [["history", "m2"]]);
});

// A tiny synthetic upstream fixture exercises the converter seams without vendoring downloaded source.
const viewer = `const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const api = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
const card = '<a href="/?file=id">';
function jumpTo() {}
async function boot() {
  const app = document.getElementById("app");
  const file = new URLSearchParams(location.search).get("file");
  document.getElementById("live").textContent = "● 每 10 秒自动刷新";
  app.addEventListener("click", async (e) => {
    const loc = e.target.closest("[data-loc]");
    if (loc) {
      const [k, n] = loc.dataset.loc.split(":");
      jumpTo(k, \x60it-\x24{k}-\x24{n}\x60);
      return;
    }
  });
  let all = null;
  const renderHome = async () => {
    if (!all) all = await api("/api/sessions");
    app.innerHTML = "overview";
  };
  let hTimer = 0;
  const renderDetail = async (keep) => {
    app.innerHTML = detail(await api(\x60/api/snapshot?file=\x24{encodeURIComponent(file)}\x60), file, keep);
  };
  let dTimer = 0;
  try {
    if (!file) {
      await renderHome();
      setInterval(async () => { all = await api("/api/sessions"); if (document.activeElement?.id !== "sq") renderHome(); }, 10000);
      return;
    }
    await renderDetail();
    setInterval(() => { if (document.activeElement?.tagName !== "INPUT") renderDetail({ q: document.getElementById("q")?.value ?? "", ts: toolSort }); }, 10000);
  } catch (e) {
    app.innerHTML = \x60<p class="note">加载失败：\x24{esc(e.message)}</p>\x60;
  }
}
boot();
`;
const modelSource = `
const CHARS_PER_TOKEN = 4;
export function estimateTokens(text: string) { return Math.ceil(text.length / CHARS_PER_TOKEN); }
export function buildSnapshot(entries: any[]) {
  const userMsgs: any[] = [];
  const asstMsgs: any[] = [];
  const toolRes: any[] = [];
  for (const e of entries) {
    const m = e.message;
    if (m.role === "user") {
      const uText = String(m.content ?? "");
      userMsgs.push({ time: e.timestamp, text: uText.slice(0, 8000), tokens: estimateTokens(uText) });
    } else if (m.role === "assistant") {
      const aText = String(m.content ?? "");
      const kinds: string[] = [];
      asstMsgs.push({ time: e.timestamp, text: aText.slice(0, 8000), tokens: estimateTokens(aText), kinds });
    } else if (m.role === "toolResult") {
      const c = String(m.content ?? "");
      toolRes.push({ time: e.timestamp, tool: m.toolName ?? "", callId: m.toolCallId ?? "", text: c.slice(0, 8000), tokens: estimateTokens(c.slice(0, 4000)) });
    }
  }
  return { count: entries.length, userMsgs, asstMsgs, toolRes };
}
`;
async function sourceAt(source) {
	await mkdir(join(source, "viewer", "public"), { recursive: true });
	await mkdir(join(source, "src"));
	await writeFile(join(source, "package.json"), JSON.stringify({ name: "pi-context", version: "0.1.0" }));
	await writeFile(join(source, "src", "model.ts"), modelSource);
	await writeFile(join(source, "viewer", "public", "app.js"), viewer);
	await writeFile(join(source, "viewer", "public", "styles.css"), "body{color:#fff}");
	await writeFile(join(source, "viewer", "public", "app.html"), '<!doctype html><header><a href="/">Home</a></header><main id="app"></main><script src="app.js"></script>');
	await writeFile(join(source, "viewer", "NOTICE"), "Original attribution retained");
}

test("pi-context conversion creates a browser-only consent package without executing the extension", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-context-convert-"));
	const source = join(root, "source");
	const output = join(root, "plugin");
	try {
		await sourceAt(source);
		await writeFile(join(source, "index.ts"), "throw new Error('NEVER EXECUTE PI EXTENSION');");
		assert.equal(await convertPiContext(source, output), output);
		const plugin = await readHostPluginPackage(output);
		assert.equal(plugin.manifest.id, "pi-context");
		assert.deepEqual([...plugin.manifest.permissions], ["sessions.read", "workbench.navigate"]);
		assert.deepEqual([...plugin.assets.keys()].sort(), ["NOTICE", "app.html", "app.js", "bridge.mjs", "data.mjs", "model.mjs", "pideck-plugin.json", "styles.css", "worker.mjs"].sort());
		const code = await readFile(join(output, "app.js"), "utf8");
		assert.ok(!code.includes("fetch(p)") && !code.includes("setInterval("));
		assert.ok(code.includes("host.onChange") && code.includes("&quot;"));
		assert.ok(code.includes("host.locate?.(file, k, Number(n))"));
		assert.equal(await readFile(join(output, "NOTICE"), "utf8"), "Original attribution retained");
		const model = await import(pathToFileURL(join(output, "model.mjs")));
		assert.deepEqual(model.buildSnapshot([{ id: "m1", timestamp: 0, message: { role: "user", content: "hi" } }]).userMsgs[0], { time: 0, text: "hi", tokens: 1, id: "m1" });
		assert.equal(model.buildSnapshot([{ id: "x", timestamp: 0, message: { role: "other" } }]).count, 1);
		await assert.rejects(convertPiContext(source, output), /EEXIST/);
		assert.equal(await readFile(join(output, "app.js"), "utf8"), code);
		await assert.rejects(convertPiContext(source, join(source, "plugin")), /outside/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("pi-context conversion fails closed on changed viewer seams and imported backend code", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-context-convert-invalid-"));
	const source = join(root, "source");
	try {
		await sourceAt(source);
		await writeFile(join(source, "src", "model.ts"), "import fs from 'node:fs'; export const buildSnapshot = fs.readFileSync;");
		await assert.rejects(convertPiContext(source, join(root, "imported")), /import-free/);
		await writeFile(join(source, "viewer", "public", "app.js"), "fetch('/other');");
		await assert.rejects(convertPiContext(source, join(root, "changed")), /Unsupported pi-context viewer/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
