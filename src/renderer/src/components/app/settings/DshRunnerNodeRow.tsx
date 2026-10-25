import { useEffect, useRef, useState } from "react";
import type { AppSettings, DshRunnerNodeInfo } from "../../../../../shared/types";
import { dshRunnerNodeReleasePageUrl } from "../../../../../shared/types/dshRunnerNodeRelease";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { openInSystemBrowser } from "../../../utils/openExternal";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { DirtyMarker, SettingRow } from "./SettingRows";

function sourceLabel(source: DshRunnerNodeInfo["source"]): string {
	switch (source) {
		case "configured":
			return t("settings.dshRunnerNodeSourceConfigured");
		case "env":
			return t("settings.dshRunnerNodeSourceEnv");
		case "sidecar":
			return t("settings.dshRunnerNodeSourceSidecar");
		case "known-location":
			return t("settings.dshRunnerNodeSourceKnown");
		case "path":
			return t("settings.dshRunnerNodeSourcePath");
		default:
			return t("settings.dshRunnerNodeNotDetected");
	}
}

function looksLikePath(p: string): boolean {
	return p.includes("/") || p.includes("\\");
}

/**
 * 开发设置：DSH 沙箱 runner 的本机 Node 路径。
 * Windows 必须是 CUI node.exe（不能用 electron.exe），主版本需 Node 24。
 * 本机其它 Node 可继续占 PATH；缺 24 时可一键下载到 userData。
 */
