import { memo, useCallback, useRef, useState } from "react";
import { ImagePlus } from "lucide-react";
import type { AppSettings } from "../../../../../shared/types";
import { APP_DISPLAY_NAME_DEFAULT, APP_DISPLAY_NAME_MAX_LENGTH } from "../../../../../shared/types/settings";
import { t } from "../../../i18n";
import { readLogoImageFile } from "../../../utils/brandLogoImage";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { PiTuiLogoMark } from "../PiTuiLogo";
import { resolveLogoStyle } from "../piTuiLogoData";
import { DirtyMarker, SettingRow } from "./SettingRows";

type BrandingSectionProps = {
	draft: AppSettings;
	updateDraft: (patch: Partial<AppSettings>) => void;
	isDirty: (field: keyof AppSettings) => boolean;
};

/**
 * 品牌区设置行：Logo 风格（含自定义图片）+ 应用显示名称。
 *
 * 从 AppearanceTab 拆出来：主 tab 已接近单文件行数红线，而品牌这几行自带一处「选文件 → 缩图 → 写草稿」
 * 的异步状态，混在主题/字体堆里只会更难读。落点订阅走 atoms，这里只负责写草稿。
 */
export const BrandingSection = memo(function BrandingSection({ draft, updateDraft, isDirty }: BrandingSectionProps) {
	const customLogo = draft.logoCustomImage ?? "";
	const [readError, setReadError] = useState("");
	const fileInputRef = useRef<HTMLInputElement | null>(null);

	const handleFile = useCallback(
		async (file: File) => {
			setReadError("");
			try {
				updateDraft({ logoCustomImage: await readLogoImageFile(file) });
			} catch {
				// 读取/缩图失败只提示，不动已有设置——用户多半是选错了文件，清掉旧图反而更糟
				setReadError(t("settings.logoCustomImageFailed"));
			}
		},
		[updateDraft],
	);

	return (
		<>
			{/* Logo 风格：classic = PiDeck 现状四块拼图；pi-tui = pi 官方 TUI 三色像素标；custom = 自备图片。保存后所有 logo 落点即时切换。 */}
			<SettingRow
				title={
					<>
						<span>{t("settings.logoStyle")}</span>
						<DirtyMarker dirty={isDirty("logoStyle")} label={t("settings.logoStyle")} />
					</>
				}
				description={t("settings.logoStyleDesc")}
			>
				<Select
					value={resolveLogoStyle(draft.logoStyle)}
					onValueChange={(value) => {
						// 收窄到三档字面量再写草稿：Select 回调只给 string，不用 as 绕过类型
						if (value === "classic" || value === "pi-tui" || value === "custom") updateDraft({ logoStyle: value });
					}}
				>
					<SelectTrigger className="w-44">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="classic">
							<span className="flex items-center gap-2">
								{/* 经典银灰标需要黑底承托，不能直接放在浅色菜单上；保留完整 π 轮廓与镂空。 */}
								<svg viewBox="140 140 520 520" width="16" height="16" className="size-4 shrink-0 rounded-xs bg-black p-px" aria-hidden="true" shapeRendering="crispEdges">
									<path fill="#f4f4f5" fillRule="evenodd" d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z" />
									<path fill="#a7a8ab" d="M517.36 400H634.72V634.72H517.36Z" />
								</svg>
								<span>{t("settings.logoStyleClassic")}</span>
							</span>
						</SelectItem>
						<SelectItem value="pi-tui">
							<span className="flex items-center gap-2">
								<PiTuiLogoMark size={16} />
								<span>{t("settings.logoStylePiTui")}</span>
							</span>
						</SelectItem>
						<SelectItem value="custom">
							<span className="flex items-center gap-2">
								{/* 已选过图就把缩略图放进选项里，选项预览仍只反映「选了哪张图」，不随草稿/已存风格变 */}
								{customLogo ? <img src={customLogo} alt="" className="size-4 shrink-0 rounded-xs object-contain" /> : <ImagePlus className="size-4 shrink-0" aria-hidden="true" />}
								<span>{t("settings.logoStyleCustom")}</span>
							</span>
						</SelectItem>
					</SelectContent>
				</Select>
			</SettingRow>
			{draft.logoStyle === "custom" && (
				<SettingRow
					title={
						<>
							<span>{t("settings.logoCustomImage")}</span>
							<DirtyMarker dirty={isDirty("logoCustomImage")} label={t("settings.logoCustomImage")} />
						</>
					}
					description={t("settings.logoCustomImageDesc")}
					stacked
				>
					<div className="flex flex-wrap items-center gap-2">
						{/* 预览不垫底色：与 LogoMark 的 custom 分支一致（自定义图自带外形，不套黑底），所见即所得 */}
						{customLogo ? <img src={customLogo} alt="" className="size-12 shrink-0 rounded-sm border border-border object-contain" /> : <div className="flex size-12 shrink-0 items-center justify-center rounded-sm border border-dashed border-border text-micro text-muted-foreground">—</div>}
						<Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
							{t("settings.logoCustomImageChoose")}
						</Button>
						{customLogo ? (
							<Button variant="ghost" size="sm" onClick={() => updateDraft({ logoCustomImage: "" })}>
								{t("settings.logoCustomImageClear")}
							</Button>
						) : null}
						<input
							ref={fileInputRef}
							type="file"
							accept="image/png,image/jpeg,image/webp,image/svg+xml,image/avif,image/x-icon"
							className="hidden"
							onChange={(event) => {
								const file = event.target.files?.[0];
								if (file) void handleFile(file);
								event.target.value = ""; // 重置以复选同一文件
							}}
						/>
					</div>
					{readError ? <p className="text-xs text-danger">{readError}</p> : null}
				</SettingRow>
			)}
			{/* 显示名是短文本（≤24 字）：用普通行放进右侧控件列，与上方主题/Logo 风格同一列对齐，不占满整行（stacked 只留给 textarea 这类超长控件） */}
			<SettingRow
				title={
					<>
						<span>{t("settings.appDisplayName")}</span>
						<DirtyMarker dirty={isDirty("appDisplayName")} label={t("settings.appDisplayName")} />
					</>
				}
				description={t("settings.appDisplayNameDesc")}
				alignEnd={false}
			>
				<Input type="text" value={draft.appDisplayName ?? ""} maxLength={APP_DISPLAY_NAME_MAX_LENGTH} placeholder={APP_DISPLAY_NAME_DEFAULT} onChange={(event) => updateDraft({ appDisplayName: event.target.value })} aria-label={t("settings.appDisplayName")} />
			</SettingRow>
		</>
	);
});
