import { expect, type Page } from "@playwright/test";

/**
 * 启动期自动浮层的统一处置（当前只有一个：「命令面板首次引导」）。
 *
 * 它会在项目激活后 2.5s 自动弹出，且用的是 Radix Dialog：
 * - 焦点域（FocusScope）会把焦点从输入框抢到弹窗按钮 → 随后的打字被吞（草稿被截断）；
 * - 全屏遮罩会拦住点击 → `locator.click` 超时并报 `... intercepts pointer events`。
 *
 * 这两条在 e2e 里都会伪装成业务失败（例如「消息没发出去」「按钮点不动」），
 * 而它们与业务无关，所以统一在这里处理，不让每个 spec 各自踩一遍。
 *
 * 手段是两件事一起做：
 * - localStorage 记账：阻止「已看过」再次调度（挡不住本轮已排定的定时器）；
 * - 页面内 MutationObserver：弹窗出现即点「以后再说」关掉（不等固定时长，避免竞态）。
 */
export async function armStartupOverlayDismissal(window: Page): Promise<boolean> {
	return window.evaluate(() => {
		try {
			localStorage.setItem("pideck:command-palette-onboarding", "1");
		} catch {
			/* 受限环境（localStorage 不可用）：忽略，下面的轮询仍能兜住 */
		}
		const dismiss = (): boolean => {
			const dialog = document.querySelector('[role="dialog"]');
			if (!dialog) return false;
			// 只点引导自己的关闭按钮，不误关别的弹窗（用例可能自己开弹窗）
			const button = Array.from(dialog.querySelectorAll("button")).find((item) => /以后再说|Later/.test(item.textContent ?? ""));
			if (!button) return false;
			button.click();
			return true;
		};
		// 用轮询而不是 MutationObserver：引导的弹出时机跟「项目激活」挂钩（activeProjectId 变真
		// 后 2.5s 才弹），可能落在用例中途；事件驱动会在“弹窗已在、后续无变更”时漏拍，
		// 轮询（100ms，只查一个选择器）不会。
		const timer = window.setInterval(() => {
			if (dismiss()) window.clearInterval(timer);
		}, 100);
		window.setTimeout(() => window.clearInterval(timer), 120_000);
		return dismiss();
	});
}

/**
 * 在 armStartupOverlayDismissal 之上再等到「启动期安静」。
 *
 * 需要严格时序的 spec（例如连续按方向键、要求焦点一直留在输入框）用这个：
 * 先让引导把该弹的弹完、关掉，再开始业务动作，避免它在本用例中途抢焦点。
 */
export async function settleStartupOverlays(window: Page): Promise<void> {
	await armStartupOverlayDismissal(window);
	let quietSince = 0;
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (
			await window
				.getByRole("dialog")
				.first()
				.isVisible()
				.catch(() => false)
		) {
			quietSince = 0;
			await window.waitForTimeout(150);
			continue;
		}
		if (!quietSince) quietSince = Date.now();
		if (Date.now() - quietSince > 1_500) return;
		await window.waitForTimeout(150);
	}
	// 超时也放行：本函数只负责减少噪声，不该让用例在这里挂掉
	expect.soft(quietSince, "启动浮层在 15s 内没有安静下来").toBeGreaterThan(0);
}
