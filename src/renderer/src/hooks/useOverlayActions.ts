import { useState, useCallback, useMemo } from "react";
import { desktopApi as api } from "../desktopApi";
import type { Project, AppInfo } from "../../../shared/types";
interface ConfirmDialogConfig {
	title: string;
	message: string;
	onConfirm: () => void;
	danger?: boolean;
	confirmLabel?: string;
}

interface TrustRequest {
	requestId: string;
	cwd: string;
	projectName: string;
}

interface UseOverlayActionsParams {
	activeProject?: Project;
	appInfo: AppInfo;
	showToast: (message: string, duration?: number) => void;
}

export function useOverlayActions({ activeProject, appInfo, showToast }: UseOverlayActionsParams) {
	const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogConfig | null>(null);
	const [trustRequest, setTrustRequest] = useState<TrustRequest | null>(null);
	const [feedbackOpen, setFeedbackOpen] = useState(false);

	const showConfirm = useCallback((config: ConfirmDialogConfig) => setConfirmDialog(config), []);
	const clearConfirm = useCallback(() => setConfirmDialog(null), []);

	const overlayProps = useMemo(
		() => ({
			feedback: feedbackOpen
				? {
						open: true as const,
						props: {
							open: true as const,
							project: activeProject,
							appInfo,
							onClose: () => setFeedbackOpen(false),
							onToast: (message: string) => showToast(message),
							// GitHub Issue 提交页需要登录/富文本，强制系统浏览器打开（不受「链接打开方式」设置影响）
							onOpenExternal: (url: string) => void api.app.openExternal(url, true),
						},
					}
				: undefined,
			confirm: confirmDialog
				? {
						open: true as const,
						props: {
							title: confirmDialog.title,
							message: confirmDialog.message,
							onConfirm: confirmDialog.onConfirm,
							onCancel: () => setConfirmDialog(null),
							danger: confirmDialog.danger,
							confirmLabel: confirmDialog.confirmLabel,
						},
					}
				: undefined,
			trust: trustRequest
				? {
						open: true as const,
						requestId: trustRequest.requestId,
						cwd: trustRequest.cwd,
						projectName: trustRequest.projectName,
						onChoose: (choice: "trust-remember" | "trust-session" | "deny") => {
							api.projects.respondTrustRequest(trustRequest.requestId, choice);
							setTrustRequest(null);
						},
					}
				: undefined,
		}),
		[feedbackOpen, activeProject, appInfo, confirmDialog, trustRequest, showToast],
	);

	return {
		confirmDialog,
		showConfirm,
		clearConfirm,
		trustRequest,
		setTrustRequest,
		feedbackOpen,
		setFeedbackOpen,
		overlayProps,
	};
}
