import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, KeyRound, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { REMOTE_CONFIG_CODES, isRemotePiAuthSnapshot, remotePiConfigCodeFromError, type RemotePiAuthProvider, type RemotePiAuthSnapshot } from "../../../shared/piConfig";
import { desktopApi } from "../desktopApi";
import { Button } from "../components/ui-shadcn/button";
import { t } from "../i18n";
import { cn } from "../lib/utils";
import { remoteConfigErrorKey, shortConfigDigest } from "./remoteConfigModel";
import { useRemoteHostConnection } from "./useRemoteHostConnection";

/**
 * SSH 环境的「认证」页：只读的远端 auth.json 派生视图。
 *
 * 为什么是只读而不是把 AuthTab 搬过来：凭据结构性不可跨机回传（helper 的 config.readAuth 只回答
 * provider / 凭据类型 / 是否已配置），因此这里没有输入端，也没有保存/脏标记——页面不能提供一个
 * 「看起来能改、其实写不进去」的表单。改凭据的正确动作发生在那台主机上（pi /login 或直接编辑文件），
 * 界面只负责把「那台机器现在有哪些凭据」如实显示出来。
 */

export type RemoteAuthState = { phase: "loading" } | { phase: "ready"; snapshot: RemotePiAuthSnapshot } | { phase: "failed"; code: string };

export type RemoteAuthPanelPorts = {
	read: (input: { hostId: string }) => Promise<unknown>;
};

/** 生产端口：与其它远端文件共用 config:get-raw（auth.json 的 ssh 分支回 remoteAuth，不回原文）。 */
export const remoteAuthDesktopPorts: RemoteAuthPanelPorts = {
	read: ({ hostId }) => desktopApi.config.getRaw("auth.json", { target: { kind: "ssh" as const, hostId } }),
};

const TYPE_COPY = {
	api_key: "remoteAuth.type.apiKey",
	oauth: "remoteAuth.type.oauth",
	unsupported: "remoteAuth.type.unsupported",
} as const;

function readSnapshot(response: unknown): RemotePiAuthSnapshot | undefined {
	if (typeof response !== "object" || response === null) return undefined;
	const candidate = (response as { remoteAuth?: unknown }).remoteAuth;
	return isRemotePiAuthSnapshot(candidate) ? candidate : undefined;
}

function codeOf(error: unknown): string {
	return remotePiConfigCodeFromError(error) ?? REMOTE_CONFIG_CODES.unavailable;
}

