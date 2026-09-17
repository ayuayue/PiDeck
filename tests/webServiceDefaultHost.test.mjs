import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 默认值三处来源 + manager 兜底都必须是环回，防止任何一条路径回到 0.0.0.0。
const DEFAULT_HOST_SOURCES = [
  "src/main/settings/SettingsStore.ts",
  "src/renderer/src/App.tsx",
  "src/renderer/src/previewApi.ts",
];

test("web service default host is loopback in every default-settings site", () => {
  for (const file of DEFAULT_HOST_SOURCES) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      /webServiceHost:\s*"0\.0\.0\.0"/,
      `${file} must not default webServiceHost to 0.0.0.0`,
    );
  }
  const managerSource = readFileSync(
    "src/main/web/WebServiceManager.ts",
    "utf8",
  );
  assert.doesNotMatch(
    managerSource,
    /\|\|\s*"0\.0\.0\.0"/,
    "manager fallback must be loopback too",
  );
});

test("WebServiceManager falls back to loopback when host setting is blank", async () => {
  const { WebServiceManager } = loadTsCommonJs(
    "src/main/web/WebServiceManager.ts",
    {
      globals: { fetch: globalThis.fetch },
    },
  );
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
    assert.equal(manager.current.host, "127.0.0.1");
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(response.status, 200);
  } finally {
    await manager.stop();
  }
});
