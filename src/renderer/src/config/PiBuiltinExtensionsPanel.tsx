/**
 * pi 原生内置扩展开关面板（计划 A4）。
 *
 * 为什么单独一块：扩展页原有的「内置」行是 **PiDeck 自己的** `pi-deck-*.ts`；
 * pi 随 CLI 分发的四个内置扩展（mcp / llama.cpp / codemode / tool-search）此前在
 * PiDeck 里完全不可见，用户只能在 TUI 的 `pi config` 里开关。白名单模式还会无条件
 * 把它们全部带回，导致「PiDeck 里关不掉」。本面板把开关写进 pi 原生 settings.json
 * （`-builtin:<name>` / `+builtin:<name>`），全局与项目作用域各自生效。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, AlertTriangle, RefreshCw } from "lucide-react";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import { Button } from "../components/ui-shadcn/button";
import { Switch } from "../components/ui-shadcn/switch";
import type { PiBuiltinExtension, PiResourceConfigSummary, PiResourceScope } from "../../../shared/types/piResources";
import type { ResourceScope } from "./resourceScopeModel";
import { isProjectUntrustedError } from "./projectResourceErrors";

type PiResourcesApi = {
	piResourcesSummary: (scope?: PiResourceScope) => Promise<PiResourceConfigSummary>;
	piResourcesSetBuiltin: (input: { scope?: PiResourceScope; name: PiBuiltinExtension; enabled: boolean; expectedRevision?: string }) => Promise<{ ok: boolean; error?: string; revision?: string }>;
};

function api(): PiResourcesApi {
	const desktop = (window as unknown as { piDesktop?: { config?: Partial<PiResourcesApi> } }).piDesktop;
	if (!desktop?.config?.piResourcesSummary || !desktop.config.piResourcesSetBuiltin) throw new Error("PiDeck pi resources API is not available");
	return desktop.config as PiResourcesApi;
}

/** 每个内置扩展的作用说明（工具/能力影响）。 */
const BUILTIN_HINTS: Record<PiBuiltinExtension, string> = {
	mcp: "config.piResources.builtin.mcp",
	"llama.cpp": "config.piResources.builtin.llama",
	codemode: "config.piResources.builtin.codemode",
	"tool-search": "config.piResources.builtin.toolSearch",
};

