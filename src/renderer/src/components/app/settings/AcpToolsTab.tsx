import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from "react";
import { useAtom } from "jotai";
import { Plus, Trash2 } from "lucide-react";
import { desktopApi } from "../../../desktopApi";
import { acpToolsAtom } from "../../../atoms";
import { t } from "../../../i18n";
import type { AcpToolConfig } from "../../../../../shared/types/acp";
import type { AcpToolPreset } from "../../../../../shared/acpToolPresets";
import { Switch } from "../../ui-shadcn/switch";
import { AcpPresetChips } from "./AcpPresetChips";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { Textarea } from "../../ui-shadcn/textarea";

/** 草稿行 = IPC 输入形态:id 空表示新增行,保存时由主进程分配并返回。 */
type AcpToolRow = { id?: string; name: string; command: string; args: string[]; envText: string };

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
 * - 总开关即时写盘(settings.acpEnabled,同 WebRemoteAccessSection 模式),变更重启生效;
 *   关闭态只显示引导文案——opt-in,pi 用户零运行时成本(主进程不注册 ACP 网关)。
 * - 预设芯片(AcpPresetChips)管「本机 CLI 装没装」:检测只读,npm 安装/卸载经确认弹窗。
 * - 工具表初值来自 acpToolsAtom(App 挂载时经 acpToolsList IPC 拉取),保存走
 *   acpToolsSave(主进程 sanitizeAcpTools 消毒落盘,返回规范化表),成功后
 *   整表回写 atom——新建会话菜单与设置页共享同一份快照,无需事件订阅;
 * - 校验双层:保存前逐条走主进程 validateTool(名称/命令必填、与已存表查重),
 *   再本地查草稿间重名(两条新增行同名时主进程 sanitize 会静默丢第二条,必须前置拦下);
 * - 删除行只改草稿,点「保存」才写盘;未保存关闭由 SettingsModal 脏标记确认兜底。
 */
export type AcpToolsTabHandle = { save: () => Promise<boolean> };

