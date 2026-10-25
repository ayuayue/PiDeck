import { t } from "../../i18n";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui-shadcn/dialog";
import { Button } from "../ui-shadcn/button";

/**
 * 项目信任确认弹窗。
 *
 * 当用户在 pi-desktop 中打开含 .pi 配置资源（扩展 / skills / settings / SYSTEM.md 等）
 * 且未在 trust.json 记录决策的项目时，由主进程 AgentManager.ensureProjectTrust 经 IPC
 * 触发本弹窗。pi 在 RPC 模式下 project_trust 事件 hasUI 恒为 false，无法用其内置流程弹窗，
 * 因此信任决策由桌面端自行完成。
 *
 * 用户选择后通过 onChoose 回传，主进程据此决定是否启动 pi 进程：
 *   - trust-remember：永久信任，写入 trust.json
 *   - trust-session：仅本次会话信任，不落盘
 *   - deny：拒绝信任，阻止 Agent 创建并记录 false 避免重复打扰
 *
 * #115 U5 起改用 shadcn Dialog；刻意屏蔽 ESC/遮罩/关闭按钮，强制用户做出
 * 明确选择，避免误关后 Agent 卡在等待信任决策的状态。
 */
export function TrustConfirmModal(props: { cwd: string; projectName: string; onChoose: (choice: "trust-remember" | "trust-session" | "deny") => void }) {
	return (
		<Dialog
			open
			onOpenChange={() => {
				/* 强制三选一，不允许被动关闭 */
			}}
		>
			<DialogContent className="sm:max-w-md" showCloseButton={false} onEscapeKeyDown={(e) => e.preventDefault()} onInteractOutside={(e) => e.preventDefault()}>
				<DialogHeader>
					<DialogTitle>{t("agent.trust.title")}</DialogTitle>
					<DialogDescription>{t("agent.trust.message")}</DialogDescription>
				</DialogHeader>
				<p className="break-all font-mono text-sm text-muted-foreground">
					{t("agent.trust.project")}: {props.cwd}
				</p>
				<DialogFooter className="sm:justify-end">
					<Button variant="ghost" onClick={() => props.onChoose("deny")}>
						{t("agent.trust.deny")}
					</Button>
					<Button variant="secondary" onClick={() => props.onChoose("trust-session")}>
						{t("agent.trust.trustSession")}
					</Button>
					<Button variant="default" onClick={() => props.onChoose("trust-remember")}>
						{t("agent.trust.trustRemember")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
