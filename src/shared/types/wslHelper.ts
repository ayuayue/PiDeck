/**
 * WSL 发行版内 helper 的稳定码（`docs/wsl-project-in-distro-io-plan.md` Wave 1a）。
 *
 * 为什么码放 `shared/`：部署/会话失败会经 `Op` 信封跨到渲染层，码是跨进程契约而不是 main 的内部状态；
 * 形状（`WslHelperDeployment`）不放这里——它只在 main 内部流转（部署结果喂给会话），没有第二个读者。
 *
 * 为什么是闭集常量而不是拼字符串：同一类失败在不同面板上必须是同一个码，否则文案、日志、测试断言各说各话。
 * 全部是 `rejected`（没有任何一条要求重放）：部署是内容地址化的幂等写入，失败即什么都没激活。
 */
export const WSL_HELPER_DEPLOY_CODES = {
	/** argv/载荷形状不对——main 与发行版内脚本的契约被破坏，是 bug 不是环境问题。 */
	inputInvalid: "WSL_HELPER_DEPLOY_INPUT_INVALID",
	/** `$HOME` 不可用，或 `.pideck/remote-host` 不是这条私有路径上的私有目录（属主/权限不符）。 */
	homeInvalid: "WSL_HELPER_DEPLOY_HOME_INVALID",
	/** 建目录/写文件/fsync 失败：以该身份在发行版里写不进去。 */
	stagingInvalid: "WSL_HELPER_DEPLOY_STAGING_INVALID",
	/** 声明的 sha256/字节数与实际内容不符（本地 pinned 源不匹配，或落地后校验不过）。 */
	fileMismatch: "WSL_HELPER_DEPLOY_FILE_MISMATCH",
	/** 同一内容地址目录已存在但内容不同：不可变 bundle 绝不覆盖，直接拒绝。 */
	activeConflict: "WSL_HELPER_DEPLOY_ACTIVE_CONFLICT",
	/** 脚本内部未预期分支：与远端主机同口径，宁可回一个码也不裸抛。 */
	internal: "WSL_HELPER_DEPLOY_INTERNAL",
	/** 没跑起来：非 Windows、wsl.exe 缺失、spawn 失败/超时、非零退出且没有结果帧。 */
	unavailable: "WSL_HELPER_DEPLOY_UNAVAILABLE",
} as const;

export type WslHelperDeployCode = (typeof WSL_HELPER_DEPLOY_CODES)[keyof typeof WSL_HELPER_DEPLOY_CODES];

/** 闭集：脚本侧只允许回这些码，main 也只认这些；其余一律折成 `unavailable`。 */
export const WSL_HELPER_DEPLOY_CODE_LIST: readonly WslHelperDeployCode[] = Object.values(WSL_HELPER_DEPLOY_CODES);

/**
 * 发行版内 helper 会话（部署之后 spawn + hello 握手）的稳定码。
 *
 * 与部署码分两套：部署失败说明「发行版里没有可用的 bundle」，会话失败说明「bundle 在但这次连接不成立」，
 * 两者对用户的可行动作不同（前者重装/检查环境，后者重试），混成一套会让文案只能写成含糊的「WSL 不可用」。
 */
export const WSL_HELPER_SESSION_CODES = {
	/** distro/user/root/method 形状不对：调用方接线错误，没有落到发行版。 */
	inputInvalid: "WSL_HELPER_SESSION_INPUT_INVALID",
	/** 非 Windows、wsl.exe 缺失、spawn 失败——与部署码同口径的「这次根本跑不起来」。 */
	unavailable: "WSL_HELPER_SESSION_UNAVAILABLE",
	/** 发行版里找不到 node（探测脚本跑通但没命中，或 node 版本不足以跑 helper 的部署未通过）。 */
	nodeMissing: "WSL_HELPER_SESSION_NODE_MISSING",
	/** hello 帧形状不合法：对端不是这套 helper 协议。 */
	handshakeInvalid: "WSL_HELPER_SESSION_HANDSHAKE_INVALID",
	/** 对端协议版本不是 1：bundle 装对了但不是这份协议。 */
	protocolMismatch: "WSL_HELPER_SESSION_PROTOCOL_MISMATCH",
	/** helper 报告的 canonical root 与请求的项目路径不同（root 本身是符号链接或穿过它）。 */
	rootMismatch: "WSL_HELPER_SESSION_ROOT_MISMATCH",
	/** helper 缺少文件域必需的 fs.stat / fs.list / fs.read。 */
	capabilityMissing: "WSL_HELPER_SESSION_CAPABILITY_MISSING",
	/** 会话进程已经退出：请求不会再被服务，调用方需要重新发起（池会重建）。 */
	exited: "WSL_HELPER_SESSION_EXITED",
} as const;

export type WslHelperSessionCode = (typeof WSL_HELPER_SESSION_CODES)[keyof typeof WSL_HELPER_SESSION_CODES];
