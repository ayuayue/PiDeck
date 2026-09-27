import { useCallback, useEffect, useState } from "react";
import { desktopApi } from "../../../desktopApi";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { AddHostDialog } from "./AddHostDialog";
import { FingerprintConfirmDialog } from "./FingerprintConfirmDialog";
import { SettingsSection } from "./SettingsStorageTab";
import type { RemoteHostConnectionState, RemoteHostDiagnosticEntry, RemoteHostListItem, RemoteHostPinRequest } from "../../../../../shared/types/remoteHost";

/**
 * 设置 → 连接：远端主机列表 + 连接开关 + 状态/诊断。
 *
 * 交互模型对齐成熟做法（Codex 的 SSH 面板）：每行只有「名字 + 一个状态点 + 一句人话」，
 * 复杂概念（fingerprint、端口、bootstrap、helper）不出现在列表里——它们属于诊断，用户
 * 需要排查时才展开。目标是「一眼看出哪台连上了、点一下能连」。
 *
 * 本面板只做启用/停用和只读诊断；添加主机（扫描 ~/.ssh/config + 指纹确认）是后续步骤，
 * 因此这里没有「添加」按钮——不给用户一个点不通的入口。
 *
 * 状态语义（设计文档 §10）：这里是**主机连接状态**，与 Agent 的 send state 是两回事，
 * 主机 ready 不代表每个 Agent runtime ready，两者不得混成一个指示灯。
 */
