/**
 * ACP 输入框后端切换契约（源码正则，空白容忍）：
 * 1. picker 单入口 + 二级工具选择：ComposerBackendPicker 只加一个 acp SelectItem
 *    （不平铺工具列表），工具选择走独立的 AcpToolControl（仅 acp 后端渲染）；
 * 2. 主进程甩文件引用：切到 acp 与 imagegen 同款 filePath/piSessionId 清空——
 *    ACP 会话由 agent CLI 自持（session/new 在远端），残留 pi 文件引用会让历史
 *    加载 ENOENT；
 * 3. 渲染层 changeBackend 切 acp 必须带工具预选（激活链 spawn 按工具表取命令行），
 *    工具表为空时不切换（提示引导）；
 * 4. UpdateSessionRecordInput 暴露 acpToolId（草稿期预选通道）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");

test("picker 选项组:Agent CLI 组内直接列工具,选中即切后端+工具", () => {
	const source = read("src/renderer/src/components/session/ComposerComponents.tsx");
	// 单层下拉 + SelectGroup:组标题下直接列工具项(value 携带工具 id),无两页式跳转
	assert.match(source, /<SelectGroup>/, "Agent CLI 必须用选项组呈现");
	assert.match(source, /<SelectLabel className="text-xs text-muted-foreground">\{t\("sessionBackend.acp"\)\}<\/SelectLabel>/, "组标题用 sessionBackend.acp");
	assert.match(source, /value=\{`acp:\$\{tool\.id\}`\}/, "工具项 value 携带 acp: 前缀 id");
	// 选中工具项 → onChangeBackend("acp", toolId);受控 value 映射让组内高亮当前工具
	assert.match(source, /props\.onChangeBackend\("acp", next\.slice\("acp:"\.length\)\)/, "选工具必须带 toolId 走后端切换链");
	assert.match(source, /props\.backend === "acp" && props\.acpToolId \? `acp:\$\{props\.acpToolId\}` : props\.backend/, "受控 value 必须映射到组内工具项(回显高亮)");
	// 门控:开关开启且工具非空,或当前后端已是 acp
	assert.match(source, /acpEnabled && acpTools\.length > 0\) \|\| props\.backend === "acp"/, "acp 入口按 opt-in 门控且保留当前后端");
});

test("acp 后端隐藏 pi 模型/思考 chip(两套模型语义不混用)", () => {
	const source = read("src/renderer/src/components/session/ComposerComponents.tsx");
	assert.match(source, /isImageGenMode \|\| props\.backend === "acp" \? null : \(\s*<ModelThinkingChip/, "acp 后端必须隐藏 ModelThinkingChip");
	assert.match(source, /focus-visible:ring-0/, "picker 不得有 focus 环闪");
});

test("controller：切 acp 必须带工具预选，空表不切换", () => {
	const source = read("src/renderer/src/hooks/useSessionComposerController.ts");
	const change = source.slice(source.indexOf("const changeBackend = useCallback"), source.indexOf("const changeAcpTool"));
	assert.match(change, /next === "acp"/, "changeBackend 必须有 acp 分支");
	assert.match(change, /record\?\.acpToolId \?\? tools\[0\]\?\.id/, "默认工具 = 会话已选 ?? 登记表第一项");
	assert.match(change, /if \(!acpToolId\) \{[\s\S]*?return;/, "空工具表必须拒绝切换");
	assert.match(change, /acpToolId \} : \{\}/, "updateRecord 必须带 acpToolId");
	// 二级选择回调：草稿期写 record.acpToolId
	const changeTool = source.slice(source.indexOf("const changeAcpTool"), source.indexOf("\n};", source.indexOf("const changeAcpTool")));
	assert.match(changeTool, /updateRecord\(sessionId, \{ acpToolId: toolId \}\)/, "changeAcpTool 写工具预选");
});

test("主进程：切到 acp 与 imagegen 同款甩开 pi 会话文件引用", () => {
	const source = read("src/main/ipc/sessionIpc.ts");
	assert.match(source, /patch\.backend === "imagegen" \|\| patch\.backend === "acp" \? \{ filePath: null, piSessionId: null \}/, "acp 切换必须清 filePath/piSessionId");
});

test("契约类型：UpdateSessionRecordInput 暴露 acpToolId 草稿期预选", () => {
	const source = read("src/shared/types/session.ts");
	assert.match(source, /acpToolId\?: string \| null;/, "UpdateSessionRecordInput 必须含 acpToolId");
});

test("纯函数：切 acp 模型清空（backendSwitchDefaults 非 pi 分支）", async () => {
	// 直接引用同目录既有测试已覆盖的行为，这里锁源码注释对 acp 的说明存在，
	// 防止后人把 acp 误加进「保留模型」分支。
	const source = read("src/renderer/src/utils/backendSwitchDefaults.ts");
	assert.match(source, /next !== "pi"/, "非 pi 后端一律清空模型（acp 含于其中）");
});
