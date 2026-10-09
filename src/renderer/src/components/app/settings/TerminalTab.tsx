import { memo, useEffect, useMemo, useState } from "react";
import type { AppSettings } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { Input } from "../../ui-shadcn/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { Combobox, type ComboboxOption } from "../../ui-shadcn/combobox";
import { SettingsSection } from "./SettingsStorageTab";
import { DirtyMarker, SettingRow, SettingSwitchRow } from "./SettingRows";
import { TERMINAL_THEME_DEFS } from "../../../terminalThemes";

/** 下拉选项：SelectItem 直接透传 value/label */
type SelectOption = { value: string; label: string };

/** 「跟随」项的内部值：Select 的 value 不能是空串（Radix 会当成未选中），故用哨兵 */
const FOLLOW_VALUE = "__follow__";

/**
 * 终端字号档位（px）：覆盖 12–20，与外观设置的界面字号档（12/13/14/15/16）区间对齐，
 * 额外给等宽终端常用的 17/18/20 三档（终端字号通常比界面字号大 1–4px 才好看）。
 */
const TERMINAL_FONT_SIZE_OPTIONS = [11, 12, 13, 14, 15, 16, 17, 18, 20] as const;

type TerminalTabProps = {
	draft: AppSettings;
	updateDraft: (patch: Partial<AppSettings>) => void;
	isDirty: (field: keyof AppSettings) => boolean;
};

/**
 * 设置弹框「终端」tab：终端配色 / 字体 / 行为 / 启动命令。
 *
 * 这里的每一项都直接对应 AppSettings 字段，TerminalDock 通过热更新 effect 消费
 * （字号/字体/光标/主题立即生效；滚动上限因 xterm 缩小即丢历史，只在新建终端时生效）。
 */
