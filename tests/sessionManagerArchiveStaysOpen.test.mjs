import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 会话管理弹窗：批量归档成功后必须留在原地。
// 用户点归档通常是要连续清理/接着切到归档视图核对，弹窗被顺手关掉等于丢掉操作上下文；
// 关闭只应由用户主动触发（X / Esc / 遮罩）。运行中的会话会被主进程拒绝，
// 失败提示归 action 层 toast，弹窗同样保持打开。

const components = readFileSync("src/renderer/src/components/sidebar/SidebarComponents.tsx", "utf8");
const content = readFileSync("src/renderer/src/components/sidebar/SidebarContent.tsx", "utf8");
const archiveHook = readFileSync("src/renderer/src/hooks/sidebar/useSidebarArchiveActions.ts", "utf8");
const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

/** 取 SessionManagerModal 的 JSX 属性区（自闭合标签前），只做切片不做解析。 */
function managerProps() {
	const start = content.indexOf("<SessionManagerModal");
	const end = content.indexOf("/>", start);
	assert.ok(start !== -1 && end > start, "SessionManagerModal 应该仍挂载在侧栏");
	return content.slice(start, end);
}

/** 按行首锚点取一个函数的源码块（结束锚点必须是下一行首的闭合）。 */
function functionBlock(source, signature, nextSignature) {
	const start = source.search(new RegExp(`^[\\t ]*${signature}`, "m"));
	const end = source.search(new RegExp(`^[\\t ]*${nextSignature}`, "m"));
	assert.notEqual(start, -1, `找不到 ${signature}`);
	assert.notEqual(end, -1, `找不到 ${nextSignature} 边界`);
	assert.ok(end > start, `${nextSignature} 必须在 ${signature} 之后`);
	return source.slice(start, end);
}

test("session manager archive keeps the dialog open and archives under the owning project", () => {
	const manager = managerProps();
	const archiveStart = manager.indexOf("onArchive={");
	const archiveEnd = manager.indexOf("onUnarchive={", archiveStart);
	assert.ok(archiveStart !== -1 && archiveEnd > archiveStart, "会话管理弹窗必须同时提供 onArchive / onUnarchive");
	const onArchive = manager.slice(archiveStart, archiveEnd);

	assert.doesNotMatch(onArchive, /closeSessionManager/, "归档成功后不得关闭会话管理弹窗");
	assert.match(onArchive, /actions\.sessions\.archive\(/, "归档仍走 sidebar archive action");
	// worktree 家族会把子工作区的会话一起列出来：必须按会话归属项目归档并刷新，
	// 否则弹窗保持打开时子工作区那几行会残留（刷新的是错误项目）。
	assert.match(onArchive, /session\.projectId \?\? managerProject\.id/, "多工作区会话要按归属项目归档/刷新");

	// 用户主动关闭仍然要接在这一个 prop 上（X / Esc / 遮罩）
	assert.match(manager, /onClose=\{controller\.closeSessionManager\}/);
});

test("session manager archive clears the finished selection without closing", () => {
	assert.match(components, /onArchive: \(sessions: SessionSummary\[\]\) => Promise<void>/, "归档回调要能被弹窗 await");

	const handler = functionBlock(components, "const handleArchiveSelected = \\(\\) => \\{", "const handleDeleteSelected = ");
	assert.match(handler, /props\s*\.onArchive\(toArchive\)/, "按钮必须把选中的会话交给 onArchive");
	assert.match(handler, /setSelected\(new Set\(\)\)/, "归档完成后要清空选中，避免已归档行的勾选/批量计数残留");
	assert.match(handler, /setSelectAll\(false\)/);
	assert.doesNotMatch(handler, /props\.onClose\(\)/, "归档处理函数不得关闭弹窗");
	assert.doesNotMatch(handler, /closeSessionManager/, "归档处理函数不得调用弹窗关闭入口");
	// 归档按钮仍要接到这个处理函数（不能回退到内联 props.onArchive）
	assert.match(components, /onClick=\{handleArchiveSelected\}/);
});

test("archive failures toast instead of leaking a rejected promise", () => {
	const archive = functionBlock(archiveHook, "async function archiveSidebarSession\\(", "async function unarchiveSidebarSession\\(");
	assert.match(archive, /try \{[\s\S]*?await api\.sessions\.archiveRecord\(session\.id\)[\s\S]*?\} catch \(error\) \{/, "主进程拒绝（运行中会话）必须被捕获");
	assert.match(archive, /showToast\(sessionActionErrorMessage\(error, t\("app\.sessionArchiveFailed"\)\), 5000, "error"\)/, "失败要落成带原因的 toast");
	assert.match(archiveHook, /function sessionActionErrorMessage\(error: unknown, fallback: string\): string/, "失败原因要剥离 Electron invoke 包装前缀");
	assert.match(archive, /return;/);
	assert.match(zh, /"app\.sessionArchiveFailed":\s*"归档会话失败"/);
	assert.match(en, /"app\.sessionArchiveFailed":\s*"Failed to archive session"/);
});
