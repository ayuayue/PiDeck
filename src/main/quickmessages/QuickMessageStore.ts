/**
 * 快捷消息配置文件读写（`userData/quick-messages.json`）。
 *
 * 为什么独立成文件、而不是留在 settings.json：快捷消息是「清单」类数据，用户可能直接编辑它
 * （加几句自己的口头禅），独立文件改起来只有几行；settings.json 是全量重写的聚合配置，
 * 混进去等于「改一份小清单要先看懂一大坨设置」。
 *
 * 读取优先级（第一次读时决定种子，之后完全以文件为准）：
 * 1. 配置文件存在且内容可识别 → 直接用（`items: []` 是合法状态，代表用户清空，不能与「损坏」混同）；
 * 2. 文件缺失 / 内容不可识别 → 用 settings.json 里的历史字段作种子（迁移旧版本数据，不丢用户已改条目）；
 * 3. 历史字段也是空 → 用随包资源 `quick-messages.default.json`；
 * 4. 连资源文件都读不到（安装包不完整）→ 空清单 + 告警；**刻意不在代码里写兜底清单**，
 *    否则「出厂条目来自配置文件」这条规则又会被硬编码破一个洞，测试另有用例守着资源文件存在与 extraResources 配置。
 *
 * 损坏处理：JSON 解析失败时先把坏文件备份成 `<file>.bak` 再重建，用户的手工编辑仍能找回。
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeQuickMessages, QUICK_MESSAGES_FILE_VERSION, sanitizeQuickMessagesFile, type QuickMessagesFile } from "../../shared/quickMessages";
import type { QuickMessagesSaveResult, QuickMessagesSnapshot } from "../../shared/types/quickMessages";
import { renameWithRetry } from "../utils/fsRetry";

type ReadOutcome = { kind: "ok"; text: string } | { kind: "missing" } | { kind: "error"; error: Error };

export class QuickMessageStore {
	constructor(
		private readonly deps: {
			/** 用户配置文件绝对路径（主进程用 userData/quick-messages.json，测试注入临时文件） */
			getConfigPath: () => string;
			/** 出厂清单资源路径（打包态 resourcesPath，开发态仓库 resources 目录） */
			getDefaultConfigPath: () => string;
			/** 历史数据源：settings.json 里已废弃的 quickMessages 字段，仅首次种子化时读一次 */
			getLegacyItems: () => string[];
			/** 日志出口：第一个参数是 scope，装配处直接接 appLogger.info（与主进程日志模块的 scope 语义一致） */
			log: (scope: string, message: string, detail?: unknown) => void;
		},
	) {}

	/** 配置文件路径（渲染层不拼路径，只发意图，这里解析后交给 IPC 打开）。 */
	resolveFilePath(): string {
		return this.deps.getConfigPath();
	}

	/** 确保配置文件存在（供「打开配置文件」用：文件还没生成时先落一份，否则 shell 打不开不存在的路径）。 */
	async ensureFile(): Promise<void> {
		await this.getSnapshot();
	}

	/**
	 * 读取当前生效快照。每次都读盘（不缓存）：这个功能的价值就在于用户能直接编辑文件，
	 * 一旦缓存，「从文件重新读取」按钮和手工编辑都会失效。
	 */
	async getSnapshot(): Promise<QuickMessagesSnapshot> {
		const filePath = this.deps.getConfigPath();
		const defaults = await this.readDefaults();
		const outcome = await this.readText(filePath);

		let items: string[] | null = null;
		// 本次快照是否「不是直接从配置文件读到的」：文件新建、重建或读取失败。
		let seeded = false;

		if (outcome.kind === "ok") {
			const parsed = this.parse(outcome.text, filePath);
			const file = parsed === null ? null : sanitizeQuickMessagesFile(parsed);
			if (file) {
				items = file.items;
			} else {
				// 内容可解析但结构不对（缺 items / 是数字 / 手写坏了）：先备份原文件，避免静默吞掉用户内容。
				seeded = true;
				await this.backupCorrupt(filePath);
			}
		} else if (outcome.kind === "missing") {
			seeded = true;
		} else {
			// 读失败（权限/被占用）：不覆盖文件，只用种子值撑住本次界面，等用户显式保存再落盘。
			seeded = true;
			this.deps.log("quick-messages", "read config failed, using seed", { error: outcome.error.message });
		}

		if (items === null) {
			items = this.resolveSeed(defaults.items);
			if (outcome.kind !== "error") await this.writeSeed(filePath, items);
		}

		return { items, defaults: defaults.items, filePath, seeded, defaultsAvailable: defaults.available };
	}

	/**
	 * 保存用户配置：入参来自渲染层（不可信），先清洗再原子写（写 tmp → rename，Windows 杀软瞬态锁重试）。
	 * 刻意不写 `.bak`：`.bak` 保留给「损坏文件备份」，保存时覆盖会毁掉那份可找回的手工编辑。
	 */
	async save(input: unknown): Promise<QuickMessagesSaveResult> {
		const items = normalizeQuickMessages(input);
		const filePath = this.deps.getConfigPath();
		try {
			await this.writeFile(filePath, items);
			this.deps.log("quick-messages", "config saved", { count: items.length });
			// 回读一次，保证返回给渲染层的快照与磁盘一致（seeded=false、filePath 等都真实）。
			return { ok: true, snapshot: await this.getSnapshot() };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.deps.log("quick-messages", "config save failed", { error: message, count: items.length });
			return { ok: false, error: message };
		}
	}

	/** 出厂清单：读随包资源文件；缺失/损坏时告警并返回空（不用代码兜底，避免又回到硬编码）。 */
	private async readDefaults(): Promise<{ items: string[]; available: boolean }> {
		const outcome = await this.readText(this.deps.getDefaultConfigPath());
		if (outcome.kind !== "ok") {
			this.deps.log("quick-messages", "default resource unreadable", { kind: outcome.kind });
			return { items: [], available: false };
		}
		const parsed = this.parse(outcome.text, this.deps.getDefaultConfigPath());
		const file = parsed === null ? null : sanitizeQuickMessagesFile(parsed);
		if (!file) {
			this.deps.log("quick-messages", "default resource invalid shape", {});
			return { items: [], available: false };
		}
		return { items: file.items, available: true };
	}

	/** 种子优先级：历史 settings.json 字段 > 出厂资源清单。 */
	private resolveSeed(defaultItems: string[]): string[] {
		const legacy = normalizeQuickMessages(this.deps.getLegacyItems());
		if (legacy.length > 0) {
			this.deps.log("quick-messages", "seeded from legacy settings field", { count: legacy.length });
			return legacy;
		}
		return defaultItems;
	}

	/** 首次生成：把种子写进配置文件，让用户看得见、能直接编辑（写失败只告警，本次界面照常可用）。 */
	private async writeSeed(filePath: string, items: string[]): Promise<void> {
		try {
			await this.writeFile(filePath, items);
			this.deps.log("quick-messages", "config file created", { count: items.length });
		} catch (error) {
			this.deps.log("quick-messages", "seed write failed", { error: error instanceof Error ? error.message : String(error) });
		}
	}

	/** 原子写：写 tmp → renameWithRetry 替换，避免半截文件被下次读取当成损坏。 */
	private async writeFile(filePath: string, items: string[]): Promise<void> {
		const payload: QuickMessagesFile = { version: QUICK_MESSAGES_FILE_VERSION, items };
		await mkdir(dirname(filePath), { recursive: true });
		const tmpPath = `${filePath}.tmp`;
		await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
		await renameWithRetry(tmpPath, filePath);
	}

	/** 坏文件备份为 `<file>.bak`（失败仅告警：备份不是主流程，重建仍要继续）。 */
	private async backupCorrupt(filePath: string): Promise<void> {
		try {
			await copyFile(filePath, `${filePath}.bak`);
			this.deps.log("quick-messages", "corrupt config backed up", {});
		} catch (error) {
			this.deps.log("quick-messages", "corrupt backup failed", { error: error instanceof Error ? error.message : String(error) });
		}
	}

	private async readText(filePath: string): Promise<ReadOutcome> {
		try {
			return { kind: "ok", text: await readFile(filePath, "utf8") };
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			const code = (error as { code?: unknown } | null)?.code;
			return code === "ENOENT" ? { kind: "missing" } : { kind: "error", error: err };
		}
	}

	/** JSON 解析；失败返回 null（调用方按「不可识别」处理并备份）。 */
	private parse(text: string, filePath: string): unknown | null {
		try {
			return JSON.parse(text) as unknown;
		} catch (error) {
			this.deps.log("quick-messages", "config parse failed", {
				file: filePath,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}
}
