/**
 * Ask 划选守卫（按压感知版）回归测试 —— 修复「ask 选项点很久才能勾上」。
 *
 * 根因（Electron 真实输入管线夹具实测，tests/fixtures/ask-click-driver.cjs）：
 * Chromium 中按钮 mousedown 不会塌缩 document 选区，旧选区残留导致旧守卫
 * hasTextSelection() 把「划选复制/双击选词之后的真实点击」持续吞掉，直到
 * 用户恰好点到非按钮区域（用户实测「点其他位置就好」；失焦本身不清选区）。
 *
 * 新契约（askUi.ts）：document mousedown 捕获阶段记录按压时选区快照；
 * click 时只有「选区非空且与快照不一致（或无快照）」才吞——
 * - 无选区 → 放行（大多数点击）
 * - 快照与当前选区一致 → 旧选区残留，放行（修复点）
 * - 快照与当前选区不同 → 本次按压新拖出的选区（划选 mouseup 冒充 click），吞掉
 * - 无快照（null，如键盘触发或首帧前）且有选区 → 保守吞掉（旧守卫兜底语义）
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/** 加载 askUi.ts 纯逻辑（与 askUiStateMachine.test.mjs 同一装载模式）。 */
function loadAskUi(selectionText) {
	const source = readFileSync("src/renderer/src/utils/askUi.ts", "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		fileName: "askUi.ts",
	}).outputText;
	// selectionText === undefined：不提供 window（SSR 兜底分支）；
	// 沙箱不提供 document → 模块级 mousedown 监听器不安装（快照恒 null，走保守兜底）
	const sandbox =
		selectionText === undefined
			? { exports: {}, require: () => ({}) }
			: {
					exports: {},
					require: () => ({}),
					window: {
						getSelection: () => (selectionText === null ? null : { toString: () => selectionText }),
					},
				};
	vm.runInNewContext(output, sandbox, { filename: "askUi.ts" });
	return sandbox.exports;
}

// ── 纯判定核心 shouldSuppressAskClickSnapshot ──

test("纯判定：click 时无有效选区 → 放行（任意快照）", () => {
	const { shouldSuppressAskClickSnapshot } = loadAskUi("");
	assert.equal(shouldSuppressAskClickSnapshot("", ""), false);
	assert.equal(shouldSuppressAskClickSnapshot("旧选区", ""), false);
	assert.equal(shouldSuppressAskClickSnapshot(null, ""), false);
	// 纯空白选区与旧守卫 trim 语义一致，视为无选区
	assert.equal(shouldSuppressAskClickSnapshot(null, "  \n\t  "), false);
});

test("纯判定：选区与按压快照一致（旧选区残留）→ 放行 —— 本次修复的核心断言", () => {
	// 用户此前划选/双击产生的旧选区一直残留，按钮 mousedown 不塌缩它；
	// 按压前后选区未变化 = 真实点击，不得吞掉（旧守卫在此误吞 = 用户报的 bug）
	const { shouldSuppressAskClickSnapshot } = loadAskUi("问题标题文本");
	assert.equal(shouldSuppressAskClickSnapshot("问题标题文本", "问题标题文本"), false);
});

test("纯判定：选区与快照不一致（本次按压新拖出）→ 吞掉（保留原守卫意图）", () => {
	const { shouldSuppressAskClickSnapshot } = loadAskUi("拖出来的新选区");
	// 按压开始时无选区，click 时出现选区 = 划选恰好结束在按钮上的冒充 click
	assert.equal(shouldSuppressAskClickSnapshot("", "拖出来的新选区"), true);
	// 按压期间选区被改变同样视为冒充
	assert.equal(shouldSuppressAskClickSnapshot("按压前的旧选区", "改变后选区"), true);
});

test("纯判定：无按压快照且有选区 → 保守吞掉（兜底旧守卫语义）", () => {
	const { shouldSuppressAskClickSnapshot } = loadAskUi("划选文本");
	assert.equal(shouldSuppressAskClickSnapshot(null, "划选文本"), true);
	assert.equal(shouldSuppressAskClickSnapshot(undefined, "划选文本"), true);
});

// ── DOM 包装（vm 沙箱无按压快照，行为应与旧守卫等价） ──

test("shouldSuppressAskClick: 无 window 视为不吞（SSR 兜底）", () => {
	const { shouldSuppressAskClick } = loadAskUi(undefined);
	assert.equal(shouldSuppressAskClick(), false);
});

test("shouldSuppressAskClick: 沙箱内无按压快照，行为与旧守卫等价", () => {
	assert.equal(loadAskUi("").shouldSuppressAskClick(), false);
	assert.equal(loadAskUi("有选区").shouldSuppressAskClick(), true);
	assert.equal(loadAskUi("  \n  ").shouldSuppressAskClick(), false);
});

// ── 静态契约：模块级监听 + 全部接线点迁移 ──

test("askUi 安装模块级 mousedown 快照监听并导出按压感知守卫", () => {
	const util = readFileSync("src/renderer/src/utils/askUi.ts", "utf8");
	assert.match(util, /export function shouldSuppressAskClickSnapshot/);
	assert.match(util, /export function shouldSuppressAskClick/);
	assert.match(util, /document\.addEventListener\(\s*"mousedown"/s);
	// 旧守卫彻底移除（单一守卫机制，避免两套语义并存）
	assert.doesNotMatch(util, /export function hasTextSelection/);
});

test("全部 ask 按钮接线按压感知守卫，旧全局守卫彻底移除", () => {
	const overlay = readFileSync("src/renderer/src/components/overlays/SessionRuntimeUiOverlay.tsx", "utf8");
	const security = readFileSync("src/renderer/src/components/overlays/SecurityConfirmCard.tsx", "utf8");

	assert.doesNotMatch(overlay, /hasTextSelection/);
	assert.doesNotMatch(security, /hasTextSelection/);
	assert.match(overlay, /import \{[^}]*shouldSuppressAskClick[^}]*\} from "\.\.\/\.\.\/utils\/askUi"/);
	assert.match(security, /import \{[^}]*shouldSuppressAskClick[^}]*\} from "\.\.\/\.\.\/utils\/askUi"/);

	// overlay 6 处：批量 yes/no、批量 select、multi_select、submitValue、单 select
	const overlayGuards = overlay.match(/if \(shouldSuppressAskClick\(\)\) return;/g);
	assert.ok(overlayGuards && overlayGuards.length >= 6, `overlay 守卫数不足: ${overlayGuards?.length}`);
	// 安全卡 2 处：允许/拒绝
	const securityGuards = security.match(/if \(shouldSuppressAskClick\(\)\) return;/g);
	assert.ok(securityGuards && securityGuards.length >= 2, `security 守卫数不足: ${securityGuards?.length}`);
});
