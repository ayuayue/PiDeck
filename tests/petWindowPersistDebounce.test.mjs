/**
 * PetWindow.moveTo 持久化防抖契约。
 *
 * 背景（2027-02）：PetPatrol 巡游每 50ms tick 调一次 moveTo（PetPatrol.ts tickMs=50），
 * 而 moveTo 曾在方法体末尾直接 `void savePos(...)` —— 完全绕过 moved 事件里精心设计的
 * 400ms 防抖（PetWindow.ts「moved 高频触发…防抖 400ms 合并写盘」），巡游 30 秒 =
 * 600 次磁盘写（含 mkdir + JSON 序列化），与防抖注释自相矛盾。
 *
 * 契约：moveTo 只能把位置交给统一防抖路径（schedulePersistPosition → pendingPos +
 * 400ms timer），不得在方法体内直接 savePos 落盘。destroy() 已有 pendingPos 兜底落盘，
 * 语义不丢失——最后一次位置最迟在 destroy / 400ms 防抖窗口后持久化。
 */
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync("src/main/pet/PetWindow.ts", "utf8");

/** 提取某个方法体（tab 一级缩进的方法声明到配对的闭合大括号）。 */
function extractMethodBody(name) {
	const pattern = new RegExp(`\\n\\t(?:private |readonly |async )?${name}\\([^)]*\\)\\s*(:\\s*[^{]*)?\\{([\\s\\S]*?)\\n\\t\\}`);
	const match = source.match(pattern);
	return match ? match[2] : null;
}

test("契约: PetWindow 存在统一防抖持久化路径 schedulePersistPosition", () => {
	assert.ok(/schedulePersistPosition\(\s*pos:\s*\{\s*x:\s*number;\s*y:\s*number\s*\}\s*\)/.test(source), "PetWindow.ts 缺少 schedulePersistPosition(pos) 私有方法：moveTo 与 moved 事件应共用同一条 400ms 防抖持久化路径。");
});

test("契约: moveTo 不得直接落盘，必须走防抖路径", () => {
	const body = extractMethodBody("moveTo");
	assert.ok(body, "未能从 PetWindow.ts 解析出 moveTo 方法体，正则契约需维护。");
	assert.ok(!body.includes("void savePos("), "moveTo 方法体内出现直接 savePos 落盘：巡游 tick（50ms）会把写盘频率放大到 20 次/秒，" + "绕过 400ms 防抖。应改为 schedulePersistPosition（pendingPos + 防抖 timer，destroy 有兜底落盘）。");
	assert.ok(body.includes("schedulePersistPosition("), "moveTo 应调用 schedulePersistPosition 走统一防抖路径。");
});

test("契约: moved 事件与 moveTo 共用同一条防抖路径", () => {
	const body = extractMethodBody("schedulePersistPosition");
	assert.ok(body, "未能从 PetWindow.ts 解析出 schedulePersistPosition 方法体，正则契约需维护。");
	assert.ok(body.includes("this.pendingPos"), "schedulePersistPosition 必须更新 pendingPos（destroy 兜底依赖它）。");
	assert.ok(/saveTimer|setTimeout/.test(body), "schedulePersistPosition 必须含防抖 timer。");
	const movedIndex = source.indexOf('this.win.on("moved"');
	assert.ok(movedIndex >= 0, "未能定位 moved 事件处理器，正则契约需维护。");
	const movedSlice = source.slice(movedIndex, movedIndex + 700);
	assert.ok(movedSlice.includes("schedulePersistPosition("), "moved 事件处理器应改用 schedulePersistPosition 统一路径。");
});
