import { useCallback, useEffect, useState } from "react";
import { desktopApi } from "../../../desktopApi";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui-shadcn/dialog";
import { Input } from "../../ui-shadcn/input";
import { Label } from "../../ui-shadcn/label";
import type { RemoteHostAddInput, RemoteHostConfigCandidate } from "../../../../../shared/types/remoteHost";

/** 跳过原因是稳定枚举；这里显式映射而不是拼接 key，否则远端回来的任意字符串会拼出不存在的 key。 */
function skipReasonLabel(reason: string): string {
	switch (reason) {
		case "wildcard":
			return t("settings.connections.add.skipReason.wildcard");
		case "invalid":
			return t("settings.connections.add.skipReason.invalid");
		case "unsupported-directive":
			return t("settings.connections.add.skipReason.unsupported-directive");
		default:
			return reason;
	}
}

/**
 * 「添加 SSH 连接」对话框。
 *
 * 布局照成熟做法（Codex）：**先列出 `~/.ssh/config` 里已经配好的主机让用户勾选**，手动填写是次要入口。
 * 理由很直接——用户要连的主机几乎总是已经配过 SSH 的，再让他把 host/user/port 手打一遍既啰嗦又容易错。
 *
 * 两种模式下「保存」做的是同一件事：提交后主进程会推送指纹确认，**指纹必须由用户亲眼看**，
 * 因此这里不做「保存即完成」的假象——提交后弹框关闭，由 ConnectionsTab 上的确认框接手。
 */
