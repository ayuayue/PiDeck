import { test, expect } from "./mock-pi-fixture";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
import type { PiDesktopApi } from "../src/preload";

test.beforeEach(async ({ window }) => {
	await window.addLocatorHandler(window.getByRole("heading", { name: "用命令面板直达任何设置", exact: true }), async () => {
		await window.getByRole("button", { name: "以后再说", exact: true }).click();
	});
});

test("DSH 添加页走真实 host 发现/保存，校验失败保留草稿，顶部保存生效", async ({ app, window }, testInfo) => {
	test.setTimeout(180_000);
	const archive = resolve("dist-runtime", `dsh-runtime-${process.platform}-${process.arch}.tgz`);
	expect(existsSync(archive), "Run npm run runtime:pack before the DSH integration test").toBe(true);
	await app.evaluate(({ dialog }, path) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
	}, archive);
	const installation = await window.evaluate(() => (window as unknown as { piDesktop: PiDesktopApi }).piDesktop.sessions.importDshRuntimeFile());
	expect(installation).toMatchObject({ ok: true });

	const requests: string[] = [];
	const endpoint = createServer((request, response) => {
		requests.push(request.url ?? "");
		response.setHeader("Content-Type", "application/json");
		response.end(JSON.stringify({ object: "list", data: [{ id: "e2e-model", object: "model", owned_by: "test" }] }));
	});
	await new Promise<void>((done) => endpoint.listen(0, "127.0.0.1", done));
	const address = endpoint.address();
	if (!address || typeof address === "string") throw new Error("Local model endpoint did not start");
	try {
		await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 25_000 });
		const config = window.locator(".settings-modal");
		if (!(await config.isVisible())) await window.getByRole("button", { name: "设置", exact: true }).click();
		await expect(config).toBeVisible();
		await config.getByRole("tab", { name: "配置管理", exact: true }).click();
		await config.getByRole("tab", { name: "DSH 配置管理", exact: true }).click();
		await config.getByRole("button", { name: "启动 host", exact: true }).click();
		const modelTab = config.getByRole("navigation", { name: "DSH 配置管理" }).getByRole("button", { name: "模型", exact: true });
		await expect(modelTab).toBeEnabled({ timeout: 35_000 });
		await modelTab.click();
		await config.getByRole("button", { name: "添加 provider", exact: true }).click();
		const page = config.locator(".provider-add-page");
		await expect(page).toContainText("credentials");
		await page.getByRole("textbox", { name: "供应商名称", exact: true }).fill("中文 DSH");
		await page.getByRole("textbox", { name: "Base URL", exact: true }).fill(`http://127.0.0.1:${address.port}/v1`);
		await page.locator("input[type=password]").fill("e2e-local-key");
		await page.getByText("先填写连接信息", { exact: false }).scrollIntoViewIfNeeded();
		await window.screenshot({ path: testInfo.outputPath("dsh-provider-hints.png") });
		await page.getByRole("button", { name: "获取模型列表", exact: true }).click();
		await page.getByRole("button", { name: "e2e-model", exact: true }).click();
		await page.getByRole("button", { name: "保存所选模型", exact: true }).click();
		const modelInput = page.getByPlaceholder("模型 ID", { exact: true });
		await expect(modelInput).toHaveValue("e2e-model", { timeout: 20_000 });
		expect(requests).toContain("/v1/models");
		await window.screenshot({ path: testInfo.outputPath("dsh-provider-add.png") });

		// 非整数容量不能提交；顶部保存也需说明校验失败，不能清掉草稿。
		await page.getByRole("button", { name: "容量（上下文窗口 / 最大输出）", exact: true }).click();
		const contextInput = page.locator("label").filter({ hasText: "上下文" }).locator("input");
		await contextInput.fill("1.5");
		await page.getByRole("textbox", { name: "供应商名称", exact: true }).click();
		await expect(page.getByRole("button", { name: "添加", exact: true })).toBeDisabled();
		await config.getByRole("button", { name: "保存", exact: true }).first().click();
		await expect(page.getByRole("alert")).toBeVisible({ timeout: 15_000 });
		await expect(page.getByRole("textbox", { name: "供应商名称", exact: true })).toHaveValue("中文 DSH");
		await expect(modelInput).toHaveValue("e2e-model");
		await contextInput.fill("128000");
		await page.getByRole("textbox", { name: "供应商名称", exact: true }).click();
		await config.getByRole("button", { name: "保存", exact: true }).first().click();
		await expect(page).toHaveCount(0, { timeout: 25_000 });
		const profile = await window.evaluate(async () => {
			const result = await (window as unknown as { piDesktop: PiDesktopApi }).piDesktop.sessions.describeDshSettings();
			const ns = result.namespaces.find((entry) => entry.ns === "llm-pi-ai");
			return (ns?.value as { providers?: Record<string, unknown> } | undefined)?.providers?.["中文 DSH"];
		});
		expect(profile).toMatchObject({ api: "openai-completions", baseURL: `http://127.0.0.1:${address.port}/v1`, models: [{ id: "e2e-model" }], apiKeyEnv: expect.stringMatching(/^[A-Za-z_][A-Za-z0-9_]*$/) });
		expect(JSON.stringify(profile)).not.toContain("e2e-local-key");
		const piProviders = await window.evaluate(async () => Object.keys((await (window as unknown as { piDesktop: PiDesktopApi }).piDesktop.config.getModels()).parsed.providers));
		expect(piProviders).not.toContain("中文 DSH");
		// 已存在的中文名仍被重复检查拦截。
		await config.getByRole("button", { name: "添加 provider", exact: true }).click();
		await page.getByRole("textbox", { name: "供应商名称", exact: true }).fill("中文 DSH");
		await expect(page.getByText("该供应商已存在", { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "返回", exact: true }).first().click();
	} finally {
		endpoint.closeAllConnections();
		await new Promise<void>((done, reject) => endpoint.close((error) => (error ? reject(error) : done())));
	}
});
