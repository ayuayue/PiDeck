/**
 * 供应商名是配置键，不是环境变量名；Pi 与 DSH 均允许中文、数字开头和空格。
 * DSH 凭据引用由 credentialRefFor 单独生成，不能反过来限制 Pi 名称。
 *
 * 唯一的例外是 `%`：Windows 下 pi 常经 cmd.exe shim 启动（PiLocator 的 windowsVerbatimArguments
 * 通道），cmd 的 %VAR% 展开不受引号影响（实测 `"a%PATH%b"` 照样展开），供应商名又会被原样送进
 * `--provider`，成对 `%` 会让 pi 收到与配置不符的值。启动层修不了，只能在这里拒绝。
 */
export const PROVIDER_NAME_MAX_LENGTH = 80;

/** 与主进程的配置安全边界一致：拒绝路径、控制字符、`%` 和超长名称。 */
export function isValidProviderName(name: string): boolean {
	if (typeof name !== "string") return false;
	const trimmed = name.trim();
	return trimmed.length > 0 && trimmed.length <= PROVIDER_NAME_MAX_LENGTH && trimmed !== "__proto__" && !/[\\/\u0000-\u001f\u007f%]/.test(name) && !trimmed.includes("..");
}

export const PROVIDER_NAME_RULE_I18N_KEY = "config.providerNameRule";
