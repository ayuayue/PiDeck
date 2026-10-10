/**
 * ACP 预设工具的「生命周期芯片」:安装检测/版本徽章/一键安装卸载。
 *
 * 独立于工具登记表(那个管 settings.acpTools;这里管的是本机 CLI 装没装)。
 * 检测只读,tab 挂载时并行跑一遍;安装/卸载是全局 npm 副作用,ConfirmDialog
 * 把关后执行,进度行经 onLifecycleEvent 订阅展示(npm 输出等宽小字,尾截 30 行)。
 * manual 形态(claude/cursor 官网脚本)不提供安装按钮,只留官网链接引导。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, ExternalLink, Loader2, Plus, Trash2 } from "lucide-react";
import { desktopApi } from "../../../desktopApi";
import { t } from "../../../i18n";
import { ACP_TOOL_PRESETS, type AcpToolPreset } from "../../../../../shared/acpToolPresets";
import type { AcpToolStatus } from "../../../../../shared/types/acp";
import { Button } from "../../ui-shadcn/button";
import { ConfirmDialog } from "../../ui-shadcn/ConfirmDialog";

type PresetAction = { preset: AcpToolPreset; kind: "install" | "uninstall" };

/** 单个预设芯片:名称点击=登记进工具表;徽章显示安装状态;npm 形态给安装/卸载按钮。 */
function PresetChip(props: { preset: AcpToolPreset; status?: AcpToolStatus; running: boolean; onAdd: (preset: AcpToolPreset) => void; onAction: (action: PresetAction) => void }) {
	const { preset, status, running, onAdd, onAction } = props;
	const npmInstallable = preset.install?.kind === "npm";
	const badgeText = !status ? t("acp.statusDetecting") : status.state === "installed" ? t("acp.statusInstalled", { version: status.version ?? "?" }) : status.state === "npx-ready" ? t("acp.statusNpxReady") : status.state === "missing" ? t("acp.statusMissing") : t("acp.statusUnknown");
	const badgeTone = !status || status.state === "unknown" ? "text-muted-foreground" : status.state === "installed" || status.state === "npx-ready" ? "text-primary" : "text-muted-foreground";
	return (
		<div className="border-border bg-background flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-1.5">
			<button type="button" className="hover:bg-accent flex items-center gap-1.5 rounded px-1 py-0.5 text-left" title={t(PRESET_DESC_KEYS[preset.id])} onClick={() => onAdd(preset)}>
				<Plus size={12} aria-hidden="true" />
				<span className="text-xs">{preset.name}</span>
			</button>
			<span className={`text-[10px] ${badgeTone}`}>{badgeText}</span>
			{running ? <Loader2 size={11} className="animate-pideck-spin" aria-label={t("acp.installRunning")} /> : null}
			{npmInstallable && status?.state === "missing" ? (
				<Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]" title={t("acp.installAction")} onClick={() => onAction({ preset, kind: "install" })}>
					<Download size={11} aria-hidden="true" />
					{t("acp.installAction")}
				</Button>
			) : null}
			{npmInstallable && status?.state === "installed" ? (
				<Button variant="ghost" size="sm" className="text-muted-foreground h-6 px-1.5 text-[11px]" title={t("acp.uninstallAction")} onClick={() => onAction({ preset, kind: "uninstall" })}>
					<Trash2 size={11} aria-hidden="true" />
				</Button>
			) : null}
			{preset.install?.kind === "manual" && status?.state === "missing" ? <span className="text-muted-foreground text-[10px]">{t("acp.manualInstallHint")}</span> : null}
			<a href={preset.homepage} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground" title={t("acp.presetHome")}>
				<ExternalLink size={11} aria-hidden="true" />
			</a>
		</div>
	);
}

