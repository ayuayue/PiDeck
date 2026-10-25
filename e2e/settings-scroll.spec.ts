import { test, expect } from "./fixtures";
import { openSettings } from "./open-session";

/**
 * 设置弹窗内容区可滚动回归（pane Tabs 结构下高度链完整）：
 * 在「系统设置」分区任一长内容 tab（如视觉桥）内，内容超出时容器必须可滚动、
 * 不被 DialogContent 的 overflow:hidden 裁剪。
 */
test("设置弹窗内容区可滚动（pane Tabs 高度链回归）", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	await openSettings(window);
	const modal = window.locator(".settings-modal");
	await expect(modal).toBeVisible();

	// 切到「视觉桥」tab 并等待懒加载内容出现（懒加载失败 fallback 只有 loading 占位）
	await modal.getByText("视觉桥").click();
	await expect(modal.getByText("启用视觉桥", { exact: true })).toBeVisible({ timeout: 15_000 });

	// 从内容滚动容器向上遍历高度链，检查每一层是否有明确约束
	const info = await window.evaluate(() => {
		const content = document.querySelector('.settings-modal [data-slot="tabs-content"].settings-panel') as HTMLElement | null;
		if (!content) return { found: false, nodes: [] };
		const nodes: unknown[] = [];
		let el: HTMLElement | null = content;
		while (el && nodes.length < 12) {
			const s = getComputedStyle(el);
			nodes.push({
				cls: String(el.className).slice(0, 72),
				scrollHeight: el.scrollHeight,
				clientHeight: el.clientHeight,
				overflowY: s.overflowY,
				height: s.height,
				minHeight: s.minHeight,
				flex: s.flex,
				display: s.display,
				position: s.position,
			});
			if (s.position === "fixed") break;
			el = el.parentElement;
		}
		// 实际滚动能力：在内容区触发滚轮后检查 scrollTop 是否变化
		content.scrollTop = 0;
		const before = content.scrollHeight - content.clientHeight;
		content.scrollTop = Math.min(500, before);
		return { found: true, nodes, overflowable: before > 0, scrolledTo: content.scrollTop };
	});

	console.log("SCROLL-CHAIN", JSON.stringify(info, null, 2));
	expect(info.found).toBe(true);
	// 视觉桥内容很长（提示词 6 行 textarea + 运行日志等），必然超过视口
	expect(info.overflowable).toBe(true);
	// 内容区滚动容器自身必须有 auto 溢出；若某一层 ancestor 吃掉高度则 scrolledTo 为 0
	expect(info.scrolledTo).toBeGreaterThan(0);

	// 用户场景是「滚轮不滚」：把鼠标悬停到内容区中心后滚轮，验证真实滚动事件生效。
	// 用 role 精确定位视觉桥 tabpanel（imagegen 是 forceMount+hidden 常驻，class 也含 settings-panel）
	const panel = modal.getByRole("tabpanel", { name: "视觉桥" });
	const box = await panel.boundingBox();
	expect(box).not.toBeNull();
	await window.mouse.move(box!.x + box!.width / 2, box!.y + Math.min(120, box!.height / 2));
	const beforeWheel = await panel.evaluate((el) => (el as HTMLElement).scrollTop);
	await window.mouse.wheel(0, 600);
	await window.waitForTimeout(200);
	const afterWheel = await panel.evaluate((el) => (el as HTMLElement).scrollTop);
	console.log("WHEEL", { beforeWheel, afterWheel });
	expect(afterWheel).toBeGreaterThan(beforeWheel);
});
