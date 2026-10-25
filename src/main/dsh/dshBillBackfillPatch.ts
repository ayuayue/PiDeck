/**
 * dsh-bill 历史回填补丁（host 启动 CPU 修复）。
 *
 * 背景（用户实测：一开 host CPU 占满，`dsh web` 无此问题）：
 * dsh-bill@0.14 启动时执行 backfillFromLog()——对每条没有记账记录的会话调
 * sessionQuery.readSession(id) 完整回放整个会话日志。会话文件大/多时 CPU 飙升
 * 数分钟；且回填超时（BACKFILL_TIMEOUT_MS=20s）的会话不会落记录，下次启动再
 * 整遍重放。官方 `dsh web` 不挂 dsh-bill 行（该行是 PiDeck hostEntry 自挂的费用
 * 采集行），所以官方部署没有全量会话 corpus 可回放，无此问题。
 *
 * 方案（用户选定）：只砍「启动时全量历史回填」，保留实时记账（llm/stream 钩子，
 * 费用页照常记新调用）与 records.jsonl 存量历史读取。对 host 实际加载的
 * dsh-bill/lib/index.js 做幂等文本补丁：把 lifecycle 链里的
 * `.then(() => backfillFromLog())` 替换为读取 DSH_BILL_BACKFILL 环境变量的守卫。
 * 想把历史会话导入费用页时，设 DSH_BILL_BACKFILL=1 启动一次 PiDeck 即可恢复
 * 官方回填行为（fork env 继承主进程环境，变量能传到 host）。
 *
 * 为什么文件补丁而不是配置/移除 bill 行：dsh-bill Config 只有 maxRecords/
 * priceOverrides，没有 backfill 开关；移除 bill 行会连实时记账一起丢。文件补丁
 * 对 dev、打包内置、userData 安装的 runtime 三种形态统一生效（require 锚点一致，
 * 都解析到 host 实际加载的那份副本），已安装的旧 runtime 无需重新打包即被修复。
 * runtime 完整性校验（DshRuntimeManager.verifyStagedRuntime）只查 manifest 与
 * 关键包存在性，不含文件内容哈希——补丁不会触发重装循环。
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** 补丁后代码的标志串：存在即视为已打补丁（幂等判据，与具体注释文案无关）。 */
const PATCH_MARKER = "process.env.DSH_BILL_BACKFILL";

/** dsh-bill@0.14 lifecycle 链中的回填调用（全文唯一，见 lib/index.js 生命周期段）。 */
const TARGET_SNIPPET = ".then(() => backfillFromLog())";

/** 守卫替换：默认跳过回填，env 显式为 "1" 时保留官方行为。 */
const REPLACEMENT_SNIPPET = '.then(() => { /* pideck: startup backfill off (set DSH_BILL_BACKFILL=1 to restore) */ if (process.env.DSH_BILL_BACKFILL === "1") return backfillFromLog(); })';

/** 从入口文件向上找 dsh-bill 包根（含 package.json 且 name 匹配）；找不到返回 null。 */
function findDshBillPackageDir(entryPath: string): string | null {
	let current = dirname(entryPath);
	for (let depth = 0; depth < 6; depth += 1) {
		const pkgPath = join(current, "package.json");
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: unknown };
				if (pkg.name === "dsh-bill") return current;
			} catch {
				// package.json 读不了就继续向上找，不中断（异常目录按不存在处理）。
			}
		}
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
	return null;
}

/**
 * 对 host 实际加载的 dsh-bill 应用「启动回填默认关」补丁（幂等、失败不阻断 boot）。
 *
 * @param dshBillEntryPath require.resolve("dsh-bill") 的结果（包 main 入口绝对路径）。
 * @param log 进度/告警回调（scope 固定 dsh-host，由调用方提供）。
 * @returns 是否实际写入了补丁（已打过 / 找不到目标 / 写失败都返回 false）。
 */
export function applyDshBillBackfillPatch(dshBillEntryPath: string, log: (message: string, detail?: unknown) => void): boolean {
	if (!dshBillEntryPath || !existsSync(dshBillEntryPath)) {
		log("dsh-bill 回填补丁跳过：入口文件不存在", { dshBillEntryPath });
		return false;
	}

	// 候选文件：包根 lib/index.js（标准布局）优先，入口文件本身兜底（main 指向
	// 非标准路径的版本）。取第一个存在且包含目标/标志串的文件。
	const packageDir = findDshBillPackageDir(dshBillEntryPath);
	const candidates = [...(packageDir ? [join(packageDir, "lib", "index.js")] : []), dshBillEntryPath];
	let targetPath: string | null = null;
	let content: string | null = null;
	for (const candidate of candidates) {
		if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
		try {
			const text = readFileSync(candidate, "utf8");
			if (text.includes(PATCH_MARKER) || text.includes(TARGET_SNIPPET)) {
				targetPath = candidate;
				content = text;
				break;
			}
		} catch (error) {
			log("dsh-bill 回填补丁读取失败（跳过该候选）", { candidate, error: String(error) });
		}
	}

	if (!targetPath || content === null) {
		// 找不到目标：多半是 dsh-bill 未来版本改了生命周期代码。fail-open——不打补丁
		// 就是官方行为（可能有 CPU 问题），但绝不能让补丁失败阻断 host 启动。
		log("dsh-bill 回填补丁未找到目标代码（版本不匹配？），跳过", { dshBillEntryPath });
		return false;
	}

	// 幂等：已打过补丁直接返回，避免每次 boot 重写文件。
	if (content.includes(PATCH_MARKER)) return false;

	// 唯一性校验：目标串出现次数异常（压缩/重构后的版本）时不盲改，宁可不生效。
	const occurrences = content.split(TARGET_SNIPPET).length - 1;
	if (occurrences !== 1) {
		log("dsh-bill 回填补丁目标串出现次数异常，放弃修改", { targetPath, occurrences });
		return false;
	}

	const patched = content.replace(TARGET_SNIPPET, REPLACEMENT_SNIPPET);
	// 原子落位：同目录临时文件 + rename（Node rename 对已存在目标文件是覆盖语义，
	// 同卷 rename 原子——不会出现半截文件让 host 模块加载崩溃）。Windows 上目标被
	// 占用（杀软扫描）会 EPERM，重试几次后放弃，保持未补丁状态继续启动。
	const tmpPath = `${targetPath}.pideck-tmp`;
	try {
		writeFileSync(tmpPath, patched, "utf8");
		for (let attempt = 0; attempt < 3; attempt += 1) {
			try {
				renameSync(tmpPath, targetPath);
				log("dsh-bill 回填补丁已应用（启动时不再全量回放历史会话）", { targetPath });
				return true;
			} catch (error) {
				if (attempt === 2) throw error;
			}
		}
		return false;
	} catch (error) {
		log("dsh-bill 回填补丁写入失败（保持官方行为继续启动）", { targetPath, error: String(error) });
		try {
			if (existsSync(tmpPath)) renameSync(tmpPath, `${tmpPath}.bak`);
		} catch {
			// 清理失败就留着 tmp，不影响功能（下次 boot 会重试）。
		}
		return false;
	}
}
