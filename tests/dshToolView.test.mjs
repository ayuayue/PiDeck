import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * DSH 工具视图（host ToolEventView）→ 轨迹可读信息单测：
 * call/result 信封解包、标题回退、terminal/diff/generic/search/read 详情拼装。
 */

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

function loadModule() {
	const sandbox = { exports: {} };
	vm.runInNewContext(transpile("src/renderer/src/components/session/trajectory/dshToolView.ts"), sandbox, { filename: "dshToolView.ts" });
	return sandbox.exports;
}

const { unwrapToolView, toolViewTitle, toolViewDetail, toolViewInput, toolViewOutput } = loadModule();

test("unwrapToolView 只解包对应 for 的视图", () => {
	const envelope = { for: "call", view: { card: "terminal", title: "ls" } };
	assert.equal(unwrapToolView(envelope, "call")?.title, "ls");
	assert.equal(unwrapToolView(envelope, "result"), undefined);
	assert.equal(unwrapToolView(undefined, "call"), undefined);
	assert.equal(unwrapToolView(null, "call"), undefined);
	assert.equal(unwrapToolView({ for: "call" }, "call"), undefined);
});

test("toolViewTitle：result 标题优先，缺省回退 call 标题", () => {
	const meta = {
		view: { for: "call", view: { card: "terminal", title: "ls -la" } },
		resultView: { for: "result", view: { card: "terminal", title: "ls -la (done)" } },
	};
	assert.equal(toolViewTitle(meta), "ls -la (done)");
	assert.equal(toolViewTitle({ view: meta.view }), "ls -la");
	assert.equal(toolViewTitle({}), undefined);
	assert.equal(toolViewTitle(undefined), undefined);
});

test("toolViewDetail：terminal 命令 + cwd + 输出 + 退出码", () => {
	const meta = {
		view: { for: "call", view: { card: "terminal", title: "npm test", cwd: "/repo" } },
		resultView: { for: "result", view: { card: "terminal", output: "pass 10", exitCode: 0 } },
	};
	const detail = toolViewDetail(meta);
	assert.match(detail ?? "", /\$ npm test/);
	assert.match(detail ?? "", /cwd: \/repo/);
	assert.match(detail ?? "", /pass 10/);
	assert.match(detail ?? "", /exit 0/);
});

test("toolViewDetail：terminal 超长输出截断", () => {
	const meta = {
		resultView: { for: "result", view: { card: "terminal", title: "cmd", output: "x".repeat(1200) } },
	};
	const detail = toolViewDetail(meta);
	assert.ok(detail && detail.length < 900, "output must be truncated");
	assert.match(detail ?? "", /…$/);
});

test("toolViewDetail：diff 文件摘要", () => {
	const meta = {
		view: { for: "call", view: { card: "diff", title: "Write foo.txt", diffs: [{ path: "foo.txt", oldLines: 3, newLines: 5 }] } },
	};
	const detail = toolViewDetail(meta);
	assert.match(detail ?? "", /foo\.txt \(\+5 −3\)/);
});

test("toolViewDetail：generic rawInput + content 文本", () => {
	const meta = {
		view: { for: "call", view: { card: "generic", title: "run job", rawInput: "job-42" } },
		resultView: { for: "result", view: { card: "generic", content: [{ type: "text", text: "done" }] } },
	};
	const detail = toolViewDetail(meta);
	assert.match(detail ?? "", /job-42/);
	assert.match(detail ?? "", /done/);
});

test("toolViewDetail：search 命中列表与 read 行数", () => {
	const search = toolViewDetail({
		resultView: {
			for: "result",
			view: {
				card: "search",
				shape: "matches",
				files: [
					{
						path: "a.ts",
						matches: [
							{ lineNumber: 1, line: "x" },
							{ lineNumber: 2, line: "y" },
						],
					},
				],
			},
		},
	});
	assert.match(search ?? "", /a\.ts: 2 处命中/);
	const read = toolViewDetail({
		resultView: { for: "result", view: { card: "read", lines: [{ number: 1, text: "a" }], offset: 10 } },
	});
	assert.match(read ?? "", /L10\+1 行/);
});

test("toolViewDetail：无视图信息返回 undefined", () => {
	assert.equal(toolViewDetail(undefined), undefined);
	assert.equal(toolViewDetail({}), undefined);
	assert.equal(toolViewDetail({ view: { for: "call", view: {} } }), undefined);
});

test("toolViewInput / toolViewOutput split call payload from result", () => {
	const meta = {
		view: { for: "call", view: { card: "terminal", title: "ls -la", cwd: "/repo" } },
		resultView: { for: "result", view: { card: "terminal", output: "pass", exitCode: 0 } },
	};
	assert.match(toolViewInput(meta) ?? "", /\$ ls -la/);
	assert.match(toolViewInput(meta) ?? "", /cwd: \/repo/);
	assert.doesNotMatch(toolViewInput(meta) ?? "", /pass/);
	assert.match(toolViewOutput(meta) ?? "", /pass/);
	assert.match(toolViewOutput(meta) ?? "", /exit 0/);
});
