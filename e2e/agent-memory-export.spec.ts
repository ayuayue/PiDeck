import { test, expect } from "./mock-pi-fixture";

/**
 * 记忆导出弹窗（issue #481）：条目数随记忆量增长，列表必须走虚拟滚动。
 *
 * 守两件事：
 * 1. 教训（failure）条目确实在可导出范围内——导出不是只覆盖「通用记忆」；
 * 2. 长列表只挂载视口附近的行（虚拟化接线正确），且滚到底能勾到最后一条
 *    （接线错时 VirtualStack 视口恒 0，一行都不渲染——这条断言就是防它）。
 */

const DELIMITER = "\n§\n";
const memoryEntries = Array.from({ length: 60 }, (_, index) => `全局记忆条目 ${index + 1}`);
const failureEntries = Array.from({ length: 6 }, (_, index) => `[failure] 教训条目 ${index + 1}`);

test.use({
	seedMemoryFiles: {
		"MEMORY.md": `${memoryEntries.join(DELIMITER)}\n`,
		"failures.md": `${failureEntries.join(DELIMITER)}\n`,
		"USER.md": `用户偏好条目 1${DELIMITER}用户偏好条目 2\n`,
	},
});

test("导出弹窗：长列表虚拟滚动，教训条目同样在可导出范围", async ({ window }) => {
	test.setTimeout(150_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	await window.getByRole("button", { name: "设置" }).click();
	const settings = window.locator(".settings-modal");
	await expect(settings).toBeVisible();
	await settings.getByRole("tab", { name: "记忆", exact: true }).click();
	await settings.getByRole("button", { name: "导出", exact: true }).click();

	const exportDialog = window.getByTestId("agent-memory-export-dialog");
	await expect(exportDialog).toBeVisible();

	// 1. 教训条目在可导出范围内：汇总行按 target 给出条数，而不是只列「通用记忆」。
	await expect(exportDialog.getByText(/^教训\s*6$/)).toBeVisible();

	// 2. 虚拟化：71 行（3 个分组 + 68 条）只挂视口附近的一部分。
	const stack = exportDialog.locator("[data-virtual-stack]");
	await expect(stack).toBeVisible();
	const mounted = await exportDialog.locator("[data-virtual-stack] [data-index]").count();
	expect(mounted).toBeGreaterThan(0);
	expect(mounted).toBeLessThan(40);

	// 3. 滚到底能到最后一条教训（行高实测 + 容器接线正确）。
	await stack.evaluate((element) => {
		const scroller = element.parentElement;
		if (scroller) scroller.scrollTop = scroller.scrollHeight;
	});
	await expect(exportDialog.getByText("教训条目 6", { exact: false })).toBeVisible();
});
