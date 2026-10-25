import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 回复快捷操作「配置化」的守卫测试：规则只来自资源文件与用户文件，
// 渲染层组件不允许再内置任何规则常量；打包清单与主进程装配必须齐全。

const DEFAULT_RESOURCE = "resources/reply-actions.default.json";
const readDefaults = () => JSON.parse(readFileSync(DEFAULT_RESOURCE, "utf8"));

test("出厂规则必须打进安装包（漏了 extraResources，打包版就没有内置规则）", () => {
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	const entries = pkg.build?.extraResources ?? [];
	assert.ok(
		entries.some((entry) => typeof entry === "object" && entry.from === DEFAULT_RESOURCE),
		`package.json extraResources 缺少 ${DEFAULT_RESOURCE}`,
	);
});

test("出厂规则覆盖常用工程场景：继续 / 提交 / 推送 / 失败重试都要有", () => {
	const items = readDefaults().items;
	const texts = items.map((rule) => rule.text);
	const has = (needle) => texts.some((text) => text.includes(needle));
	assert.ok(has("继续"), "出厂规则缺少「继续」类收尾动作");
	assert.ok(has("提交"), "出厂规则缺少「提交」类动作");
	assert.ok(has("推送"), "出厂规则缺少「推送」类动作");
	assert.ok(has("重试") || has("排查"), "出厂规则缺少失败后的重试/排查动作");
	for (const rule of items) {
		assert.ok(typeof rule.text === "string" && rule.text.trim().length > 0, "规则文案必须非空");
		assert.ok(Array.isArray(rule.triggers) && rule.triggers.length > 0, `规则「${rule.text}」至少要有一个触发条件`);
	}
	assert.ok(
		items.some((rule) => rule.triggers.some((trigger) => trigger.kind === "onFailure")),
		"出厂规则必须包含失败触发的场景（重试/排查）",
	);
	assert.equal(new Set(texts).size, texts.length, "出厂规则出现重复文案");
});

test("组件不内置规则常量（配置化后写死一处就漏一处）", () => {
	for (const file of ["src/renderer/src/components/session/SessionReplyActions.tsx", "src/renderer/src/components/session/ComposerArea.tsx", "src/renderer/src/components/session/SessionView.tsx"]) {
		const source = readFileSync(file, "utf8");
		assert.ok(!/triggers:\s*\[\s*\{\s*kind/.test(source), `${file} 不应内置触发条件，规则只来自规则文件`);
	}
});

test("主进程装配：规则文件来自 userData、出厂规则来自随包 resources（两个磁盘根同源）", () => {
	const source = readFileSync("src/main/index.ts", "utf8");
	assert.match(source, /new ReplyActionRuleStore\(\{/);
	assert.match(source, /REPLY_ACTIONS_FILE_NAME/);
	assert.match(source, /REPLY_ACTIONS_DEFAULT_RESOURCE_NAME/);
});

test("IPC 三通道与 preload 暴露成对（漏一处运行时就是 undefined）", () => {
	const ipcSource = readFileSync("src/shared/ipc.ts", "utf8");
	for (const channel of ["replyActionsGet", "replyActionsSave", "replyActionsOpenFile"]) {
		assert.match(ipcSource, new RegExp(`${channel}\\s*:`), `shared/ipc.ts 缺少 ${channel}`);
	}
	const preload = readFileSync("src/preload/index.ts", "utf8");
	assert.match(preload, /replyActions:\s*\{[\s\S]{0,400}?invoke\(ipcChannels\.replyActionsGet\)/, "preload 必须暴露 replyActions.get");
	assert.match(preload, /replyActions:\s*\{[\s\S]{0,600}?invoke\(ipcChannels\.replyActionsSave/, "preload 必须暴露 replyActions.save");
	assert.match(preload, /replyActions:\s*\{[\s\S]{0,800}?invoke\(ipcChannels\.replyActionsOpenFile/, "preload 必须暴露 replyActions.openFile");
});

test("两个管理弹框共用尺寸与打开时不抢第一项焦点", () => {
	const quick = readFileSync("src/renderer/src/components/app/settings/QuickMessagesDialog.tsx", "utf8");
	const reply = readFileSync("src/renderer/src/components/app/settings/ReplyActionsDialog.tsx", "utf8");
	const quickClass = quick.match(/<DialogContent[^>]*className="([^"]+)"/u)?.[1];
	const replyClass = reply.match(/<DialogContent[^>]*className="([^"]+)"/u)?.[1];
	assert.equal(replyClass, quickClass, "两个管理弹框必须使用同一尺寸 class");
	assert.match(quick, /onOpenAutoFocus=\{\(event\) => event\.preventDefault\(\)\}/, "快捷消息弹框不应自动聚焦第一项");
	assert.match(reply, /onOpenAutoFocus=\{\(event\) => event\.preventDefault\(\)\}/, "回复快捷操作弹框不应自动聚焦第一项");
});

test("回复规则编辑器：何时显示是一个带文字的下拉（成功 / 失败 / 全部 / 命中关键词），不再是两列勾选框", () => {
	const source = readFileSync("src/renderer/src/components/app/settings/ReplyActionsDialog.tsx", "utf8");
	assert.match(source, /from "\.\.\/\.\.\/ui-shadcn\/table"/, "规则编辑器应复用项目 Table 原语");
	for (const column of ["replyActionsColumnOrder", "replyActionsColumnText", "replyActionsColumnTrigger", "replyActionsColumnOperations"]) {
		assert.match(source, new RegExp(`t\\(\\"settings\\.${column}\\"\\)`), `缺少表头 ${column}`);
	}
	assert.match(source, /from "\.\.\/\.\.\/ui-shadcn\/select"/, "何时显示应使用带文字的下拉");
	for (const mode of ["onStop", "onFailure", "always", "textMatch"]) {
		assert.match(source, new RegExp(`settings\\.replyActionsTrigger\\.${mode}`), `触发下拉缺少「${mode}」选项`);
	}
	assert.doesNotMatch(source, /replyActionsColumnOnStop|replyActionsColumnOnFailure|from "\.\.\/\.\.\/ui-shadcn\/checkbox"/, "成功 / 失败不再分成两列勾选框");
});

test("设置页管理区与入口接线（缺少入口用户就改不了规则）", () => {
	const commonTab = readFileSync("src/renderer/src/components/app/settings/CommonTab.tsx", "utf8");
	assert.match(commonTab, /<ReplyActionsSetting\s*\/>/, "CommonTab 必须挂 ReplyActionsSetting");
	const setting = readFileSync("src/renderer/src/components/app/settings/ReplyActionsSetting.tsx", "utf8");
	assert.match(setting, /useReplyActions\(\)/, "设置行应读规则快照");
	assert.match(setting, /<ReplyActionsDialog/, "设置行必须挂管理弹框");
});