export function AcpPresetChips(props: { onAdd: (preset: AcpToolPreset) => void }) {
	const [statuses, setStatuses] = useState<Partial<Record<string, AcpToolStatus>>>({});
	const [runningId, setRunningId] = useState<string | undefined>();
	const [logLines, setLogLines] = useState<string[]>([]);
	const [confirmAction, setConfirmAction] = useState<PresetAction | undefined>();
	const confirmRef = useRef<PresetAction | undefined>(undefined);
	confirmRef.current = confirmAction;

	const detect = useCallback(async (presetId: string) => {
		try {
			const status = await desktopApi.acp.detectTool(presetId as Parameters<typeof desktopApi.acp.detectTool>[0]);
			setStatuses((current) => ({ ...current, [presetId]: status }));
		} catch {
			setStatuses((current) => ({ ...current, [presetId]: { presetId: presetId as AcpToolStatus["presetId"], state: "unknown" } }));
		}
	}, []);

	// 挂载并行检测全部预设(只读);安装/卸载完成后单点重测。
	useEffect(() => {
		for (const preset of ACP_TOOL_PRESETS) void detect(preset.id);
	}, [detect]);

	// 安装/卸载进度订阅:行追加(尾截 30 行防长日志撑爆弹窗)。
	useEffect(() => {
		const unsubscribe = desktopApi.acp.onLifecycleEvent((event) => {
			if (event.phase === "line") {
				setLogLines((current) => [...current, event.line].slice(-30));
			} else {
				setLogLines((current) => [...current, event.ok ? t("acp.installDone") : t("acp.installFailed")].slice(-30));
			}
		});
		return unsubscribe;
	}, []);

	const runAction = useCallback(
		async (action: PresetAction) => {
			setRunningId(action.preset.id);
			setLogLines([]);
			try {
				await desktopApi.acp[action.kind === "install" ? "installTool" : "uninstallTool"](action.preset.id);
			} catch (cause) {
				setLogLines((current) => [...current, cause instanceof Error ? cause.message : String(cause)]);
			} finally {
				setRunningId(undefined);
				void detect(action.preset.id);
			}
		},
		[detect],
	);

	return (
		<section className="flex flex-col gap-2">
			<h4 className="text-xs font-semibold">{t("acp.presetsTitle")}</h4>
			<div className="flex flex-wrap gap-2">
				{ACP_TOOL_PRESETS.map((preset) => (
					<PresetChip key={preset.id} preset={preset} status={statuses[preset.id]} running={runningId === preset.id} onAdd={props.onAdd} onAction={setConfirmAction} />
				))}
			</div>
			{logLines.length > 0 ? (
				<pre className="bg-muted/50 text-muted-foreground max-h-28 overflow-y-auto rounded-md p-2 font-mono text-[10px] leading-relaxed" aria-label={t("acp.installLog")}>
					{logLines.join("\n")}
				</pre>
			) : (
				<p className="text-muted-foreground text-xs">{t("acp.presetsHint")}</p>
			)}
			{confirmAction ? (
				<ConfirmDialog
					title={t(confirmAction.kind === "install" ? "acp.installConfirmTitle" : "acp.uninstallConfirmTitle", { name: confirmAction.preset.name })}
					message={t(confirmAction.kind === "install" ? "acp.installConfirmMessage" : "acp.uninstallConfirmMessage", { pkg: confirmAction.preset.install?.kind === "npm" ? confirmAction.preset.install.package : "" })}
					danger={confirmAction.kind === "uninstall"}
					onConfirm={() => {
						const action = confirmAction;
						setConfirmAction(undefined);
						if (action) void runAction(action);
					}}
					onCancel={() => setConfirmAction(undefined)}
				/>
			) : null}
		</section>
	);
}

/** 预设 id → i18n 描述 key：静态字面量映射保证 t() 的 key 联合类型可收窄(模板字符串拼不出来)。 */
const PRESET_DESC_KEYS: Record<AcpToolPreset["id"], Parameters<typeof t>[0]> = {
	gemini: "acp.presetDesc.gemini",
	"claude-agent": "acp.presetDesc.claude-agent",
	codex: "acp.presetDesc.codex",
	kimi: "acp.presetDesc.kimi",
	qwen: "acp.presetDesc.qwen",
	opencode: "acp.presetDesc.opencode",
	"cursor-agent": "acp.presetDesc.cursor-agent",
	codebuddy: "acp.presetDesc.codebuddy",
	minimax: "acp.presetDesc.minimax",
};
