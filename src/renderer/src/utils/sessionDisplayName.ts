/**
 * 会话展示名。
 *
 * (fork) 后缀是会话名本身的一部分（fork/clone 完成时由主进程经 pi set_session_name
 * 物理写入标题，见 main/sessions/sessionForkTitle.ts），不再由展示层按 forked 标记拼装——
 * 否则用户重命名把后缀删掉后，展示层又会拼回去（「删不掉」）。
 * 这里直接返回标题原文，侧栏、Tab 栏、搜索、分支栏等所有展示点因此天然一致。
 */
export function sessionDisplayName(
	title: string | undefined,
	_forked?: boolean,
): string | undefined {
	return title;
}
