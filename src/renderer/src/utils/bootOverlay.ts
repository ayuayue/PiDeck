/**
 * 启动遮罩（index.html 的 `#boot-overlay`）撤除入口。
 *
 * 撤除时机是这里唯一的语义：**必须等工作区知道自己该显示什么之后再撤**。
 * 冷启动首帧 `currentSessionIdAtom` / `sessionTabIdsAtom` 都还是空（会话与 tab
 * 列表由 IPC 异步恢复，实测挂载后约 200ms 才落地），此刻工作区渲染的是无会话
 * 分支——`ProjectEmptyState`（引导页）。按挂载帧立即撤遮罩会把这帧暴露给用户，
 * 表现为「启动闪一下引导页，随后变成正常会话」。
 *
 * 所以 main.tsx 挂载时不再撤除（只保留硬兜底超时，防止工作台被永久遮挡），
 * 正常路径由内容就绪信号触发：`hooks/app/useBootOverlayReady.ts`。
 * 本函数幂等：重复调用只生效一次。
 */
export function dismissBootOverlay(): void {
	const overlay = document.getElementById("boot-overlay");
	if (!overlay) return;
	if (overlay.dataset.dismissing === "true") return;
	overlay.dataset.dismissing = "true";

	let removed = false;
	const removeOverlay = () => {
		if (removed) return;
		removed = true;
		overlay.remove();
	};

	overlay.classList.add("fade-out");
	// 过渡结束后从 DOM 移除覆盖层，释放层级上下文。
	overlay.addEventListener("transitionend", removeOverlay, { once: true });
	// 兜底：某些环境下 transitionend 可能不触发。
	window.setTimeout(removeOverlay, 700);
}
