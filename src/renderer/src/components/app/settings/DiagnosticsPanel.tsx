import { useCallback, useEffect, useState } from "react";
import type { DiagnosticsSnapshot } from "../../../../../shared/types";
import { formatBytes } from "../../../../../shared/formatBytes";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { Button } from "../../ui-shadcn/button";
import { SettingRow, SettingSwitchRow } from "./SettingRows";

type DiagnosticsPanelProps = {
	enabled: boolean;
	onChange: (enabled: boolean) => void;
};

/**
 * 开发设置里的性能诊断：开关 + 即时快照。
 * 采样在主进程，本面板只拉 snapshot / 打开目录；关着时零轮询，
 * 开着时 2s 拉一次——CPU 归因要看的是变化，手动刷新容易正好错过尖刺。
 */
export function DiagnosticsPanel(props: DiagnosticsPanelProps) {
	const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null);
	const [loading, setLoading] = useState(false);

	const refresh = useCallback(async (showLoading = true) => {
		if (showLoading) setLoading(true);
		try {
			const next = await desktopApi.system.getDiagnosticsSnapshot();
			if (next) setSnapshot(next);
		} catch {
			setSnapshot(null);
		} finally {
			if (showLoading) setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (!props.enabled) return;
		void refresh();
		const timer = setInterval(() => void refresh(false), 2000);
		return () => clearInterval(timer);
	}, [props.enabled, refresh]);

	const lag = snapshot?.eventLoopLagMs ?? 0;
	const maxLag = snapshot?.eventLoopLagMaxMs ?? 0;
	const timings = snapshot?.recentTimings ?? [];
	const processCpu = snapshot?.processCpu ?? [];

	return (
		<>
			<SettingSwitchRow title={t("settings.developerDiagnostics")} description={t("settings.developerDiagnosticsDesc")} checked={props.enabled} onChange={props.onChange} />
			{props.enabled ? (
				<>
					{/* 常规一行式：统计描述左列 + 两个按钮右列，不再上下两行；timings 列表单独放行下 */}
					<SettingRow
						title={<span>{t("settings.developerDiagnosticsRefresh")}</span>}
						description={
							snapshot
								? `${t("settings.developerDiagnosticsMemory", {
										rss: formatBytes(snapshot.main.rssBytes),
										heap: formatBytes(snapshot.main.heapUsedBytes),
									})} · ${t("settings.developerDiagnosticsLag", {
										lag: String(lag),
										max: String(maxLag),
									})}`
								: t("settings.developerDiagnosticsEmpty")
						}
					>
						<div className="flex items-center gap-2">
							<Button variant="secondary" size="sm" loading={loading} onClick={() => void refresh()}>
								{t("settings.developerDiagnosticsRefresh")}
							</Button>
							<Button variant="secondary" size="sm" onClick={() => void desktopApi.system.openDiagnosticsFolder()}>
								{t("settings.developerDiagnosticsOpenFolder")}
							</Button>
						</div>
					</SettingRow>
					{processCpu.length > 0 ? (
						// scroll-ok: text —— 单行文本列表（进程数 <= 十几个），无虚拟化必要。
						<div className="mt-1 max-h-40 overflow-auto px-1">
							<div className="font-mono text-caption text-muted-foreground">{t("settings.developerDiagnosticsProcesses")}</div>
							<ul className="font-mono text-caption text-muted-foreground">
								{processCpu.slice(0, 12).map((row) => (
									<li key={row.pid}>
										{processTypeLabel(row.type)} #{row.pid} {row.cpuPct}%{row.peakCpuPct > row.cpuPct ? ` · ${t("settings.developerDiagnosticsProcessPeak", { peak: String(row.peakCpuPct) })}` : ""}
									</li>
								))}
							</ul>
						</div>
					) : null}
					{timings.length > 0 ? (
						// scroll-ok: text —— 单一文本块（pre / markdown 正文），没有行列表可切，虚拟化无从下手。
						<ul className="mt-1 max-h-48 overflow-auto px-1 font-mono text-caption text-muted-foreground">
							{timings.slice(0, 20).map((item, index) => (
								<li key={`${item.name}-${item.startedAt}-${index}`}>
									{item.durationMs}ms {item.name}
									{item.detail?.agentId ? ` ${String(item.detail.agentId).slice(0, 8)}` : ""}
								</li>
							))}
						</ul>
					) : null}
				</>
			) : null}
		</>
	);
}

/** 进程类型到文案；Electron 新类型（Zygote 等）直接显示原值。 */
function processTypeLabel(type: string): string {
	switch (type) {
		case "Browser":
			return t("settings.developerDiagnosticsProcMain");
		case "Tab":
			return t("settings.developerDiagnosticsProcRender");
		case "GPU":
			return t("settings.developerDiagnosticsProcGpu");
		case "Utility":
			return t("settings.developerDiagnosticsProcUtility");
		default:
			return type;
	}
}