export function RemoteAuthPanel(props: { hostId: string; hostLabel?: string; ports?: RemoteAuthPanelPorts }) {
	const ports = props.ports ?? remoteAuthDesktopPorts;
	const { ensureConnected } = useRemoteHostConnection();
	const [state, setState] = useState<RemoteAuthState>({ phase: "loading" });
	const generation = useRef(0);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			generation.current += 1;
		};
	}, []);

	const load = useCallback(async () => {
		const request = generation.current + 1;
		generation.current = request;
		setState({ phase: "loading" });
		// 与其它远端面板同一条原则：先确保主机在线再读，用户看到的应是「正在连接」而不是「主机未就绪」。
		const ready = await ensureConnected(props.hostId);
		if (!mounted.current || request !== generation.current) return;
		if (!ready.ok) {
			setState({ phase: "failed", code: REMOTE_CONFIG_CODES.hostNotReady });
			return;
		}
		try {
			const response = await ports.read({ hostId: props.hostId });
			if (!mounted.current || request !== generation.current) return;
			const snapshot = readSnapshot(response);
			setState(snapshot === undefined ? { phase: "failed", code: REMOTE_CONFIG_CODES.fileInvalid } : { phase: "ready", snapshot });
		} catch (error) {
			if (!mounted.current || request !== generation.current) return;
			setState({ phase: "failed", code: codeOf(error) });
		}
	}, [ensureConnected, ports, props.hostId]);

	useEffect(() => {
		void load();
	}, [load]);

	const snapshot = state.phase === "ready" ? state.snapshot : undefined;
	const failed = state.phase === "failed";
	const errorKey = failed ? remoteConfigErrorKey(state.code) : undefined;
	const reload = (
		<Button type="button" variant="outline" size="sm" className="ml-auto h-8 gap-1.5" disabled={state.phase === "loading"} onClick={() => void load()} data-testid="remote-auth-reload">
			<RefreshCw className="size-3.5" aria-hidden="true" />
			{t("remoteConfig.reload")}
		</Button>
	);

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="remote-auth-panel" data-phase={state.phase}>
			<div className="flex shrink-0 flex-wrap items-center gap-2" data-testid="remote-auth-header">
				<span className="text-control font-medium">{t("remoteAuth.title")}</span>
				<span className="rounded-sm bg-bg-input px-1.5 py-0.5 text-micro text-muted-foreground" data-testid="remote-auth-readonly">
					{t("remoteAuth.readOnly")}
				</span>
				{props.hostLabel ? (
					<span className="truncate font-mono text-micro text-muted-foreground" data-testid="remote-auth-host">
						{props.hostLabel}
					</span>
				) : null}
				{reload}
			</div>

			{/* 能力边界先说清楚：这一页为什么不给输入、改凭据该去哪儿。 */}
			<div className="flex shrink-0 flex-col gap-1 rounded-md border border-border-subtle bg-bg-panel px-3 py-2" data-testid="remote-auth-scope">
				<div className="flex items-center gap-1.5 text-control font-medium">
					<ShieldCheck className="size-4 shrink-0" aria-hidden="true" />
					{t("remoteAuth.scope")}
				</div>
				<p className="text-label leading-relaxed text-muted-foreground">{t("remoteAuth.loginHint")}</p>
			</div>

			{state.phase === "loading" ? (
				<div role="status" aria-live="polite" className="flex items-center justify-center gap-2.5 rounded-md border border-border-subtle bg-bg-panel px-3 py-8 text-control text-muted-foreground" data-testid="remote-auth-loading">
					<LoaderCircle className="size-4 shrink-0 animate-pideck-spin" aria-hidden="true" />
					<span className="animate-pulse">{t("remoteAuth.loading")}</span>
				</div>
			) : null}

			{failed ? (
				<div className="flex flex-col gap-2 rounded-md border border-danger/20 bg-danger-soft px-3.5 py-2.5" data-testid="remote-auth-error" data-code={state.code}>
					<div className="flex items-center gap-2 text-control font-medium text-danger">
						<AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
						{t("remoteAuth.failedTitle")}
					</div>
					<p className="text-control leading-relaxed text-danger">{errorKey ? t(errorKey) : t("remoteConfig.errorUnavailable")}</p>
					<code className="font-mono text-micro text-muted-foreground">{t("remoteConfig.errorCode", { code: state.code })}</code>
				</div>
			) : null}

			{snapshot ? (
				<>
					<div className="flex shrink-0 flex-wrap items-center gap-3 rounded-md border border-border-subtle bg-bg-panel px-3 py-2" data-testid="remote-auth-meta">
						<div className="flex min-w-0 items-baseline gap-1.5">
							<span className="text-micro text-muted-foreground">{t("remoteConfig.version")}</span>
							<code className="font-mono text-micro text-foreground/80" title={snapshot.version}>
								{shortConfigDigest(snapshot.version)}
							</code>
						</div>
						<span className="ml-auto text-micro text-muted-foreground" data-testid="remote-auth-count">
							{t("remoteAuth.count", { count: snapshot.providers.length })}
						</span>
					</div>

					{snapshot.providers.length === 0 ? (
						<div className="flex items-start gap-2 rounded-md border border-dashed border-border-subtle px-3.5 py-4" data-testid="remote-auth-empty">
							<KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
							<span className="text-control leading-relaxed text-muted-foreground">{t("remoteAuth.empty")}</span>
						</div>
					) : (
						<ul className="flex flex-col gap-1.5" data-testid="remote-auth-providers">
							{snapshot.providers.map((provider) => (
								<RemoteAuthRow key={provider.provider} provider={provider} />
							))}
						</ul>
					)}
				</>
			) : null}
		</div>
	);
}

function RemoteAuthRow(props: { provider: RemotePiAuthProvider }) {
	const { provider } = props;
	return (
		<li className="flex min-w-0 items-center gap-2 rounded-md border border-border-subtle bg-bg-panel px-3 py-2" data-testid="remote-auth-provider" data-provider={provider.provider} data-type={provider.type} data-configured={provider.configured ? "true" : "false"}>
			<span className="truncate text-control font-medium text-foreground">{provider.provider}</span>
			<span className="shrink-0 rounded border border-border-subtle px-1 text-micro text-muted-foreground">{t(TYPE_COPY[provider.type])}</span>
			<span className={cn("ml-auto shrink-0 text-micro", provider.configured ? "text-success" : "text-muted-foreground")}>{provider.configured ? t("remoteConfig.secretConfigured") : t("remoteConfig.secretMissing")}</span>
		</li>
	);
}
