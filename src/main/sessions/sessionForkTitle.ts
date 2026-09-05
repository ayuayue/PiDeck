/**
 * fork/clone 产物的物理命名后缀。
 *
 * 为什么必须有这个函数：(fork) 属于会话名本身，而不是展示层的装饰。
 * 以前 (fork) 由展示层按 catalog 的 forked 标记拼装，用户重命名把后缀删掉后
 * 展示层又会拼回去（「删不掉」）；现在 fork/clone 完成时直接把后缀写进真实标题
 * （pi set_session_name RPC 持久化到会话文件），改名删掉就是真的删掉，
 * 扫描回读（session_info 命中）也与标题一致。
 *
 * 后缀由调用方传入（i18n mainCopy("session.forkedSuffix")），本函数只做
 * 「追加一次、不重复」的纯文本规则，便于单测。
 */
export function appendSessionForkSuffix(title: string, suffix: string): string {
	if (!title || !suffix) return title;
	// 已带后缀（外部命名/重复调用）不再追加，避免 "xxx (fork) (fork)"。
	// 同时兼容无空格形式（用户手动命名 "xxx(fork)"）不重复追加。
	return title.endsWith(" " + suffix) || title.endsWith(suffix)
		? title
		: `${title} ${suffix}`;
}
