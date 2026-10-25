import { useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings } from "../../../../../shared/types";
import { getShortcutDef, SHORTCUT_DEFS, buildAcceleratorFromKeyEvent, formatAccelerator, isValidAccelerator, resolveShortcutBindings, type ShortcutGroupId, type ShortcutId } from "../../../../../shared/shortcuts";
import { t, type TranslationKey } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { DirtyMarker, SettingRow } from "./SettingRows";
import { SettingsSection } from "./SettingsStorageTab";

type ShortcutsTabProps = {
	draft: AppSettings;
	updateDraft: (patch: Partial<AppSettings>) => void;
	isDirty: (field: keyof AppSettings) => boolean;
	/** 主进程 process.platform（appInfo.platform），决定平台默认键与展示格式 */
	platform: string;
	/** 存在冲突等非法状态时上报（设置页据此禁用保存按钮） */
	onInvalidChange?: (invalid: boolean) => void;
};

/** 录制中的临时提示（不持久化，Esc 或录制完成即清） */
type RecordHint = { id: ShortcutId; kind: "needModifier" };

const GROUP_LABEL_KEYS: Record<ShortcutGroupId, TranslationKey> = {
	general: "settings.shortcuts.groupGeneral",
	dev: "settings.shortcuts.groupDev",
};

/**
 * 分组的 DOM 锚点 id，写全量字面量而非模板拼接：命令面板的锚点索引
 * （utils/settingsFieldAnchors.ts）与 `tests/settingsFieldAnchors.test.mjs` 都按
 * 「源码里出现完整 id 字符串」核对，模板拼出来的 id 在源码里查不到，
 * 会让「搜到却跳不动」这类静默失效失去守卫。
 */
const GROUP_SECTION_IDS: Record<ShortcutGroupId, string> = {
	general: "settings-section-shortcuts-general",
	dev: "settings-section-shortcuts-dev",
};

/**
 * 注册表（shared 层）里的文案 key 声明为 string，避免共享层反向依赖渲染层 i18n 类型；
 * 合法性由 tests/shortcutRegistry.test.mjs 的「labelKey 前缀」断言兜底。
 */
function shortcutLabelKey(key: string): TranslationKey {
	return key as TranslationKey;
}

/**
 * 快捷键管理 tab：列出全部全局快捷键（注册表见 shared/shortcuts.ts），
 * 支持点击「修改」后按键录制，冲突/非法组合就地报错并阻止保存。
 *
 * 数据流：改的是草稿里的 shortcuts 覆盖表（ShortcutId → accelerator），
 * 缺省键 = 平台默认；主进程 before-input-event 实时匹配同一份覆盖（保存即生效）。
 */
