import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 默认值三处来源 + manager 兜底都必须是 0.0.0.0，确保任意路径默认对外可访问。
const DEFAULT_HOST_SOURCES = ["src/main/settings/SettingsStore.ts", "src/shared/types/settings.ts", "src/renderer/src/previewApi.ts"];

test("web service default host is 0.0.0.0 in every default-settings site", () => {
	for (const file of DEFAULT_HOST_SOURCES) {
		const source = readFileSync(file, "utf8");
		assert.match(source, /webServiceHost:\s*"0\.0\.0\.0"/, `${file} must default webServiceHost to 0.0.0.0`);
	}
	const managerSource = readFileSync("src/main/web/WebServiceManager.ts", "utf8");
	assert.match(managerSource, /normalizeWebHost\(/, "manager must route host through normalizeWebHost");
	assert.doesNotMatch(managerSource, /127\.0\.0\.1/, "manager must not hard-code 127.0.0.1 fallback");
});

test("WebServiceManager falls back to 0.0.0.0 when host setting is blank", async () => {
	const { WebServiceManager } = loadTsCommonJs("src/main/web/WebServiceManager.ts", {
		globals: { fetch: globalThis.fetch },
	});
	const manager = new WebServiceManager({
		subscribePiEvents: () => () => undefined,
	});
	// 先随机端口起一次拿可用端口，再走 applySettings 的空 host 兜底路径复用该端口。
	await manager.start("127.0.0.1", 0);
	const port = manager.current.port;
	try {
		await manager.applySettings({
			webServiceEnabled: true,
			webServiceHost: "  ",
			webServicePort: port,
		});
		assert.equal(manager.current.host, "0.0.0.0");
		const response = await fetch(`http://127.0.0.1:${port}/api/health`);
		assert.equal(response.status, 200);
	} finally {
		await manager.stop();
	}
});
