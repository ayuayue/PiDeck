import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useAtom, useSetAtom } from "jotai";
import { ChevronDown, Plus, Trash2 } from "lucide-react";
import { desktopApi } from "../../../desktopApi";
import { acpEnabledAtom, acpToolsAtom } from "../../../atoms";
import { t } from "../../../i18n";
import type { AcpToolConfig } from "../../../../../shared/types/acp";
import type { AcpToolPreset } from "../../../../../shared/acpToolPresets";
import { Switch } from "../../ui-shadcn/switch";
import { Badge } from "../../ui-shadcn/badge";
import { AcpPresetChips } from "./AcpPresetChips";
import { SectionHeading } from "../../ui-shadcn/section-heading";
import { Button } from "../../ui-shadcn/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../ui-shadcn/collapsible";
import { Checkbox } from "../../ui-shadcn/checkbox";
import { Input } from "../../ui-shadcn/input";
import { Textarea } from "../../ui-shadcn/textarea";
import { ACP_STALL_TIMEOUT_DEFAULT_MS, ACP_STALL_TIMEOUT_SECONDS, ACP_TURN_TIMEOUT_DEFAULT_MS, ACP_TURN_TIMEOUT_MINUTES, acpStallTimeoutPatch, acpStallTimeoutText, acpTurnTimeoutPatch, acpTurnTimeoutText } from "./acpTimeoutInput";
import {
	ACP_RETRY_BASE_DELAY_SECONDS,
	ACP_RETRY_DEFAULT_BASE_DELAY_MS,
	ACP_RETRY_DEFAULT_MAX_RETRIES,
	ACP_RETRY_MAX_RETRIES_RANGE,
	acpRetryBaseDelayPatch,
	acpRetryBaseDelayText,
	acpRetryMaxRetriesPatch,
	acpRetryMaxRetriesText,
} from "./acpRetryInput";
import { cn } from "../../../lib/utils";

/** 草稿行 = IPC 输入形态:id 空表示新增行,保存时由主进程分配并返回;draftKey 是纯渲染用本地标识(React key/折叠态跟踪),不入盘。 */
type AcpToolRow = { draftKey: string; id?: string; name: string; command: string; args: string[]; envText: string; bypassPermissions: boolean };

/** env 序列化:Record → 「KEY=VALUE」每行一条的编辑文本;顺序稳定保证脏标记确定。 */
function envToText(env: Record<string, string> | undefined): string {
	if (!env) return "";
	return Object.entries(env)
		.map(([key, value]) => `${key}=${value}`)
		.join("\n");
}

/** 编辑文本 → Record:逐行按首个 = 拆分;空白/无 = 的行丢弃(保存时主进程 sanitizeEnv 二次消毒)。 */
function envFromText(text: string): Record<string, string> | undefined {
	const env: Record<string, string> = {};
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		const key = trimmed.slice(0, eq).trim();
		const value = trimmed.slice(eq + 1);
		if (key) env[key] = value;
	}
	return Object.keys(env).length > 0 ? env : undefined;
}

/**
 * 设置弹窗「ACP 工具」tab:总开关(opt-in)+ 预设工具生命周期(检测/安装/卸载)+ settings.acpTools 表。
 *
 * 数据流(与 pi/dsh 设置无关的独立持久层,模式同生图 tab):
 * - 总开关即时写盘(settings.acpEnabled,同 WebRemoteAccessSection 模式),并同步回
 *   acpEnabledAtom：后端下拉/新建会话菜单读的就是这个 atom，不同步就得重启应用才看得到 ACP 入口。
 *   主进程侧网关常驻注册、开关在 create 边界实时读，所以「改开关 → 立即能用」整条链路成立；
 *   关闭态只显示引导文案——opt-in,pi 用户零运行时成本(不 spawn 任何 CLI)。
 * - 预设芯片(AcpPresetChips)管「本机 CLI 装没装」:检测只读,npm 安装/卸载经确认弹窗。
 * - 工具表初值来自 acpToolsAtom(App 挂载时经 acpToolsList IPC 拉取),保存走
 *   acpToolsSave(主进程 sanitizeAcpTools 消毒落盘,返回规范化表),成功后
 *   整表回写 atom——新建会话菜单与设置页共享同一份快照,无需事件订阅;
 * - 校验双层:保存前逐条走主进程 validateTool(名称/命令必填、与已存表查重),
 *   再本地查草稿间重名(两条新增行同名时主进程 sanitize 会静默丢第二条,必须前置拦下);
 * - 删除行只改草稿,点弹框头部统一「保存」才写盘;未保存关闭由 SettingsModal 脏标记确认兜底。
 */
