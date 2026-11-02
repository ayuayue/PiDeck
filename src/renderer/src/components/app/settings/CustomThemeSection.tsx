/**
 * 设置页「自定义主题」区块：主题目录卡片列表（内置示例 + 用户文件）、应用/停用、
 * JSON 编辑器（保存前主进程同源校验）、AI 开发指南落盘入口。
 * 应用动作只写草稿（themePalette="custom" + customTheme 快照，themeStyle 落到 base 样式），
 * 预览/持久化由壳层接管；主题包带 base 时继承该内置样式（等宽/方角/标记等形状 chrome），
 * 只覆盖它写明的颜色与字体——配色由主题包独占，样式由 base 决定。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getI18nLocale, t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import type { AppSettings } from "../../../../../shared/types";
import { CUSTOM_THEME_TEMPLATE, DEMO_CUSTOM_THEME, serializeCustomThemePackage, type CustomThemeBaseSkin, type CustomThemeListItem } from "../../../../../shared/customThemes";
import { STYLE_PRESETS } from "../../../themePresets";
import { Button } from "../../ui-shadcn/button";
import { Badge } from "../../ui-shadcn/badge";
import { Textarea } from "../../ui-shadcn/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../ui-shadcn/dialog";
import { AlertTriangle, BookOpenText, Check, Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { showNotice } from "../../../utils/notice";
import { cn } from "@/lib/utils";

type CustomThemeSectionProps = {
	draft: AppSettings;
	updateDraft: (patch: Partial<AppSettings>) => void;
};

/** 单个色板小样：底色块 + 主色条 + 文字点，token 缺席时回落当前主题变量（视觉不空洞） */
function SchemeSwatch({ tokens, dark }: { tokens: Record<string, string>; dark: boolean }) {
	return (
		<div className="flex h-8 w-[76px] shrink-0 items-center gap-1 rounded-sm border border-border px-1.5" style={{ background: tokens["bg-app"] ?? (dark ? "#16181a" : "#f5f5f4") }} aria-hidden="true" title={dark ? t("settings.themeDark") : t("settings.themeLight")}>
			<span className="h-4 w-4 rounded-[2px] border border-black/10" style={{ background: tokens["bg-panel"] ?? (dark ? "#1e2124" : "#ffffff") }} />
			<span className="h-2 w-2 rounded-full" style={{ background: tokens["accent"] ?? "var(--color-accent)" }} />
			<span className="h-1.5 w-5 rounded-full" style={{ background: tokens["text-primary"] ?? (dark ? "#ececec" : "#2b2b2b") }} />
		</div>
	);
}

/** 编辑器弹窗状态：title 仅展示；raw 为当前编辑文本 */
type EditorState = { title: string; raw: string };

/** 行主键 / 磁盘操作键：用户文件用 fileId（文件名），内置示例没有文件、用包内 id */
function themeRowKey(item: CustomThemeListItem): string {
	return item.source === "builtin" ? item.id : (item.fileId ?? item.id);
}

