import { writeFileSync } from "node:fs";
import { test, expect } from "./mock-pi-fixture";
import { makeSeedProject, seedProjectsOption } from "./open-session";

const projects = [makeSeedProject("会话删除测试-A-很长的项目名称用于检查按钮重叠"), makeSeedProject("短项目")];
test.use({ seedProjects: seedProjectsOption(projects) });

test("project menu keeps title clearance when the pointer leaves the row", async ({ window }, testInfo) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await window.getByRole("tab", { name: "项目", exact: true }).click();
	const measurements: { project: string; overlap: number; padding: number; hovered: boolean; actionsOpacity: string }[] = [];
	for (const project of projects) {
		const row = window.locator(".project-group > .conversation", { hasText: project.name });
		await expect(row).toBeVisible();
		await row.hover();
		await expect
			.poll(() =>
				row.evaluate((element) => {
					const actions = element.querySelector(":scope > div:last-child");
					if (!actions) throw new Error("missing project actions");
					return getComputedStyle(actions).opacity;
				}),
			)
			.toBe("1");
		await row.getByRole("button", { name: "更多操作", exact: true }).click();
		await expect(window.getByRole("menu")).toBeVisible();
		await window.mouse.move(900, 650);
		// 等旧 padding 过渡结束，避免只采到鼠标移出瞬间的上一帧。
		await window.waitForTimeout(300);
		const geometry = await row.evaluate((element) => {
			const text = element.querySelector("strong");
			const body = element.querySelector(".conversation-body");
			const actions = element.querySelector(":scope > div:last-child");
			if (!text || !body || !actions) throw new Error("missing project row layout elements");
			return { overlap: Math.max(0, text.getBoundingClientRect().right - actions.getBoundingClientRect().left), padding: parseFloat(getComputedStyle(body).paddingRight), hovered: element.matches(":hover"), actionsOpacity: getComputedStyle(actions).opacity };
		});
		measurements.push({ project: project.name, ...geometry });
		await row.screenshot({ path: testInfo.outputPath(project === projects[0] ? "long-menu-open.png" : "short-menu-open.png") });
		await window.keyboard.press("Escape");
	}
	writeFileSync(testInfo.outputPath("project-menu-geometry.json"), JSON.stringify(measurements, null, 2), "utf8");
	for (const sample of measurements) {
		expect(sample.hovered).toBe(false);
		expect(sample.actionsOpacity).toBe("1");
		expect(sample.overlap, `title overlaps pinned menu actions: ${JSON.stringify(sample)}`).toBe(0);
		expect(sample.padding).toBe(88);
	}
});
