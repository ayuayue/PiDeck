import { _electron as electron, expect, test as base, type ElectronApplication, type Locator, type Page, type TestInfo } from "@playwright/test";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

/**
 * 远端主机功能级验收（task-25）的专用 fixture 与纯函数。
 *
 * 与 e2e/fixtures.ts 的一点刻意差异，是真机验收的必要条件：
 * 1) **不隔离 HOME/USERPROFILE**：产品自身用系统 OpenSSH 连主机，必须能读到真实用户的
 *    ~/.ssh/config 与私钥；只隔离 Electron 的 userData（--user-data-dir + APPDATA/LOCALAPPDATA），
 *    绝不碰开发者的真实应用数据。
 *
 * 凭据只从环境变量读；仓库里不存在也不允许出现真实主机/指纹字面量。
 */

/** 凭据与超时环境变量的唯一出处：spec、fixture 与守卫测试都从这里取名字。 */
/**
 * 应用真实 userData 在隔离根下的子目录名。fixture 用它给 Electron 传 `--user-data-dir`/`PIDECK_E2E_USER_DATA_DIR`，
 * 断言（例如读落盘 pin）也必须用同一个名字，否则读的是隔离根本身而不是应用的 userData。
 */
export const REMOTE_APP_DATA_DIR_NAME = "profile";

export const REMOTE_ACCEPTANCE_ENV = {
	host: "PIDECK_E2E_REMOTE_HOST",
	user: "PIDECK_E2E_REMOTE_USER",
	fingerprint: "PIDECK_E2E_REMOTE_FINGERPRINT",
	port: "PIDECK_E2E_REMOTE_PORT",
	connectTimeoutMs: "PIDECK_E2E_REMOTE_CONNECT_TIMEOUT_MS",
	helperTimeoutMs: "PIDECK_E2E_REMOTE_HELPER_TIMEOUT_MS",
} as const;

export type RemoteAcceptanceCredentials = { host: string; user: string; fingerprint: string; port: number };
export type RemoteAcceptanceTimeouts = { connectMs: number; helperMs: number };

const DEFAULT_CONNECT_TIMEOUT_MS = 180_000;
const DEFAULT_HELPER_TIMEOUT_MS = 240_000;
/** ED25519 SHA256 指纹形态：恰好一个 SHA256: 前缀 + base64 段（前缀大小写不敏感，正文逐字保留）。 */
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{20,}={0,2}$/;

/**
 * 归一化指纹；形态不认识就返回空串（调用方据此当作「没有凭据」而不是「指纹匹配」）。
 *
 * 口径：**前缀大小写不敏感**（env 是用户手输的，sha256:/SHA256: 都接受，统一归一成 SHA256:），
 * base64 正文**逐字保留**（base64 区分大小写，正文放宽才是真的放水）。空正文、双前缀、
 * 无前缀、纯空白一律不可用。
 */
export function normalizeRemoteFingerprint(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length < 8) return "";
	const prefix = trimmed.slice(0, 7);
	if (prefix.toUpperCase() !== "SHA256:") return "";
	const normalized = "SHA256:" + trimmed.slice(7);
	return FINGERPRINT.test(normalized) ? normalized : "";
}

/** 期望指纹是否命中真实展示、或产品实际落盘的指纹集合（逐项归一化比较）。 */
export function matchesRemoteFingerprint(expected: string, observed: readonly string[]): boolean {
	const normalized = normalizeRemoteFingerprint(expected);
	if (normalized === "") return false;
	return observed.some((value) => normalizeRemoteFingerprint(value) === normalized);
}

/**
 * 读回产品为某台主机**实际落盘**的主机密钥指纹（隔离 userData 里的 `remote-hosts.json`）。
 *
 * 为什么不再从界面读：首次信任自 74682ad72 起在主进程内完成（TOFU），设置页不再弹「确认主机指纹」，
 * 界面也就没有可读的指纹文本。但验收要证的仍是同一件事——产品为这台主机钉住的是**期望的那把钥匙**；
 * 而落盘值正是它此后用 `StrictHostKeyChecking=yes` 强制执行的那一个，比读界面文本更强。
 *
 * `userDataRoot` 是应用真实的 userData 目录（隔离根下的 `profile/`），不是 fixture 的隔离根。
 * 只读不写；文件不在、快照不是已知形状、主机不存在、或指纹字段不合法时返回 undefined（调用方据此失败）。
 */
