import { useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { closeFavoritesPageAtom, favoriteDetailOpenAtom, favoritesPageOpenAtom } from "../../atoms/favorites-atoms";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { FavoritesWorkspace } from "./FavoritesWorkspace";

/**
 * 「收藏」页面宿主：会话 Tab 栏里的专属页面 Tab（不是弹窗、也不是会话 Tab）。
 *
 * 与 AgentMarketPage 同一生命周期约定：切到会话只是失活（子树保持挂载，搜索/滚动状态不丢），
 * 关闭 Tab 才卸载；Esc 只由当前呈现的页面响应，Radix 弹层自己消费的 Esc 不抢。
 */
export function FavoritesPage(props: { active: boolean }) {
	const open = useAtomValue(favoritesPageOpenAtom);
	const detailOpen = useAtomValue(favoriteDetailOpenAtom);
	const close = useSetAtom(closeFavoritesPageAtom);

	useEffect(() => {
		if (!open || !props.active) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			// 详情抽屉打开时 Esc 只关抽屉（抽屉自己的 window 监听负责），不连带关页面。
			if (detailOpen) return;
			close();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [close, detailOpen, open, props.active]);

	if (!open) return null;

	return (
		<div className={cn("absolute inset-0 z-30 flex flex-col bg-background", !props.active && "hidden")} role="region" aria-label={t("favorites.title")}>
			<FavoritesWorkspace />
		</div>
	);
}