export function ShortcutsTab(props: ShortcutsTabProps) {
	const { draft, updateDraft, platform, onInvalidChange } = props;
	const [recordingId, setRecordingId] = useState<ShortcutId | null>(null);
	const [hint, setHint] = useState<RecordHint | null>(null);
	// 录制期间也要拿到最新的覆盖表：每次渲染都刷新 ref，避免 keydown 闭包持有过期 draft
	const overridesRef = useRef<Record<string, string>>(draft.shortcuts ?? {});
	overridesRef.current = draft.shortcuts ?? {};

	// 生效绑定 = 覆盖 ∪ 平台默认，与主进程 resolveShortcutBindings 同一实现，
	// 保证设置页展示的键就是实际生效的键。
	const resolved = useMemo(() => resolveShortcutBindings(draft.shortcuts ?? {}, platform), [draft.shortcuts, platform]);

	// 冲突检测：两个快捷键解析到同一个 accelerator（含默认键互相撞车的情况）
	const conflicts = useMemo(() => {
		const byAcc = new Map<string, ShortcutId[]>();
		for (const def of SHORTCUT_DEFS) {
			if (def.hidden) continue;
			const list = byAcc.get(resolved[def.id]) ?? [];
			list.push(def.id);
			byAcc.set(resolved[def.id], list);
		}
		const map = new Map<ShortcutId, ShortcutId[]>();
		for (const ids of byAcc.values()) {
			if (ids.length > 1) {
				for (const id of ids)
					map.set(
						id,
						ids.filter((other) => other !== id),
					);
			}
		}
		return map;
	}, [resolved]);

	const invalid = conflicts.size > 0;
	// 冲突态上报：设置页据此禁用保存按钮，避免把互相抢键的配置存进磁盘
	useEffect(() => {
		onInvalidChange?.(invalid);
	}, [invalid, onInvalidChange]);

	/** 提交录制结果：写入覆盖表并结束录制 */
	const commit = (id: ShortcutId, acc: string) => {
		updateDraft({ shortcuts: { ...overridesRef.current, [id]: acc } });
		setRecordingId(null);
		setHint(null);
	};

	/** 恢复某条快捷键为平台默认：从覆盖表删掉该 id（缺省键 = 默认） */
	const resetToDefault = (id: ShortcutId) => {
		const next = { ...overridesRef.current };
		delete next[id];
		updateDraft({ shortcuts: next });
		setRecordingId(null);
		setHint(null);
	};

	// 录制监听：窗口级捕获（焦点在输入框等子元素时也拿得到），拦截一切按键
	useEffect(() => {
		if (!recordingId) return;
		const onKeyDown = (event: KeyboardEvent) => {
			event.preventDefault();
			event.stopPropagation();
			// Esc = 取消录制；Delete/Backspace = 恢复默认（与主流快捷键录制器一致）
			if (event.key === "Escape") {
				setRecordingId(null);
				setHint(null);
				return;
			}
			if (event.key === "Delete" || event.key === "Backspace") {
				resetToDefault(recordingId);
				return;
			}
			const acc = buildAcceleratorFromKeyEvent(event, platform);
			if (!acc) return; // 纯修饰键按下等，继续等待下一个键
			if (!isValidAccelerator(acc, platform)) {
				setHint({ id: recordingId, kind: "needModifier" });
				return;
			}
			commit(recordingId, acc);
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
		// commit/resetToDefault 每次渲染重建但只依赖 ref + 稳定 setter，闭包不会过期
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [recordingId, platform]);

	const hasOverrides = Object.keys(overridesRef.current).length > 0;

	return (
		<div className="settings-panel min-w-0">
			{/* 顶部说明 + 一键全部恢复默认 */}
			<div className="flex items-center justify-between gap-4 pb-1">
				<p className="text-caption leading-relaxed text-muted-foreground">{t("settings.shortcuts.intro")}</p>
				{hasOverrides ? (
					<Button variant="outline" size="sm" onClick={() => updateDraft({ shortcuts: {} })}>
						{t("settings.shortcuts.resetAll")}
					</Button>
				) : null}
			</div>
			{/* 按注册表分组渲染：通用 / 开发 */}
			{(Object.keys(GROUP_LABEL_KEYS) as ShortcutGroupId[]).map((group) => {
				const defs = SHORTCUT_DEFS.filter((def) => def.group === group && !def.hidden);
				if (defs.length === 0) return null;
				return (
					<SettingsSection key={group} id={GROUP_SECTION_IDS[group]} title={t(GROUP_LABEL_KEYS[group])}>
						{defs.map((def) => {
							const recording = recordingId === def.id;
							const overridden = overridesRef.current[def.id] !== undefined;
							const conflictedWith = conflicts.get(def.id) ?? [];
							return (
								<SettingRow
									key={def.id}
									title={
										<span className="inline-flex items-center gap-1.5">
											{t(shortcutLabelKey(def.labelKey))}
											<DirtyMarker dirty={props.isDirty("shortcuts")} label={t(shortcutLabelKey(def.labelKey))} />
										</span>
									}
									description={
										<>
											{t(shortcutLabelKey(def.descriptionKey))}
											{conflictedWith.length > 0 && (
												<span className="mt-0.5 block font-medium text-destructive">
													{t("settings.shortcuts.conflictWith", {
														label: conflictedWith.map((id) => t(shortcutLabelKey(getShortcutDef(id)?.labelKey ?? id))).join(", "),
													})}
												</span>
											)}
											{hint && hint.id === def.id && hint.kind === "needModifier" && <span className="mt-0.5 block text-destructive">{t("settings.shortcuts.needModifier")}</span>}
										</>
									}
								>
									<div className="flex items-center justify-end gap-2">
										{recording ? (
											<span className="text-caption text-muted-foreground">{t("settings.shortcuts.recordingHint")}</span>
										) : (
											<kbd className={`inline-flex min-w-14 items-center justify-center rounded border px-2 py-1 font-mono text-xs text-foreground ${conflictedWith.length > 0 ? "border-destructive/60 bg-destructive/10" : "border-border-subtle bg-bg-muted"}`}>{formatAccelerator(resolved[def.id], platform)}</kbd>
										)}
										<Button
											variant={recording ? "default" : "outline"}
											size="sm"
											disabled={recordingId !== null && !recording}
											onClick={() => {
												setHint(null);
												setRecordingId(recording ? null : def.id);
											}}
										>
											{t(recording ? "settings.shortcuts.recording" : "settings.shortcuts.change")}
										</Button>
										{overridden && !recording ? (
											<Button variant="ghost" size="sm" onClick={() => resetToDefault(def.id)}>
												{t("settings.shortcuts.reset")}
											</Button>
										) : null}
									</div>
								</SettingRow>
							);
						})}
					</SettingsSection>
				);
			})}
		</div>
	);
}
