/**
 * fork/copy 改名失败不得静默。
 *
 * 现场教训（2026-10-08，Linux）：copy 的 catalog 里存了坏路径（`\home\…`），
 * sessionScanner.rename ENOENT —— 仅落一条 warn 日志，用户侧零反馈：
 * 文件从未获得 (copy) session_info 名，侧栏标题停在「最后一条输入」弱兜底上，
 * 看起来像「复制出的会话名是乱的」，实际是「改名失败了」。
 *
 * 契约：
 * 1. rename 失败不阻断 fork/copy 本身（产物已存在，报错会让用户以为复制失败）；
 * 2. 失败必须以 agentsNotice toast 形式对用户可见（emitAgentsNotice 汇聚点
 *    统一构造 runtime envelope → 渲染层 useSessionRuntimeBridge 弹 toast），
 *    不能只写日志；
 * 3. 失败时 catalog 条目不得携带未落盘的后缀标题（title 保持原名，
 *    ensureRuntimeTarget 拿到的就是未加后缀的 title —— 权威名以文件为准）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const indexSource = readFileSync("src/main/index.ts", "utf8");

/** 取函数体：默认从 marker 后第一个 "{" 配平；类型体需显式传 signatureEnd 跳过参数表。 */
function functionBody(source, marker, signatureEnd) {
	const start = source.indexOf(marker);
	assert.ok(start >= 0, `marker not found: ${marker}`);
	let bodyStart;
	if (signatureEnd) {
		bodyStart = source.indexOf(signatureEnd, start);
		assert.ok(bodyStart >= 0, `signature end not found: ${signatureEnd}`);
		bodyStart = bodyStart + signatureEnd.length - 1;
	} else {
		bodyStart = source.indexOf("{", start);
		assert.ok(bodyStart >= 0, `body not found after: ${marker}`);
	}
	let depth = 0;
	for (let index = bodyStart; index < source.length; index += 1) {
		if (source[index] === "{") depth += 1;
		if (source[index] === "}") {
			depth -= 1;
			if (depth === 0) return source.slice(bodyStart, index + 1);
		}
	}
	throw new Error("unbalanced function body");
}

/** 在函数体内取 try/catch 的 catch 分支体（从 "} catch (" 到该 try 语句收口）。 */
function catchBranch(functionText) {
	const catchStart = functionText.indexOf("} catch (error) {");
	assert.ok(catchStart >= 0, "catch branch not found");
	let depth = 0;
	for (let index = catchStart + "} catch (error) {".length - 1; index < functionText.length; index += 1) {
		if (functionText[index] === "{") depth += 1;
		if (functionText[index] === "}") {
			depth -= 1;
			if (depth === 0) return functionText.slice(catchStart, index + 1);
		}
	}
	throw new Error("unbalanced catch branch");
}

test("copy 流程的 rename 失败分支必须发出 agentsNotice 用户通知", () => {
	const body = functionBody(indexSource, "async function copyCatalogSession");
	assert.match(body, /sessionScanner\.rename\(result\.sessionPath,\s*forkedTitle\)/);
	const catchBody = catchBranch(body);
	assert.match(catchBody, /emitAgentsNotice\(/, "copy rename 失败必须发用户通知（不能只写日志）");
	// i18n key 直写通知契约：渲染层 t() 按 key 查文案。
	assert.match(catchBody, /"notice\.sessionSuffixRenameFailed"/);
});

test("fork 流程的 rename 失败分支必须发出 agentsNotice 用户通知", () => {
	const body = functionBody(indexSource, "resolveTargetSessionId: async () => {");
	assert.match(body, /agentManager\.rename\(agentId,\s*forkedTitle\)/);
	const catchBody = catchBranch(body);
	assert.match(catchBody, /emitAgentsNotice\(/, "fork rename 失败必须发用户通知（不能只写日志）");
});

test("emitAgentsNotice 汇聚点必须走 sessionsRuntimeEvent envelope（渲染层唯一通知入口）", () => {
	const helper = functionBody(indexSource, "function emitAgentsNotice(", "): void {");
	// 渲染层 useSessionRuntimeBridge 只消费 runtime envelope（sourceChannel=agents:notice），
	// 裸 webContents.send(agentsNotice) 是死流量（与 AgentManager DIRECT_EMIT_CHANNELS 同规则）。
	assert.match(helper, /sendSessionRuntimeEnvelope\(/);
	assert.match(helper, /ipcChannels\.agentsNotice/);
	assert.match(helper, /sourceChannel: ipcChannels\.agentsNotice/);
});

test("rename 失败时条目标题保持未加后缀的原名（权威名以文件为准）", () => {
	// title 只在 rename 成功后才被改写为 forkedTitle —— 失败分支不得触碰 title。
	const copyBody = functionBody(indexSource, "async function copyCatalogSession");
	const forkBody = functionBody(indexSource, "resolveTargetSessionId: async () => {");
	for (const body of [copyBody, forkBody]) {
		const tryPart = body.slice(0, body.indexOf("} catch (error) {"));
		assert.match(tryPart, /title = forkedTitle;/, "成功路径才写回标题");
		// catch 分支内不得出现 title = forkedTitle（防止失败也宣称后缀已应用）。
		const catchPart = catchBranch(body);
		assert.doesNotMatch(catchPart, /title = forkedTitle;/);
	}
});

test("通知文案存在于主进程 i18n（渲染层经 ...mainProcess 展开，不得重复声明）", () => {
	const mainCopy = readFileSync("src/shared/i18n/mainProcessCopy.ts", "utf8");
	assert.match(mainCopy, /"notice\.sessionSuffixRenameFailed"/);
	// 渲染层字典 spread 主进程字典：若在渲染层也显式声明同一 key，
	// tsc 会报 TS2783（specified more than once）。必须只写一份。
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	assert.match(zh, /\.\.\.mainProcessZhCN/);
	assert.match(en, /\.\.\.mainProcessEnUS/);
	assert.equal((zh.match(/notice\.sessionSuffixRenameFailed/g) ?? []).length, 0, "渲染层不得重复声明主进程通知 key");
	assert.equal((en.match(/notice\.sessionSuffixRenameFailed/g) ?? []).length, 0, "renderer dictionary must not redeclare main-process notice keys");
});
