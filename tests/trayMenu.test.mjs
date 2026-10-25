/**
 * 托盘菜单模板（src/main/tray/trayMenuTemplate.ts）纯函数单测：
 * - 菜单结构顺序：版本行（disabled）→ 检查更新 → 显示窗口 → 最近项目 → 数据/日志目录 → 重启/退出；
 * - 最近项目截断上限 5，空项目显示占位 disabled 项；
 * - 项目 label 带尾段路径消歧；WSL/Linux 路径同样取尾段；
 * - 回调接线：每个菜单项 click 触发对应 callback；
 * - 双语文案经 copy 函数插值（version 占位符替换）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const loadPure = createTsSandbox();
const { buildTrayMenuTemplate, trayProjectLabel, TRAY_RECENT_PROJECTS_LIMIT } = loadPure("src/main/tray/trayMenuTemplate.ts");

/** 测试 copy 桩：返回 `key(params)` 便于断言键与插值。 */
function copyStub(key, params) {
	return params ? `${key}(${Object.values(params).join(",")})` : key;
}

function makeCallbacks() {
	const fired = [];
	return {
		fired,
		showWindow: () => fired.push("showWindow"),
		checkUpdate: () => fired.push("checkUpdate"),
		openProject: (id) => fired.push(`openProject:${id}`),
		openDataDir: () => fired.push("openDataDir"),
		openLogsDir: () => fired.push("openLogsDir"),
		restart: () => fired.push("restart"),
		quit: () => fired.push("quit"),
	};
}

test("菜单结构：版本行 disabled 居首，区块顺序与分隔符正确", () => {
	const template = buildTrayMenuTemplate(copyStub, "0.7.9", [], makeCallbacks());
	assert.equal(template[0].label, "tray.version(0.7.9)");
	assert.equal(template[0].enabled, false, "版本行只读展示，不可点击");
	assert.equal(template[1].label, "tray.checkUpdate");
	assert.equal(template[2].type, "separator");
	assert.equal(template[3].label, "tray.showWindow");
	assert.equal(template[4].type, "separator");
	// 空项目占位 + 分隔符 + 两个目录 + 分隔符 + 重启 + 退出
	assert.equal(template[5].label, "tray.noProjects");
	assert.equal(template[5].enabled, false);
	assert.equal(template[6].type, "separator");
	assert.equal(template[7].label, "tray.openDataDir");
	assert.equal(template[8].label, "tray.openLogsDir");
	assert.equal(template[9].type, "separator");
	assert.equal(template[10].label, "tray.restart");
	assert.equal(template[11].label, "tray.quit");
	assert.equal(template.length, 12, "结构漂移会破坏此断言——新增区块时请同步");
});

test("最近项目：超过上限截断、顺序保持（置顶/最近打开优先由调用方排序保证）", () => {
	const projects = Array.from({ length: 8 }, (_, index) => ({ id: `p${index}`, name: `项目${index}`, path: `C:\\dev\\p${index}` }));
	const template = buildTrayMenuTemplate(copyStub, "0.7.9", projects, makeCallbacks());
	const projectItems = template.filter((item) => typeof item.click === "function" && item.label?.includes("项目"));
	assert.equal(projectItems.length, TRAY_RECENT_PROJECTS_LIMIT);
	assert.equal(projectItems.length, 5);
	assert.ok(projectItems[0].label.includes("项目0"), "首项保持调用方排序");
});

test("项目点击回调携带 projectId", () => {
	const callbacks = makeCallbacks();
	const template = buildTrayMenuTemplate(copyStub, "0.7.9", [{ id: "abc", name: "pi-desktop-dev", path: "C:/Users/x/pi-desktop-dev" }], callbacks);
	const projectItem = template.find((item) => item.label?.includes("pi-desktop-dev"));
	projectItem.click();
	assert.deepEqual(callbacks.fired, ["openProject:abc"]);
});

test("trayProjectLabel：尾段路径消歧；名称等于尾段时不重复；Linux 路径兼容", () => {
	assert.equal(trayProjectLabel({ id: "1", name: "api", path: "C:\\work\\api" }), "api");
	assert.equal(trayProjectLabel({ id: "2", name: "API 服务", path: "C:\\work\\api" }), "API 服务 · api");
	assert.equal(trayProjectLabel({ id: "3", name: "api", path: "/home/u/projects/api" }), "api");
	assert.equal(trayProjectLabel({ id: "4", name: "前端", path: "/home/u/projects/pideck-web" }), "前端 · pideck-web");
});

test("工具与退出区回调全部接线", () => {
	const callbacks = makeCallbacks();
	const template = buildTrayMenuTemplate(copyStub, "0.7.9", [], callbacks);
	const byLabel = (label) => template.find((item) => item.label === label);
	byLabel("tray.showWindow").click();
	byLabel("tray.checkUpdate").click();
	byLabel("tray.openDataDir").click();
	byLabel("tray.openLogsDir").click();
	byLabel("tray.restart").click();
	byLabel("tray.quit").click();
	assert.deepEqual(callbacks.fired, ["showWindow", "checkUpdate", "openDataDir", "openLogsDir", "restart", "quit"]);
});

test("双语插值：version 占位符按语言模板替换", () => {
	const zh = (key, params) => ({ "tray.version": `PiDeck v${params?.version ?? ""}` })[key];
	const en = (key, params) => ({ "tray.version": `PiDeck v${params?.version ?? ""}` })[key];
	assert.equal(buildTrayMenuTemplate(zh, "1.2.3", [], makeCallbacks())[0].label, "PiDeck v1.2.3");
	assert.equal(buildTrayMenuTemplate(en, "1.2.3", [], makeCallbacks())[0].label, "PiDeck v1.2.3");
});
