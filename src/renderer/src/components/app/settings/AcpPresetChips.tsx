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
import { openInSystemBrowser } from "../../../utils/openExternal";
import { ACP_TOOL_PRESETS, type AcpToolPreset } from "../../../../../shared/acpToolPresets";
import type { AcpToolStatus } from "../../../../../shared/types/acp";
import { Badge } from "../../ui-shadcn/badge";
import { Button } from "../../ui-shadcn/button";
import { ConfirmDialog } from "../../ui-shadcn/ConfirmDialog";
import { SectionHeading } from "../../ui-shadcn/section-heading";

type PresetAction = { preset: AcpToolPreset; kind: "install" | "uninstall" };

/** 单个预设芯片:名称点击=登记进工具表;徽章显示安装状态;npm 形态给安装/卸载按钮。 */
function PresetChip(props: { preset: AcpToolPreset; status?: AcpToolStatus; running: boolean; onAdd: (preset: AcpToolPreset) => void; onAction: (action: PresetAction) => void }) {
	const { preset, status, running, onAdd, onAction } = props;
	const npmInstallable = preset.install?.kind === "npm";
	const badgeText = !status ? t("acp.statusDetecting") : status.state === "installed" ? t("acp.statusInstalled", { version: status.version ?? "?" }) : status.state === "npx-ready" ? t("acp.statusNpxReady") : status.state === "missing" ? t("acp.statusMissing") : t("acp.statusUnknown");
	// missing 是「需要处理」，不能和 unknown 同灰；primary 是主题强调色，不是状态色。
	const badgeVariant = !status || status.state === "unknown" ? "neutral" : status.state === "missing" ? "warning" : "success";
	return (
		<div className="flex min-w-0 items-center gap-2 rounded-md border border-border-subtle bg-bg-panel px-2.5 py-1.5">
			<button type="button" className="hover:bg-accent flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left" title={t(PRESET_DESC_KEYS[preset.id])} onClick={() => onAdd(preset)}>
				<Plus size={12} aria-hidden="true" className="shrink-0" />
				<span className="truncate text-control">{preset.name}</span>
			</button>
			<Badge variant={badgeVariant} size="sm" className="shrink-0">
				{badgeText}
			</Badge>
			{running ? <Loader2 size={11} className="animate-pideck-spin shrink-0" aria-label={t("acp.installRunning")} /> : null}
			{/* 右侧动作组统一靠右：安装/卸载/外链三种可供性在网格里对齐成一列，
			    而不是每张芯片各自参差贴住名称。 */}
			<div className="ml-auto flex shrink-0 items-center gap-0.5">
				{npmInstallable && status?.state === "missing" ? (
					<Button variant="ghost" size="xs" title={t("acp.installAction")} onClick={() => onAction({ preset, kind: "install" })}>
						<Download aria-hidden="true" />
						{t("acp.installAction")}
					</Button>
				) : null}
				{npmInstallable && status?.state === "installed" ? (
					<Button variant="ghost" size="icon-xs" className="text-muted-foreground" title={t("acp.uninstallAction")} onClick={() => onAction({ preset, kind: "uninstall" })}>
						<Trash2 aria-hidden="true" />
					</Button>
				) : null}
				{preset.install?.kind === "manual" && status?.state === "missing" ? <span className="text-muted-foreground text-micro">{t("acp.manualInstallHint")}</span> : null}
				{/* 官方文档/安装页强制走系统浏览器：那是照着敲安装命令、下载安装包的页面，
				    塞进内置浏览器既没有下载能力也没有终端，用户还得再复制一遍 URL 出去。
				    与更新页的发行说明同一口径（openExternal(url, forceSystem)），不受「链接打开方式」设置影响。 */}
				<button type="button" className="text-muted-foreground hover:text-foreground" title={t("acp.presetHome")} onClick={() => void openInSystemBrowser(preset.homepage)}>
					<ExternalLink size={11} aria-hidden="true" />
				</button>
			</div>
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
			<SectionHeading title={t("acp.presetsTitle")} />
			<div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
				{ACP_TOOL_PRESETS.map((preset) => (
					<PresetChip key={preset.id} preset={preset} status={statuses[preset.id]} running={runningId === preset.id} onAdd={props.onAdd} onAction={setConfirmAction} />
				))}
			</div>
			{logLines.length > 0 ? (
				// scroll-ok: text —— 单一文本块（pre / markdown 正文），没有行列表可切，虚拟化无从下手。
				<pre className="bg-muted/50 text-muted-foreground max-h-28 overflow-y-auto rounded-md p-2 font-mono text-micro leading-relaxed" aria-label={t("acp.installLog")}>
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
	mimo: "acp.presetDesc.mimo",
	copilot: "acp.presetDesc.copilot",
	kilo: "acp.presetDesc.kilo",
	cline: "acp.presetDesc.cline",
	qoder: "acp.presetDesc.qoder",
	"qoder-cn": "acp.presetDesc.qoder-cn",
};
