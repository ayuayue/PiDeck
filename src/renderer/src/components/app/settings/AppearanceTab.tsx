import { memo } from "react";
import type { AppSettings } from "../../../../../shared/types";
import type { AppSkinId } from "../../../../../shared/types/settings";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { SKIN_PRESETS } from "../../../themePresets";
import { clampSessionTabMaxWidth, SESSION_TAB_MAX_WIDTH_MAX, SESSION_TAB_MAX_WIDTH_MIN } from "../../../../../shared/sessionTabWidth";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { SettingsSection } from "./SettingsStorageTab";
import { DirtyMarker, SettingRow, SettingSwitchRow } from "./SettingRows";
import { Check, Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

const ZOOM_FACTOR_MIN = 0.8;
const ZOOM_FACTOR_MAX = 1.5;
const ZOOM_FACTOR_STEP = 0.05;

type AppearanceTabProps = {
	draft: AppSettings;
	updateDraft: (patch: Partial<AppSettings>) => void;
	isDirty: (field: keyof AppSettings) => boolean;
	/** 是否启用了分区字号（任一区域字号非空） */
	perAreaFontSize: boolean;
	setPerAreaFontSize: (checked: boolean) => void;
};

/** 下拉选项：disabled 可选（SelectItem 透传） */
type SelectOption = { value: string; label: string; disabled?: boolean };

/**
 * 设置弹框「外观设置」tab：主题/背景/字体/聊天排版/窗口样式。
 * 独立组件 + memo：切换 tab 或壳层无关状态变化时不重渲染本 tab。
 */
export const AppearanceTab = memo(function AppearanceTab(props: AppearanceTabProps) {
	const { draft, updateDraft, isDirty } = props;
	const themeOptions: SelectOption[] = [
		{ value: "system", label: t("settings.themeSystem") },
		{ value: "schedule", label: t("settings.themeSchedule") },
		{ value: "light", label: t("settings.themeLight") },
		{ value: "dark", label: t("settings.themeDark") },
	];
	// 主题色预设来自 themePresets.ts；外观主题选择器中每套主题自带推荐主色，
	// 保留 ACCENT_PRESETS 仅供自定义主题参考（无独立主色下拉）。
	const fontSizeOptions: SelectOption[] = [
		{ value: "compact", label: t("settings.fontSizeCompact") },
		{ value: "default", label: t("settings.fontSizeDefault") },
		{ value: "medium", label: t("settings.fontSizeMedium") },
		{ value: "large", label: t("settings.fontSizeLarge") },
		{ value: "xlarge", label: t("settings.fontSizeXlarge") },
	];
	const fontBaseOptions: SelectOption[] = [
		{ value: "system", label: t("settings.fontFamilyBaseSystem") },
		{ value: "sans", label: t("settings.fontFamilyBaseSans") },
		{ value: "serif", label: t("settings.fontFamilyBaseSerif") },
		{ value: "custom", label: t("settings.fontCustomOption") },
	];
	const fontMonoOptions: SelectOption[] = [
		{ value: "system-mono", label: t("settings.fontFamilyMonoSystemMono") },
		{ value: "custom", label: t("settings.fontCustomOption") },
	];

	const changeZoomFactor = (delta: number) => {
		const next = Math.min(ZOOM_FACTOR_MAX, Math.max(ZOOM_FACTOR_MIN, Math.round((draft.zoomFactor + delta) * 100) / 100));
		updateDraft({ zoomFactor: next });
	};

	return (
		<>
			{/* 主题与背景 */}
			<SettingsSection title={t("settings.sectionThemeBackground")}>
				<SettingRow
					title={
						<>
							<span>{t("settings.theme")}</span>
							<DirtyMarker dirty={isDirty("theme")} label={t("settings.theme")} />
						</>
					}
					alignEnd={false}
				>
					<Select value={draft.theme} onValueChange={(value) => updateDraft({ theme: value as AppSettings["theme"] })}>
						<SelectTrigger className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{themeOptions.map((option) => (
								<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingRow>
				{draft.theme === "schedule" && (
					<SettingRow
						title={
							<>
								<span>{t("settings.themeScheduleRange")}</span>
								<DirtyMarker dirty={isDirty("themeScheduleLightStart") || isDirty("themeScheduleDarkStart")} label={t("settings.themeScheduleRange")} />
							</>
						}
						description={t("settings.themeScheduleRangeDesc")}
						alignEnd={false}
					>
						<div className="flex items-center gap-1.5">
							<Input type="time" className="w-[112px] shrink-0" value={draft.themeScheduleLightStart} onChange={(event) => updateDraft({ themeScheduleLightStart: event.target.value })} aria-label={t("settings.themeScheduleLightStart")} />
							<span className="text-text-tertiary" aria-hidden="true">
								→
							</span>
							<Input type="time" className="w-[112px] shrink-0" value={draft.themeScheduleDarkStart} onChange={(event) => updateDraft({ themeScheduleDarkStart: event.target.value })} aria-label={t("settings.themeScheduleDarkStart")} />
						</div>
					</SettingRow>
				)}
				<SettingRow
					title={
						<>
							<span>{t("settings.accent")}</span>
							<DirtyMarker dirty={isDirty("themeSkin") || isDirty("accent")} label={t("settings.accent")} />
						</>
					}
					description={t("settings.accentDesc")}
					stacked
				>
					<AppearanceThemePicker
						value={draft.themeSkin}
						onPick={(id) => {
							const preset = SKIN_PRESETS.find((p) => p.id === id);
							// 外观主题自带推荐主色：选择主题时联动写入 accent，保证「一套主题 = 完整外观」
							updateDraft(preset ? { themeSkin: id, accent: preset.accent } : { themeSkin: id });
						}}
					/>
				</SettingRow>
				{/* 背景图片：pideck-bg:// 协议加载 userData/backgrounds/ 下文件 */}
				<SettingRow
					title={
						<>
							<span>{t("settings.backgroundImage")}</span>
							<DirtyMarker dirty={isDirty("backgroundImage") || isDirty("backgroundImageOpacity")} label={t("settings.backgroundImage")} />
						</>
					}
					description={t("settings.backgroundImageDesc")}
				>
					<div className="flex items-center gap-2">
						{draft.backgroundImage ? (
							<img src={`pideck-bg://local/${encodeURIComponent(draft.backgroundImage)}`} alt="" className="h-12 w-20 shrink-0 rounded-sm border border-border object-cover" />
						) : (
							<div className="flex h-12 w-20 shrink-0 items-center justify-center rounded-sm border border-dashed border-border text-[11px] text-muted-foreground">—</div>
						)}
						<Button
							variant="outline"
							size="sm"
							onClick={async () => {
								const name = await desktopApi.dialog.pickBackgroundImage();
								if (name) updateDraft({ backgroundImage: name });
							}}
						>
							{t("settings.backgroundImageChoose")}
						</Button>
						{draft.backgroundImage ? (
							<Button
								variant="ghost"
								size="sm"
								onClick={() => {
									const name = draft.backgroundImage;
									updateDraft({ backgroundImage: "" });
									if (name) void desktopApi.dialog.removeBackgroundImage(name);
								}}
							>
								{t("settings.backgroundImageClear")}
							</Button>
						) : null}
					</div>
				</SettingRow>
				<SettingRow anchor="appearance-background-image-opacity" title={<span>{t("settings.backgroundImageOpacity")}</span>}>
					<div className="flex w-full items-center gap-2">
						<input
							type="range"
							min={0}
							max={100}
							// 滑块与存储同语义=图片可见度（100%=图全显，0%=全遮罩），不再反转
							value={Math.round((draft.backgroundImageOpacity ?? 0.8) * 100)}
							onChange={(event) => updateDraft({ backgroundImageOpacity: Number(event.target.value) / 100 })}
							className="h-4 min-w-0 flex-1 accent-[var(--color-accent)]"
							aria-label={t("settings.backgroundImageOpacity")}
						/>
						<span className="w-10 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">{Math.round((draft.backgroundImageOpacity ?? 0.8) * 100)}%</span>
					</div>
				</SettingRow>
			</SettingsSection>

			{/* 字体 */}
			<SettingsSection title={t("settings.sectionFonts")}>
				{/* 窗口缩放：与字号设置同分组，避免「字变大」两个入口分散在不同分组；
           提示文案说明其与字号档位的区别（缩放=整体，字号=仅文字）。 */}
				<SettingRow
					title={
						<>
							<span>{t("settings.zoomFactor")}</span>
							<DirtyMarker dirty={isDirty("zoomFactor")} label={t("settings.zoomFactor")} />
						</>
					}
					description={t("settings.zoomFactorHint")}
				>
					<div className="flex items-center gap-2">
						<Button
							variant="ghost"
							size="icon"
							className="size-8 rounded-[6px] border border-border-subtle bg-bg-panel text-text-secondary hover:border-[var(--color-accent)] hover:bg-bg-active hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40"
							disabled={draft.zoomFactor <= ZOOM_FACTOR_MIN}
							onClick={() => changeZoomFactor(-ZOOM_FACTOR_STEP)}
							aria-label={t("settings.zoomOut")}
							title={t("settings.zoomOut")}
						>
							<Minus size={16} strokeWidth={2.2} aria-hidden="true" />
						</Button>
						<output className="min-w-8 text-center font-brand text-control font-semibold text-foreground" aria-live="polite">
							{Math.round(draft.zoomFactor * 100)}%
						</output>
						<Button
							variant="ghost"
							size="icon"
							className="size-8 rounded-[6px] border border-border-subtle bg-bg-panel text-text-secondary hover:border-[var(--color-accent)] hover:bg-bg-active hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40"
							disabled={draft.zoomFactor >= ZOOM_FACTOR_MAX}
							aria-label={t("settings.zoomIn")}
							title={t("settings.zoomIn")}
							onClick={() => changeZoomFactor(ZOOM_FACTOR_STEP)}
						>
							<Plus size={16} strokeWidth={2.2} aria-hidden="true" />
						</Button>
					</div>
				</SettingRow>
				<SettingRow
					title={
						<>
							<span>{t("settings.fontSize")}</span>
							<DirtyMarker dirty={isDirty("fontSize")} label={t("settings.fontSize")} />
						</>
					}
					alignEnd={false}
				>
					<Select value={draft.fontSize} onValueChange={(value) => updateDraft({ fontSize: value as AppSettings["fontSize"] })}>
						<SelectTrigger className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{fontSizeOptions.map((option) => (
								<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingRow>
				<SettingSwitchRow
					anchor="appearance-font-size-per-area"
					title={t("settings.fontSizePerArea")}
					description={t("settings.fontSizePerAreaDesc")}
					checked={props.perAreaFontSize}
					onChange={(checked) => {
						props.setPerAreaFontSize(checked);
						if (!checked) {
							updateDraft({ uiFontSize: null, chatFontSize: null, inputFontSize: null });
						}
					}}
				/>
				{props.perAreaFontSize && (
					<>
						<SettingRow
							title={
								<>
									<span>{t("settings.uiFontSize")}</span>
									<DirtyMarker dirty={isDirty("uiFontSize")} label={t("settings.uiFontSize")} />
								</>
							}
							alignEnd={false}
						>
							<Select value={draft.uiFontSize ?? draft.fontSize} onValueChange={(value) => updateDraft({ uiFontSize: value as AppSettings["uiFontSize"] })}>
								<SelectTrigger className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{fontSizeOptions.map((option) => (
										<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
											{option.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</SettingRow>
						<SettingRow
							title={
								<>
									<span>{t("settings.chatFontSize")}</span>
									<DirtyMarker dirty={isDirty("chatFontSize")} label={t("settings.chatFontSize")} />
								</>
							}
							alignEnd={false}
						>
							<Select value={draft.chatFontSize ?? draft.fontSize} onValueChange={(value) => updateDraft({ chatFontSize: value as AppSettings["chatFontSize"] })}>
								<SelectTrigger className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{fontSizeOptions.map((option) => (
										<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
											{option.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</SettingRow>
						<SettingRow
							title={
								<>
									<span>{t("settings.inputFontSize")}</span>
									<DirtyMarker dirty={isDirty("inputFontSize")} label={t("settings.inputFontSize")} />
								</>
							}
							alignEnd={false}
						>
							<Select value={draft.inputFontSize ?? draft.fontSize} onValueChange={(value) => updateDraft({ inputFontSize: value as AppSettings["inputFontSize"] })}>
								<SelectTrigger className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{fontSizeOptions.map((option) => (
										<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
											{option.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</SettingRow>
					</>
				)}
				<SettingRow
					title={
						<>
							<span>{t("settings.fontFamilyBase")}</span>
							<DirtyMarker dirty={isDirty("fontFamilyBase")} label={t("settings.fontFamilyBase")} />
						</>
					}
					alignEnd={false}
				>
					<Select value={draft.fontFamilyBase} onValueChange={(value) => updateDraft({ fontFamilyBase: value as AppSettings["fontFamilyBase"] })}>
						<SelectTrigger className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{fontBaseOptions.map((option) => (
								<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingRow>
				{draft.fontFamilyBase === "custom" && (
					<SettingRow title={<span>{t("settings.fontFamilyBaseCustomField")}</span>} stacked>
						<Input type="text" value={draft.fontFamilyBaseCustom} placeholder={t("settings.fontFamilyBaseCustomPlaceholder")} onChange={(event) => updateDraft({ fontFamilyBaseCustom: event.target.value })} />
					</SettingRow>
				)}
				<SettingRow
					title={
						<>
							<span>{t("settings.fontFamilyMono")}</span>
							<DirtyMarker dirty={isDirty("fontFamilyMono")} label={t("settings.fontFamilyMono")} />
						</>
					}
					alignEnd={false}
				>
					<Select value={draft.fontFamilyMono} onValueChange={(value) => updateDraft({ fontFamilyMono: value as AppSettings["fontFamilyMono"] })}>
						<SelectTrigger className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{fontMonoOptions.map((option) => (
								<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingRow>
				{draft.fontFamilyMono === "custom" && (
					<SettingRow title={<span>{t("settings.fontFamilyMonoCustomField")}</span>} stacked>
						<Input type="text" value={draft.fontFamilyMonoCustom} placeholder={t("settings.fontFamilyMonoCustomPlaceholder")} onChange={(event) => updateDraft({ fontFamilyMonoCustom: event.target.value })} />
					</SettingRow>
				)}
			</SettingsSection>

			{/* 聊天排版 */}
			<SettingsSection title={t("settings.sectionChatLayout")}>
				<SettingRow anchor="appearance-content-width" title={<span>{t("settings.contentWidthPct")}</span>} description={t("settings.contentWidthPctDesc")}>
					<div className="flex w-full items-center gap-2">
						<input type="range" min="60" max="100" step="1" value={draft.chatContentWidthPct} onChange={(event) => updateDraft({ chatContentWidthPct: parseInt(event.target.value) })} className="min-w-0 flex-1 accent-[var(--color-accent)]" aria-label={t("settings.contentWidthPct")} />
						<span className="min-w-8 shrink-0 text-right font-brand text-sm text-muted-foreground tabular-nums">{draft.chatContentWidthPct}%</span>
					</div>
				</SettingRow>
			</SettingsSection>

			{/* 窗口样式 */}
			<SettingsSection title={t("settings.sectionWindowStyle")}>
				{/* 会话 Tab 宽度上限：仅封顶不设最小宽，Tab 仍按内容收缩；拖动时先本地夹取预览，保存时主进程再归一化。 */}
				<SettingRow anchor="appearance-session-tab-width" title={<span>{t("settings.sessionTabMaxWidth")}</span>} description={t("settings.sessionTabMaxWidthDesc")}>
					<div className="flex w-full items-center gap-2">
						<input
							type="range"
							min={SESSION_TAB_MAX_WIDTH_MIN}
							max={SESSION_TAB_MAX_WIDTH_MAX}
							step="4"
							value={draft.sessionTabMaxWidth}
							onChange={(event) => updateDraft({ sessionTabMaxWidth: clampSessionTabMaxWidth(parseInt(event.target.value)) })}
							className="min-w-0 flex-1 accent-[var(--color-accent)]"
							aria-label={t("settings.sessionTabMaxWidth")}
						/>
						<span className="min-w-12 shrink-0 text-right font-brand text-sm text-muted-foreground tabular-nums">{draft.sessionTabMaxWidth}px</span>
					</div>
				</SettingRow>
				<SettingSwitchRow anchor="appearance-native-title-bar" title={t("settings.nativeTitleBar")} checked={draft.useNativeTitleBar} onChange={(checked) => updateDraft({ useNativeTitleBar: checked })} />
				<SettingSwitchRow anchor="appearance-native-menu" title={t("settings.nativeMenu")} checked={draft.showNativeMenu} onChange={(checked) => updateDraft({ showNativeMenu: checked })} />
			</SettingsSection>
		</>
	);
});

/**
 * 外观主题选择器：每个主题一张色板预览卡（背景/侧栏/面板/主色/边框五色块），
 * 选中态用主色描边 + 勾选标记。选择即联动写入 themeSkin + 主题自带主色 accent
 * （值更新在父级 AppearanceTab 的 onPick 中完成）。
 * custom 主题没有内置色板（由 customThemeOverrides 驱动），仅当当前值为 custom 时
 * 显示一个占位卡，避免选中状态丢失；自定义覆盖的高级编辑不在本组件范围。
 */
const AppearanceThemePicker = memo(function AppearanceThemePicker(props: { value: AppSkinId; onPick: (id: AppSkinId) => void }) {
	const { value, onPick } = props;
	return (
		<div className="grid w-full grid-cols-2 gap-2 md:grid-cols-5" role="radiogroup" aria-label={t("settings.accent")}>
			{SKIN_PRESETS.map((preset) => {
				const selected = preset.id === value;
				const surface = preset.previewSurfaces;
				return (
					<button
						key={preset.id}
						type="button"
						role="radio"
						aria-checked={selected}
						title={t(preset.descKey)}
						onClick={() => onPick(preset.id)}
						className={cn("group relative flex flex-col gap-1.5 rounded-lg border p-2 text-left transition-colors duration-fast", selected ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]" : "border-border-subtle bg-bg-panel hover:border-border-default")}
					>
						{/* 色板迷你预览：左=侧栏，右=应用区（边框线/主色/面板块） */}
						<span className="flex h-12 w-full overflow-hidden rounded-[6px] border border-border-subtle" style={{ background: surface.background }} aria-hidden="true">
							<span className="h-full w-[32%] border-r border-border-subtle" style={{ background: surface.sidebar }} />
							<span className="flex-1 p-1.5">
								<span className="mb-1 block h-1.5 w-3/4 rounded-sm" style={{ background: surface.border }} />
								<span className="block h-1.5 w-1/2 rounded-sm" style={{ background: surface.accent }} />
								<span
									className="mt-1 block h-1.5 w-2/3 rounded-sm"
									style={{
										background: surface.panel,
										border: `1px solid ${surface.border}`,
									}}
								/>
							</span>
						</span>
						<span className="text-control leading-tight text-foreground">{t(preset.labelKey)}</span>
						{selected && <Check className="absolute right-1.5 top-1.5 size-3.5 text-[var(--color-accent)]" strokeWidth={3} aria-hidden="true" />}
					</button>
				);
			})}
			{value === "custom" && (
				<button type="button" role="radio" aria-checked={true} className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border-default bg-bg-panel p-2 text-control leading-tight text-muted-foreground">
					{t("settings.skin.custom")}
				</button>
			)}
		</div>
	);
});
