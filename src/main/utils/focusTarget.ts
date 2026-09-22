/**
 * 从进程 argv 中提取「点击系统通知」携带的会话/Agent 跳转目标。
 *
 * Windows toast 使用 activationType="protocol"，点击时系统按注册表协议关联唤起应用，
 * 被唤起实例的 argv 携带 launch URL。支持两种格式：
 * - pideck://session/<uuid>：主路径。通知创建时直接嵌入会话 id（SessionRecord.id 跨重启稳定），
 *   冷启动/运行中均可跳转，不依赖 agent 运行时状态。
 * - pideck://agent/<uuid>：兼容旧版 toast 的兜底格式（agent 运行时才可解析到会话）。
 * 返回 undefined 表示本次唤起不是通知点击，仅聚焦窗口即可。
 */
const FOCUS_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SESSION_RE = new RegExp(`pideck://session/(${FOCUS_UUID})`, "i");
const AGENT_RE = new RegExp(`pideck://agent/(${FOCUS_UUID})`, "i");

const OPEN_PROJECT_FLAG = "--open-project";

export type FocusTarget = {
	quickTaskPath?: string;
	quickTaskDesktop?: boolean;
	sessionId?: string;
	agentId?: string;
	/** 文件夹右键菜单唤起：待打开/导入的目录路径（来自 --open-project 参数）。 */
	projectPath?: string;
};

export function extractFocusTargetFromArgv(argv?: string[]): FocusTarget | undefined {
	if (!argv || argv.length === 0) return undefined;
	for (let i = 0; i < argv.length; i++) {
		const text = String(argv[i]);
		if (text === "--quick-task-desktop") return { quickTaskDesktop: true };
		if (text === "--quick-task" || text.startsWith("--quick-task=")) {
			const path = text === "--quick-task" ? argv[i + 1] : text.slice("--quick-task=".length);
			if (path && !path.startsWith("--")) return { quickTaskPath: path };
		}
		const sessionMatch = text.match(SESSION_RE);
		if (sessionMatch) return { sessionId: sessionMatch[1] };
		const agentMatch = text.match(AGENT_RE);
		if (agentMatch) return { agentId: agentMatch[1] };
		// 右键菜单形式一：--open-project <path>（路径为独立参数，引号已被命令行解析剥离）
		if (text === OPEN_PROJECT_FLAG) {
			const path = argv[i + 1] ? String(argv[i + 1]).trim() : "";
			if (path && !path.startsWith("--")) return { projectPath: path };
		}
		// 右键菜单形式二：--open-project=<path>
		if (text.startsWith(`${OPEN_PROJECT_FLAG}=`)) {
			const path = text.slice(OPEN_PROJECT_FLAG.length + 1).trim();
			if (path) return { projectPath: path };
		}
	}
	return undefined;
}
