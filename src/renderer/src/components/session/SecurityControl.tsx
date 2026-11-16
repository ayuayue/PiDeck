import { useAtomValue } from "jotai";
import type { AgentBackend } from "../../../../shared/types";
import { sessionIsRemoteAtomFamily, sessionRemoteExtensionsAtomFamily } from "../../atoms";
import { DshPermissionMenu } from "./DshPermissionMenu";
import { AcpAdditionalDirectoriesControl } from "./AcpAdditionalDirectoriesControl";
import { SecurityLevelMenu } from "./SecurityLevelMenu";

/**
 * 底栏安全控制位统一入口（C20）：
 * - pi 后端：内置安全等级菜单（SecurityLevelMenu，SecurityStore 会话级覆盖，安全门热更新）；
 * - DSH 后端：权限预设菜单（DshPermissionMenu，host 侧 /permission，dsh-web 同款预设）；
 * - ACP 后端：不渲染权限档（权限由 agent CLI 自己的 session/request_permission 流程接管，
 *   PiDeck 的 pi 安全门对 ACP 子进程不生效），但渲染「附加根目录」入口（#560：会话级
 *   session/new 参数，与作用域设置同格）。
 * 新增后端（如未来 Codex 运行时）只在这里注册控制位，不再在 ComposerArea 写 if/else。
 *
 * 远端 pi：安全门是 PiDeck 内置扩展，只有在**实际注入**（`remoteExtensions.applied`）后才会生效。
 * 未注入时这里直接不渲染——一个“能切、不生效”的等级选择器比没有入口更糟（用户会以为已经拦了）。
 */
export function SecurityControl(props: { sessionId: string; backend?: AgentBackend; disabled?: boolean }) {
	const isRemoteSession = useAtomValue(sessionIsRemoteAtomFamily(props.sessionId));
	const remoteExtensions = useAtomValue(sessionRemoteExtensionsAtomFamily(props.sessionId));
	if (isRemoteSession && !(remoteExtensions?.applied ?? []).includes("pi-deck-security-gate.ts")) return null;
	if (props.backend === "dsh") {
		return <DshPermissionMenu sessionId={props.sessionId} disabled={props.disabled} />;
	}
	if (props.backend === "acp") {
		// ACP 权限由 agent 自己的 request_permission 接管，但「能访问哪些目录」是会话级
		// 创建参数（session/new 的 additionalDirectories），放在这一格（#560）。
		return <AcpAdditionalDirectoriesControl sessionId={props.sessionId} disabled={props.disabled} />;
	}
	return <SecurityLevelMenu sessionId={props.sessionId} disabled={props.disabled} />;
}
