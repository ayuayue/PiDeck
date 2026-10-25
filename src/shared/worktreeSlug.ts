/**
 * worktree 名称 → 合法 slug（目录名 == 分支名）。
 *
 * 跨进程纯契约：renderer 创建对话框的预览与 main 的 WorktreeService 共用，
 * 保证「用户看到的预览」与「最终创建的分支名」完全一致，避免输入与结果脱节。
 *
 * 修复 issue #166：旧实现用 `[^\p{L}\p{N}]` 把 `.`、`_` 也替换成 `-`，
 * 但 `.` / `_` 是 git 分支和文件系统目录名都接受的合法字符，属于过度清洗。
 */

/**
 * 把用户输入转换为合法的 worktree 目录名 / 分支名 slug。
 *
 * 保留 Unicode 字母与数字（如中文、日文），以及 git 分支与文件系统都接受的
 * `.` / `_` / `-`；其余字符（空格、/、\、~、^、:、?、*、[、@、{、控制符等）
 * 折叠为单个 `-`。
 *
 * 边界处理（对应 git check-ref-format 硬性规则，否则 git worktree add 直接报错）：
 * - 去掉开头/结尾的 `.`（git 不允许；Windows 目录名尾部点还会被系统静默剥掉，
 *   导致「目录名 ≠ 分支名」，必须显式清除）；
 * - 连续 `..` 折叠为单个 `.`（`..` 是 git 非法分支字符，也避免目录被解析为上级路径）；
 * - 结尾 `.lock` 改为 `-lock`（git 保留后缀，不丢弃用户文本）；
 * - 空结果回落 "workspace"。
 */
export function worktreeSlugify(input: string): string {
	return (
		input
			.trim()
			// 非法字符折叠为单个 -；保留字母/数字/._-
			.replace(/[^\p{L}\p{N}._-]+/gu, "-")
			// 去掉首尾 -（含非法字符折叠后产生的）
			.replace(/^-+|-+$/g, "")
			// 去掉首尾点（git 分支规则 + Windows 目录名约束）
			.replace(/^\.+|\.+$/g, "")
			// 连续点折叠为单个点
			.replace(/\.{2,}/g, ".")
			// git 保留后缀 .lock 改为 -lock，避免整个分支名被拒
			.replace(/\.lock$/, "-lock")
			// 去点/折叠后可能再次让首尾出现 -，最后清一次
			.replace(/^-+|-+$/g, "") || "workspace"
	);
}
