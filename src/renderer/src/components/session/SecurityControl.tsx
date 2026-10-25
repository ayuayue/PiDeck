import type { AgentBackend } from "../../../../shared/types";
import { DshPermissionMenu } from "./DshPermissionMenu";
import { SecurityLevelMenu } from "./SecurityLevelMenu";

/**
 * 底栏安全控制位统一入口（C20）：
 * - pi 后端：内置安全等级菜单（SecurityLevelMenu，SecurityStore 会话级覆盖，安全门热更新）；
 * - DSH 后端：权限预设菜单（DshPermissionMenu，host 侧 /permission，dsh-web 同款预设）；
 * - ACP 后端：不渲染——权限由 agent CLI 自己的 session/request_permission 流程接管
 *   （运行中弹卡应答），PiDeck 的 pi 安全门对 ACP 子进程不生效，摆出来只会误导
 *   （用户反馈：ACP 会话的权限/模式不应再走 PiDeck 的）。
 * 新增后端（如未来 Codex 运行时）只在这里注册控制位，不再在 ComposerArea 写 if/else。
 */
export function SecurityControl(props: { sessionId: string; backend?: AgentBackend; disabled?: boolean }) {
	if (props.backend === "dsh") {
		return <DshPermissionMenu sessionId={props.sessionId} disabled={props.disabled} />;
	}
	if (props.backend === "acp") {
		return null;
	}
	return <SecurityLevelMenu sessionId={props.sessionId} disabled={props.disabled} />;
}