export type AcpToolsTabHandle = { save: () => Promise<boolean> };

export const AcpToolsTab = forwardRef<AcpToolsTabHandle, { onDirtyChange?: (dirty: boolean) => void }>(function AcpToolsTab(props, ref) {
	const [saved, setSaved] = useAtom(acpToolsAtom);
	const setAcpEnabledAtom = useSetAtom(acpEnabledAtom);
	const [rows, setRows] = useState<AcpToolRow[]>([]);
	// 折叠展开态按 draftKey 跟踪:默认全部收起只留摘要行,点头部展开编辑(同生图 tab 供应商行)。
	const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
	// 草稿行没有稳定身份(新增行无 id,行序会变),本地递增 key 让折叠态在增删后不错位。
	const nextKeyRef = useRef(1);
	const makeRowKey = useCallback(() => `draft-${nextKeyRef.current++}`, []);
	const [hydrated, setHydrated] = useState(false);
	const [error, setError] = useState<string | undefined>();
	// 总开关独立于弹框 draft:即时写盘(同 WebRemoteAccessSection 模式),变更重启生效。
	// undefined = 尚未从主进程拉到(settings.get 异步),期间禁用开关防抖动。
	const [enabled, setEnabled] = useState<boolean | undefined>(undefined);

	useEffect(() => {
		let cancelled = false;
		void desktopApi.settings
			.get()
			.then((settings) => {
				if (!cancelled) setEnabled(settings.acpEnabled === true);
			})
			.catch(() => {
				if (!cancelled) setEnabled(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const toggleEnabled = useCallback(
		async (next: boolean) => {
			setEnabled(next);
			// 同步快照，否则后端下拉/新建会话菜单要重启应用才看得到 ACP 入口
			setAcpEnabledAtom(next);
			try {
				await desktopApi.settings.update({ acpEnabled: next });
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
				setEnabled(!next);
				setAcpEnabledAtom(!next);
			}
		},
		[setAcpEnabledAtom],
	);

	// 挂载时以 atom 快照为初值;之后只经保存回写,弹窗开关不重复拉 IPC
	useEffect(() => {
		if (!hydrated) {
			setRows(saved.map((tool) => ({ draftKey: makeRowKey(), id: tool.id, name: tool.name, command: tool.command, args: [...tool.args], envText: envToText(tool.env), bypassPermissions: tool.bypassPermissions === true })));
			setHydrated(true);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- 一次性初值同步,后续以保存回写为准
	}, [hydrated]);

	const dirty = useMemo(() => serializeRows(rows) !== serializeRows(saved.map((tool) => ({ id: tool.id, name: tool.name, command: tool.command, args: [...tool.args], envText: envToText(tool.env), bypassPermissions: tool.bypassPermissions === true }))), [rows, saved]);
	useEffect(() => {
		props.onDirtyChange?.(dirty);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- onDirtyChange 由弹框稳定传入,不参与比较
	}, [dirty]);

	const patchRow = useCallback((index: number, patch: Partial<AcpToolRow>) => {
		setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
	}, []);

	const toggleExpanded = useCallback((key: string, open: boolean) => {
		setExpandedKeys((current) => {
			const next = new Set(current);
			if (open) next.add(key);
			else next.delete(key);
			return next;
		});
	}, []);

	const expandKey = useCallback((key: string | undefined) => {
		if (!key) return;
		setExpandedKeys((current) => new Set(current).add(key));
	}, []);

	const removeRow = useCallback((index: number) => {
		setRows((current) => current.filter((_, i) => i !== index));
	}, []);

	// 新增/预设预填的行自动展开:用户要填的字段直接可见,填完可手动收起。
	const addRow = useCallback(() => {
		const draftKey = makeRowKey();
		setRows((current) => [...current, { draftKey, name: "", command: "", args: [], envText: "", bypassPermissions: false }]);
		expandKey(draftKey);
	}, [makeRowKey, expandKey]);

	// 预设只是预填草稿行(名称/命令/参数可改),保存仍走统一校验链;
	// 同命令同参的行已存在(草稿或已存)时提示,避免重复堆行。
	const addFromPreset = useCallback(
		(preset: AcpToolPreset) => {
			const already = rows.some((row) => row.command === preset.command && row.args.join(" ") === preset.args.join(" "));
			if (already) {
				setError(t("acp.presetAlreadyAdded", { name: preset.name }));
				return;
			}
			setError(undefined);
			const draftKey = makeRowKey();
			// qoder 预设把 bypass 写进了启动参数，复选框不需要重复表达
			setRows((current) => [...current, { draftKey, name: preset.name, command: preset.command, args: [...preset.args], envText: "", bypassPermissions: false }]);
			expandKey(draftKey);
		},
		[rows, makeRowKey, expandKey],
	);

	const save = useCallback(async (): Promise<boolean> => {
		setError(undefined);
		try {
			// 第一层:主进程逐条校验(必填 + 与已存表查重;主进程不知草稿全貌)
			const validations = await Promise.all(rows.map((row) => desktopApi.acp.validateTool(row)));
			const firstInvalid = validations.findIndex((result) => !result.ok);
			if (firstInvalid >= 0) {
				const failed = validations[firstInvalid];
				// 自动展开出错行:行已收起时错误文案在列表外,不展开用户找不到是哪条
				expandKey(rows[firstInvalid]?.draftKey);
				if (failed && !failed.ok && failed.reasonKey) setError(t(failed.reasonKey));
				return false;
			}
			// 第二层:草稿间重名(同名新增行会让 sanitize 静默丢行,必须前置报错)
			const names = new Set<string>();
			for (const row of rows) {
				if (names.has(row.name)) {
					expandKey(row.draftKey);
					setError(t("acp.toolDuplicateName"));
					return false;
				}
				names.add(row.name);
			}
			// id 缺省 = 新增行,由主进程分配;返回的规范化表同步回 atom(菜单立即可见)。
			// draftKey 按位沿用:normalize 保序,收起态不因保存而重置。
			const normalized = await desktopApi.acp.saveTools(rows.map((row) => ({ id: row.id, name: row.name, command: row.command, args: row.args, env: envFromText(row.envText), bypassPermissions: row.bypassPermissions })));
			setRows(normalized.map((tool: AcpToolConfig, index: number) => ({ draftKey: rows[index]?.draftKey ?? makeRowKey(), id: tool.id, name: tool.name, command: tool.command, args: [...tool.args], envText: envToText(tool.env), bypassPermissions: tool.bypassPermissions === true })));
			setSaved(normalized);
			return true;
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			return false;
		}
	}, [rows, setSaved, makeRowKey, expandKey]);

	// 弹框头部统一「保存」按钮复用同一保存路径(校验/回写/脏标记清理完全一致)
	useImperativeHandle(ref, () => ({ save }), [save]);

	return (
		<div className="flex flex-col gap-4">
			<section className="flex flex-col gap-2">
				<div className="flex items-center justify-between gap-4">
					<div className="flex items-center gap-2">
						<h3 className="text-control font-semibold">{t("acp.toolsTitle")}</h3>
						{/* 实验性标识：ACP 多后端尚未经过完整使用测试，徽标常驻提示，反馈入口指向侧栏「问题反馈」 */}
						<Badge variant="outline" size="sm" className="font-normal text-muted-foreground">
							{t("acp.experimentalBadge")}
						</Badge>
					</div>
					<Switch checked={enabled === true} disabled={enabled === undefined} onCheckedChange={(checked) => void toggleEnabled(checked)} aria-label={t("acp.toolsTitle")} />
				</div>
				<p className="text-caption leading-relaxed text-muted-foreground">{t("acp.toolsDescription")}</p>
				<p className="text-caption leading-relaxed text-muted-foreground">{t("acp.experimentalHint")}</p>
				{enabled === true ? <p className="text-micro text-muted-foreground">{t("acp.enabledHint")}</p> : null}
			</section>
			{enabled !== true ? (
				// 关闭态:只展示引导文案,不跑检测不列登记表——opt-in,pi 用户零成本。
				<section className="flex flex-col gap-2">
					<p className="text-muted-foreground py-6 text-center text-xs">{t("acp.disabledHint")}</p>
				</section>
			) : (
				<>
					<AcpPresetChips onAdd={addFromPreset} />
					{rows.length === 0 ? (
						<p className="text-muted-foreground py-6 text-center text-xs">{t("acp.toolsEmpty")}</p>
					) : (
						<div className="flex flex-col gap-2">
							<SectionHeading title={t("acp.registeredTitle", { count: rows.length })} description={t("acp.registeredHint")} />
							{rows.map((row, index) => {
								const open = expandedKeys.has(row.draftKey);
								// 折叠态摘要:命令+参数一眼核对是不是某条 CLI;env 有内容才附条数。
								const commandSummary = [row.command.trim(), row.args.join(" ")].filter(Boolean).join(" ");
								const envLineCount = row.envText.split(/\r?\n/).filter((line) => line.trim()).length;
								return (
									// key 用本地 draftKey:折叠态跟着行走,删除中间行不会错位到相邻行
									<Collapsible key={row.draftKey} open={open} onOpenChange={(next) => toggleExpanded(row.draftKey, next)} className="border-border bg-background rounded-md border">
										{/* 折叠头 = 名称 + 命令摘要;删除按钮与 trigger 平级(button 嵌套 button 非法),收起时也能删。 */}
										<div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 py-2 pl-3 pr-2">
											<CollapsibleTrigger asChild>
												<button type="button" className="flex min-w-0 items-center gap-1.5 rounded text-left" title={open ? t("common.collapse") : t("common.expand")}>
													<ChevronDown size={14} aria-hidden="true" className={cn("shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
													<span className="shrink-0 truncate text-control font-medium text-foreground">{row.name.trim() || t("acp.toolUnnamed")}</span>
													{!open && commandSummary ? <code className="text-caption text-muted-foreground min-w-0 truncate font-mono">{commandSummary}</code> : null}
													{!open && envLineCount > 0 ? <span className="text-caption text-muted-foreground shrink-0">{t("acp.envCount", { count: envLineCount })}</span> : null}
												</button>
											</CollapsibleTrigger>
											<Button variant="ghost" size="icon" title={t("acp.toolRemove")} onClick={() => removeRow(index)}>
												<Trash2 size={14} aria-hidden="true" />
											</Button>
										</div>
										<CollapsibleContent className="flex flex-col gap-2 px-3 pb-3">
											{/* 字段一律带可见 label：此前只靠 placeholder，填了值之后就看不出这格是什么，
											    标签用隐式关联（label 包裹控件）同时补上可访问名。 */}
											<div className="grid grid-cols-2 items-end gap-2">
												<label className="flex min-w-0 flex-col gap-1">
													<span className="text-micro text-muted-foreground">{t("acp.toolName")}</span>
													<Input value={row.name} onChange={(event) => patchRow(index, { name: event.target.value })} />
												</label>
												<label className="flex min-w-0 flex-col gap-1">
													<span className="text-micro text-muted-foreground">{t("acp.toolCommand")}</span>
													<Input value={row.command} onChange={(event) => patchRow(index, { command: event.target.value })} />
												</label>
											</div>
											<label className="flex min-w-0 flex-col gap-1">
												<span className="text-micro text-muted-foreground">{t("acp.toolArgs")}</span>
												<Input
													value={row.args.join(" ")}
													onChange={(event) => {
														// 参数按空白拆分:与主进程 spawn 的数组语义一致,避免引号转义教学成本
														patchRow(index, { args: event.target.value.trim() ? event.target.value.split(/\s+/) : [] });
													}}
												/>
											</label>
											<label className="flex min-w-0 flex-col gap-1">
												<span className="text-micro text-muted-foreground">{t("acp.toolEnv")}</span>
												<Textarea value={row.envText} rows={2} className="font-mono text-xs" spellCheck={false} onChange={(event) => patchRow(index, { envText: event.target.value })} />
											</label>
											{/* 逐工具开关：有的 CLI 不认启动参数（Claude 适配器只认 settings.json），
									    只能握手后按它自己的 mode 枚举切，所以做成工具级配置而不是预设参数。 */}
											<label className="flex items-start gap-2">
												<Checkbox checked={row.bypassPermissions} onCheckedChange={(checked) => patchRow(index, { bypassPermissions: checked === true })} className="mt-0.5" />
												<span className="flex min-w-0 flex-col gap-0.5">
													<span className="text-micro text-muted-foreground">{t("acp.bypassPermissionsLabel")}</span>
													<span className="text-micro text-muted-foreground/80">{t("acp.bypassPermissionsHint")}</span>
												</span>
											</label>
										</CollapsibleContent>
									</Collapsible>
								);
							})}
						</div>
					)}
					{/* 工具表变更走弹框头部统一「保存」(经 ref.save 复用同一校验/回写链),此处不再重复放按钮 */}
					<Button variant="outline" size="sm" className="self-start" onClick={addRow}>
						<Plus size={14} aria-hidden="true" />
						{t("acp.toolAdd")}
					</Button>
					<AcpTimeoutSettings />
					<AcpRetrySettings />
				</>
			)}
			{error ? <p className="text-destructive text-xs">{error}</p> : null}
		</div>
	);
});

/** 脏标记投影:参数顺序无关(重排行不算脏),字段稳定序列化即可;入参放宽到字段子集,已存表投影无需补 draftKey。 */
function serializeRows(rows: Array<Pick<AcpToolRow, "id" | "name" | "command" | "args" | "envText" | "bypassPermissions">>): string {
	return JSON.stringify(rows.map((row) => ({ id: row.id ?? "", name: row.name, command: row.command, args: [...row.args].sort(), envText: row.envText, bypassPermissions: row.bypassPermissions })));
}

/**
 * 超时保护：回合无进展兑底（acpPromptTurnTimeoutMs）与完全静默判定（acpPromptStallTimeoutMs）。
 *
 * 两项都即时写盘（同总开关，不进弹框脏标记）：回合派发时实时读 settings，所以改完**下一个回合**就生效，
 * 不需要重启（手动改 settings.json 才需要，因为 SettingsStore 只在启动 load）。
 * 回合超时的语义是「无进展上限」：回合内有 session/update 或挂起审批就自动顺延，
 * 因此调大不会让卡死的会话一直挂着，只是放宽真静默的容忍度。
 */
function AcpTimeoutSettings() {
	const [turnDraft, setTurnDraft] = useState<string>("");
	// 已落盘的毫秒值：非法输入/写盘失败都回退到它，避免输入框停在用户以为生效的错值上。
	const [turnSaved, setTurnSaved] = useState<number>(ACP_TURN_TIMEOUT_DEFAULT_MS);
	const [stallDraft, setStallDraft] = useState<string>("");
	const [stallSaved, setStallSaved] = useState<number>(ACP_STALL_TIMEOUT_DEFAULT_MS);
	const [error, setError] = useState<string | undefined>();

	useEffect(() => {
		let cancelled = false;
		void desktopApi.settings
			.get()
			.then((settings) => {
				if (cancelled) return;
				// 缺省键 = 未自定义，输入框就显示生效中的代码默认值；用户不改不会写盘。
				setTurnSaved(settings.acpPromptTurnTimeoutMs ?? ACP_TURN_TIMEOUT_DEFAULT_MS);
				setStallSaved(settings.acpPromptStallTimeoutMs ?? ACP_STALL_TIMEOUT_DEFAULT_MS);
				setTurnDraft(acpTurnTimeoutText(settings.acpPromptTurnTimeoutMs));
				setStallDraft(acpStallTimeoutText(settings.acpPromptStallTimeoutMs));
			})
			.catch(() => {
				if (cancelled) return;
				setTurnDraft(acpTurnTimeoutText(undefined));
				setStallDraft(acpStallTimeoutText(undefined));
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const commitTurn = useCallback(
		async (raw: string) => {
			const patch = acpTurnTimeoutPatch(raw);
			if (!patch) {
				setTurnDraft(acpTurnTimeoutText(turnSaved));
				setError(t("acp.timeoutInvalid", { min: ACP_TURN_TIMEOUT_MINUTES.min, max: ACP_TURN_TIMEOUT_MINUTES.max }));
				return;
			}
			if (patch.acpPromptTurnTimeoutMs === turnSaved) {
				setTurnDraft(acpTurnTimeoutText(turnSaved));
				setError(undefined);
				return;
			}
			try {
				await desktopApi.settings.update(patch);
				setTurnSaved(patch.acpPromptTurnTimeoutMs ?? ACP_TURN_TIMEOUT_DEFAULT_MS);
				setTurnDraft(acpTurnTimeoutText(patch.acpPromptTurnTimeoutMs));
				setError(undefined);
			} catch (cause) {
				setTurnDraft(acpTurnTimeoutText(turnSaved));
				setError(t("acp.timeoutSaveFailed", { message: cause instanceof Error ? cause.message : String(cause) }));
			}
		},
		[turnSaved],
	);

	const commitStall = useCallback(
		async (raw: string) => {
			const patch = acpStallTimeoutPatch(raw);
			if (!patch) {
				setStallDraft(acpStallTimeoutText(stallSaved));
				setError(t("acp.timeoutInvalid", { min: ACP_STALL_TIMEOUT_SECONDS.min, max: ACP_STALL_TIMEOUT_SECONDS.max }));
				return;
			}
			if (patch.acpPromptStallTimeoutMs === stallSaved) {
				setStallDraft(acpStallTimeoutText(stallSaved));
				setError(undefined);
				return;
			}
			try {
				await desktopApi.settings.update(patch);
				setStallSaved(patch.acpPromptStallTimeoutMs ?? ACP_STALL_TIMEOUT_DEFAULT_MS);
				setStallDraft(acpStallTimeoutText(patch.acpPromptStallTimeoutMs));
				setError(undefined);
			} catch (cause) {
				setStallDraft(acpStallTimeoutText(stallSaved));
				setError(t("acp.timeoutSaveFailed", { message: cause instanceof Error ? cause.message : String(cause) }));
			}
		},
		[stallSaved],
	);

	return (
		<section className="flex flex-col gap-2">
			<SectionHeading title={t("acp.timeoutTitle")} description={t("acp.timeoutDescription")} />
			<div className="flex flex-col gap-3">
				<label className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
					<span className="flex min-w-0 flex-col gap-0.5">
						<span className="text-control font-medium text-foreground">{t("acp.timeoutTurnLabel")}</span>
						<span className="text-caption leading-relaxed text-muted-foreground">{t("acp.timeoutTurnDescription")}</span>
					</span>
					<span className="flex items-center gap-1.5">
						<Input
							type="number"
							inputMode="numeric"
							min={ACP_TURN_TIMEOUT_MINUTES.min}
							max={ACP_TURN_TIMEOUT_MINUTES.max}
							className="w-20 text-right"
							value={turnDraft}
							onChange={(event) => setTurnDraft(event.target.value)}
							onBlur={() => void commitTurn(turnDraft)}
							onKeyDown={(event) => {
								if (event.key === "Enter") event.currentTarget.blur();
							}}
						/>
						<span className="text-micro text-muted-foreground">{t("acp.timeoutUnitMinutes")}</span>
					</span>
				</label>
				<label className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
					<span className="flex min-w-0 flex-col gap-0.5">
						<span className="text-control font-medium text-foreground">{t("acp.timeoutStallLabel")}</span>
						<span className="text-caption leading-relaxed text-muted-foreground">{t("acp.timeoutStallDescription")}</span>
					</span>
					<span className="flex items-center gap-1.5">
						<Input
							type="number"
							inputMode="numeric"
							min={ACP_STALL_TIMEOUT_SECONDS.min}
							max={ACP_STALL_TIMEOUT_SECONDS.max}
							className="w-20 text-right"
							value={stallDraft}
							onChange={(event) => setStallDraft(event.target.value)}
							onBlur={() => void commitStall(stallDraft)}
							onKeyDown={(event) => {
								if (event.key === "Enter") event.currentTarget.blur();
							}}
						/>
						<span className="text-micro text-muted-foreground">{t("acp.timeoutUnitSeconds")}</span>
					</span>
				</label>
			</div>
			{error ? <p className="text-destructive text-xs">{error}</p> : null}
		</section>
	);
}

/**
 * 失败自动重试：ACP 回合因瞬时故障（网络抖动 / 网关 5xx / CLI 侧流断开）失败时，
 * 自动重发同一个 session/prompt —— 只在「本回合还没有任何输出」时重试，已有输出绝不重发。
 *
 * 与超时保护同一套写盘语义（即时写盘、下一回合生效）。关闭 = 回到引入自动重试前的行为：
 * 失败立刻报错 + 回填草稿。pi 与 DSH 后端各有内置重试，这一项只管 ACP。
 */
function AcpRetrySettings() {
	const [enabled, setEnabled] = useState<boolean | undefined>(undefined);
	const [maxRetriesDraft, setMaxRetriesDraft] = useState<string>("");
	// 已落盘的生效值：非法输入/写盘失败都回退到它，避免输入框停在用户以为生效的错值上。
	const [maxRetriesSaved, setMaxRetriesSaved] = useState<number>(ACP_RETRY_DEFAULT_MAX_RETRIES);
	const [baseDelayDraft, setBaseDelayDraft] = useState<string>("");
	const [baseDelaySaved, setBaseDelaySaved] = useState<number>(ACP_RETRY_DEFAULT_BASE_DELAY_MS);
	const [error, setError] = useState<string | undefined>();

	useEffect(() => {
		let cancelled = false;
		void desktopApi.settings
			.get()
			.then((settings) => {
				if (cancelled) return;
				// 缺省键 = 未自定义，输入框显示生效中的代码默认值；用户不改不会写盘。
				setEnabled(settings.acpTurnRetryEnabled ?? true);
				setMaxRetriesSaved(settings.acpTurnRetryMaxRetries ?? ACP_RETRY_DEFAULT_MAX_RETRIES);
				setBaseDelaySaved(settings.acpTurnRetryBaseDelayMs ?? ACP_RETRY_DEFAULT_BASE_DELAY_MS);
				setMaxRetriesDraft(acpRetryMaxRetriesText(settings.acpTurnRetryMaxRetries));
				setBaseDelayDraft(acpRetryBaseDelayText(settings.acpTurnRetryBaseDelayMs));
			})
			.catch(() => {
				if (cancelled) return;
				setMaxRetriesDraft(acpRetryMaxRetriesText(undefined));
				setBaseDelayDraft(acpRetryBaseDelayText(undefined));
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const commitMaxRetries = useCallback(
		async (raw: string) => {
			const patch = acpRetryMaxRetriesPatch(raw);
			if (!patch) {
				setMaxRetriesDraft(acpRetryMaxRetriesText(maxRetriesSaved));
				setError(t("acp.timeoutInvalid", { min: ACP_RETRY_MAX_RETRIES_RANGE.min, max: ACP_RETRY_MAX_RETRIES_RANGE.max }));
				return;
			}
			if (patch.acpTurnRetryMaxRetries === maxRetriesSaved) {
				setMaxRetriesDraft(acpRetryMaxRetriesText(maxRetriesSaved));
				setError(undefined);
				return;
			}
			try {
				await desktopApi.settings.update(patch);
				setMaxRetriesSaved(patch.acpTurnRetryMaxRetries ?? ACP_RETRY_DEFAULT_MAX_RETRIES);
				setMaxRetriesDraft(acpRetryMaxRetriesText(patch.acpTurnRetryMaxRetries));
				setError(undefined);
			} catch (cause) {
				setMaxRetriesDraft(acpRetryMaxRetriesText(maxRetriesSaved));
				setError(t("acp.timeoutSaveFailed", { message: cause instanceof Error ? cause.message : String(cause) }));
			}
		},
		[maxRetriesSaved],
	);

	const commitBaseDelay = useCallback(
		async (raw: string) => {
			const patch = acpRetryBaseDelayPatch(raw);
			if (!patch) {
				setBaseDelayDraft(acpRetryBaseDelayText(baseDelaySaved));
				setError(t("acp.timeoutInvalid", { min: ACP_RETRY_BASE_DELAY_SECONDS.min, max: ACP_RETRY_BASE_DELAY_SECONDS.max }));
				return;
			}
			if (patch.acpTurnRetryBaseDelayMs === baseDelaySaved) {
				setBaseDelayDraft(acpRetryBaseDelayText(baseDelaySaved));
				setError(undefined);
				return;
			}
			try {
				await desktopApi.settings.update(patch);
				setBaseDelaySaved(patch.acpTurnRetryBaseDelayMs ?? ACP_RETRY_DEFAULT_BASE_DELAY_MS);
				setBaseDelayDraft(acpRetryBaseDelayText(patch.acpTurnRetryBaseDelayMs));
				setError(undefined);
			} catch (cause) {
				setBaseDelayDraft(acpRetryBaseDelayText(baseDelaySaved));
				setError(t("acp.timeoutSaveFailed", { message: cause instanceof Error ? cause.message : String(cause) }));
			}
		},
		[baseDelaySaved],
	);

	const toggle = useCallback(async (next: boolean) => {
		const previous = enabled;
		setEnabled(next);
		try {
			await desktopApi.settings.update({ acpTurnRetryEnabled: next });
			setError(undefined);
		} catch (cause) {
			setEnabled(previous);
			setError(t("acp.timeoutSaveFailed", { message: cause instanceof Error ? cause.message : String(cause) }));
		}
	}, [enabled]);

	return (
		<section className="flex flex-col gap-2">
			<SectionHeading title={t("acp.retryTitle")} description={t("acp.retryDescription")} />
			<div className="flex flex-col gap-3">
				<div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
					<span className="flex min-w-0 flex-col gap-0.5">
						<span className="text-control font-medium text-foreground">{t("acp.retryEnabledLabel")}</span>
						<span className="text-caption leading-relaxed text-muted-foreground">{t("acp.retryEnabledDescription")}</span>
					</span>
					<Switch checked={enabled === true} disabled={enabled === undefined} onCheckedChange={(checked) => void toggle(checked)} aria-label={t("acp.retryEnabledLabel")} />
				</div>
				<label className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
					<span className="flex min-w-0 flex-col gap-0.5">
						<span className="text-control font-medium text-foreground">{t("acp.retryMaxRetriesLabel")}</span>
						<span className="text-caption leading-relaxed text-muted-foreground">{t("acp.retryMaxRetriesDescription")}</span>
					</span>
					<span className="flex items-center gap-1.5">
						<Input
							type="number"
							inputMode="numeric"
							min={ACP_RETRY_MAX_RETRIES_RANGE.min}
							max={ACP_RETRY_MAX_RETRIES_RANGE.max}
							className="w-20 text-right"
							value={maxRetriesDraft}
							onChange={(event) => setMaxRetriesDraft(event.target.value)}
							onBlur={() => void commitMaxRetries(maxRetriesDraft)}
							onKeyDown={(event) => {
								if (event.key === "Enter") event.currentTarget.blur();
							}}
						/>
						<span className="text-micro text-muted-foreground">{t("acp.retryUnitTimes")}</span>
					</span>
				</label>
				<label className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
					<span className="flex min-w-0 flex-col gap-0.5">
						<span className="text-control font-medium text-foreground">{t("acp.retryBaseDelayLabel")}</span>
						<span className="text-caption leading-relaxed text-muted-foreground">{t("acp.retryBaseDelayDescription")}</span>
					</span>
					<span className="flex items-center gap-1.5">
						<Input
							type="number"
							inputMode="numeric"
							min={ACP_RETRY_BASE_DELAY_SECONDS.min}
							max={ACP_RETRY_BASE_DELAY_SECONDS.max}
							className="w-20 text-right"
							value={baseDelayDraft}
							onChange={(event) => setBaseDelayDraft(event.target.value)}
							onBlur={() => void commitBaseDelay(baseDelayDraft)}
							onKeyDown={(event) => {
								if (event.key === "Enter") event.currentTarget.blur();
							}}
						/>
						<span className="text-micro text-muted-foreground">{t("acp.timeoutUnitSeconds")}</span>
					</span>
				</label>
			</div>
			{error ? <p className="text-destructive text-xs">{error}</p> : null}
		</section>
	);
}
