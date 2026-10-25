// 项目外文件链接的「用户意图门」契约（issue：AI 生成/操作在项目外的文件点不开）。
//
// 背景：会话内文件链接此前对项目外路径一律硬拒——`resolveFileLinkPath(path, baseDir, projectRoot)`
// 越界即 null，点击只弹「路径不在当前项目内」，哪怕用户当次安全等级是「关」（渲染层从未读过安全配置）。
// 现在项目外路径改由安全等级求值：不限制目录的等级（off / standard）直接只读打开，危险情形
// （受保护的敏感文件 / 限定目录越界 / 策略读不到）弹二次确认，denyDirs 只拒绝。
//
// 本测试锁住三件事（等级细则见 tests/externalPathAccessPolicy.test.mjs）：
//  1. 判定 → UI 动作的唯一映射 planExternalPathOpen：allow→open / ask→confirm / deny→blocked；
//  2. 门只做意图收集：确认才 proceed、取消不 proceed、blocked 分支绝不 proceed；
//  3. App 路由：项目外路径必须走 requestExternalPathOpen，放行后的打开只读且不带项目 scope
//     （确认一次「看」不能变成「可写任意路径」），项目内路径的项目边界保持不变；
//  4. 目录与「文件管理器定位」不弹框：门先 stat 定类（或直接按 kind=reveal），再带 targetKind 求值。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const read = (path) => readFileSync(path, "utf8");
// 项目外路径的路由（handleOpenLinkedFile）已迁入 useSessionFileLinks；弹框挂载点仍在 App。
const appSource = read("src/renderer/src/hooks/workspace/useSessionFileLinks.ts");
const appShellSource = read("src/renderer/src/App.tsx");
const gateSource = read("src/renderer/src/hooks/useExternalPathOpenGate.tsx");
const openerSource = read("src/renderer/src/hooks/useSessionFilePathOpener.ts");

const { planExternalPathOpen } = loadTsCommonJs("src/renderer/src/utils/externalPathAccessPolicy.ts");

/** loadTsCommonJs 在独立 VM realm 执行：对象原型不同，deepStrictEqual 会报「same structure but not reference-equal」，统一用 JSON 比较。 */
const check = (actual, expected) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);

test("判定 → UI 动作：allow 直接打开、ask 二次确认、deny 只拒绝", () => {
	check(planExternalPathOpen({ access: "allow", reason: "unrestricted" }), { action: "open" });
	check(planExternalPathOpen({ access: "allow", reason: "security-disabled" }), { action: "open" });
	check(planExternalPathOpen({ access: "ask", reason: "sensitive" }), { action: "confirm", reason: "sensitive" });
	check(planExternalPathOpen({ access: "ask", reason: "outside-allowed-dirs" }), { action: "confirm", reason: "outside-allowed-dirs" });
	check(planExternalPathOpen({ access: "ask", reason: "policy-unavailable" }), { action: "confirm", reason: "policy-unavailable" });
	check(planExternalPathOpen({ access: "deny", reason: "deny-dir" }), { action: "blocked", reason: "deny-dir" });
});

