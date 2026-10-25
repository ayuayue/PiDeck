import { test, expect } from "./mock-pi-fixture";
import { makeSeedProject } from "./open-session";

const imageHistoryProject = makeSeedProject("imagegen-composer-layout");
const IMAGE_HISTORY_TITLE = "生图历史输入栏布局锚点";

/**
 * A persisted image-generation turn causes useSessionComposerController to lock
 * the composer into imagegen mode when the history is opened.
 */
test.use({
	seedProjects: [imageHistoryProject],
	seedImageGenConfig: {
		activeProviderId: "layout-provider",
		activeModel: "layout-model-with-a-long-name",
		providers: [
			{
				id: "layout-provider",
				name: "Layout test provider",
				baseUrl: "https://example.invalid/v1",
				apiKey: "test-key",
				models: ["layout-model-with-a-long-name"],
				extraParams: {
					size: true,
					output_format: true,
					watermark: true,
				},
			},
		],
	},
	seedSessionFiles: [
		{
			projectPath: imageHistoryProject.path,
			entries: [
				{
					type: "session",
					version: 3,
					id: "imagegen-layout-session",
					parentId: null,
					name: IMAGE_HISTORY_TITLE,
					cwd: imageHistoryProject.path,
					timestamp: new Date(Date.now() - 60_000).toISOString(),
				},
				{
					type: "message",
					id: "imagegen-layout-user",
					parentId: "imagegen-layout-session",
					timestamp: new Date(Date.now() - 59_000).toISOString(),
					message: {
						role: "user",
						content: [{ type: "text", text: "请生成一张用于布局测试的图片" }],
					},
				},
				{
					type: "message",
					id: "imagegen-layout-result",
					parentId: "imagegen-layout-user",
					timestamp: new Date(Date.now() - 58_000).toISOString(),
					message: {
						role: "assistant",
						content: [{ type: "text", text: "[imagegen]" }],
						api: "openai-images",
						imageGen: {
							status: "complete",
							prompt: "用于布局测试的图片",
							size: "1024x1024",
						},
					},
				},
			],
		},
	],
});

test("imagegen history keeps composer controls on one row in a narrow normal tab", async ({ app, window }) => {
	test.setTimeout(180_000);
	await app.evaluate(({ BrowserWindow }) => {
		const mainWindow = BrowserWindow.getAllWindows()[0];
		mainWindow?.setBounds({ width: 880, height: 680 });
	});
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await window.getByRole("tab", { name: "项目", exact: true }).click();

	const projectRow = window
		.locator(".conversation", {
			hasText: "pideck-seed-imagegen-composer-layout-",
		})
		.first();
	await expect(projectRow).toBeVisible({ timeout: 30_000 });
	await projectRow.click();

	const historyRow = window.locator(".conversation", { hasText: IMAGE_HISTORY_TITLE }).first();
	await expect(historyRow).toBeVisible({ timeout: 15_000 });
	await historyRow.click();
	await expect(window.locator(".composer .rich-input")).toHaveAttribute("contenteditable", "true", {
		timeout: 20_000,
	});

	const metrics = await window
		.locator(".composer-bottom-layout")
		.first()
		.evaluate((layout) => {
			const left = layout.querySelector<HTMLElement>(".composer-bottom-left");
			const center = layout.querySelector<HTMLElement>(".composer-bottom-center");
			const bar = layout.closest<HTMLElement>(".composer-bottom-bar");
			if (!left || !center || !bar) throw new Error("composer bottom bar is incomplete");
			return {
				leftHeight: Math.round(left.getBoundingClientRect().height),
				centerHeight: Math.round(center.getBoundingClientRect().height),
				barHeight: Math.round(bar.getBoundingClientRect().height),
			};
		});

	// Image-generation parameters must horizontally scroll or truncate at narrow
	// widths. Letting this group wrap makes ComposerMeasuredExtras grow the panel,
	// which is perceived as the input box jumping upward after history selection.
	expect(metrics.leftHeight).toBeLessThanOrEqual(30);
	expect(metrics.centerHeight).toBeLessThanOrEqual(30);
	expect(metrics.barHeight).toBeLessThanOrEqual(50);
});
