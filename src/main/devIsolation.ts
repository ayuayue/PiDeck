import { execFileSync } from "node:child_process";

/**
 * 开发态多 worktree / 多分支并行隔离。
 *
 * 所有 `npm run dev` 默认共用 %APPDATA%/PiDeck-dev 和 Vite :5181，
 * 同版本单实例锁会把第二个窗口杀掉。按 git 分支拆目录和端口后，
 * feat/* 与 dev 可同时开；历史目录由启动迁移器接管，不打散已有配置。
 *
 * 正式包 / dist:win:dev 不走分支后缀（没有可靠的 checkout 身份）。
 * `--user-data-dir=` 仍优先（e2e）。
 */

export const DEFAULT_DEV_USER_DATA_NAME = "PiDeck-dev";
export const LEGACY_DEV_USER_DATA_NAME = "pi-desktop-dev";
export const DEFAULT_DEV_VITE_PORT = 5181;
export const DEV_BRANCH_ENV = "PIDECK_DEV_BRANCH";
export const DEV_VITE_PORT_ENV = "PIDECK_DEV_VITE_PORT";

/** 这些分支共用 `PiDeck-dev` + 5181，旧数据首启迁移，功能分支仍独立。 */
const SHARED_DEV_BRANCHES = new Set(["main", "master", "dev", "develop"]);

export function sanitizeDevBranchSegment(branch: string): string {
	const cleaned = branch
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "");
	return cleaned.slice(0, 48) || "detached";
}

export function isSharedDevBranch(branch: string | undefined): boolean {
	if (!branch?.trim()) return true;
	return SHARED_DEV_BRANCHES.has(sanitizeDevBranchSegment(branch));
}

/** `%APPDATA%/<返回值>`：共享分支为 `PiDeck-dev`，其余带分支后缀。 */
export function resolveDevUserDataDirName(branch: string | undefined): string {
	if (isSharedDevBranch(branch)) return DEFAULT_DEV_USER_DATA_NAME;
	return `${DEFAULT_DEV_USER_DATA_NAME}-${sanitizeDevBranchSegment(branch ?? "")}`;
}

/**
 * 共享分支固定 5181；其它分支散列到 5182–5281，降低多 worktree Vite 抢端口。
 * electron-vite 会把实际监听地址注入 ELECTRON_RENDERER_URL，散列碰撞时让位也无妨。
 */
export function resolveDevVitePort(branch: string | undefined): number {
	if (isSharedDevBranch(branch)) return DEFAULT_DEV_VITE_PORT;
	const segment = sanitizeDevBranchSegment(branch ?? "");
	let hash = 2166136261;
	for (let i = 0; i < segment.length; i += 1) {
		hash ^= segment.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return 5182 + ((hash >>> 0) % 100);
}

export function readDevGitBranch(input: { env?: NodeJS.ProcessEnv; cwd?: string; execGit?: (cwd: string) => string | undefined } = {}): string | undefined {
	const env = input.env ?? process.env;
	const fromEnv = env[DEV_BRANCH_ENV]?.trim();
	if (fromEnv) return fromEnv;
	const cwd = input.cwd ?? process.cwd();
	const execGit = input.execGit ?? defaultExecGit;
	const raw = execGit(cwd)?.trim();
	if (!raw || raw === "HEAD") return undefined;
	return raw;
}

function defaultExecGit(cwd: string): string | undefined {
	try {
		return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2000,
			windowsHide: true,
		});
	} catch {
		return undefined;
	}
}