export function ConnectionsTab() {
	const [hosts, setHosts] = useState<RemoteHostListItem[]>([]);
	const [states, setStates] = useState<Record<string, RemoteHostConnectionState>>({});
	const [busy, setBusy] = useState<Record<string, boolean>>({});
	const [message, setMessage] = useState<string | null>(null);
	const [diagnostics, setDiagnostics] = useState<Record<string, RemoteHostDiagnosticEntry[]>>({});
	const [adding, setAdding] = useState(false);
	const [pinRequest, setPinRequest] = useState<RemoteHostPinRequest | null>(null);
	const [pinBusy, setPinBusy] = useState(false);

	/**
	 * 订阅指纹确认推送。
	 *
	 * 必须在组件卸载时退订：窗口销毁后继续收到推送不仅浪费，还会让「确认」这件事脱离用户可见的上下文。
	 */
	useEffect(() => {
		const unsubscribe = desktopApi.remoteHosts.onPinRequest((request) => setPinRequest(request));
		return unsubscribe;
	}, []);

	/** 拉取主机目录。功能未启用、目录不可读等都以稳定码返回，转成人话提示而不是抛错。 */
	const refresh = useCallback(async () => {
		const result = await desktopApi.remoteHosts.list();
		if (!result.ok) {
			// REMOTE_FEATURE_DISABLED 是正常状态（正式包默认关闭），不是错误。
			setMessage(result.code === "REMOTE_FEATURE_DISABLED" ? t("settings.connections.disabled") : t("settings.connections.listUnavailable"));
			setHosts([]);
			return;
		}
		setMessage(null);
		setHosts(result.hosts);
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	/** 连接/断开共用一条路径：置忙 → 调用 → 用稳定码或状态回填 → 清忙。 */
	const toggle = useCallback(async (hostId: string, connect: boolean) => {
		setBusy((current) => ({ ...current, [hostId]: true }));
		try {
			if (connect) {
				const result = await desktopApi.remoteHosts.connect(hostId);
				if (result.ok) {
					setStates((current) => ({ ...current, [hostId]: result.state }));
					setMessage(null);
				} else {
					// 失败不猜状态：显示稳定码，具体原因去诊断里看。
					setMessage(t("settings.connections.connectFailed", { code: result.code }));
					setStates((current) => ({ ...current, [hostId]: "offline" }));
				}
			} else {
				const result = await desktopApi.remoteHosts.disconnect(hostId);
				if (result.ok) {
					setStates((current) => ({ ...current, [hostId]: "disconnected" }));
					setMessage(null);
				} else {
					setMessage(t("settings.connections.disconnectFailed", { code: result.code }));
				}
			}
		} finally {
			setBusy((current) => ({ ...current, [hostId]: false }));
			// 诊断随开关一起刷新，用户失败后立刻能看到阶段停在哪儿。
			const result = await desktopApi.remoteHosts.diagnostics(hostId);
			if (result.ok) setDiagnostics((current) => ({ ...current, [hostId]: result.entries }));
		}
	}, []);

	return (
		<div className="flex min-w-0 flex-col gap-3">
			<SettingsSection title={t("settings.connections.title")} description={t("settings.connections.hint")}>
				<div className="flex flex-col gap-2">
					{hosts.length === 0 ? <p className="px-1 py-3 text-body text-muted-foreground">{t("settings.connections.empty")}</p> : null}
					{hosts.map((host) => {
						const state = states[host.id] ?? (host.disabled ? "offline" : "disconnected");
						const connected = state === "ready" || state === "degraded";
						const pending = busy[host.id] === true;
						return (
							<div key={host.id} className="flex flex-col gap-2 rounded-lg border border-border-subtle px-3 py-2">
								<div className="flex items-center gap-3">
									{/* 开关语义：「连上」是唯一目标状态，中间态与失败态都如实显示，不假装成功。 */}
									<Button variant={connected ? "secondary" : "default"} size="sm" disabled={pending || host.disabled} onClick={() => void toggle(host.id, !connected)} aria-label={connected ? t("settings.connections.disconnect") : t("settings.connections.connect")}>
										{connected ? t("settings.connections.disconnect") : t("settings.connections.connect")}
									</Button>
									<div className="flex min-w-0 flex-col">
										<strong className="truncate text-body font-semibold text-foreground">{host.label}</strong>
										<span className="truncate text-label text-muted-foreground">
											{host.sshHost} · {t(`settings.connections.state.${state}`)}
										</span>
									</div>
									{/* 未验证 / 已禁用是持久属性，和连接状态分开显示，避免被当成「连接失败」。 */}
									<div className="ml-auto flex items-center gap-2">
										{host.disabled ? <span className="text-label text-muted-foreground">{t("settings.connections.disabledTag")}</span> : null}
										{host.verified ? null : <span className="text-label text-muted-foreground">{t("settings.connections.unverifiedTag")}</span>}
									</div>
								</div>
								{/* 诊断只在有内容且非空时展示：连上时它通常只有几行阶段记录。 */}
								{(diagnostics[host.id] ?? []).length > 0 ? (
									<details className="text-label text-muted-foreground">
										<summary className="cursor-pointer select-none">{t("settings.connections.diagnostics")}</summary>
										<ul className="mt-1 flex flex-col gap-0.5 font-mono">
											{(diagnostics[host.id] ?? []).slice(-8).map((entry) => (
												<li key={`${entry.at}-${entry.code}`}>
													{entry.phase} · {entry.state} · {entry.code}
												</li>
											))}
										</ul>
									</details>
								) : null}
							</div>
						);
					})}
					<div className="flex items-center gap-2 pt-1">
						{/* 添加是主路径入口；未验证/禁用是持久属性，因此统一在此展示。 */}
						<Button variant="default" size="sm" onClick={() => setAdding(true)}>
							{t("settings.connections.add")}
						</Button>
						<Button variant="ghost" size="sm" onClick={() => void refresh()}>
							{t("settings.connections.refresh")}
						</Button>
						{message !== null ? <span className="text-label text-muted-foreground">{message}</span> : null}
					</div>
				</div>
			</SettingsSection>
			{adding ? (
				<AddHostDialog
					onClose={() => setAdding(false)}
					onSubmitted={() => {
						// 提交后关弹框，由指纹确认接手；此时列表还是旧的（draft 尚未验证），等确认完再刷新。
						setAdding(false);
						void refresh();
					}}
				/>
			) : null}
			{pinRequest !== null ? (
				<FingerprintConfirmDialog
					request={pinRequest}
					busy={pinBusy}
					onAnswer={(choice) => {
						const request = pinRequest;
						if (request === null) return;
						setPinBusy(true);
						void (async () => {
							try {
								const result = await desktopApi.remoteHosts.answerPin(request.requestId, request.hostId, choice);
								// 拒绝是正常结果；只有真正的失败（过期、非法、来自其他窗口）才提示。
								if (!result.ok) setMessage(t("settings.connections.pin.failed", { code: result.code }));
							} finally {
								setPinBusy(false);
								setPinRequest(null);
								// 确认后必须重拉：新主机只有保存了 pin 才出现在列表里。
								void refresh();
							}
						})();
					}}
				/>
			) : null}
		</div>
	);
}