export function readPinnedHostKeyFingerprint(userDataRoot: string, sshHost: string): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(join(userDataRoot, "remote-hosts.json"), "utf8"));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const profiles = (parsed as { profiles?: unknown }).profiles;
	if (!Array.isArray(profiles)) return undefined;
	for (const entry of profiles) {
		if (typeof entry !== "object" || entry === null) continue;
		const profile = entry as { sshHost?: unknown; verifiedEndpoint?: unknown };
		if (profile.sshHost !== sshHost) continue;
		const endpoint = profile.verifiedEndpoint;
		if (typeof endpoint !== "object" || endpoint === null) continue;
		const fingerprints = (endpoint as { hostKeyFingerprints?: unknown }).hostKeyFingerprints;
		if (!Array.isArray(fingerprints) || fingerprints.length !== 1) continue;
		const value = fingerprints[0];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function readPositiveInt(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Number(value.trim());
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function readRemoteAcceptanceTimeouts(env: Record<string, string | undefined>): RemoteAcceptanceTimeouts {
	return {
		connectMs: readPositiveInt(env[REMOTE_ACCEPTANCE_ENV.connectTimeoutMs], DEFAULT_CONNECT_TIMEOUT_MS),
		helperMs: readPositiveInt(env[REMOTE_ACCEPTANCE_ENV.helperTimeoutMs], DEFAULT_HELPER_TIMEOUT_MS),
	};
}

/**
 * 解析凭据：三个必需变量缺任意一个（或指纹/端口形态不合法）一律返回 undefined，
 * 即「无凭据 → 整体 skip」。刻意没有半凭据分支，避免以半套配置跑出一个假结论。
 */
export function readRemoteAcceptanceCredentials(env: Record<string, string | undefined>): RemoteAcceptanceCredentials | undefined {
	const host = env[REMOTE_ACCEPTANCE_ENV.host]?.trim() ?? "";
	const user = env[REMOTE_ACCEPTANCE_ENV.user]?.trim() ?? "";
	const fingerprint = normalizeRemoteFingerprint(env[REMOTE_ACCEPTANCE_ENV.fingerprint] ?? "");
	if (host === "" || user === "" || fingerprint === "") return undefined;
	const rawPort = env[REMOTE_ACCEPTANCE_ENV.port]?.trim();
	const port = rawPort === undefined || rawPort === "" ? 22 : Number(rawPort);
	if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return undefined;
	return { host, user, fingerprint, port };
}

const execFileAsync = promisify(execFile);

/**
 * 在真机上跑一条受限命令（只用于测试前置/恢复：建目录、写会话文件、改名、清理）。
 * BatchMode：绝不允许交互式密码提示把 e2e 挂住；超时由调用方给。
 */
export async function runRemoteCommand(credentials: RemoteAcceptanceCredentials, command: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
	// `-n` closes stdin locally. Without it Windows OpenSSH can keep the local process alive after a
	// short remote command has already completed, which makes a watcher oracle look like a product stall.
	const args = ["-n", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=8", "-p", String(credentials.port), credentials.user + "@" + credentials.host, command];
	const run = () => execFileAsync("ssh", args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
	try {
		const { stdout, stderr } = await run();
		return { stdout, stderr };
	} catch (error) {
		// Direct SSH oracles are test infrastructure, not the product path: a single dropped connection or a
		// local client timeout must not turn into a fake product failure. Retry exactly once; a remote command
		// failure that carried real output is rethrown unchanged.
		const failure = error as { code?: unknown; stderr?: unknown; killed?: unknown; signal?: unknown };
		const stderr = typeof failure.stderr === "string" ? failure.stderr : "";
		const timedOut = failure.killed === true || failure.code === "ETIMEDOUT" || failure.signal === "SIGTERM";
		if (!timedOut && failure.code !== 255 && !/Connection reset|Connection closed|Connection timed out|Operation timed out|Broken pipe|kex_exchange|Timeout, server|banner exchange/i.test(stderr)) throw error;
		await new Promise((resolve) => setTimeout(resolve, 300));
		const { stdout, stderr: retried } = await run();
		return { stdout, stderr: retried };
	}
}

const repoRoot = resolve(__dirname, "..");

export type RemoteAppFixture = { remoteApp: ElectronApplication; remoteWindow: Page; remoteUserDataRoot: string };

export const test = base.extend<RemoteAppFixture & { remoteCredentials: RemoteAcceptanceCredentials }>({
	// 凭据 fixture 先于 remoteApp：缺凭据时先 skip，连临时目录都不会建。
	remoteCredentials: async ({}, use) => {
		const credentials = readRemoteAcceptanceCredentials(process.env);
		if (credentials === undefined) {
			// 缺凭据 = 整体 skip：不建临时目录、不启动 Electron（test.skip 会抛出跳过信号）。
			test.skip(true, "set " + [REMOTE_ACCEPTANCE_ENV.host, REMOTE_ACCEPTANCE_ENV.user, REMOTE_ACCEPTANCE_ENV.fingerprint].join(" / ") + " to run the real-host acceptance test");
			return;
		}
		await use(credentials);
	},
	remoteUserDataRoot: async ({}, use) => {
		// Windows 上 %TEMP% 常是 8.3 短名（C:\Users\ADMINI~1\...），而 Electron 主进程的 realpath 会把它展开成长名，
		// dev 的项目文件读取边界用「canonical 目标 vs 词法根」比较，短名根会被误判为越界并在启动时打一条
		// files:list 失败（产品缺陷，已在验收报告单独记录，不在 e2e 里修）。这不是本测试要验的行为：把隔离根
		// 归一成长名一次，夹具里的项目路径就只有一种形态（系统目录选择器给的也通常是长名）。仅统一路径形态，
		// 不改变隔离范围，也不影响任何断言。
		const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "pideck-e2e-remote-")));
		await use(dir);
		await rm(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
	},
	remoteApp: async ({ remoteUserDataRoot }, use, testInfo) => {
		// 依赖 remoteCredentials：无凭据时该 fixture 已被 skip，这里根本不会执行（也就不会启动 Electron）。
		const entry = join(repoRoot, "out", "main", "index.js");
		if (!existsSync(entry)) throw new Error("out/main/index.js 不存在：先跑 npm run build:fast（e2e 不负责构建）");
		const profileDir = join(remoteUserDataRoot, REMOTE_APP_DATA_DIR_NAME);
		mkdirSync(profileDir, { recursive: true });
		// 语言固定 zh-CN，e2e 的按钮/标签选择器才与字典一致（不受宿主机系统语言影响）。
		// piEnvironmentChecked 预置 true：开发机普遍有多份 pi 安装，全新 profile 首启会弹出「Pi 环境检测」模态，
		// Radix 会把主界面 aria-hidden → 侧栏设置入口等 getByRole 集体失效（伪装成点击超时）。dev 的 e2e/fixtures.ts
		// 用同一手法规避；此处与它对齐，真实主机验收不应先被人机环境检查弹窗挡住。
		writeFileSync(join(profileDir, "settings.json"), JSON.stringify({ language: "zh-CN", piEnvironmentChecked: true }));
		const env: NodeJS.ProcessEnv = {
			...process.env,
			PIDECK_E2E_USER_DATA_DIR: profileDir,
			// 只隔离 userData；USERPROFILE/HOME 保持真实，OpenSSH 才能读到真用户的 config 与私钥。
			APPDATA: remoteUserDataRoot,
			LOCALAPPDATA: remoteUserDataRoot,
			PIDECK_E2E: "1",
			CI: "1",
		};
		delete env.ELECTRON_RENDERER_URL;
		// xterm 6 默认装 WebGL 渲染器：终端正文只画在 canvas 上，DOM 里没有 .xterm-rows。
		// 只有「远端终端」验收要读「用户实际看到的终端文本」，因此仅这一条用例关掉 GPU/软件光栅化，
		// 让 WebGL 不可用、走产品自己 try/catch 的 DOM 渲染器回退（TerminalDock 的官方兜底路径）；
		// 断言仍读真实渲染结果，不改从 PTY 旁路取数。其余用例保持默认 WebGL 渲染（真实用户路径），
		// 避免为读文本全局改变渲染后端。
		const domTerminalRenderer = testInfo.title.includes("远端终端");
		const rendererArgs = domTerminalRenderer ? ["--disable-gpu", "--disable-software-rasterizer"] : [];
		const app = await electron.launch({ args: [entry, "--user-data-dir=" + profileDir, ...rendererArgs], env: Object.fromEntries(Object.entries(env).filter((pair): pair is [string, string] => pair[1] !== undefined)) });
		await use(app);
		await app.close();
	},
	remoteWindow: async ({ remoteApp }, use) => {
		const window = await remoteApp.firstWindow();
		await window.waitForLoadState("domcontentloaded");
		// 启动引导弹窗会抢焦点/遮拦点击：与 e2e/fixtures.ts 同一处理（出现即关）。
		await expectBootOverlayGone(window);
		await use(window);
	},
});

/** 启动遮罩消失是后续所有点击的前提；单独抽出来，失败信息比后续点击超时更可读。 */
async function expectBootOverlayGone(window: Page): Promise<void> {
	const overlay = window.locator("#boot-overlay");
	await overlay.waitFor({ state: "detached", timeout: 30_000 }).catch(() => undefined);
}

/**
 * D1 诊断导出：**只在失败路径**调用，把 App 自身的连接诊断、主机清单、项目 locator 与扫描原始码
 * 一次性带回来。硬要求：
 * - 不改任何断言（本函数只打印/attach，不 expect）；
 * - 绝不能成为新的失败源：每个探针各自 try/catch，整体再包一层 try/catch，连 attach 失败也只告警；
 * - 只走 preload 已有通道（remoteHosts.list / remoteHosts.diagnostics / remoteSessions.scan / projects.list），
 *   不新增 IPC。
 */
export type RemoteDiagnosticsInput = {
	/** 触发点说明：写进报告头，便于在 trace 里定位是第几步的失败。 */
	reason: string;
	/** 第 5 步 UI 上实际显示的失败文本（例如「无法确定远端会话目录…」），读不到就传 null。 */
	uiFailureText?: string | null;
	/** 项目 A/B 的 projectId（从项目行 DOM 的 data-sidebar-removal-id 取），用于核对 locator.hostId。 */
	projectIds?: Array<string | null | undefined>;
};

/** 报告里每个探针的固定顺序：hosts → hostId → diagnostics → scanNow → projects。 */
export async function attachRemoteDiagnostics(window: Page, testInfo: TestInfo, input: RemoteDiagnosticsInput): Promise<void> {
	const report: Record<string, unknown> = {
		reason: input.reason,
		at: new Date().toISOString(),
		uiFailureText: input.uiFailureText ?? null,
	};
	const attempt = async (label: string, run: () => Promise<unknown>): Promise<void> => {
		try {
			report[label] = await run();
		} catch (error) {
			// 诊断探针失败只记录原因，绝不向上抛。
			report[label] = { diagnosticError: error instanceof Error ? error.message : String(error) };
		}
	};
	try {
		await attempt("hosts", () =>
			window.evaluate(async () => {
				const api = (window as unknown as { piDesktop: { remoteHosts: { list: () => Promise<unknown> } } }).piDesktop;
				return api.remoteHosts.list();
			}),
		);
		const hostId = readFirstHostId(report.hosts);
		report.hostId = hostId ?? null;
		if (hostId !== undefined) {
			await attempt("diagnostics", () =>
				window.evaluate(async (id: string) => {
					const api = (window as unknown as { piDesktop: { remoteHosts: { diagnostics: (hostId: string) => Promise<unknown> } } }).piDesktop;
					return api.remoteHosts.diagnostics(id);
				}, hostId),
			);
			report.latestState = readLatestDiagnosticState(report.diagnostics);
			// 失败路径上再扫一次，拿到主进程返回的**原始 code**（UI 文案只是它的呈现）。
			await attempt("scanNow", () =>
				window.evaluate(async (id: string) => {
					const api = (window as unknown as { piDesktop: { remoteSessions: { scan: (hostId: string) => Promise<unknown> } } }).piDesktop;
					return api.remoteSessions.scan(id);
				}, hostId),
			);
			// 判别性探针（D1 追加）：同一个 hostId 再走一次项目面板的读取路径。项目读取经 withProjectSession，
			// 需要时**按需建立**会话；而 remoteHome 只读当前状态。两者一个成功一个失败，就能区分「那一刻连接
			// 整体不 ready」与「状态读不到、但会话仍能按需建立」。
			const probeProjectId = (input.projectIds ?? []).find((id): id is string => typeof id === "string" && id.length > 0);
			report.probeProjectId = probeProjectId ?? null;
			if (probeProjectId !== undefined) {
				await attempt("projectRead", () =>
					window.evaluate(async (projectId: string) => {
						const api = (window as unknown as { piDesktop: { remoteHosts: { listProject: (projectId: string, path: string) => Promise<unknown> } } }).piDesktop;
						return api.remoteHosts.listProject(projectId, "");
					}, probeProjectId),
				);
			}
			report.discriminator = {
				scanCode: readStableCode(report.scanNow),
				projectReadOk: readOk(report.projectRead),
				projectReadCode: readStableCode(report.projectRead),
				classification: classifyProbe(report.scanNow, report.projectRead),
			};
		}
		await attempt("projects", () =>
			window.evaluate(
				async (input: { ids: Array<string | null | undefined> }) => {
					const api = (window as unknown as { piDesktop: { projects: { list: () => Promise<Array<{ id: string; name: string; locator?: { kind: string; hostId?: string; remotePath?: string } }>> } } }).piDesktop;
					const all = await api.projects.list();
					return {
						all: all.map((project) => ({ id: project.id, name: project.name, locatorKind: project.locator?.kind ?? null, locatorHostId: project.locator?.hostId ?? null })),
						requested: input.ids.map((id) => {
							const found = all.find((project) => project.id === id);
							return id === null || id === undefined ? { id: null, found: false } : { id: id, found: found !== undefined, name: found?.name ?? null, locatorKind: found?.locator?.kind ?? null, locatorHostId: found?.locator?.hostId ?? null, remotePath: found?.locator?.remotePath ?? null };
						}),
					};
				},
				{ ids: input.projectIds ?? [] },
			),
		);
	} catch (error) {
		report.collectError = error instanceof Error ? error.message : String(error);
	}
	try {
		const text = JSON.stringify(report, null, 2);
		// 打印 + attach：trace 与 CI 日志里都能读到同一份内容。
		console.log("[remote-acceptance-diagnostics] " + text);
		await testInfo.attach("remote-acceptance-diagnostics", { body: text, contentType: "text/plain" });
	} catch (error) {
		console.warn("[remote-acceptance-diagnostics] attach failed: " + (error instanceof Error ? error.message : String(error)));
	}
}

function readFirstHostId(hosts: unknown): string | undefined {
	const record = hosts as { ok?: boolean; hosts?: Array<{ id?: unknown }> } | undefined;
	if (record === undefined || record === null || record.ok !== true || !Array.isArray(record.hosts)) return undefined;
	const first = record.hosts.find((host) => typeof host?.id === "string");
	return typeof first?.id === "string" ? first.id : undefined;
}

/** `{ ok: true|false }` 探针的 ok 位；不是对象就返回 undefined。 */
function readOk(value: unknown): boolean | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const ok = (value as { ok?: unknown }).ok;
	return typeof ok === "boolean" ? ok : undefined;
}

/** 探针结果里的稳定码（`{ok:false, code}` 或 `{ok:true}` 都安全）。 */
function readStableCode(value: unknown): string | null {
	if (value === null || typeof value !== "object") return null;
	const code = (value as { code?: unknown }).code;
	return typeof code === "string" ? code : null;
}

/**
 * 只做**事实分类**，不替产品下结论：扫描失败而项目读取成功 ⇒ 状态读不到但会话能按需建立；
 * 两者都失败 ⇒ 那一刻连接整体不可用。
 */
function classifyProbe(scan: unknown, projectRead: unknown): string {
	if (readOk(scan) === true) return "scan-succeeded-diagnostic-only";
	const projectOk = readOk(projectRead);
	if (projectOk === true) return "project-read-succeeded-while-scan-failed";
	if (projectOk === false) return "both-scan-and-project-read-failed";
	return "inconclusive-project-read-not-run";
}

/**
 * 侧栏项目行的容器（ProjectTree 的 SidebarRemovalRow 用这个类名）。
 *
 * 与 `remoteHostAcceptance.spec.ts` 里的同名局部函数**逐字同款**：Phase 4 的会话验收要用同一个锚点，
 * 而 spec 内的局部函数无法跨文件复用（那份 spec 不在本次允许改动的范围内）。放这里是为了让
 * 「新增的远端会话入口」与既有的项目锚点只有一个来源，避免第二次实现挑选器。
 */
/** 远端空态默认是输入页：文件面板是次入口，测试要列目录时先点「浏览远端文件」。 */
export async function openRemoteProjectFiles(window: Page): Promise<void> {
	const browse = window.getByRole("button", { name: "浏览远端文件", exact: true }).first();
	if (await browse.isVisible().catch(() => false)) await browse.click();
}

/** 打开会话运行菜单：兼容旧 Tab 栏 ⋯ 与现行会话头部「更多运行操作」。 */
export async function openSessionRunMenu(window: Page): Promise<void> {
	await dismissRemoteToasts(window);
	const legacy = window.locator(".session-tabs-actions").getByRole("button", { name: "更多操作" });
	if ((await legacy.count()) > 0) {
		await legacy.first().click();
		return;
	}
	await window.getByRole("button", { name: "更多运行操作" }).first().click();
}

/** 关闭通知中心里的 toast：它们会盖住会话头部按钮并拦截点击。 */
export async function dismissRemoteToasts(window: Page): Promise<void> {
	const region = window.getByRole("region", { name: /Notifications/ });
	const close = region.getByRole("button", { name: "关闭", exact: true });
	for (let index = 0; index < 8; index += 1) {
		if ((await close.count()) === 0) break;
		await close
			.first()
			.click({ timeout: 2_000 })
			.catch(() => undefined);
		await window.waitForTimeout(30);
	}
}

/** 连接成功后的进度对话框是模态的；不关掉会挡住设置页的连接/断开按钮。 */
export async function dismissRemoteConnectionProgress(window: Page): Promise<void> {
	const progress = window.getByRole("dialog", { name: /已连接$/ });
	const buttons = progress.getByRole("button", { name: /^(完成|关闭)$/ });
	// 连接/断开都可能异步再弹一次进度框；观察 5s，出现就关，避免它在随后挡住设置页按钮。
	for (let tick = 0; tick < 20; tick += 1) {
		if (
			(await progress.count()) > 0 &&
			(await progress
				.first()
				.isVisible()
				.catch(() => false))
		) {
			// 「完成」是就绪态的主关闭按钮；仍可见时再试「关闭」。
			await buttons
				.first()
				.click({ timeout: 3_000 })
				.catch(() => undefined);
			await window.waitForTimeout(100);
			if (
				await progress
					.first()
					.isVisible()
					.catch(() => false)
			)
				await buttons
					.last()
					.click({ timeout: 3_000 })
					.catch(() => undefined);
		}
		await window.waitForTimeout(250);
	}
}

/**
 * 在当前打开的远端目录浏览器里导航到绝对路径。选取即「当前目录」，没有单独的确认按钮；
 * 隐藏目录（.pideck-e2e-*）需要先打开「显示隐藏目录」。
 */
export async function chooseRemoteDirectory(window: Page, targetPath: string): Promise<void> {
	const picker = window.getByTestId("directory-picker").last();
	await expect(picker).toBeVisible({ timeout: 30_000 });
	const currentPath = async () => (await picker.getAttribute("data-current-path")) ?? "";
	await expect.poll(currentPath, { timeout: 30_000 }).not.toBe("");
	let current = await currentPath();
	const target = targetPath.replace(/\/+$/, "");
	const hiddenToggle = picker.getByRole("button", { name: "显示隐藏目录" });
	const showHiddenIfNeeded = async (segment: string) => {
		if (!segment.startsWith(".")) return;
		if ((await hiddenToggle.getAttribute("aria-pressed")) !== "true") await hiddenToggle.click();
	};
	if (target !== current && !target.startsWith(current === "/" ? "/" : current + "/")) {
		const parent = picker.getByRole("button", { name: "上一级" });
		for (let step = 0; step < 32 && current !== "/"; step += 1) {
			await parent.click();
			await expect.poll(currentPath, { timeout: 30_000 }).not.toBe(current);
			current = await currentPath();
		}
	}
	const rest =
		target === current
			? []
			: target
					.slice(current === "/" ? 1 : current.length + 1)
					.split("/")
					.filter(Boolean);
	for (const segment of rest) {
		await showHiddenIfNeeded(segment);
		const entry = picker.getByRole("button", { name: segment, exact: true }).first();
		await expect(entry).toBeVisible({ timeout: 30_000 });
		await entry.click();
		const expected = current === "/" ? "/" + segment : current + "/" + segment;
		await expect.poll(currentPath, { timeout: 30_000 }).toBe(expected);
		current = expected;
	}
}

export function remoteProjectRow(window: Page, projectName: string) {
	return window.locator(".project-group").filter({ hasText: projectName });
}

/**
 * 项目标题行里「项目名按钮」的可点/可右键区域。
 *
 * dev 的 ProjectTree 重设计删掉了旧的 .project-draggable：项目名现在是一个
 * button.cursor-grab（点击同时切项目与折叠），里面才是 .conversation-title。
 * 会话行同样用 .conversation-title，但项目标题行在 DOM 顺序上永远排在它展开的会话之前，
 * 所以 first() 就是标题本身，而不是某条会话（不用 nth，也不依赖按钮里没有稳定 role/aria-label 的现状）。
 * 点击/右键都落在标题按钮上：右键事件冒泡到标题行的 onContextMenu，与旧行为一致。
 */
export function remoteProjectTitle(window: Page, projectName: string): Locator {
	return remoteProjectRow(window, projectName).locator(".conversation-title").first();
}

/**
 * 在指定项目里新建会话（Phase 4 P4.2 真机 UI 验收的**新点**：远端项目的会话创建入口）。
 *
 * 为什么必须单独有它：既有夹具只覆盖到「登记远端项目」，而远端项目的中间空态是**只读**面板
 * （ProjectEmptyState → RemoteProjectPanel，没有任何新建入口），所以「在该项目里新建会话」
 * 只能从侧栏项目行的操作浮层进入。
 *
 * 为什么先 hover 再点：项目行右侧操作浮层是 dimmed actions（`opacity-0 pointer-events-none` +
 * `group-hover:pointer-events-auto`，见 ProjectTree 的 dimmedActionsClass）。Playwright 的点击
 * 命中测试跑在 hover 之前，`pointer-events:none` 的按钮收不到事件、直接 click 会超时；
 * **不用 `force: true`**——force 跳过命中测试，点击会落到浮层下面的项目名按钮上（表现为
 * 「点了 + 结果折叠/展开了项目」），那不是用户路径，也就不是证据。
 *
 * 只负责「点真实入口」这一件事：会话视图/时间线的断言留给调用方。
 */
export async function createRemoteSessionInProject(window: Page, projectName: string): Promise<void> {
	const row = remoteProjectRow(window, projectName);
	await expect(row).toBeVisible();
	await row.hover();
	// 展开的项目组中心落在会话列表上，hover浮层所属的标题行才能真的解除命中屏蔽。
	await remoteProjectTitle(window, projectName).hover();
	// aria-label 来自 i18n `app.newNormalSession`（项目行「+」与 Chat 标题栏「+」共用同一文案），
	// 所以必须限定在项目行内取，避免命中 Chat 区那个同名按钮。
	const newSession = row.getByRole("button", { name: "普通会话", exact: true });
	await expect(newSession).toBeVisible();
	await newSession.click();
}

function readLatestDiagnosticState(diagnostics: unknown): unknown {
	const record = diagnostics as { ok?: boolean; entries?: Array<{ state?: unknown; phase?: unknown; code?: unknown; at?: unknown }> } | undefined;
	if (record === undefined || record === null || record.ok !== true || !Array.isArray(record.entries) || record.entries.length === 0) return null;
	const last = record.entries[record.entries.length - 1];
	return { state: last?.state ?? null, phase: last?.phase ?? null, code: last?.code ?? null, at: last?.at ?? null, entryCount: record.entries.length };
}