export const TerminalTab = memo(function TerminalTab(props: TerminalTabProps) {
	const { draft, updateDraft, isDirty } = props;
	/** 系统字体族（主进程枚举，进程内缓存）；加载失败时保持空列表并给出提示 */
	const [systemFonts, setSystemFonts] = useState<string[]>([]);
	const [fontsFailed, setFontsFailed] = useState(false);

	useEffect(() => {
		let cancelled = false;
		void desktopApi.terminal
			.fonts()
			.then((families) => {
				if (cancelled) return;
				setSystemFonts(families);
				setFontsFailed(families.length === 0);
			})
			.catch(() => {
				// 枚举失败不阻断设置页：字体下拉退化为「跟随代码字体」+ 当前值
				if (!cancelled) setFontsFailed(true);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const fontOptions = useMemo<ComboboxOption[]>(() => {
		const options: ComboboxOption[] = [{ value: "", label: t("settings.terminal.fontFamily.follow"), keywords: "follow cascade mono consolas monospace 跟随 代码字体" }];
		for (const family of systemFonts) options.push({ value: family, label: family });
		// 已保存的字体可能不在系统列表里（换机器/卸载字体）：保留为一项，避免下拉显示成空而实际仍生效
		const current = draft.terminalFontFamily.trim();
		if (current && !systemFonts.includes(current)) options.push({ value: current, label: current, hint: t("settings.terminal.fontFamilyMissing") });
		return options;
	}, [systemFonts, draft.terminalFontFamily]);

	const themeOptions: SelectOption[] = [{ value: "inherit", label: t("settings.terminal.theme.inherit") }, ...TERMINAL_THEME_DEFS.map((def) => ({ value: def.id as string, label: def.label }))];
	const cursorStyleOptions: SelectOption[] = [
		{ value: "block", label: t("settings.terminal.cursorStyle.block") },
		{ value: "bar", label: t("settings.terminal.cursorStyle.bar") },
		{ value: "underline", label: t("settings.terminal.cursorStyle.underline") },
	];
	const confirmCloseOptions: SelectOption[] = [
		{ value: "never", label: t("settings.terminal.confirmClose.never") },
		{ value: "running", label: t("settings.terminal.confirmClose.running") },
		{ value: "always", label: t("settings.terminal.confirmClose.always") },
	];

	return (
		<>
			{/* 外观：配色主题与内容区间距 */}
			<SettingsSection title={t("settings.terminal.appearance")}>
				<SettingRow
					title={
						<>
							<span>{t("settings.terminal.theme")}</span>
							<DirtyMarker dirty={isDirty("terminalTheme")} label={t("settings.terminal.theme")} />
						</>
					}
					description={t("settings.terminal.themeDesc")}
					alignEnd={false}
				>
					<Select value={draft.terminalTheme} onValueChange={(value) => updateDraft({ terminalTheme: value as AppSettings["terminalTheme"] })}>
						<SelectTrigger className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{themeOptions.map((option) => (
								<SelectItem key={option.value} value={option.value}>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingRow>
				<SettingRow
					anchor="terminal-padding-y"
					stacked
					title={
						<>
							<span>{t("settings.terminal.paddingY")}</span>
							<DirtyMarker dirty={isDirty("terminalPaddingY")} label={t("settings.terminal.paddingY")} />
						</>
					}
					description={t("settings.terminal.paddingYDesc")}
				>
					<Input type="number" min={0} max={32} value={draft.terminalPaddingY} onChange={(event) => updateDraft({ terminalPaddingY: Number(event.target.value) })} />
				</SettingRow>
			</SettingsSection>

			{/* 字体：两项都是选择款——字体取自系统字体集合，字号取预设档位；
			    默认分别是「跟随代码字体」「跟随界面字号」（值为空 = 跟随） */}
			<SettingsSection title={t("settings.terminal.font")}>
				<SettingRow
					anchor="terminal-font-size"
					title={
						<>
							<span>{t("settings.terminal.fontSize")}</span>
							<DirtyMarker dirty={isDirty("terminalFontSize")} label={t("settings.terminal.fontSize")} />
						</>
					}
					description={t("settings.terminal.fontSizeDesc")}
					alignEnd={false}
				>
					<Select value={draft.terminalFontSize === null ? FOLLOW_VALUE : String(draft.terminalFontSize)} onValueChange={(value) => updateDraft({ terminalFontSize: value === FOLLOW_VALUE ? null : Number(value) })}>
						<SelectTrigger className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={FOLLOW_VALUE}>{t("settings.terminal.fontSize.follow")}</SelectItem>
							{TERMINAL_FONT_SIZE_OPTIONS.map((size) => (
								<SelectItem key={size} value={String(size)}>
									{size}px
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingRow>
				<SettingRow
					anchor="terminal-font-family"
					title={
						<>
							<span>{t("settings.terminal.fontFamily")}</span>
							<DirtyMarker dirty={isDirty("terminalFontFamily")} label={t("settings.terminal.fontFamily")} />
						</>
					}
					description={t("settings.terminal.fontFamilyDesc")}
					alignEnd={false}
				>
					{/* 系统字体 350+ 族：用可搜索下拉，Select 靠滚动找不到目标字体 */}
					<Combobox
						value={draft.terminalFontFamily}
						options={fontOptions}
						onValueChange={(value) => updateDraft({ terminalFontFamily: value })}
						placeholder={t("settings.terminal.fontFamily.follow")}
						searchPlaceholder={t("settings.terminal.fontFamilySearch")}
						emptyLabel={t("settings.terminal.fontFamilyEmpty")}
						ariaLabel={t("settings.terminal.fontFamily")}
					/>
				</SettingRow>
				{fontsFailed && <p className="px-1 pt-1 text-[11px] text-muted-foreground">{t("settings.terminal.fontFamilyLoadFailed")}</p>}
			</SettingsSection>

			{/* 行为：滚动上限/光标/复制/关闭确认 */}
			<SettingsSection title={t("settings.terminal.behavior")}>
				<SettingRow
					anchor="terminal-scrollback"
					stacked
					title={
						<>
							<span>{t("settings.terminal.scrollback")}</span>
							<DirtyMarker dirty={isDirty("terminalScrollback")} label={t("settings.terminal.scrollback")} />
						</>
					}
					description={t("settings.terminal.scrollbackDesc")}
				>
					<Input type="number" min={0} max={200000} value={draft.terminalScrollback} onChange={(event) => updateDraft({ terminalScrollback: Number(event.target.value) })} />
				</SettingRow>
				<SettingRow
					title={
						<>
							<span>{t("settings.terminal.cursorStyle")}</span>
							<DirtyMarker dirty={isDirty("terminalCursorStyle")} label={t("settings.terminal.cursorStyle")} />
						</>
					}
					alignEnd={false}
				>
					<Select value={draft.terminalCursorStyle} onValueChange={(value) => updateDraft({ terminalCursorStyle: value as AppSettings["terminalCursorStyle"] })}>
						<SelectTrigger className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{cursorStyleOptions.map((option) => (
								<SelectItem key={option.value} value={option.value}>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingRow>
				<SettingSwitchRow title={t("settings.terminal.cursorBlink")} description={t("settings.terminal.cursorBlinkDesc")} checked={draft.terminalCursorBlink} dirty={isDirty("terminalCursorBlink")} dirtyLabel={t("settings.terminal.cursorBlink")} onChange={(checked) => updateDraft({ terminalCursorBlink: checked })} />
				<SettingSwitchRow
					title={t("settings.terminal.copyOnSelect")}
					description={t("settings.terminal.copyOnSelectDesc")}
					checked={draft.terminalCopyOnSelect}
					dirty={isDirty("terminalCopyOnSelect")}
					dirtyLabel={t("settings.terminal.copyOnSelect")}
					onChange={(checked) => updateDraft({ terminalCopyOnSelect: checked })}
				/>
				<SettingRow
					title={
						<>
							<span>{t("settings.terminal.confirmClose")}</span>
							<DirtyMarker dirty={isDirty("terminalConfirmClose")} label={t("settings.terminal.confirmClose")} />
						</>
					}
					description={t("settings.terminal.confirmCloseDesc")}
					alignEnd={false}
				>
					<Select value={draft.terminalConfirmClose} onValueChange={(value) => updateDraft({ terminalConfirmClose: value as AppSettings["terminalConfirmClose"] })}>
						<SelectTrigger className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{confirmCloseOptions.map((option) => (
								<SelectItem key={option.value} value={option.value}>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingRow>
			</SettingsSection>

			{/* 启动：新终端自动执行的命令 */}
			<SettingsSection title={t("settings.terminal.startup")}>
				<SettingRow
					stacked
					title={
						<>
							<span>{t("settings.terminal.startupCommand")}</span>
							<DirtyMarker dirty={isDirty("terminalStartupCommand")} label={t("settings.terminal.startupCommand")} />
						</>
					}
					description={t("settings.terminal.startupCommandDesc")}
				>
					<Input type="text" value={draft.terminalStartupCommand} placeholder={t("settings.terminal.startupCommandPlaceholder")} onChange={(event) => updateDraft({ terminalStartupCommand: event.target.value })} />
				</SettingRow>
			</SettingsSection>
		</>
	);
});
