import { FolderCog } from "lucide-react";
import { useAtomValue } from "jotai";
import { projectByIdAtomFamily, sessionRecordByIdAtomFamily } from "../../atoms";
import { t } from "../../i18n";
import { isChatProject } from "../../rendererUtils";
import { Button } from "../ui-shadcn/button";
import { useSessionPaneServices } from "./SessionPaneServices";

/**
 * 内置对话区（Chat）会话头部的「切换聊天记录目录」入口。
 *
 * 设计要点：
 * - 仅当会话所属项目是内置聊天项目（kind === "chat"）时渲染；普通项目会话不出现，
 *   避免与侧边栏项目的目录管理（changeChatPath 同一实现）重复抢占。
 * - 复用 SessionPaneServices.changeChatPath（App 层注入）：弹目录选择器 → 主进程
 *   写入 chat-path.json 并广播 projects:changed → 重扫会话 → toast 提示。
 * - title 带出当前目录路径，用户不点也知道聊天记录存在哪。
 */
export function ChatDirectoryButton(props: { sessionId: string }) {
	const session = useAtomValue(sessionRecordByIdAtomFamily(props.sessionId));
	const project = useAtomValue(projectByIdAtomFamily(session?.projectId ?? ""));
	const { changeChatPath, showNotice } = useSessionPaneServices();

	// 非内置聊天会话（普通项目/匿名）不渲染：普通项目有自己更完整的目录管理入口
	if (!session || !isChatProject(project)) return null;

	return (
		<Button
			type="button"
			variant="ghost"
			size="icon-sm"
			className="chat-directory-button size-7 shrink-0 text-muted-foreground hover:text-foreground"
			title={`${t("app.chatProjectSettings")}\n${project.path}`}
			aria-label={t("app.chatProjectSettings")}
			onClick={() => {
				// changeChatPath 内部已处理「取消选择 / 路径未变」的静默返回；
				// 只有真正的写入/重扫失败会走到这里，用 notice 兜底提示。
				void changeChatPath(project).catch((error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					showNotice(message, 5000, "error");
				});
			}}
		>
			<FolderCog className="size-3.5" aria-hidden="true" />
		</Button>
	);
}
