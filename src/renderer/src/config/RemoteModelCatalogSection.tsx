import { AlertTriangle, Boxes, ChevronDown, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { REMOTE_MODEL_PROBE_CODES } from "../../../shared/types/remoteModel";
import { Button } from "../components/ui-shadcn/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui-shadcn/collapsible";
import { useConfigEditor } from "./useConfigEditorApi";
import { t } from "../i18n";
import { formatModelTokenCount, groupRemoteModelsByProvider, initialRemoteModelCatalogState, reduceRemoteModelCatalog, remoteModelProbeErrorKey } from "./remoteModelCatalogModel";

/**
 * Host-level catalog, loaded without a project or live session. Keep the full list collapsible so the
 * shared configuration editor remains reachable even when pi reports hundreds of built-in models.
 */
export function RemoteModelCatalogSection(props: { hostId: string }) {
	const { api } = useConfigEditor();
	const [state, dispatch] = useReducer(reduceRemoteModelCatalog, initialRemoteModelCatalogState);
	const generation = useRef(0);
	const loading = state.phase === "loading";
	const groups = state.phase === "ready" ? groupRemoteModelsByProvider(state.models) : [];

	const runProbe = useCallback(
		async (force = false) => {
			const request = ++generation.current;
			dispatch({ type: "started" });
			try {
				const result = await api.probeRemoteModels(props.hostId, force);
				if (request !== generation.current) return;
				if (result.ok && result.hostId !== props.hostId) throw new Error("host mismatch");
				dispatch({ type: "succeeded", result });
			} catch {
				// The IPC contract normally returns structured codes; a transport rejection is presented as unavailable.
				if (request === generation.current) dispatch({ type: "failed", code: REMOTE_MODEL_PROBE_CODES.unavailable });
			}
		},
		[api, props.hostId],
	);
	useEffect(() => {
		void runProbe();
		return () => {
			generation.current += 1;
		};
	}, [runProbe]);

	return (
		<div className="flex shrink-0 flex-col gap-2 rounded-md border border-border-subtle bg-bg-panel px-3 py-2" data-testid="remote-model-catalog" data-phase={state.phase}>
			<div className="flex flex-wrap items-center gap-2">
				<div className="flex min-w-0 flex-col">
					<span className="text-micro font-medium text-muted-foreground">{t("remoteModel.title")}</span>
					<span className="text-micro text-muted-foreground">{t("remoteModel.probeHint")}</span>
				</div>
				<Button type="button" variant="outline" size="sm" className="ml-auto h-8 gap-1.5" disabled={loading} onClick={() => void runProbe(true)} data-testid="remote-model-probe">
					<RefreshCw className={"size-3.5 " + (loading ? "animate-pideck-spin" : "")} aria-hidden="true" />
					{loading ? t("remoteModel.probing") : t("remoteModel.probeAction")}
				</Button>
			</div>

			{loading ? (
				<div className="py-2 text-center text-micro text-muted-foreground" data-testid="remote-model-probe-loading">
					{t("remoteModel.probing")}
				</div>
			) : null}

			{state.phase === "error" ? (
				<div className="flex flex-col gap-1 rounded-sm border border-danger/20 bg-danger-soft px-2.5 py-2" data-testid="remote-model-probe-error" data-code={state.code}>
					<div className="flex items-center gap-1.5 text-micro text-danger">
						<AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
						<span>{t(remoteModelProbeErrorKey(state.code ?? REMOTE_MODEL_PROBE_CODES.unavailable))}</span>
					</div>
				</div>
			) : null}

			{state.phase === "empty" ? (
				<div className="flex flex-col gap-1 text-micro text-muted-foreground" data-testid="remote-model-probe-empty" data-code={state.code}>
					<span className="flex items-center gap-1.5">
						<Boxes className="size-3.5 shrink-0" aria-hidden="true" />
						{t("remoteModel.empty")}
					</span>
				</div>
			) : null}

			{state.phase === "ready" ? (
				<Collapsible className="group/catalog" data-testid="remote-model-providers">
					<CollapsibleTrigger className="flex w-full items-center gap-1.5 text-left text-micro text-muted-foreground" data-testid="remote-model-probe-summary">
						<ChevronDown className="size-3.5 -rotate-90 transition-transform group-data-[state=open]/catalog:rotate-0" aria-hidden="true" />
						{t("remoteModel.readySummary", { count: state.count, providers: groups.length })}
					</CollapsibleTrigger>
					{/* 展开目录沿用配置页的纵向滚动，避免模型清单与外层表单争抢滚轮。 */}
					<CollapsibleContent className="pt-2">
						{groups.map((group) => (
							<section key={group.provider} className="mb-2 flex shrink-0 flex-col gap-1" data-testid="remote-model-provider" data-provider={group.provider}>
								<div className="flex items-baseline gap-1.5">
									<span className="text-micro font-medium text-foreground/90">{group.provider}</span>
									<span className="text-micro text-muted-foreground" data-testid="remote-model-provider-count">
										{t("remoteModel.providerCount", { count: group.models.length })}
									</span>
								</div>
								<ul className="grid gap-0.5">
									{group.models.map((model) => (
										<li key={model.provider + "\u0000" + model.id} className="flex flex-wrap items-baseline gap-1.5 text-micro" data-testid="remote-model-entry" data-provider={model.provider} data-model-id={model.id}>
											<span className="font-medium text-foreground/90">{model.name ?? model.id}</span>
											{model.name && model.name !== model.id ? <code className="font-mono text-muted-foreground">{model.id}</code> : null}
											{model.contextWindow !== undefined ? <span className="text-muted-foreground">{t("remoteModel.contextWindow", { tokens: formatModelTokenCount(model.contextWindow) })}</span> : null}
											{model.maxTokens !== undefined ? <span className="text-muted-foreground">{t("remoteModel.maxTokens", { tokens: formatModelTokenCount(model.maxTokens) })}</span> : null}
											{model.reasoning ? <span className="rounded-sm bg-bg-input px-1 text-muted-foreground">{t("remoteModel.reasoning")}</span> : null}
											{model.images || model.input?.includes("image") ? <span className="rounded-sm bg-bg-input px-1 text-muted-foreground">{t("remoteModel.vision")}</span> : null}
										</li>
									))}
								</ul>
							</section>
						))}
					</CollapsibleContent>
				</Collapsible>
			) : null}
		</div>
	);
}
