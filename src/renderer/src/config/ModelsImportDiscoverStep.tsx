// 导入面板「导入本地其他工具配置」入口：懒扫描本机其他 Agent 的供应商配置 → 勾选 → 拉取真实 key → 上抛供应商草稿。
// 状态随面板常驻挂载保留（切换选项卡/进入流程不重扫）；首次切到本选项卡才扫描（ADR 0024）。
import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "../components/ui-shadcn/button";
import { Checkbox } from "../components/ui-shadcn/checkbox";
import { t } from "../i18n";
import type { ProviderConfig, ModelsFile } from "./configTypes";
import { desktopApi } from "../desktopApi";
import type { ExternalAgentDiscoveryResult, ExternalAgentKind, ExternalAgentProviderFound } from "../../../shared/types/externalAgentDiscovery";

interface ModelsImportDiscoverStepProps {
	active: boolean;
	data: ModelsFile;
	onImported: (providers: Record<string, ProviderConfig>) => void;
}

const agentLabel = (agent: ExternalAgentKind): string => t(`config.models.transfer.agent.${agent}`);

const discoverNoteText = (note: string | undefined): string | undefined => {
	if (!note) return undefined;
	if (note === "no-key") return t("config.models.transfer.discoverNoteNoKey");
	if (note.startsWith("subscription")) return t("config.models.transfer.discoverNoteSubscription");
	return undefined;
};

/** 发现条目 → pi ProviderConfig 草稿（api 协议与 baseUrl 直接映射；模型转成最小条目）。 */
function foundToProviderConfig(found: ExternalAgentProviderFound, apiKey?: string): ProviderConfig {
	return {
		baseUrl: found.baseUrl,
		api: found.apiType,
		apiKey,
		models: found.modelIds.map((id) => ({ id })),
	};
}

/** 本机工具发现导入入口步：拉 key 后经 onImported 上抛，进入面板共享的勾选/冲突流程。 */
export function ModelsImportDiscoverStep(props: ModelsImportDiscoverStepProps) {
	const [error, setError] = useState<string | null>(null);
	const [scanning, setScanning] = useState(false);
	const [discovered, setDiscovered] = useState<ExternalAgentDiscoveryResult | null>(null);
	const [discoveredSelected, setDiscoveredSelected] = useState<Set<string>>(new Set());
	const scannedOnce = useRef(false);

	const handleScan = async () => {
		setScanning(true);
		setError(null);
		try {
			const result = await desktopApi.config.discoverExternalAgents();
			setDiscovered(result);
			setDiscoveredSelected(new Set(result.providers.filter((item) => (item.note !== undefined && item.note.startsWith("subscription") ? false : true)).map((item) => item.id)));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setScanning(false);
		}
	};

	// 懒扫描：读本机配置文件是只读小操作，但只有用户真正切到本选项卡才执行；结果在面板会话内保留，重扫走「重新扫描」。
	useEffect(() => {
		if (!props.active || scannedOnce.current) return;
		scannedOnce.current = true;
		void handleScan();
	}, [props.active]);

	/** 勾选后先逐条拉真实 key（失败仅降级为无 key 供应商），再进入通用 select/conflicts 流程。 */
	const handleApplyDiscovered = async () => {
		if (!discovered) return;
		if (discoveredSelected.size === 0) {
			setError(t("config.models.transfer.noProvidersSelected"));
			return;
		}
		setScanning(true);
		try {
			const next: Record<string, ProviderConfig> = {};
			for (const found of discovered.providers) {
				if (!discoveredSelected.has(found.id)) continue;
				let apiKey: string | undefined;
				const res = await desktopApi.config.resolveExternalAgentKey(found.id);
				if (res.ok) apiKey = res.apiKey;
				else if (found.apiKeyMasked) setError(t("config.models.transfer.discoverKeyFailed", { id: found.providerName, reason: res.error }));
				next[found.providerName] = foundToProviderConfig(found, apiKey);
			}
			props.onImported(next);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setScanning(false);
		}
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* scroll-ok: bounded —— 行数有硬上限（受控分页 / 上限常量 / 固定枚举），不随数据无限增长。 */}
			<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
				<div className="space-y-3">
					<div className="flex items-start justify-between gap-3">
						<p className="text-sm text-text-tertiary">{t("config.models.transfer.discoverHint")}</p>
						<Button variant="outline" size="sm" onClick={() => void handleScan()} disabled={scanning}>
							<RefreshCw size={14} className="mr-1" />
							{scanning ? t("config.models.transfer.discoverScanning") : t("config.models.transfer.discoverScan")}
						</Button>
					</div>
					{discovered && discovered.providers.length === 0 && !scanning && <p className="text-sm text-text-tertiary">{t("config.models.transfer.discoverEmpty")}</p>}
					{discovered && discovered.providers.length > 0 && (
						<div className="space-y-1">
							{discovered.providers.map((found) => {
								const noteText = discoverNoteText(found.note);
								return (
									<label key={found.id} className="flex items-center gap-2 py-1">
										<Checkbox
											checked={discoveredSelected.has(found.id)}
											onCheckedChange={() => {
												const next = new Set(discoveredSelected);
												if (next.has(found.id)) next.delete(found.id);
												else next.add(found.id);
												setDiscoveredSelected(next);
											}}
										/>
										<span className="font-medium">{found.providerName}</span>
										<span className="rounded-full border border-border-subtle px-1.5 py-px text-micro text-muted-foreground">{agentLabel(found.agent)}</span>
										{found.apiKeyMasked ? <span className="font-mono text-xs text-text-tertiary">{found.apiKeyMasked}</span> : null}
										{found.baseUrl ? <span className="min-w-0 flex-1 truncate text-xs text-text-tertiary">{found.baseUrl}</span> : null}
										{props.data.providers[found.providerName] ? <span className="text-xs text-warning">{t("config.models.transfer.conflictWithLocal")}</span> : <span className="text-xs text-info">{t("config.models.transfer.newProvider")}</span>}
										{noteText ? <span className="text-xs text-text-tertiary">{noteText}</span> : null}
									</label>
								);
							})}
							{discoveredSelected.size > 0 && <p className="text-xs text-text-tertiary">{t("config.models.transfer.discoverSelectedCount", { count: discoveredSelected.size })}</p>}
						</div>
					)}
					{error && <p className="text-sm text-danger">{error}</p>}
				</div>
			</div>
			<div className="flex shrink-0 items-center justify-end gap-2 border-t border-border-subtle px-5 py-3">
				<Button size="sm" onClick={() => void handleApplyDiscovered()} disabled={scanning || !discovered || discoveredSelected.size === 0}>
					{t("config.models.transfer.next")}
				</Button>
			</div>
		</div>
	);
}
