import { expect, test } from "./mock-pi-fixture";

/**
 * 智能体市场批量删除：内置不可选、全选只作用于可删项、删完回到正常列表。
 *
 * 自定义智能体用真实 IPC 建（走主进程 AgentProfileStore），而不是 UI 一个个新建：
 * 批量删除关心的是选择态与删除链路，编辑器已有独立用例覆盖。
 */
test("智能体批量删除：跳过内置，删除自定义", async ({ window }) => {
	await window.evaluate(async () => {
		await window.piDesktop.agentProfiles.create({ name: "批量甲", description: "第一个", systemPrompt: "你是甲" });
		await window.piDesktop.agentProfiles.create({ name: "批量乙", description: "第二个", systemPrompt: "你是乙" });
	});

	await window.getByRole("button", { name: "智能体" }).click();
	await expect(window.getByRole("heading", { name: "智能体" })).toBeVisible();
	await expect(window.getByText("批量甲")).toBeVisible();

	await window.getByRole("button", { name: "批量", exact: true }).click();
	const bar = window.getByRole("group", { name: "批量选择" });
	await expect(bar).toBeVisible();

	// 内置智能体的复选框必须禁用（title 说明原因）
	const builtinCheckbox = window.getByRole("checkbox", { name: "内置智能体不可删除，可复制一份再修改", exact: true }).first();
	await expect(builtinCheckbox).toBeDisabled();

	await bar.getByRole("button", { name: "全选" }).click();
	await expect(bar.getByText("已选 2 项")).toBeVisible();

	await bar.getByRole("button", { name: "删除选中" }).click();
	const dialog = window.getByRole("alertdialog");
	await expect(dialog.getByText("批量删除智能体")).toBeVisible();
	await dialog.getByRole("button", { name: "删除" }).click();

	await expect(window.getByText("批量甲")).toHaveCount(0);
	await expect(window.getByText("批量乙")).toHaveCount(0);
	await expect(window.getByRole("group", { name: "批量选择" })).toHaveCount(0);
	// 内置智能体仍在列表里（批量框没把它算进去）
	await expect(window.getByText("翻译官").first()).toBeVisible();
});
