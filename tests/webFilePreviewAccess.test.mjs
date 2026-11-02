/**
 * Web 端文件预览的路径分流单测：项目内 → 相对路径沙箱，项目外（绝对路径 / `~/x`）→
 * 交后端按安全等级求值，不再硬拒。同时覆盖 /api/file-content 应答 → 预览状态的映射
 *（ask 需确认 / deny 拒绝 / 其它失败）与 diff 目标在项目外时回退成文件预览。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { toProjectRelative, classifyFileContentOutcome, WebFilePreview } = loadTsCommonJs("src/renderer/src/web/WebFilePreview.tsx", {
	stubs: {
		"@/components/session/MarkdownStream": { MarkdownStream: () => null },
		"@/components/ui-shadcn/virtual-stack": { VirtualStack: () => null },
		"@/i18n": { t: (key) => key },
		"lucide-react": { Loader2: () => null, X: () => null },
		"./useDismissOnBack": { useDismissOnBack: () => {} },
		// SSR 不跑 effect：只要模块能解析，fetch 不会被真正调用
		"./webApi": {
			fetchFileContent: async () => ({}),
			fetchGitDiff: async () => null,
			fetchGitStatus: async () => ({ repo: false, groups: null }),
		},
	},
});

test("toProjectRelative：项目内裁成相对路径，项目外交给安全等级求值", () => {
	// 项目内：相对路径原样、绝对路径裁成相对、盘符大小写不敏感
	assert.equal(toProjectRelative("src/a.ts", "C:/proj"), "src/a.ts");
	assert.equal(toProjectRelative("./src/a.ts", "C:/proj"), "src/a.ts");
	assert.equal(toProjectRelative("C:\\proj\\src\\a.ts", "C:/proj"), "src/a.ts");
	assert.equal(toProjectRelative("c:/PROJ/src/a.ts", "C:/proj"), "src/a.ts");
	// 项目外：绝对路径 / `~/x` / UNC → null（调用方按安全等级求值，不再直接拦）
	assert.equal(toProjectRelative("C:/other/b.ts", "C:/proj"), null);
	assert.equal(toProjectRelative("/home/u/b.ts", "C:/proj"), null);
	assert.equal(toProjectRelative("~/.pi/agent/settings.json", "C:/proj"), null);
	assert.equal(toProjectRelative("~\\notes.md", "C:/proj"), null);
	assert.equal(toProjectRelative("\\\\wsl$\\Ubuntu\\home\\b.ts", "C:/proj"), null);
	// 没有项目根时无法判定相对位置
	assert.equal(toProjectRelative("src/a.ts", ""), null);
});

/** 模块在 vm 里加载，返回的对象原型不同：转成测试 realm 的普通值再比。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

const view = (outcome) => plain(classifyFileContentOutcome(outcome));

test("classifyFileContentOutcome：ask / deny / 其它失败三路分流", () => {
	assert.deepEqual(view({ ok: true, data: { content: "x" } }), { phase: "ready", data: { content: "x" } });
	// 需确认：带上服务端 reason，渲染层据此选文案
	assert.deepEqual(view({ ok: false, error: { code: "webError.fileAccessNeedsConfirm", reason: "outside-allowed-dirs" } }), { phase: "confirm", reason: "outside-allowed-dirs" });
	// 拒绝（命中 denyDirs）：不提供「再来一次」的入口
	assert.deepEqual(view({ ok: false, error: { code: "webError.fileAccessDenied", reason: "deny-dir" } }), { phase: "denied", reason: "deny-dir" });
	// 越界 / 缺失 / 网络错误 → 统一失败态（不把 404 当需确认）
	assert.deepEqual(view({ ok: false, error: { code: "webError.fileOutsideProject" } }), { phase: "failed" });
	assert.deepEqual(view({ ok: false, error: { code: "webError.fileNotFound" } }), { phase: "failed" });
	assert.deepEqual(view({ ok: false, error: new Error("file content 500") }), { phase: "failed" });
	assert.deepEqual(view({ ok: false, error: null }), { phase: "failed" });
});

test("WebFilePreview：项目外 diff 目标回退成文件预览并说明原因，不再给「仅支持项目内」死胡同", () => {
	const html = renderToStaticMarkup(
		createElement(WebFilePreview, {
			target: { kind: "diff", projectId: "p1", projectRoot: "C:/proj", path: "C:/other/b.ts" },
			onClose: () => {},
		}),
	);
	// 头部直接显示真实路径（不再被裁成空），并带「回退展示当前文件内容」提示
	assert.match(html, /C:\/other\/b\.ts/);
	assert.match(html, /web\.diffFallbackToFile/);
});

test("WebFilePreview：项目内 diff 目标仍走 diff 预览", () => {
	const html = renderToStaticMarkup(
		createElement(WebFilePreview, {
			target: { kind: "diff", projectId: "p1", projectRoot: "C:/proj", path: "C:/proj/src/a.ts" },
			onClose: () => {},
		}),
	);
	assert.doesNotMatch(html, /web\.diffFallbackToFile/);
	// 头部展示相对路径
	assert.match(html, />src\/a\.ts</);
});
