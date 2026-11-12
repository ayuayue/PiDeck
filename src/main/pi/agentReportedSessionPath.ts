/**
 * 「pi 上报的会话文件路径 → 绝对路径」的策略（本机/WSL 与**远端**两套规则）。
 *
 * 为什么单独成文件：这是本任务最容易踩错的一处判定——远端路径**不得**过本机规则
 * （`toAbsoluteSessionPath` 在 Windows 上不把 `/home/u/…` 当绝对路径，会拼到盘符后面再换分隔符）；
 * 而远端 pi 的 `sessionDir` 是相对值时上报的又是相对 cwd 的路径。两条规则各自的基址与拒绝条件
 * 需要能被直接断言，不该埋在 `AgentManager` 的私有方法里。
 *
 * 日志去重也在这里：`get_state` 每次轮询都会重报同一个相对路径，不去重时一条无害配置一分钟能刷出
 * 几十条同文案 warn（用户诊断报告里 790 条 warn 里绝大部分是它）。
 */
import type { SessionEnvironment } from "../../shared/types";
import { toAbsoluteSessionPath } from "../../shared/sessionIdentity";
import { resolveRemoteReportedSessionPath } from "./remoteSessionPath";

/** 只用到 warn 这一个方法（与 AppLogger 结构上兼容）。 */
type WarnLog = (message: string, detail: Record<string, unknown>) => void;

export type ReportedSessionPathInput = {
	readonly reported: string | undefined;
	readonly remote: boolean;
	/** 本机/WSL 项目的根（`toAbsoluteSessionPath` 的基址）。 */
	readonly projectPath: string;
	/** 远端项目的根；远端 pi 就是在这个 cwd 下解析相对 `sessionDir`。 */
	readonly remoteCwd: string;
	readonly environment: SessionEnvironment;
};

export class ReportedSessionPathResolver {
	private readonly loggedRelative = new Set<string>();

	constructor(private readonly warn: WarnLog) {}

	/**
	 * 返回绝对路径；`undefined` 表示 pi 没上报（新建会话的第一次 `get_state` 之前）。
	 *
	 * 远端解析失败（形状不可能来自 POSIX 主机）时**保留上报值**并记 warn：拒绝一个仍可能被 pi 用来
	 * 重启会话的路径不会让事情变好，而登记侧会用稳定码如实拒绝它。
	 */
	resolve(input: ReportedSessionPathInput): string | undefined {
		const { reported } = input;
		if (reported === undefined || reported === "") return undefined;
		if (!input.remote) {
			const resolved = toAbsoluteSessionPath(reported, input.projectPath, input.environment);
			this.logOnce(reported, resolved, "Session file path was relative; resolved to absolute", { sessionPath: reported, resolved });
			return resolved;
		}
		const resolved = resolveRemoteReportedSessionPath(reported, input.remoteCwd);
		if (resolved === undefined) {
			this.warn("Remote session path could not be resolved; keeping reported value", { remoteCwd: input.remoteCwd, reported });
			return reported;
		}
		this.logOnce(reported, resolved, "Remote session file path was relative; resolved against remote cwd", { remoteCwd: input.remoteCwd, resolved });
		return resolved;
	}

	/** 同一个原始路径只记一次（配置性相对路径每次轮询都会重报）。 */
	private logOnce(reported: string, resolved: string, message: string, detail: Record<string, unknown>): void {
		if (resolved === reported || this.loggedRelative.has(reported)) return;
		this.loggedRelative.add(reported);
		this.warn(message, detail);
	}
}