export const AcpToolsTab = forwardRef<AcpToolsTabHandle, { onDirtyChange?: (dirty: boolean) => void }>(function AcpToolsTab(props, ref) {
	const [saved, setSaved] = useAtom(acpToolsAtom);
	const [rows, setRows] = useState<AcpToolRow[]>([]);
	const [hydrated, setHydrated] = useState(false);
	const [saving, setSaving] = useState(false);
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

	const toggleEnabled = useCallback(async (next: boolean) => {
		setEnabled(next);
		try {
			await desktopApi.settings.update({ acpEnabled: next });
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setEnabled(!next);
		}
	}, []);

	// 挂载时以 atom 快照为初值;之后只经保存回写,弹窗开关不重复拉 IPC
	useEffect(() => {
		if (!hydrated) {
			setRows(saved.map((tool) => ({ id: tool.id, name: tool.name, command: tool.command, args: [...tool.args], envText: envToText(tool.env) })));
			setHydrated(true);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- 一次性初值同步,后续以保存回写为准
	}, [hydrated]);

	const dirty = useMemo(() => serializeRows(rows) !== serializeRows(saved.map((tool) => ({ id: tool.id, name: tool.name, command: tool.command, args: [...tool.args], envText: envToText(tool.env) }))), [rows, saved]);
	useEffect(() => {
		props.onDirtyChange?.(dirty);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- onDirtyChange 由弹框稳定传入,不参与比较
	}, [dirty]);

	const patchRow = useCallback((index: number, patch: Partial<AcpToolRow>) => {
		setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
	}, []);

	const removeRow = useCallback((index: number) => {
		setRows((current) => current.filter((_, i) => i !== index));
	}, []);

	const addRow = useCallback(() => {
		setRows((current) => [...current, { name: "", command: "", args: [], envText: "" }]);
	}, []);

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
			setRows((current) => [...current, { name: preset.name, command: preset.command, args: [...preset.args], envText: "" }]);
		},
		[rows],
	);

	const save = useCallback(async (): Promise<boolean> => {
		setSaving(true);
		setError(undefined);
		try {
			// 第一层:主进程逐条校验(必填 + 与已存表查重;主进程不知草稿全貌)
			const validations = await Promise.all(rows.map((row) => desktopApi.acp.validateTool(row)));
			const firstInvalid = validations.findIndex((result) => !result.ok);
			if (firstInvalid >= 0) {
				const failed = validations[firstInvalid];
				if (failed && !failed.ok && failed.reasonKey) setError(t(failed.reasonKey));
				return false;
			}
			// 第二层:草稿间重名(同名新增行会让 sanitize 静默丢行,必须前置报错)
			const names = new Set<string>();
			for (const row of rows) {
				if (names.has(row.name)) {
					setError(t("acp.toolDuplicateName"));
					return false;
				}
				names.add(row.name);
			}
			// id 缺省 = 新增行,由主进程分配;返回的规范化表同步回 atom(菜单立即可见)
			const normalized = await desktopApi.acp.saveTools(rows.map((row) => ({ id: row.id, name: row.name, command: row.command, args: row.args, env: envFromText(row.envText) })));
			setRows(normalized.map((tool: AcpToolConfig) => ({ id: tool.id, name: tool.name, command: tool.command, args: [...tool.args], envText: envToText(tool.env) })));
			setSaved(normalized);
			return true;
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			return false;
		} finally {
			setSaving(false);
		}
	}, [rows, setSaved]);

	// 弹框头部统一「保存」按钮复用同一保存路径(校验/回写/脏标记清理完全一致)
	useImperativeHandle(ref, () => ({ save }), [save]);

	return (
		<div className="flex flex-col gap-4">
			<section className="flex flex-col gap-2">
				<div className="flex items-center justify-between gap-4">
					<h3 className="text-sm font-semibold">{t("acp.toolsTitle")}</h3>
					<Switch checked={enabled === true} disabled={enabled === undefined} onCheckedChange={(checked) => void toggleEnabled(checked)} aria-label={t("acp.toolsTitle")} />
				</div>
				<p className="text-muted-foreground text-xs leading-relaxed">{t("acp.toolsDescription")}</p>
				{enabled === true ? <p className="text-muted-foreground text-[11px]">{t("acp.enabledHint")}</p> : null}
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
						<div className="flex flex-col gap-3">
							{rows.map((row, index) => (
								// 行 key 用 index:新增/删除都经整表保存,草稿行没有稳定身份
								<div key={index} className="border-border bg-background flex flex-col gap-2 rounded-md border p-3">
									<div className="grid grid-cols-[1fr_1fr_auto] gap-2">
										<Input value={row.name} placeholder={t("acp.toolName")} onChange={(event) => patchRow(index, { name: event.target.value })} />
										<Input value={row.command} placeholder={t("acp.toolCommand")} onChange={(event) => patchRow(index, { command: event.target.value })} />
										<Button variant="ghost" size="icon" title={t("acp.toolRemove")} onClick={() => removeRow(index)}>
											<Trash2 size={14} aria-hidden="true" />
										</Button>
									</div>
									<Input
										value={row.args.join(" ")}
										placeholder={t("acp.toolArgs")}
										onChange={(event) => {
											// 参数按空白拆分:与主进程 spawn 的数组语义一致,避免引号转义教学成本
											patchRow(index, { args: event.target.value.trim() ? event.target.value.split(/\s+/) : [] });
										}}
									/>
									<Textarea value={row.envText} placeholder={t("acp.toolEnv")} rows={2} className="font-mono text-xs" spellCheck={false} onChange={(event) => patchRow(index, { envText: event.target.value })} aria-label={t("acp.toolEnv")} />
								</div>
							))}
						</div>
					)}
					<div className="flex items-center justify-between">
						<Button variant="outline" size="sm" onClick={addRow}>
							<Plus size={14} aria-hidden="true" />
							{t("acp.toolAdd")}
						</Button>
						<Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
							{saving ? t("common.saving") : t("common.save")}
						</Button>
					</div>
				</>
			)}
			{error ? <p className="text-destructive text-xs">{error}</p> : null}
		</div>
	);
});

/** 脏标记投影:参数顺序无关(重排行不算脏),字段稳定序列化即可。 */
function serializeRows(rows: AcpToolRow[]): string {
	return JSON.stringify(rows.map((row) => ({ id: row.id ?? "", name: row.name, command: row.command, args: [...row.args].sort(), envText: row.envText })));
}
