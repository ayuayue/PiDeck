import { useEffect, useState } from "react";
import type { AppSettings } from "../../../../../shared/types";
import { type WallpaperEngineItem, wallpaperEnginePlayability } from "../../../../../shared/wallpaperEngine";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { Button } from "../../ui-shadcn/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";

const NONE = "__none__";

/**
 * 用一个离屏 <video> 的 canPlayType 判断容器是否可播；不加入 DOM，不加载任何媒体。
 * 无 DOM（SSR 渲染测试）时一律视为 "maybe"，不误标为不支持。
 */
function canPlayTypeProbe(): (mime: string) => string {
	if (typeof document === "undefined") return () => "maybe";
	const probe = document.createElement("video");
	return (mime) => probe.canPlayType(mime);
}

/**
 * Wallpaper Engine 视频壁纸设置（第一期只列 type=video）。
 * 渲染层只拿到解析后的元数据（id/title/file/preview），视频本体由 pideck-we:// 协议播放。
 */
export function WallpaperEngineSection({ draft, updateDraft }: { draft: AppSettings; updateDraft: (patch: Partial<AppSettings>) => void }) {
	const dir = draft.weWorkshopDir ?? "";
	const [items, setItems] = useState<WallpaperEngineItem[]>([]);
	const [error, setError] = useState<string>("");

	const [canPlayType] = useState(canPlayTypeProbe);

	useEffect(() => {
		let cancelled = false;
		if (!dir) {
			setItems([]);
			setError("");
			return;
		}
		void desktopApi.dialog.listWallpaperEngine(dir).then((result) => {
			if (cancelled) return;
			setItems(result.items);
			setError(result.error === "unreadable" ? t("settings.wallpaperEngineUnreadable") : result.items.length === 0 ? t("settings.wallpaperEngineEmpty") : "");
		});
		return () => {
			cancelled = true;
		};
	}, [dir]);

	return (
		<div className="flex w-full flex-col gap-2">
			<div className="flex items-center gap-2">
				<span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={dir}>
					{dir || "—"}
				</span>
				<Button
					variant="outline"
					size="sm"
					onClick={async () => {
						const picked = await desktopApi.dialog.pickWallpaperEngineDir();
						if (picked) updateDraft({ weWorkshopDir: picked, weWallpaperId: "" });
					}}
				>
					{t("settings.wallpaperEngineChooseDir")}
				</Button>
			</div>
			{dir ? (
				<Select value={draft.weWallpaperId || NONE} onValueChange={(value) => updateDraft({ weWallpaperId: value === NONE ? "" : value })}>
					<SelectTrigger size="sm" aria-label={t("settings.wallpaperEngine")}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={NONE}>{t("settings.wallpaperEngineOff")}</SelectItem>
						{items.map((item) => {
							// 容器本身不可播（例如 mov 在此设备上没有解码器）：标注并禁用；mp4 内 HEVC 等只能播放时发现，由背景层回退
							const unsupported = wallpaperEnginePlayability(item.file, canPlayType) === "unsupported";
							return (
								<SelectItem key={item.id} value={item.id} disabled={unsupported && item.id !== draft.weWallpaperId}>
									{unsupported ? `${item.title} · ${t("settings.wallpaperEngineUnsupported")}` : item.title}
								</SelectItem>
							);
						})}
					</SelectContent>
				</Select>
			) : null}
			{error ? <span className="text-xs text-muted-foreground">{error}</span> : null}
		</div>
	);
}
