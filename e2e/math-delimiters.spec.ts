import { test, expect } from "./mock-pi-fixture";

/** Real Electron + mock stdio smoke: exercises streaming and settled formula DOM. */
test("bracket formulas render in Electron", async ({ window }, testInfo) => {
	test.setTimeout(120_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 30_000 });
	const composer = window.getByRole("textbox").first();
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	await composer.fill(
		"MATH_REPRO\n" +
			String.raw`因此，\(9+12=\boxed{21}\) 个一定满足要求。

| 数量 | 说明 |
| --- | --- |
| \(0\le s\le4\) | 第一种 |
| \(5\le s\le11\) | 第二种 |
| \(12\le s\le17\) | 第三种 |

\[x^2+y^2=z^2\] 后续正文保持完整。

答案：\(\boxed{21\text{ 个}}\)

代码保持源码：` +
			"`\\(x\\)`\n\n验证完成。",
	);
	await window.keyboard.press("Enter");
	const timeline = window.locator(".message-timeline");
	await expect(timeline.locator(".katex").first()).toBeVisible({ timeout: 30_000 });
	await expect(timeline).toContainText("验证完成。", { timeout: 30_000 });
	await expect(timeline.locator("td .katex")).toHaveCount(3);
	await expect(timeline.locator(".katex-display")).toHaveCount(1);
	await expect(timeline.locator("code").filter({ hasText: String.raw`\(x\)` })).toBeVisible();
	const later = window.getByRole("button", { name: "以后再说", exact: true });
	if (await later.isVisible()) await later.click();
	await expect(timeline.locator(".katex-error")).toHaveCount(0);
	await window.screenshot({ path: testInfo.outputPath("math-desktop.png") });
	await window.setViewportSize({ width: 900, height: 760 });
	await expect(timeline.locator(".katex").first()).toBeVisible();
	await window.screenshot({ path: testInfo.outputPath("math-narrow.png") });
	await window.getByRole("button", { name: /^主题：/ }).click();
	await expect(timeline.locator(".katex").first()).toBeVisible();
	await window.screenshot({ path: testInfo.outputPath("math-theme.png") });
	await window.reload();
	await window.getByRole("button", { name: /^空闲 MATH_REPRO/ }).click();
	await expect(window.locator(".message-timeline td .katex")).toHaveCount(3, { timeout: 30_000 });
	await expect(window.locator(".message-timeline .katex-error")).toHaveCount(0);
	await window.screenshot({ path: testInfo.outputPath("math-history.png") });
});
