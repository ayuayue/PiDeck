/**
 * WSL 目录浏览的公共形状（`docs/wsl-project-in-distro-io-plan.md` Wave 0）。
 *
 * 为什么不复用 `projectFiles.ts` 的 `ProjectDirectoryPage`：那套形状绑定「已存在的项目」——
 * `target.projectId` 是授权依据，`revision/generation` 描述同一项目事实的新鲜度，`dirWatch`
 * 是订阅降级。目录选择发生在项目建立**之前**，一次发行版内单层列举没有可承诺的 revision/watch
 * 语义，硬套会把「没查过」伪装成「没有变化」。
 *
 * 条目沿用 `RemoteDirectoryEntry`：SSH 与 WSL 的目录浏览器是同一个组件，「一个子目录名」在这两条
 * 链路里是同一事实。WSL 列举不判定符号链接（只列目录），所以 `isSymlink` 留空而不是谎报 false。
 *
 * 路径一律是**发行版内的 Linux 绝对路径**：这条通道面向还没成为项目的目录，转成规范 UNC 只在入库
 * 那一刻发生（`normalizeWslProjectAddPath`）。渲染层拿到的路径不可交给本机 fs API。
 */
import type { Op } from "../op";
import type { RemoteDirectoryEntry } from "./remoteHost";

export type WslDirectoryPage = {
	/** 本次列出的目录（已归一：绝对路径，除根外无尾斜杠）。 */
	path: string;
	/** 子目录（含指向目录的符号链接），按名排序；不含文件。 */
	entries: RemoteDirectoryEntry[];
	/** 超过上限时显式带出，不靠「刚好等于上限」猜截断。 */
	truncated: boolean;
};

/**
 * 稳定码（闭集）：跨进程、进日志、进测试断言，文案由渲染层按码取。
 * 全部是只读失败，`outcome` 恒为 `rejected`（没有任何重放风险）。
 */
export const WSL_DIRECTORY_CODES = {
	/** 空/非绝对/超长/含控制字符——请求本身不可用，没有落到发行版。 */
	pathInvalid: "WSL_DIRECTORY_PATH_INVALID",
	/** 发行版不可达、wsl.exe 缺失、超时或非 Windows。 */
	unavailable: "WSL_DIRECTORY_DISTRO_UNAVAILABLE",
	/** 目录不存在。 */
	notFound: "WSL_DIRECTORY_NOT_FOUND",
	/** 该路径存在但不是目录。 */
	notDirectory: "WSL_DIRECTORY_NOT_A_DIRECTORY",
	/** 目录存在但当前档案用户进不去（以档案用户身份执行，所以 root 档案能进 /root）。 */
	unreadable: "WSL_DIRECTORY_UNREADABLE",
} as const;

export type WslDirectoryCode = (typeof WSL_DIRECTORY_CODES)[keyof typeof WSL_DIRECTORY_CODES];

export type WslDirectoryPageResult = Op<WslDirectoryPage>;
