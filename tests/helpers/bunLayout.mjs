/**
 * bun 安装布局的临时目录 fixture：`<root>/.bun/bin/pi`（按需带上同目录的 bun 本体）。
 *
 * 为什么抽出来：ExtensionManager 的「推导路径 / 回退裸 bun」测试与 piCliUpdates 的端到端代跑测试
 * 都要这个布局，各写一份会随布局细节（`bun`/`bun.exe`、要不要造 bun 本体）漂移。
 * 调用方必须在 finally 里 await cleanup()，测试失败时也不留 /tmp 垃圾。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 平台可执行名：与生产代码 resolvePiSelfUpdateChannel 的 bunName 规则一致。 */
export const BUN_BIN_NAME = process.platform === "win32" ? "bun.exe" : "bun";
export const PI_BIN_NAME = process.platform === "win32" ? "pi.exe" : "pi";

/**
 * 造一份 bun 全局安装布局。
 * @param {{ withBun: boolean }} options withBun=false 模拟「本体在别处」（Homebrew/scoop），用于验证回退。
 */
export async function createBunLayout({ withBun }) {
	const root = await mkdtemp(join(tmpdir(), "pideck-bun-"));
	const binDir = join(root, ".bun", "bin");
	await mkdir(binDir, { recursive: true });
	const piPath = join(binDir, PI_BIN_NAME);
	const bunPath = join(binDir, BUN_BIN_NAME);
	await writeFile(piPath, "", "utf8");
	if (withBun) await writeFile(bunPath, "", "utf8");
	return {
		root,
		binDir,
		piPath,
		bunPath,
		/** 安装根（`<root>/.bun`），即生产代码作为 BUN_INSTALL 传给子进程的值。 */
		installRoot: join(root, ".bun"),
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}
