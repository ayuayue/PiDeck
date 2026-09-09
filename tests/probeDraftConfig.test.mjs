/**
 * probeDraftConfig 单测：测试连接的隔离探针目录文件构建。
 *
 * 背景：卡片 / 添加·编辑页的测试连接统一走「临时 agent 目录 + PI_CODING_AGENT_DIR」，
 * 测的是当前表单值，不落盘正式配置。断言：
 *  1. models.json 结构 = { providers: { name: provider } }，provider 原样保留；
 *  2. auth.json 只写待测 provider 的 key（不复制正式 auth.json，无 token 副本）；
 *  3. settings.json 仅在传入非空正式配置时复制（扩展供应商靠它加载）；
 *  4. WSL 路径转换（C:\xx → /mnt/c/xx，非 Windows 路径原样）；
 *  5. env 键名固定为 PI_CODING_AGENT_DIR（pi 实测值，防止改名漂移）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	buildProbeDraftFiles,
	PROBE_AGENT_DIR_ENV,
	toWslAccessiblePath,
} from "../src/main/pi/probeDraftConfig.ts";

test("buildProbeDraftFiles: models.json 顶包 providers 且 provider 原样写入", () => {
	const provider = {
		api: "openai-completions",
		baseUrl: "https://api.example.com/v1",
		models: [{ id: "m1", name: "M1" }],
	};
	const { modelsJson } = buildProbeDraftFiles("my-provider", provider, "sk-123");
	const parsed = JSON.parse(modelsJson);
	assert.deepEqual(parsed, { providers: { "my-provider": provider } });
});

test("buildProbeDraftFiles: 带 key 时 auth.json 写入 api_key 条目", () => {
	const { authJson } = buildProbeDraftFiles("p1", { models: [] }, "sk-secret");
	assert.deepEqual(JSON.parse(authJson), { p1: { type: "api_key", key: "sk-secret" } });
});

test("buildProbeDraftFiles: 无 key 时 auth.json 为空对象（pi 回退 models.json 内 key）", () => {
	const { authJson } = buildProbeDraftFiles("p1", { models: [] }, undefined);
	assert.deepEqual(JSON.parse(authJson), {});
});

test("buildProbeDraftFiles: 输出为格式化 JSON（可人工排查临时目录）", () => {
	const { modelsJson } = buildProbeDraftFiles("p1", { models: [] });
	assert.equal(modelsJson, '{\n  "providers": {\n    "p1": {\n      "models": []\n    }\n  }\n}');
});

test("buildProbeDraftFiles: 传 settings 时生成 settingsJson 副本（扩展供应商靠它加载）", () => {
	const settings = { enabledExtensions: ["some-extension"], theme: "dark" };
	const { settingsJson } = buildProbeDraftFiles("p1", { models: [] }, "sk-1", settings);
	assert.deepEqual(JSON.parse(settingsJson), settings);
});

test("buildProbeDraftFiles: settings 为空或未传时不生成 settingsJson", () => {
	assert.equal(buildProbeDraftFiles("p1", { models: [] }, "sk-1").settingsJson, undefined);
	assert.equal(buildProbeDraftFiles("p1", { models: [] }, "sk-1", {}).settingsJson, undefined);
});

test("buildProbeDraftFiles: auth.json 只含待测 provider 的 key，不复制正式 auth（无 token 副本）", () => {
	const { authJson } = buildProbeDraftFiles("p1", { models: [] }, "sk-only");
	const parsed = JSON.parse(authJson);
	assert.deepEqual(Object.keys(parsed), ["p1"]);
});

test("PROBE_AGENT_DIR_ENV 固定为 pi 实测的 PI_CODING_AGENT_DIR", () => {
	assert.equal(PROBE_AGENT_DIR_ENV, "PI_CODING_AGENT_DIR");
});

test("toWslAccessiblePath: Windows 绝对路径转 /mnt/<drive>，分隔符转 /", () => {
	assert.equal(toWslAccessiblePath("C:\\Users\\me\\tmp"), "/mnt/c/Users/me/tmp");
	assert.equal(toWslAccessiblePath("D:/work\\x"), "/mnt/d/work/x");
});

test("toWslAccessiblePath: 非 Windows 形式路径原样返回", () => {
	assert.equal(toWslAccessiblePath("/tmp/dir"), "/tmp/dir");
	assert.equal(toWslAccessiblePath("relative/path"), "relative/path");
});