export function DshRunnerNodeRow(props: { draft: AppSettings; updateDraft: (patch: Partial<AppSettings>) => void; isDirty: (field: keyof AppSettings) => boolean }) {
	const { draft, updateDraft, isDirty } = props;
	const draftPath = (draft.dshRunnerNodePath ?? "").trim();
	const [info, setInfo] = useState<DshRunnerNodeInfo | null>(null);
	const [detecting, setDetecting] = useState(false);
	const [installing, setInstalling] = useState(false);
	const [installMessage, setInstallMessage] = useState<string | null>(null);
	const [installError, setInstallError] = useState<string | null>(null);
	const mountedRef = useRef(true);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	const runDetect = async (configuredPath: string) => {
		setDetecting(true);
		try {
			const next = await desktopApi.sessions.detectDshRunnerNode(configuredPath);
			if (mountedRef.current) setInfo(next);
		} catch {
			// 探测异常保持现状
		} finally {
			if (mountedRef.current) setDetecting(false);
		}
	};

	const initialRan = useRef(false);
	useEffect(() => {
		if (initialRan.current) return;
		initialRan.current = true;
		void runDetect(draftPath);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const chooseFile = async () => {
		try {
			const selected = await desktopApi.sessions.chooseDshRunnerNode();
			if (!selected) return;
			updateDraft({ dshRunnerNodePath: selected });
			void runDetect(selected);
		} catch {
			// 对话框取消
		}
	};

	const installPrivateCopy = async () => {
		setInstalling(true);
		setInstallMessage(null);
		setInstallError(null);
		try {
			const result = await desktopApi.sessions.installDshRunnerNode();
			if (!mountedRef.current) return;
			if (result.ok && result.path) {
				updateDraft({ dshRunnerNodePath: "" });
				setInstallMessage(t("settings.dshRunnerNodeInstallOk"));
				void runDetect("");
			} else {
				setInstallError(t("settings.dshRunnerNodeInstallFailed", { error: result.error ?? "" }));
			}
		} catch (error) {
			if (mountedRef.current) {
				setInstallError(
					t("settings.dshRunnerNodeInstallFailed", {
						error: error instanceof Error ? error.message : String(error),
					}),
				);
			}
		} finally {
			if (mountedRef.current) setInstalling(false);
		}
	};

	const status = info;
	const effectiveVersion = status?.source === "not-found" ? "" : (status?.version ?? "");
	const resolvedDisplay = draftPath || status?.resolvedPath || status?.system?.resolvedPath || "";
	const detectedPath = status?.system?.resolvedPath ?? status?.resolvedPath ?? "";
	const ok = Boolean(status?.compatible && !status.error);
	const needsInstall = !ok;
	const detectedCompatible = Boolean(status?.system?.resolvedPath && status.system.resolvedPath !== draftPath && /^24\./.test(status.system.version));

	return (
		<SettingRow
			title={
				<>
					<span id="settings-section-dsh-runner-node">{t("settings.dshRunnerNode")}</span>
					<DirtyMarker dirty={isDirty("dshRunnerNodePath")} label={t("settings.dshRunnerNode")} />
				</>
			}
			description={t("settings.dshRunnerNodeDesc")}
			stacked
		>
			<div className="w-full space-y-1.5">
				<div className="flex flex-wrap items-center gap-2">
					<Input
						className="w-56 min-w-0 flex-1 font-mono text-xs"
						value={draftPath}
						placeholder={draftPath ? "" : looksLikePath(detectedPath) ? detectedPath : t("settings.dshRunnerNodePlaceholder")}
						title={draftPath || (looksLikePath(detectedPath) ? detectedPath : "")}
						onChange={(e) => updateDraft({ dshRunnerNodePath: e.target.value })}
					/>
					<Button variant="outline" size="sm" disabled={detecting} onClick={() => void runDetect(draftPath)}>
						{detecting ? t("settings.dshRunnerNodeDetecting") : t("settings.dshRunnerNodeDetect")}
					</Button>
					<Button variant="outline" size="sm" onClick={() => void chooseFile()}>
						{t("settings.dshRunnerNodeBrowse")}
					</Button>
					{draftPath && (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								updateDraft({ dshRunnerNodePath: "" });
								void runDetect("");
							}}
						>
							{t("settings.dshRunnerNodeClear")}
						</Button>
					)}
				</div>
				{ok && resolvedDisplay && (
					<small className="block truncate font-mono text-caption text-muted-foreground" title={`${sourceLabel(status?.source ?? "path")}${effectiveVersion ? ` · ${t("settings.dshRunnerNodeVersion", { version: effectiveVersion })}` : ""} · ${resolvedDisplay}`}>
						{sourceLabel(status?.source ?? "path")}
						{effectiveVersion ? ` · ${t("settings.dshRunnerNodeVersion", { version: effectiveVersion })}` : ""}
						{" · "}
						{resolvedDisplay}
					</small>
				)}
				{status?.error && (
					<div className="space-y-1">
						<small className="block text-caption text-danger">{status.error}</small>
						{detectedCompatible && (
							<Button
								variant="outline"
								size="sm"
								onClick={() => {
									const p = status.system?.resolvedPath ?? "";
									updateDraft({ dshRunnerNodePath: p });
									void runDetect(p);
								}}
							>
								{t("settings.dshRunnerNodeUseDetected")} · {status.system?.resolvedPath}
							</Button>
						)}
					</div>
				)}
				{needsInstall && (
					<div className="flex flex-wrap items-center gap-2">
						<Button variant="outline" size="sm" disabled={installing} onClick={() => void installPrivateCopy()}>
							{installing ? t("settings.dshRunnerNodeInstalling") : t("settings.dshRunnerNodeInstall")}
						</Button>
						<Button variant="ghost" size="sm" onClick={() => openInSystemBrowser(dshRunnerNodeReleasePageUrl(draft.updateSource ?? "atomgit"))}>
							{t("settings.dshRunnerNodeOpenDownload")}
						</Button>
					</div>
				)}
				{installMessage && <small className="block text-caption text-muted-foreground">{installMessage}</small>}
				{installError && <small className="block text-caption text-danger">{installError}</small>}
				<small className="block text-caption leading-relaxed text-muted-foreground">{t("settings.dshRunnerNodeCoexistHint")}</small>
			</div>
		</SettingRow>
	);
}
