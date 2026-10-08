import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from "react";
import { useAtom } from "jotai";
import { ExternalLink, Plus, Trash2 } from "lucide-react";
import { desktopApi } from "../../../desktopApi";
import { acpToolsAtom } from "../../../atoms";
import { t } from "../../../i18n";
import type { AcpToolConfig } from "../../../../../shared/types/acp";
import { ACP_TOOL_PRESETS, type AcpToolPreset, type AcpToolPresetId } from "../../../../../shared/acpToolPresets";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";

/** 草稿行 = IPC 输入形态:id 空表示新增行,保存时由主进程分配并返回。 */
type AcpToolRow = { id?: string; name: string; command: string; args: string[] };

/**
 * 设置弹窗「ACP 工具」tab:管理 settings.acpTools 表(名称/命令/启动参数)。
 *
 * 数据流(与 pi/dsh 设置无关的独立持久层,模式同生图 tab):
 * - 初值来自 acpToolsAtom(App 挂载时经 acpToolsList IPC 拉取),保存走
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

	// 挂载时以 atom 快照为初值;之后只经保存回写,弹窗开关不重复拉 IPC
	useEffect(() => {
		if (!hydrated) {
			setRows(saved.map((tool) => ({ id: tool.id, name: tool.name, command: tool.command, args: [...tool.args] })));
			setHydrated(true);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- 一次性初值同步,后续以保存回写为准
	}, [hydrated]);

	const dirty = useMemo(() => serializeRows(rows) !== serializeRows(saved.map((tool) => ({ id: tool.id, name: tool.name, command: tool.command, args: [...tool.args] }))), [rows, saved]);
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
		setRows((current) => [...current, { name: "", command: "", args: [] }]);
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
			setRows((current) => [...current, { name: preset.name, command: preset.command, args: [...preset.args] }]);
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
			const normalized = await desktopApi.acp.saveTools(rows.map((row) => ({ id: row.id, name: row.name, command: row.command, args: row.args })));
			setRows(normalized.map((tool: AcpToolConfig) => ({ id: tool.id, name: tool.name, command: tool.command, args: [...tool.args] })));
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
				<h3 className="text-sm font-semibold">{t("acp.toolsTitle")}</h3>
				<p className="text-muted-foreground text-xs leading-relaxed">{t("acp.toolsDescription")}</p>
			</section>
			<section className="flex flex-col gap-2">
				<h4 className="text-xs font-semibold">{t("acp.presetsTitle")}</h4>
				<div className="flex flex-wrap gap-2">
					{ACP_TOOL_PRESETS.map((preset) => (
						<div key={preset.id} className="border-border bg-background flex items-center gap-2 rounded-md border px-2.5 py-1.5">
							<button type="button" className="hover:bg-accent flex items-center gap-1.5 rounded px-1 py-0.5 text-left" title={t(PRESET_DESC_KEYS[preset.id])} onClick={() => addFromPreset(preset)}>
								<Plus size={12} aria-hidden="true" />
								<span className="text-xs">{preset.name}</span>
							</button>
							<a href={preset.homepage} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground" title={t("acp.presetHome")}>
								<ExternalLink size={11} aria-hidden="true" />
							</a>
						</div>
					))}
				</div>
				<p className="text-muted-foreground text-xs">{t("acp.presetsHint")}</p>
			</section>
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
			{error ? <p className="text-destructive text-xs">{error}</p> : null}
		</div>
	);
});

/** 预设 id → i18n 描述 key：静态字面量映射保证 t() 的 key 联合类型可收窄(模板字符串拼不出来)。 */
const PRESET_DESC_KEYS: Record<AcpToolPresetId, Parameters<typeof t>[0]> = {
	gemini: "acp.presetDesc.gemini",
	"claude-agent": "acp.presetDesc.claude-agent",
	codex: "acp.presetDesc.codex",
	kimi: "acp.presetDesc.kimi",
	qwen: "acp.presetDesc.qwen",
	opencode: "acp.presetDesc.opencode",
};

/** 脏标记投影:参数顺序无关(重排行不算脏),字段稳定序列化即可。 */
function serializeRows(rows: AcpToolRow[]): string {
	return JSON.stringify(rows.map((row) => ({ id: row.id ?? "", name: row.name, command: row.command, args: [...row.args].sort() })));
}
