/**
 * 「获取模型成功后自动补 /v1」在新增/编辑供应商弹框里的接线测试（回归守卫）。
 *
 * 背景：检测侧（ConfigManager.fetchProviderModels）在 /v1/models 走通而用户 baseUrl
 * 不带版本路径时返回 suggestedBaseUrl；设置页展开卡片的 handleFetchModels 早已经
 * applySuggestedBaseUrl 应用它，但 AddProviderDialog 拿到结果后直接丢弃，
 * 用户在该弹框拉完模型保存后，models.json 里仍是不带 /v1 的根路径 → 会话 404。
 *
 * 断言：
 *  1. resolveFetchedBaseUrl 纯函数契约：建议地址去尾斜杠、只在真正不同时改写；
 *  2. AddProviderDialog.handleFetchModels 成功分支必须消费 suggestedBaseUrl 并写回草稿。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// loadTsCommonJs 在 vm 沙箱里执行模块，返回对象带沙箱侧原型，
// deepStrictEqual 会因「引用/原型不同」失败 —— 先 JSON 归一化再比较。
const plain = (value) => JSON.parse(JSON.stringify(value));

test("resolveFetchedBaseUrl：建议地址存在且不同于当前 → 改写（去尾斜杠）", () => {
	const { resolveFetchedBaseUrl } = loadTsCommonJs("src/renderer/src/config/addProviderDraft.ts", { stubs: {} });

	assert.deepEqual(plain(resolveFetchedBaseUrl("https://host.example", "https://host.example/v1")), {
		baseUrl: "https://host.example/v1",
		changed: true,
	});
	// 尾部斜杠不参与比较：实质相同 → 不改写，原样返回当前值
	assert.deepEqual(plain(resolveFetchedBaseUrl("https://host.example/v1/", "https://host.example/v1")), {
		baseUrl: "https://host.example/v1/",
		changed: false,
	});
});

test("resolveFetchedBaseUrl：无建议 / 建议为空 → 保持当前值", () => {
	const { resolveFetchedBaseUrl } = loadTsCommonJs("src/renderer/src/config/addProviderDraft.ts", { stubs: {} });

	assert.deepEqual(plain(resolveFetchedBaseUrl("https://host.example", undefined)), { baseUrl: "https://host.example", changed: false });
	assert.deepEqual(plain(resolveFetchedBaseUrl("https://host.example", "   ")), { baseUrl: "https://host.example", changed: false });
});

test("AddProviderDialog.handleFetchModels 必须消费 suggestedBaseUrl 写回草稿", () => {
	const source = readFileSync("src/renderer/src/config/AddProviderDialog.tsx", "utf8");
	// 空白容忍：定位成功分支，断言其中调用了 resolveFetchedBaseUrl 并 setBaseUrl
	const successBranch = source.match(/if\s*\(result\.success\s*&&\s*result\.models\)[\s\S]{0,600}?setFetching\(false\)/);
	assert.ok(successBranch, "未找到 handleFetchModels 成功分支");
	assert.match(successBranch[0], /resolveFetchedBaseUrl\s*\(/);
	assert.match(successBranch[0], /setBaseUrl\s*\(/);
});

test("ConfigModal 后台自动发现也必须消费 suggestedBaseUrl（补 /v1 不挑入口）", () => {
	const source = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
	// 后台发现是静默拉取（无 fetchModels 按钮路径）：成功分支里必须应用改写建议；
	// 用 discovered\[ 作锚点把它锚定到自动发现循环，而不是 handleFetchModels。
	const discoveryThen = source.match(/\.then\s*\(\s*\(result\)\s*=>\s*\{[\s\S]{0,400}?discovered\[providerName\][\s\S]{0,400}?\}\s*\)/);
	assert.ok(discoveryThen, "未找到后台自动发现的 .then(result) 分支");
	assert.match(discoveryThen[0], /applySuggestedBaseUrl\s*\(\s*providerName\s*,\s*result\.suggestedBaseUrl\s*\)/);
});
