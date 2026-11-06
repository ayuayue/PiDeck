import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base, expect } from "./fixtures";

/**
 * 模型表渐进渲染窗口的 UI 链路（20 行窗口 + 继续加载）。
 *
 * 每行是「4 输入框 + Popover + 2 Dialog + 操作按钮」的重树：早先窗口取 100 行，
 * 几十行的供应商展开即全量挂载，点一下卡一下（WSL 配置里 56 模型的供应商实测）。
 * 这里用 26 个模型证明展开只挂前 20 行，其余走「继续加载」，行 index 语义不变。
 */

const MODEL_COUNT = 26;
const PROVIDER = "e2e-window-provider";

const test = base.extend({
	// 覆盖 userDataRoot：models.json 必须在 app 启动前落盘（app 依赖本 fixture，顺序有保障）。
	userDataRoot: async ({}, use) => {
		const dir = mkdtempSync(join(tmpdir(), "pideck-e2e-"));
		const agentDir = join(dir, ".pi", "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					[PROVIDER]: {
						baseUrl: "http://127.0.0.1:1/v1",
						models: Array.from({ length: MODEL_COUNT }, (_unused, index) => ({ id: `model-${index}`, name: `Model ${index}`, context: 4096, maxTokens: 1024 })),
					},
				},
			}),
		);
		await use(dir);
		await rm(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
	},
});

test("models table windows rows at 20 and extends on 继续加载", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await window.getByRole("button", { name: "设置" }).click();
	const settingsDialog = window.locator(".settings-modal");
	await expect(settingsDialog).toBeVisible();
	await settingsDialog.getByRole("tab", { name: "配置管理", exact: true }).click();
	const modal = settingsDialog.locator(".config-layout");
	await expect(modal).toBeVisible();

	// 展开种子供应商：折叠态没有表体，展开后只应挂载窗口内的行。
	const card = modal.locator(".config-provider-card", { hasText: PROVIDER });
	await expect(card).toBeVisible({ timeout: 15_000 });
	const table = card.locator(".config-model-table");
	await card.getByText(PROVIDER, { exact: true }).click();
	await expect(table).toBeVisible();
	await expect(table.locator("tbody tr")).toHaveCount(20);

	const loadMore = card.getByRole("button", { name: /继续加载/ });
	await expect(loadMore).toBeVisible();
	await loadMore.click();
	await expect(table.locator("tbody tr")).toHaveCount(MODEL_COUNT);
	await expect(card.getByRole("button", { name: /继续加载/ })).toHaveCount(0);
});
