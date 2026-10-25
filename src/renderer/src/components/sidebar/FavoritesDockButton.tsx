import { useAtomValue, useSetAtom } from "jotai";
import { Star } from "lucide-react";
import { favoritesModuleHiddenAtom } from "../../atoms/app-ui-atoms";
import { openFavoritesPageAtom } from "../../atoms/favorites-atoms";
import { t } from "../../i18n";

/**
 * 侧栏顶部动作区的「收藏」入口（智能体下方，与 AutomationDockButton / AgentMarketDockButton 同款行）。
 * 点击打开（或激活）会话 Tab 栏里的「收藏」页面 Tab；行内不放徽标——收藏没有「正在运行」这类状态。
 * 外观设置→功能模块里隐藏「收藏」：只摘掉本入口，已收藏快照不受影响（页面仍可经命令面板打开）。
 */
export function FavoritesDockButton() {
	const openFavoritesPage = useSetAtom(openFavoritesPageAtom);
	const hidden = useAtomValue(favoritesModuleHiddenAtom);
	if (hidden) return null;
	return (
		<button type="button" className="group flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-body text-foreground transition-colors hover:bg-bg-hover" aria-label={t("favorites.title")} title={t("favorites.title")} onClick={() => openFavoritesPage()}>
			<Star className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
			<span className="min-w-0 flex-1 truncate font-medium">{t("favorites.title")}</span>
		</button>
	);
}
