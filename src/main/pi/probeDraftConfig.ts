/**
 * 「测试连接」隔离探针的临时 agent 目录构建（纯函数，便于单测）。
 *
 * 为什么需要：测试必须校验「用户眼前的值」（卡片里改到一半的字段、添加/编辑页的草稿），
 * 而真实探针（probePiModel）fork 的 pi 只读磁盘 agent 目录（models.json/auth.json/settings.json）。
 * 直接落盘会污染正式配置（半成品写盘、取消失效），所以把待测值写进临时 agent 目录，
 * 用 PI_CODING_AGENT_DIR 环境变量把 pi 的配置读取指向临时目录，探针结束后整目录删除。
 *
 * 三份文件：
 * - models.json：只含待测 provider（当前表单值，含 apiKey——pi 也认 models.json 层的 models_json_key）；
 * - auth.json：待测 provider 的 api_key 条目（无 key 时为空对象，回退 models.json 内 key）；
 * - settings.json：正式 settings.json 的副本（扩展供应商靠它加载，如扩展注册 api 协议的供应商）；
 *   刻意不复制正式 auth.json——避免 token 副本；测试按钮本就要求 baseUrl + apiKey 非空，
 *   OAuth/登录态供应商不在这条路径的覆盖范围内。
 *
 * pi 侧环境变量名：PI_CODING_AGENT_DIR（APP_NAME=pi → `PI_CODING_AGENT_DIR`，见 pi 的 agent-dir 解析）。
 * 实测（2026-09，pi 0.85.1）：设置后 pi 从该目录读配置，探针能按临时目录里的 provider 发起真实调用。
 */

/** pi 的 agent 配置目录覆盖环境变量（`${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`）。 */
export const PROBE_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/**
 * 构建临时 agent 目录的文件内容。调用方负责 mkdtemp/写盘/删除。
 * settings 传正式 settings.json 的解析值；空对象时不生成 settingsJson（少写一个文件）。
 */
export function buildProbeDraftFiles(
	providerName: string,
	provider: Record<string, unknown>,
	apiKey?: string,
	settings?: Record<string, unknown>,
): { modelsJson: string; authJson: string; settingsJson?: string } {
	const modelsFile = { providers: { [providerName]: provider } };
	const authFile = apiKey ? { [providerName]: { type: "api_key", key: apiKey } } : {};
	return {
		modelsJson: JSON.stringify(modelsFile, null, 2),
		authJson: JSON.stringify(authFile, null, 2),
		...(settings && Object.keys(settings).length > 0
			? { settingsJson: JSON.stringify(settings, null, 2) }
			: {}),
	};
}

/**
 * Windows 绝对路径 → WSL 可访问路径（默认挂载 /mnt/<drive>，WSL 发行版标准行为）。
 * 非 Windows 绝对路径或已是非 Windows 形式的路径原样返回。
 * 局限：自定义挂载点（非 /mnt/<drive>）的发行版不支持，按注释留待按需扩展。
 */
export function toWslAccessiblePath(winPath: string): string {
	const drive = /^([A-Za-z]):[\\/]/.exec(winPath);
	if (!drive) return winPath;
	return `/mnt/${drive[1].toLowerCase()}${winPath.slice(2).replace(/\\/g, "/")}`;
}