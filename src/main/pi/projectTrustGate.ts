import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ipcChannels } from "../../shared/ipc";
import type { Project } from "../../shared/types";
import { toWindowsHostPath, toWslLinuxPath, type WslEnvironment } from "../wsl/WslPaths";

export type ProjectTrustChoice = "trust-remember" | "trust-session" | "deny";

/** 信任配置读写（AgentManager.configManager 的窄化接口）。 */
export interface ProjectTrustConfigStore {
	/** 干净项目自动写入 trust.json 标记信任（幂等）。 */
	ensureTrustedDirectory(cwd: string): Promise<void>;
	/** 读取已记录的信任决策；未记录返回 null/undefined（两者等价「未决策」）。 */
	getProjectTrustDecision(cwd: string): Promise<boolean | null | undefined>;
	/** 持久化信任决策（只写 true，不持久化拒绝）。 */
	setProjectTrustDecision(cwd: string, trusted: boolean): Promise<void>;
}

/** 宿主窗口的最小结构面（避免直接依赖 electron 类型，便于单测）。 */
export interface TrustDialogWindow {
	isDestroyed(): boolean;
	webContents: { send(channel: string, payload: unknown): void };
}

/** AgentManager 拆分 Wave 4C：宿主回调只暴露配置读写、日志、WSL 环境与窗口获取。 */
export interface ProjectTrustHost {
	getConfigStore(): ProjectTrustConfigStore;
	info(message: string, data?: Record<string, unknown>): void;
	/** WSL 项目下信任资源检查用 host 路径、trust.json 键用 Linux 路径。 */
	getWslEnvironment(): WslEnvironment | null;
	/** 渲染主窗口（弹信任确认窗）；无窗口（headless）时由调用方默认拒绝。 */
	getWindow(): TrustDialogWindow | null;
}

/**
 * 项目信任闸（AgentManager 拆分 Wave 4C，2027-02 从 AgentManager 迁出，行为零变化）。
 *
 * pi 信任机制只对「含项目级 pi 资源」的项目触发，且 RPC 模式下 pi 的 project_trust 事件
 * hasUI 恒为 false、ctx.ui.select 不接 RPC UI 协议，无法弹窗。
 * 因此 pi-desktop 在启动 pi 进程前自行完成信任确认：干净项目自动信任并写入 trust.json；
 * 含 .pi/.agents 资源且未记录的项目弹窗让用户决策。
 */
export class ProjectTrustGate {
	/** 需要信任才能加载的项目级资源（复刻 pi 的 hasTrustRequiringProjectResources）。 */
	private static readonly TRUST_REQUIRING_RESOURCE_FILES = ["settings.json", "extensions", "skills", "mcp.json", "themes", "SYSTEM.md", "APPEND_SYSTEM.md"] as const;

	private readonly pendingTrustRequests = new Map<string, { resolve: (choice: ProjectTrustChoice) => void }>();

	constructor(private readonly host: ProjectTrustHost) {}

	/**
	 * 复刻 pi 的 hasTrustRequiringProjectResources：检查项目目录或其父目录是否存在
	 * 需要信任才能加载的资源（.pi 下的配置/扩展/skills 等，或项目级 .agents/skills）。
	 * 用户全局 ~/.agents/skills 视为可信，不触发信任确认。
	 */
	hasTrustRequiringResources(hostCwd: string): boolean {
		const configDir = join(hostCwd, ".pi");
		if (
			ProjectTrustGate.TRUST_REQUIRING_RESOURCE_FILES.some((file) => existsSync(join(configDir, file))) ||
			// pi-mcp-adapter also loads a project-root layer. It can define stdio commands,
			// so a project with only .mcp.json still requires an explicit trust decision.
			existsSync(join(hostCwd, ".mcp.json"))
		) {
			return true;
		}
		const userAgentsSkillsDir = join(this.host.getWslEnvironment()?.windowsHome ?? homedir(), ".agents", "skills");
		let currentDir = hostCwd;
		while (true) {
			const agentsSkillsDir = join(currentDir, ".agents", "skills");
			if (agentsSkillsDir !== userAgentsSkillsDir && existsSync(agentsSkillsDir)) {
				return true;
			}
			const parentDir = dirname(currentDir);
			if (parentDir === currentDir) return false;
			currentDir = parentDir;
		}
	}