export function PiBuiltinExtensionsPanel(props: {
	scope: ResourceScope;
	projectId?: string;
	/** 切换成功后通知父层刷新依赖数据（例如 MCP 提示）。 */
	onChanged?: () => void;
}) {
	const scopeKind = props.scope === "project" && props.projectId ? "project" : "global";
	const projectId = scopeKind === "project" ? props.projectId : undefined;
	const scope: PiResourceScope = scopeKind === "project" && projectId ? { scope: "project", projectId } : { scope: "global" };
	const [snapshot, setSnapshot] = useState<{ scope: PiResourceScope; summary: PiResourceConfigSummary } | null>(null);
	const summary = snapshot && snapshot.scope.scope === scope.scope && (scope.scope === "global" || (snapshot.scope.scope === "project" && scope.scope === "project" && snapshot.scope.projectId === scope.projectId)) ? snapshot.summary : null;
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [toggling, setToggling] = useState<string | null>(null);
	const readVersion = useRef(0);
	const scopeVersion = useRef(0);
	const pendingToggle = useRef(false);

	const load = useCallback(async () => {
		const version = ++readVersion.current;
		setLoading(true);
		setError(null);
		try {
			const next = await api().piResourcesSummary(scope);
			if (version !== readVersion.current) return;
			setSnapshot({ scope, summary: next });
			setError(next.error ?? null);
		} catch (caught) {
			if (version !== readVersion.current) return;
			setSnapshot(null);
			setError(isProjectUntrustedError(caught) ? t("config.projectUntrusted.notice") : caught instanceof Error ? caught.message : String(caught));
		} finally {
			if (version === readVersion.current) setLoading(false);
		}
	}, [scopeKind, projectId]);

	useEffect(() => {
		setSnapshot(null);
		setToggling(null);
		pendingToggle.current = false;
		void load();
		return () => {
			// 切换作用域或卸载后，旧读写只能完成落盘，不得再覆盖当前面板。
			scopeVersion.current += 1;
			readVersion.current += 1;
		};
	}, [load]);

	const toggle = async (name: PiBuiltinExtension, enabled: boolean) => {
		// 四个开关共享同一 settings revision，必须串行；ref 同时挡住同一帧的重复点击。
		if (pendingToggle.current || loading || !summary || summary.error) return;
		const version = scopeVersion.current;
		pendingToggle.current = true;
		setToggling(name);
		setError(null);
		try {
			const result = await api().piResourcesSetBuiltin({ scope, name, enabled, expectedRevision: summary.revision });
			if (version !== scopeVersion.current) return;
			if (!result.ok) {
				// Refresh conflicts before displaying the error, while retaining the trust-gate guidance.
				if (result.error?.includes("changed on disk")) await load();
				if (version === scopeVersion.current) setError(isProjectUntrustedError(result.error) ? t("config.projectUntrusted.notice") : (result.error ?? t("config.piResources.saveFailed")));
				return;
			}
			await load();
			if (version !== scopeVersion.current) return;
			props.onChanged?.();
			showNotice(t("config.piResources.saved"), 2500);
		} catch (caught) {
			if (version === scopeVersion.current) setError(isProjectUntrustedError(caught) ? t("config.projectUntrusted.notice") : caught instanceof Error ? caught.message : String(caught));
		} finally {
			if (version === scopeVersion.current) {
				pendingToggle.current = false;
				setToggling(null);
			}
		}
	};

	return (
		<div className="mb-3 rounded-md border border-border-subtle bg-bg-panel p-3">
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0">
					<div className="text-control font-medium">{t("config.piResources.title")}</div>
					<p className="mt-0.5 text-micro text-muted-foreground">{t("config.piResources.hint")}</p>
				</div>
				<Button variant="outline" size="xs" onClick={() => void load()} disabled={loading || toggling !== null}>
					<RefreshCw size={13} />
					{t("common.refresh")}
				</Button>
			</div>

			{error ? (
				<div className="mt-2 flex items-start gap-1.5 rounded-sm border border-danger/20 bg-danger-soft px-2 py-1.5 text-micro text-danger">
					<AlertTriangle size={13} className="mt-px shrink-0" />
					<span className="break-all">{error}</span>
				</div>
			) : null}

			{loading && !summary ? (
				<div className="flex items-center justify-center gap-1.5 py-3 text-micro text-muted-foreground">
					<Loader2 size={12} className="animate-pideck-spin" aria-hidden="true" />
					{t("common.loading")}
				</div>
			) : null}

			{summary ? (
				<div className="mt-2 grid gap-1.5">
					{summary.builtins.map((item) => (
						<div key={item.name} className="flex items-center justify-between gap-3 rounded-sm border border-border-subtle px-2.5 py-1.5">
							<div className="min-w-0">
								<div className="flex items-center gap-1.5">
									<span className="font-mono text-control text-text-primary">builtin:{item.name}</span>
									<span className={`rounded-sm px-1 text-micro ${item.enabled ? "text-[var(--color-success)]" : "text-muted-foreground"}`}>{item.enabled ? t("config.piResources.on") : t("config.piResources.off")}</span>
									{item.state === "inherit" && scope.scope === "project" ? <span className="text-micro text-muted-foreground">· {t("config.piResources.inherited")}</span> : null}
									{item.toolEnabled !== undefined ? <span className={`text-micro ${item.toolEnabled ? "text-[var(--color-success)]" : "text-muted-foreground"}`}>· {item.toolEnabled ? t("config.piResources.toolOn") : t("config.piResources.toolOff")}</span> : null}
								</div>
								<div className="mt-0.5 text-micro text-muted-foreground">{t(BUILTIN_HINTS[item.name] as never)}</div>
							</div>
							<Switch checked={item.enabled} disabled={loading || toggling !== null || !!summary.error} onCheckedChange={(checked) => void toggle(item.name, checked)} aria-label={item.name} />
						</div>
					))}
					<p className="font-mono text-micro text-muted-foreground" title={summary.settingsPath}>
						{summary.settingsPath}
					</p>
					<p className="text-micro text-muted-foreground">{t("config.piResources.restartHint")}</p>
				</div>
			) : null}
		</div>
	);
}