export function AddHostDialog(props: { onClose: () => void; onSubmitted: (hostId: string) => void }) {
	const [candidates, setCandidates] = useState<RemoteHostConfigCandidate[]>([]);
	const [skipped, setSkipped] = useState<{ alias: string; reason: string }[]>([]);
	const [currentUser, setCurrentUser] = useState("");
	const [selected, setSelected] = useState<string | null>(null);
	const [scanNote, setScanNote] = useState<string | null>(null);
	const [mode, setMode] = useState<"scan" | "manual">("scan");
	const [manual, setManual] = useState({ label: "", hostName: "", port: "" });
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		void (async () => {
			const result = await desktopApi.remoteHosts.scanConfig();
			if (!active) return;
			if (!result.ok) {
				// 功能被关闭时直接不给入口提示；读不到 config 时退到手动填写并说明原因。
				setScanNote(result.code === "REMOTE_FEATURE_DISABLED" ? t("settings.connections.add.disabled") : t("settings.connections.add.scanFailed"));
				setMode("manual");
				return;
			}
			setCandidates(result.candidates);
			setSkipped(result.skipped);
			setCurrentUser(result.user);
			// 扫描不到任何主机（比如没配过 SSH）时没必要停在空列表上，直接给手动表单。
			if (result.candidates.length === 0) setMode("manual");
		})();
		return () => {
			active = false;
		};
	}, []);

	const submit = useCallback(
		async (input: RemoteHostAddInput) => {
			setBusy(true);
			setError(null);
			try {
				const result = await desktopApi.remoteHosts.add(input);
				if (result.ok) props.onSubmitted(result.hostId);
				else setError(t("settings.connections.add.failed", { code: result.code }));
			} finally {
				setBusy(false);
			}
		},
		[props],
	);

	const submitSelected = useCallback(() => {
		const candidate = candidates.find((item) => item.alias === selected);
		if (candidate === undefined) return;
		void submit({ label: candidate.alias, hostName: candidate.hostName, user: candidate.user.length > 0 ? candidate.user : undefined, port: candidate.port ?? undefined, identityFile: candidate.identityFile ?? undefined });
	}, [candidates, selected, submit]);

	const submitManual = useCallback(() => {
		const label = manual.label.trim();
		const hostName = manual.hostName.trim();
		if (label.length === 0 || hostName.length === 0) {
			setError(t("settings.connections.add.required"));
			return;
		}
		const port = manual.port.trim().length === 0 ? undefined : Number(manual.port.trim());
		// 端口在渲染层先拦一道，避免把明显非法的值发到主进程；主进程仍会独立校验。
		if (port !== undefined && (!Number.isSafeInteger(port) || port < 1 || port > 65535)) {
			setError(t("settings.connections.add.badPort"));
			return;
		}
		void submit({ label, hostName, port });
	}, [manual, submit]);

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) props.onClose();
			}}
		>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>{t("settings.connections.add.title")}</DialogTitle>
					<DialogDescription>{t("settings.connections.add.hint")}</DialogDescription>
				</DialogHeader>

				{mode === "scan" ? (
					<div className="flex flex-col gap-2">
						{/* 候选来自用户自己的 ssh config，原样显示别名与实际目标，便于对照。 */}
						<ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
							{candidates.map((candidate) => (
								<li key={candidate.alias}>
									<button type="button" className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-body ${selected === candidate.alias ? "border-primary" : "border-border-subtle"}`} onClick={() => setSelected(candidate.alias)}>
										<span className="min-w-0 flex-1 truncate font-medium">{candidate.alias}</span>
										<span className="shrink-0 text-label text-muted-foreground">
											{candidate.user.length > 0 ? candidate.user : currentUser}@{candidate.hostName}
											{candidate.port !== null ? `:${candidate.port}` : ""}
										</span>
									</button>
								</li>
							))}
						</ul>
						{/* 被跳过的条目要说明原因：静默少一项会让用户以为自己的配置丢了。 */}
						{skipped.length > 0 ? (
							<details className="text-label text-muted-foreground">
								<summary className="cursor-pointer select-none">{t("settings.connections.add.skipped", { count: String(skipped.length) })}</summary>
								<ul className="mt-1 flex flex-col gap-0.5">
									{skipped.map((entry) => (
										<li key={`${entry.alias}-${entry.reason}`}>
											{entry.alias} — {skipReasonLabel(entry.reason)}
										</li>
									))}
								</ul>
							</details>
						) : null}
						{scanNote !== null ? <p className="text-label text-muted-foreground">{scanNote}</p> : null}
					</div>
				) : (
					<div className="flex flex-col gap-3">
						<div className="flex flex-col gap-1">
							<Label htmlFor="remote-host-label">{t("settings.connections.add.label")}</Label>
							<Input id="remote-host-label" value={manual.label} onChange={(event) => setManual((current) => ({ ...current, label: event.target.value }))} />
						</div>
						<div className="flex flex-col gap-1">
							<Label htmlFor="remote-host-name">{t("settings.connections.add.hostName")}</Label>
							<Input id="remote-host-name" placeholder="host.com" value={manual.hostName} onChange={(event) => setManual((current) => ({ ...current, hostName: event.target.value }))} />
						</div>
						<div className="flex flex-col gap-1">
							<Label htmlFor="remote-host-port">{t("settings.connections.add.port")}</Label>
							<Input id="remote-host-port" inputMode="numeric" placeholder="22" value={manual.port} onChange={(event) => setManual((current) => ({ ...current, port: event.target.value }))} />
						</div>
					</div>
				)}

				{error !== null ? <p className="text-label text-destructive">{error}</p> : null}

				<DialogFooter className="items-center justify-between gap-2 sm:justify-between">
					{/* 两种模式互为补充：扫描是主路径，手动是兜底，因此用一个轻量文字开关而不是并列按钮。 */}
					<Button variant="ghost" size="sm" onClick={() => setMode((current) => (current === "scan" ? "manual" : "scan"))} disabled={candidates.length === 0 && mode === "manual"}>
						{mode === "scan" ? t("settings.connections.add.manual") : t("settings.connections.add.fromConfig")}
					</Button>
					<div className="flex items-center gap-2">
						<Button variant="ghost" onClick={props.onClose}>
							{t("common.cancel")}
						</Button>
						<Button disabled={busy || (mode === "scan" ? selected === null : false)} onClick={() => (mode === "scan" ? submitSelected() : submitManual())}>
							{t("settings.connections.add.submit")}
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
