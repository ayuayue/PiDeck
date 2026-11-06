import type { ComponentProps } from "react";
import { ConfirmDialog } from "./OverlayParts";
import { TrustConfirmModal } from "../app/TrustConfirmModal";
import { ProviderLoginModal } from "../app/ProviderLoginModal";
import { FeedbackDialog, type FeedbackDialogProps } from "../../features/feedback/FeedbackDialog";

export type FeedbackOverlayProps = FeedbackDialogProps;

export type TrustOverlayProps = {
	open: boolean;
	requestId: string;
	cwd: string;
	projectName: string;
	onChoose: (choice: "trust-remember" | "trust-session" | "deny") => void | Promise<void>;
};

export type SessionActionOverlaysProps = {
	feedback?: { open: boolean; props: FeedbackDialogProps };
	confirm?: { open: boolean; props: ComponentProps<typeof ConfirmDialog> };
	trust?: TrustOverlayProps;
};

export function SessionActionOverlays({ feedback, confirm, trust }: SessionActionOverlaysProps) {
	return (
		<>
			{/* 设置已迁成会话列页面 Tab（SettingsFeatureRoot），不再作为会话动作弹框挂载 */}
			{feedback?.open && <FeedbackDialog {...feedback.props} />}
			{confirm?.open && <ConfirmDialog {...confirm.props} />}
			{trust?.open && <TrustConfirmModal cwd={trust.cwd} projectName={trust.projectName} onChoose={trust.onChoose} />}
			{/* 供应商登录：无 props——弹框自己订阅 providerLoginRequestAtom（`/login` 触发） */}
			<ProviderLoginModal />
		</>
	);
}