	/**
	 * 启动 pi 前完成项目信任确认，返回需传给 pi 的信任覆盖指令。
	 * - 无需信任资源的项目（干净项目）：自动写入 trust.json 标记信任。
	 * - 已信任：放行，pi 查 trustStore 即可。
	 * - 未记录或曾记 false：弹窗让用户选择。不持久化 false，保证下次仍可重新选择。
	 *   - trust-remember：写 true，pi 信任加载资源。
	 *   - trust-session：用 --approve 本次覆盖，不落盘。
	 *   - deny：用 --no-approve 本次以不信任模式启动，pi 不加载项目级资源，Agent 仍可创建。
	 */
	async ensureProjectTrust(project: Project): Promise<"approve" | "no-approve" | undefined> {
		const wslEnvironment = this.host.getWslEnvironment();
		const cwd = wslEnvironment ? toWslLinuxPath(project.path, wslEnvironment) : project.path;
		const hostCwd = wslEnvironment ? toWindowsHostPath(project.path, wslEnvironment) : project.path;
		const configStore = this.host.getConfigStore();
		if (!this.hasTrustRequiringResources(hostCwd)) {
			// 干净项目：pi 无需加载项目级资源，pi-desktop 自动记入信任，避免每次创建 Agent 重复检查。
			this.host.info("Agent ensure trusted directory start", { cwd });
			await configStore.ensureTrustedDirectory(cwd);
			this.host.info("Agent ensure trusted directory completed", { cwd });
			return undefined;
		}
		const decision = await configStore.getProjectTrustDecision(cwd);
		if (decision === true) return undefined;
		// 未记录或曾记 false：弹窗让用户选择信任策略。不写 false，确保下次打开仍可重新决策。
		const choice = await this.requestProjectTrust(cwd, project.name);
		if (choice === "trust-remember") {
			await configStore.setProjectTrustDecision(cwd, true);
			return undefined;
		}
		if (choice === "trust-session") {
			return "approve";
		}
		// deny：本次以不信任模式启动，pi 不加载项目级资源，Agent 仍可创建。
		return "no-approve";
	}

	/**
	 * 非交互信任判定（standby 池化等后台路径用，绝不弹窗）。
	 * 干净项目自动记入信任（与 ensureProjectTrust 同语义）返回 undefined；
	 * 含资源且已持久化信任返回 undefined；含资源但未决策（需要用户选择）返回 null——
	 * 调用方应放弃后台池化，等用户走正常创建流程完成信任决策。
	 */
	async resolveTrustWithoutPrompt(project: Project): Promise<undefined | null> {
		const wslEnvironment = this.host.getWslEnvironment();
		const cwd = wslEnvironment ? toWslLinuxPath(project.path, wslEnvironment) : project.path;
		const hostCwd = wslEnvironment ? toWindowsHostPath(project.path, wslEnvironment) : project.path;
		const configStore = this.host.getConfigStore();
		if (!this.hasTrustRequiringResources(hostCwd)) {
			await configStore.ensureTrustedDirectory(cwd);
			return undefined;
		}
		return (await configStore.getProjectTrustDecision(cwd)) === true ? undefined : null;
	}

	/**
	 * 通过 IPC 请求渲染进程弹出项目信任确认窗，等待用户选择。
	 * 无窗口可用（如 headless）或 60 秒未响应时默认拒绝（安全优先）。
	 */
	private requestProjectTrust(cwd: string, projectName: string): Promise<ProjectTrustChoice> {
		const requestId = randomUUID();
		const win = this.host.getWindow();
		if (!win || win.isDestroyed()) {
			return Promise.resolve<ProjectTrustChoice>("deny");
		}
		return new Promise<ProjectTrustChoice>((resolve) => {
			const timer = setTimeout(() => {
				if (this.pendingTrustRequests.delete(requestId)) {
					resolve("deny");
				}
			}, 60_000);
			this.pendingTrustRequests.set(requestId, {
				resolve: (choice) => {
					clearTimeout(timer);
					resolve(choice);
				},
			});
			win.webContents.send(ipcChannels.projectsTrustRequest, { requestId, cwd, projectName });
		});
	}

	/** 渲染进程回传用户对信任确认弹窗的选择，唤醒等待中的 Agent 创建流程。 */
	respondTrustRequest(requestId: string, choice: ProjectTrustChoice): void {
		const pending = this.pendingTrustRequests.get(requestId);
		if (pending) {
			this.pendingTrustRequests.delete(requestId);
			pending.resolve(choice);
		}
	}
}