export function CustomThemeSection({ draft, updateDraft }: CustomThemeSectionProps) {
	const [dir, setDir] = useState("");
	const [themes, setThemes] = useState<CustomThemeListItem[]>([]);
	const [editor, setEditor] = useState<EditorState | null>(null);
	const [errors, setErrors] = useState<string[]>([]);
	const [saving, setSaving] = useState(false);
	// 删除二段确认：armed=待再次点击确认的条目主键（themeRowKey）；超时自动解除，避免误删
	const [armedDeleteId, setArmedDeleteId] = useState<string | null>(null);
	const disarmTimer = useRef<number | undefined>(undefined);

	const refresh = useCallback(async (): Promise<CustomThemeListItem[]> => {
		const result = await desktopApi.customThemes.list();
		setDir(result.dir);
		setThemes(result.themes);
		return result.themes;
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useEffect(() => {
		return () => {
			if (disarmTimer.current !== undefined) window.clearTimeout(disarmTimer.current);
		};
	}, []);

	// 当前生效的自定义主题 id：配色维度落在 custom 时，正在用的就是快照里那个主题
	const appliedId = draft.themePalette === "custom" ? draft.customTheme?.id : undefined;

	/** 继承样式的显示名（base 为空返回空串） */
	const baseLabel = (base?: CustomThemeBaseSkin) => {
		const preset = base ? STYLE_PRESETS.find((entry) => entry.id === base) : undefined;
		return preset ? t(preset.labelKey) : "";
	};

	const applyTheme = (item: CustomThemeListItem) => {
		if (item.parseError) return;
		// 只写草稿：设置弹窗预览立即生效，保存后由 App 的 useAppAppearance 持久化接管。
		// 配色维度落到 custom（颜色归主题包独占）；带 base 时样式维度落到该内置样式
		// （形状 chrome 整套保留），不带 base 则沿用用户当前选的样式。
		updateDraft({
			themePalette: "custom",
			themeStyle: item.base ?? draft.themeStyle,
			customTheme: { id: item.id, name: item.name, ...(item.base ? { base: item.base } : {}), light: item.tokens.light, dark: item.tokens.dark },
		});
		showNotice(t("settings.customThemesAppliedToast"));
	};

	const unapplyTheme = () => {
		// 停用只清快照；配色维度保持 custom（回落 customThemeOverrides + 基础色板）
		updateDraft({ customTheme: undefined });
	};

	const openEditor = (title: string, raw: string) => {
		setErrors([]);
		setEditor({ title, raw });
	};

	const handleNew = () => openEditor(t("settings.customThemesNew"), serializeCustomThemePackage(CUSTOM_THEME_TEMPLATE));

	// 复制内置示例：改 id/name 后落成用户文件（内置示例的 id 保留，不与它共用）
	const handleCopyDemo = () => {
		const copy = serializeCustomThemePackage(DEMO_CUSTOM_THEME)
			.replace(/"id":\s*"[^"]+"/, '"id": "my-berry-theme"')
			.replace(/"name":\s*"[^"]+"/, '"name": "我的莓果主题"');
		openEditor(t("settings.customThemesCopyDemo"), copy);
	};

	const handleEdit = async (item: CustomThemeListItem) => {
		// 内置示例不在磁盘上、也无法就地保存，其入口是工具栏「复制示例」
		if (!item.fileId) {
			showNotice(t("settings.customThemesReadFailed"), undefined, "error");
			return;
		}
		const raw = await desktopApi.customThemes.read(item.fileId);
		if (raw === null) {
			showNotice(t("settings.customThemesReadFailed"), undefined, "error");
			void refresh();
			return;
		}
		openEditor(t("settings.customThemesEditTitle", { name: item.name }), raw);
	};

	const handleSave = async () => {
		if (!editor) return;
		setSaving(true);
		try {
			const result = await desktopApi.customThemes.save(editor.raw);
			if (!result.ok) {
				setErrors(result.errors);
				return;
			}
			setErrors([]);
			setEditor(null);
			const list = await refresh();
			// 正在使用的主题被就地修改：同步刷新草稿快照，避免「文件改了界面没变」
			if (appliedId === result.id) {
				const updated = list.find((entry) => entry.id === result.id && !entry.parseError);
				if (updated)
					updateDraft({
						themePalette: "custom",
						themeStyle: updated.base ?? draft.themeStyle,
						customTheme: { id: updated.id, name: updated.name, ...(updated.base ? { base: updated.base } : {}), light: updated.tokens.light, dark: updated.tokens.dark },
					});
			}
			showNotice(t("settings.customThemesSavedToast", { id: result.id }));
		} finally {
			setSaving(false);
		}
	};

	const handleDelete = async (item: CustomThemeListItem) => {
		// 内置示例不可删（常量随包分发，不在磁盘上）
		if (item.source !== "user") return;
		const fileId = item.fileId ?? item.id;
		if (armedDeleteId !== fileId) {
			// 第一段：进入待确认；3 秒无动作自动解除
			setArmedDeleteId(fileId);
			if (disarmTimer.current !== undefined) window.clearTimeout(disarmTimer.current);
			disarmTimer.current = window.setTimeout(() => setArmedDeleteId(null), 3000);
			return;
		}
		setArmedDeleteId(null);
		try {
			await desktopApi.customThemes.remove(fileId);
		} catch {
			// 删除失败（文件已被外部移除、回收站不可用）必须显式报错：不能弹「已删除」却什么都没删
			showNotice(t("settings.customThemesDeleteFailed", { id: item.name }), undefined, "error");
			await refresh();
			return;
		}
		await refresh();
		showNotice(t("settings.customThemesDeletedToast", { id: item.id }));
	};

	const handleGuide = async () => {
		try {
			const path = await desktopApi.customThemes.writeGuide(getI18nLocale() === "en-US" ? "en-US" : "zh-CN");
			showNotice(t("settings.customThemesGuideToast", { path }));
		} catch {
			showNotice(t("settings.customThemesGuideFailed"), undefined, "error");
		}
	};

	const handleCopyDir = async () => {
		if (!dir) return;
		try {
			await navigator.clipboard.writeText(dir);
			showNotice(t("settings.customThemesDirCopiedToast"));
		} catch {
			showNotice(dir, undefined, "error");
		}
	};

	return (
		<div className="flex flex-col gap-2">
			{/* 工具栏：新建 / 复制示例 / AI 指南 / 复制目录（目录路径即「丢给 AI」的关键信息） */}
			<div className="flex flex-wrap items-center gap-1.5">
				<Button variant="outline" size="sm" onClick={handleNew}>
					<Plus className="size-3.5" />
					{t("settings.customThemesNew")}
				</Button>
				<Button variant="outline" size="sm" title={t("settings.customThemesCopyDemoHint")} onClick={handleCopyDemo}>
					<Copy className="size-3.5" />
					{t("settings.customThemesCopyDemo")}
				</Button>
				<Button variant="outline" size="sm" onClick={handleGuide} title={t("settings.customThemesGuideHint")}>
					<BookOpenText className="size-3.5" />
					{t("settings.customThemesGuide")}
				</Button>
				<Button variant="ghost" size="sm" onClick={handleCopyDir} title={dir} disabled={!dir}>
					{t("settings.customThemesCopyDir")}
				</Button>
			</div>
			{dir ? <div className="font-mono text-micro leading-relaxed text-text-tertiary break-all">{dir}</div> : null}

			{/* 主题卡片列表 */}
			<div className="flex flex-col gap-1.5">
				{themes.length === 0 ? <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">{t("settings.customThemesEmpty")}</div> : null}
				{themes.map((item) => {
					const rowKey = themeRowKey(item);
					const applied = appliedId === item.id && !item.parseError;
					return (
						<div key={`${item.source}:${rowKey}`} className={cn("flex items-center gap-2 rounded-md border px-2.5 py-2", applied ? "border-[var(--color-accent)]" : "border-border", item.parseError ? "border-[var(--color-danger)]/60" : "")}>
							{item.parseError ? (
								// 解析失败条目：展示首个错误 + 文件名，供定位坏文件
								<div className="flex min-w-0 flex-1 items-start gap-2">
									<AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--color-danger)]" />
									<div className="min-w-0">
										<div className="truncate font-mono text-xs">{item.id}.json</div>
										<div className="truncate text-micro text-text-tertiary">{item.parseError[0]}</div>
									</div>
								</div>
							) : (
								<>
									<SchemeSwatch tokens={item.tokens.light} dark={false} />
									<SchemeSwatch tokens={item.tokens.dark} dark />
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-1.5">
											<span className="truncate text-sm">{item.name}</span>
											<Badge variant="secondary" className="shrink-0">
												{item.source === "builtin" ? t("settings.customThemesBuiltin") : t("settings.customThemesUser")}
											</Badge>
											{item.base ? (
												<Badge variant="outline" className="shrink-0" title={t("settings.customThemesBasedOnHint")}>
													{t("settings.customThemesBasedOn", { skin: baseLabel(item.base) })}
												</Badge>
											) : null}
											{applied ? (
												<Badge className="shrink-0 gap-1">
													<Check className="size-3" />
													{t("settings.customThemesApplied")}
												</Badge>
											) : null}
										</div>
										<div className="truncate text-micro text-text-tertiary">{[item.version, item.author, item.description].filter(Boolean).join(" · ")}</div>
									</div>
									<div className="flex shrink-0 items-center gap-1">
										{applied ? (
											<Button variant="ghost" size="sm" onClick={unapplyTheme}>
												{t("settings.customThemesUnapply")}
											</Button>
										) : (
											<Button variant="outline" size="sm" onClick={() => applyTheme(item)}>
												{t("settings.customThemesApply")}
											</Button>
										)}
										{/* 内置示例不在磁盘上：编辑入口是工具栏「复制示例」（就地保存会被保留 id 拦下） */}
										{item.source === "user" ? (
											<Button variant="ghost" size="sm" onClick={() => void handleEdit(item)} title={t("settings.customThemesEdit")}>
												<Pencil className="size-3.5" />
											</Button>
										) : null}
										{item.source === "user" ? (
											<Button variant="ghost" size="sm" className={cn(armedDeleteId === rowKey ? "text-[var(--color-danger)]" : "text-muted-foreground")} onClick={() => void handleDelete(item)} title={armedDeleteId === rowKey ? t("settings.customThemesDeleteConfirmAgain") : t("settings.customThemesDelete")}>
												<Trash2 className="size-3.5" />
											</Button>
										) : null}
									</div>
								</>
							)}
						</div>
					);
				})}
			</div>

			{/*
			 * JSON 编辑器：保存走主进程校验（同目录扫描同源），错误就地列出。
			 * 编辑器高度跟视口走（56dvh），再由弹窗 max-h 兜底：长主题此前会把底部按钮顶出屏幕。
			 * field-sizing-content 自撑高会无视限高，这里显式改回固定高度，超过部分由 textarea 自身滚动。
			 */}
			<Dialog open={editor !== null} onOpenChange={(open) => (open ? undefined : setEditor(null))}>
				<DialogContent className="flex max-h-[calc(100dvh-64px)] max-w-2xl flex-col gap-4 overflow-hidden">
					<DialogHeader className="shrink-0">
						<DialogTitle>{editor?.title ?? ""}</DialogTitle>
					</DialogHeader>
					<Textarea
						value={editor?.raw ?? ""}
						onChange={(event) => setEditor((prev) => (prev ? { ...prev, raw: event.target.value } : prev))}
						className="h-[min(56dvh,560px)] min-h-[160px] shrink field-sizing-fixed resize-none font-mono text-xs leading-relaxed"
						spellCheck={false}
						aria-label={t("settings.customThemesEditorTitle")}
					/>
					{errors.length > 0 ? (
						// scroll-ok: bounded —— 行数有硬上限（受控分页 / 上限常量 / 固定枚举），不随数据无限增长。
						<div className="max-h-28 shrink-0 overflow-y-auto rounded-md border border-[var(--color-danger)]/50 bg-[var(--color-danger-soft)] px-3 py-2 text-xs text-[var(--color-danger)]">
							{errors.map((error, index) => (
								// eslint-disable-next-line react/no-array-index-key -- 错误清单为静态展示，无重排
								<div key={index}>{error}</div>
							))}
						</div>
					) : null}
					<DialogFooter className="shrink-0">
						<Button variant="ghost" size="sm" onClick={() => setEditor(null)}>
							{t("common.cancel")}
						</Button>
						<Button size="sm" disabled={saving} onClick={() => void handleSave()}>
							{t("settings.customThemesSave")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
