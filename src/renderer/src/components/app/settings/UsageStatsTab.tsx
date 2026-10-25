/**
 * 用量统计设置页 Tab。
 *
 * 数据源：pi-tracker（pi）+ dsh-bill（DSH）日志，主进程聚合后整体下发。
 * 三态：未安装（引导卡，仅 pi 侧需要装插件）/ 加载中 / 数据视图（空数据有专门空态）。
 * 图表为自绘 SVG（UsageHeatmap / UsageDailyChart），不引入图表库。
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { UsageAggregated, UsageStatsDetectResult } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { SettingsSection } from "./SettingsStorageTab";
import { Button } from "../../ui-shadcn/button";
import { UsageHeatmap } from "../usageStats/UsageHeatmap";
import { UsageDailyChart } from "../usageStats/UsageDailyChart";
import { UsageDayDetail } from "../usageStats/UsageDayDetail";
import { UsageTable } from "../usageStats/UsageTable";
import { formatCost, formatTokens } from "../usageStats/format";

type Phase = "loading" | "missing" | "ready" | "error";

/** 日期戳（ms）→ "YYYY-MM-DD" 本地格式。 */
function dateKey(ts: number): string {
	const d = new Date(ts);
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${m}-${day}`;
}

function SummaryCard(props: { label: string; value: React.ReactNode; sub?: string }) {
	return (
		<div className="usage-stats-card">
			<div className="usage-stats-card-label">{props.label}</div>
			<div className="usage-stats-card-value">{props.value}</div>
			{props.sub && <div className="usage-stats-card-sub">{props.sub}</div>}
		</div>
	);
}

function CostValue(props: { cost: number; costKnown: boolean }) {
	return (
		<span title={props.costKnown ? undefined : t("usageStats.cards.costUnknown")}>
			{formatCost(props.cost)}
			{!props.costKnown && <span className="usage-stats-unknown"> *</span>}
		</span>
	);
}

function NotInstalledCard(props: { onRefresh: () => void }) {
	const [installing, setInstalling] = useState(false);
	const [installed, setInstalled] = useState(false);
	const [copied, setCopied] = useState(false);
	const installCmd = "pi install npm:pi-tracker";

	const install = async () => {
		setInstalling(true);
		try {
			await window.piDesktop.extensions.install("npm:pi-tracker");
			setInstalled(true);
			// 装完触发一次重扫：日志可能已存在（用户此前手动装过）
			await props.onRefresh();
		} catch (error) {
			console.error("[UsageStats] install pi-tracker failed", error);
		} finally {
			setInstalling(false);
		}
	};

	const copyCommand = async () => {
		try {
			await navigator.clipboard.writeText(installCmd);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			// 剪贴板不可用时静默失败（命令仍可手选复制）
		}
	};

	return (
		<div className="usage-stats-not-installed">
			<p>{t("usageStats.notInstalled.desc")}</p>
			<div className="usage-stats-install-row">
				<Button variant="default" size="sm" onClick={install} disabled={installing || installed} loading={installing}>
					{installing ? t("usageStats.notInstalled.installing") : installed ? "✓" : t("usageStats.notInstalled.install")}
				</Button>
				<code className="usage-stats-code">{installCmd}</code>
				<Button variant="ghost" size="sm" onClick={copyCommand}>
					{copied ? t("usageStats.notInstalled.copied") : t("usageStats.notInstalled.copyCmd")}
				</Button>
			</div>
			{installed && <p className="usage-stats-hint">{t("usageStats.notInstalled.installDone")}</p>}
			<p className="usage-stats-hint">{t("usageStats.notInstalled.restartHint")}</p>
			<p className="usage-stats-hint">{t("usageStats.notInstalled.backfill")}</p>
		</div>
	);
}

function UsageRows(props: { data: UsageAggregated }) {
	const { data } = props;
	const days = Math.max(1, Math.round((data.window.to - data.window.since) / 86400000) + 1);
	return (
		<>
			{/* 按天明细（默认今日）：当日卡片 + provider 条 + 当日模型/项目表；可切其他天 */}
			<UsageDayDetail rows={data.daily} costKnown={data.costKnown} />
			{/* 累计概览：独立分块（divided 横线分隔），与上方当日区块明确区分 */}
			<SettingsSection divided boxed={false} id="settings-section-usage-overview" title={t("usageStats.cards.title")}>
				<div className="usage-stats-cards">
					<SummaryCard label={t("usageStats.cards.totalTokens")} value={formatTokens(data.totals.tokens)} sub={t("usageStats.cards.today") + " " + formatTokens(data.today.tokens)} />
					<SummaryCard label={t("usageStats.cards.totalCost")} value={<CostValue cost={data.totals.cost} costKnown={data.costKnown} />} sub={t("usageStats.cards.month") + " " + formatCost(data.thisMonth.cost)} />
					<SummaryCard label={t("usageStats.cards.turns")} value={String(data.totals.turns)} sub={t("usageStats.cards.week") + " " + data.thisWeek.turns} />
					<SummaryCard label={t("usageStats.cards.activeDays")} value={String(data.activeDays)} sub={t("usageStats.window", { since: dateKey(data.window.since), days })} />
				</div>
			</SettingsSection>
			{/* 卡片总览与首个图表区块之间仅保留一条横线（由 heatmap 分区的 divided 提供），
         图表区块均不套框，靠横线 + 标题分层 */}
			<SettingsSection divided boxed={false} id="settings-section-usage-heatmap" title={t("usageStats.heatmap.title")}>
				<UsageHeatmap data={data} />
			</SettingsSection>
			<SettingsSection divided boxed={false} id="settings-section-usage-daily" title={t("usageStats.daily.title")}>
				<UsageDailyChart data={data} />
			</SettingsSection>
			<SettingsSection divided boxed={false} id="settings-section-usage-models" title={t("usageStats.models.title")}>
				<UsageTable
					headers={[t("usageStats.models.col.model"), t("usageStats.models.col.tokens"), t("usageStats.models.col.cost"), t("usageStats.models.col.turns"), t("usageStats.models.col.sessions")]}
					rows={data.byModel.map((m) => [m.model, formatTokens(m.tokens), formatCost(m.cost), String(m.turns), String(m.sessions)])}
				/>
			</SettingsSection>
			<SettingsSection divided boxed={false} id="settings-section-usage-projects" title={t("usageStats.projects.title")}>
				<UsageTable headers={[t("usageStats.projects.col.project"), t("usageStats.models.col.tokens"), t("usageStats.models.col.cost"), t("usageStats.models.col.turns")]} rows={data.byProject.map((p) => [p.project, formatTokens(p.tokens), formatCost(p.cost), String(p.turns)])} />
			</SettingsSection>
		</>
	);
}

export function UsageStatsTab() {
	const [phase, setPhase] = useState<Phase>("loading");
	const [data, setData] = useState<UsageAggregated | null>(null);
	const [detect, setDetect] = useState<UsageStatsDetectResult | null>(null);
	const [error, setError] = useState("");
	const [refreshing, setRefreshing] = useState(false);

	/** pi-tracker 是否已安装（扩展列表探测；失败时按日志存在性兜底）。 */
	const [pluginInstalled, setPluginInstalled] = useState<boolean | null>(null);

	const probePluginInstalled = useCallback(async (): Promise<boolean | null> => {
		try {
			const list = await window.piDesktop.extensions.list();
			const found = list.extensions.some((ext) => {
				const source = ext.source ?? "";
				const id = ext.id ?? "";
				return id === "pi-tracker" || source.includes("pi-tracker");
			});
			setPluginInstalled(found);
			return found;
		} catch {
			// 扩展 API 不可用时（如预览环境）不阻塞：返回 null 由日志存在性兜底
			setPluginInstalled(null);
			return null;
		}
	}, []);

	const load = useCallback(async () => {
		try {
			const detectResult = await window.piDesktop.usageStats.detect();
			setDetect(detectResult);
			const installed = await probePluginInstalled();
			if (!detectResult.installed && installed === false) {
				// 两边都还没日志，且未装 pi-tracker → 引导安装（文案同时说明 DSH 已内置 dsh-bill）
				setPhase("missing");
				return;
			}
			setRefreshing(true);
			const aggregated = await window.piDesktop.usageStats.get();
			setData(aggregated);
			setPhase("ready");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setPhase("error");
		} finally {
			setRefreshing(false);
		}
	}, [probePluginInstalled]);

	useEffect(() => {
		void load();
	}, [load]);

	const refresh = useCallback(async () => {
		setRefreshing(true);
		try {
			await window.piDesktop.usageStats.refresh();
			const aggregated = await window.piDesktop.usageStats.get();
			setData(aggregated);
			setPhase((prev) => (prev === "missing" && aggregated ? "ready" : prev));
			// 重试探测：可能刚装上插件
			const detectResult = await window.piDesktop.usageStats.detect();
			setDetect(detectResult);
			const installedNow = await probePluginInstalled();
			if (!aggregated && (detectResult.installed || installedNow === true)) {
				// 已安装但没数据：切到 ready 显示空态
				setPhase("ready");
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setPhase("error");
		} finally {
			setRefreshing(false);
		}
	}, [probePluginInstalled]);

	return (
		<>
			{/* 顶部工具栏：日志路径提示（左）+ 刷新按钮（右，用户要求从底部移到顶部） */}
			<div className="flex flex-wrap items-center justify-between gap-2">
				{detect?.logPath && <p className="break-all px-0.5 pb-3 text-caption text-muted-foreground">{detect.logPath}</p>}
				{(phase === "ready" || phase === "missing") && (
					<Button variant="secondary" size="sm" className="ml-auto" onClick={refresh} disabled={refreshing} loading={refreshing}>
						{refreshing ? t("usageStats.refreshing") : t("usageStats.refresh")}
					</Button>
				)}
			</div>
			{phase === "loading" && (
				<div className="usage-stats-hint flex items-center justify-center gap-2">
					<Loader2 size={14} className="animate-pideck-spin" aria-hidden="true" />
					{t("usageStats.loading")}
				</div>
			)}
			{phase === "missing" && <NotInstalledCard onRefresh={refresh} />}
			{phase === "error" && (
				<div className="usage-stats-hint">
					{t("usageStats.error")}
					<br />
					<small>{t("usageStats.errorHint", { message: error })}</small>
				</div>
			)}
			{phase === "ready" && data && data.recordCount > 0 && <UsageRows data={data} />}
			{phase === "ready" && (!data || data.recordCount === 0) && (
				<div className="usage-stats-hint">
					{t("usageStats.empty.title")}
					<br />
					<small>{t("usageStats.empty.desc")}</small>
					<br />
					<small>{t("usageStats.empty.backfill")}</small>
				</div>
			)}
		</>
	);
}