test("门只在用户确认后 proceed：拒绝与取消都不打开", () => {
	assert.match(gateSource, /const\s+plan\s*=\s*planExternalPathOpen\(verdict\)/);
	// 判定用实时配置：等级可能刚在安全管理里改过（读不到时策略 fail-safe 成「问一次」）
	assert.match(gateSource, /await\s+api\.security\.getConfig\(\)/);

	// blocked：只提示 + 结束，绝不能出现 proceed()
	const blocked = /if\s*\(plan\.action\s*===\s*"blocked"\)\s*\{[\s\S]*?\n\t\t\}/.exec(gateSource)?.[0];
	assert.ok(blocked, "gate must handle the blocked verdict explicitly");
	assert.match(blocked, /showNotice\(/);
	assert.doesNotMatch(blocked, /proceed\(\)/);

	// open：直接打开，不弹框
	const open = /if\s*\(plan\.action\s*===\s*"open"\)\s*\{[\s\S]*?\n\t\t\}/.exec(gateSource)?.[0];
	assert.ok(open, "gate must handle the open verdict explicitly");
	assert.match(open, /request\.proceed\(\)/);
	assert.doesNotMatch(open, /setPending\(/);

	// confirm：挂 ConfirmDialog，确认才 proceed，取消只清状态
	const dialog = /<ConfirmDialog\b[\s\S]*?\/>/.exec(gateSource)?.[0];
	assert.ok(dialog, "ask verdict must render ConfirmDialog");
	assert.match(dialog, /onConfirm=\{\(\)\s*=>\s*\{[\s\S]*?request\.proceed\(\)/);
	const cancel = /onCancel=\{\(\)\s*=>[^\n]*/.exec(dialog)?.[0];
	assert.ok(cancel, "ConfirmDialog must be cancellable");
	assert.doesNotMatch(cancel, /proceed/);
});

test("App 路由：项目外路径走安全等级门，放行后只读且不带项目 scope", () => {
	// 项目外先做一次「不带项目边界」的词法解析；解析不出来（缺基准目录 / 非法路径）才是原来的硬提示
	assert.match(appSource, /const\s+externalPath\s*=\s*resolveFileLinkPath\(path,\s*baseDir\)/);
	assert.match(appSource, /if\s*\(!externalPath\)\s*\{[\s\S]{0,200}?fileLinkCannotResolve/);

	const call = /await\s+requestExternalPathOpen\(\{[\s\S]*?\n\t+\}\);/.exec(appSource)?.[0];
	assert.ok(call, "App must route outside-project paths through requestExternalPathOpen");
	assert.match(call, /path:\s*externalPath/);

	// 只读 + 无 scope：proceed 交给 useSessionFilePathOpener 时不得携带项目授权
	const proceed = /proceed:\s*\(\)\s*=>[^\n]*/.exec(call)?.[0];
	assert.ok(proceed, "the gate needs a proceed callback");
	assert.match(proceed, /openSessionFilePath\(externalPath,\s*\{\s*line,\s*readOnly:\s*true\s*\}\)/);
	assert.doesNotMatch(proceed, /scope/);

	// 宿主必须挂出弹框节点，否则确认框无处渲染
	assert.match(appShellSource, /\{externalPathOpenDialog\}/);

	// 项目内路径的边界不变：仍带稳定 projectId 授权（绝不能因为「项目外可开」而放宽）
	assert.match(appSource, /openSessionFilePath\(resolved,\s*\{\s*line,\s*scope:\s*projectId\s*\?\s*\{\s*projectId\s*\}\s*:\s*undefined\s*\}\)/);
});

test("项目外确认后不经系统默认应用执行，只读打开进编辑器", () => {
	// 项目外路径永远不走 shell.openPath（对可执行文件等于执行），只走只读编辑器 / 图片预览 / 目录定位
	assert.doesNotMatch(openerSource, /openWithDefaultApp/);
	// scope 由调用方决定：项目外为 undefined（打开已获用户确认，主进程无项目边界）
	assert.match(openerSource, /api\.files\.stat\(path,\s*options\.scope\)/);
	assert.match(openerSource, /viewFilePath\(path,\s*undefined,\s*options\.line,\s*options\.scope,\s*options\.readOnly === true\)/);
});

test("目录与「文件管理器定位」不弹确认：门先 stat 定类，再带 targetKind 求值", () => {
	// stat 必须在 evaluate 之前（策略要区分目录才能跳过确认），且不带 scope（项目外路径本就没有项目授权）
	const statIndex = gateSource.indexOf("api.files.stat(request.path)");
	const evaluateIndex = gateSource.indexOf("evaluateExternalPathAccess({");
	assert.ok(statIndex > 0, "gate must stat the target to tell directories from files");
	assert.ok(evaluateIndex > statIndex, "the stat must happen before policy evaluation");
	assert.match(gateSource, /targetKind\s*=\s*"directory"/);
	assert.match(gateSource, /evaluateExternalPathAccess\(\{[\s\S]{0,400}?targetKind\s*\}\)/);
	// kind=reveal（文件管理器定位）不读内容，无需 stat：少一次 IPC，且不会因为目标不存在就丢失动作
	assert.match(gateSource, /if\s*\(request\.kind\s*===\s*"reveal"\)\s*\{\s*targetKind\s*=\s*"reveal";/);
	// 目录 / 定位判定为 allow → 走 open 分支（proceed 而不 setPending），即不弹框
	const openBranch = /if\s*\(plan\.action\s*===\s*"open"\)\s*\{[\s\S]*?\n\t\t\}/.exec(gateSource)?.[0];
	assert.ok(openBranch, "gate must have an explicit open branch");
	assert.doesNotMatch(openBranch, /setPending\(/);
});

test("跨项目链接：落在另一个已打开项目内的文件按那个项目的写边界打开（可编辑可保存）", () => {
	// 场景：会话属于项目 A，链接指向项目 B 的文件。此前一律按「项目外」只读打开，
	// 编辑器能打字但永不保存、Ctrl+S 毫无反应（用户当成「预览转编辑没有自动保存」）。
	// 项目 B 本来就有主进程认可的写边界，按它的 scope 打开与从 B 的文件抽屉打开同权限。
	const ownerMatch = /const\s+owningProject\s*=\s*projects\.find\([^\n]*isFilePathInsideRoot\(externalPath,\s*project\.path\)\)/.exec(appSource)?.[0];
	assert.ok(ownerMatch, "outside-project links must first look for an owning open project");
	const branch = /if\s*\(owningProject\)\s*\{[\s\S]*?\n\t\t\t\}/.exec(appSource)?.[0];
	assert.ok(branch, "owning project branch must exist");
	assert.match(branch, /openSessionFilePath\(externalPath,\s*\{\s*line,\s*scope:\s*\{\s*projectId:\s*owningProject\.id\s*\}\s*\}\)/);
	assert.doesNotMatch(branch, /readOnly/);
	// 归属匹配必须在只读安全门之前：否则跨项目文件仍然先被当项目外只读打开
	assert.ok(appSource.indexOf("owningProject") < appSource.indexOf("requestExternalPathOpen({"), "owning-project routing must run before the external gate");
});
