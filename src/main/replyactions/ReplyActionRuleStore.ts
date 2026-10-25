/**
 * 回复快捷操作规则文件读写（`userData/reply-actions.json`）。
 *
 * 与 QuickMessageStore 同一套模式（清单类数据独立成文件，用户可直接编辑）：
 * 读取优先级：文件可识别 → 直接用；缺失/不可识别 → 出厂规则资源 `reply-actions.default.json`；
 * 资源也读不到 → 空清单 + 告警（不在代码里写兜底规则，出厂内容只来自资源文件）。
 * 损坏处理：先备份 `<file>.bak` 再重建。
 *
 * 与快捷消息的差异：没有 legacy settings 迁移源——回复快捷操作是本次新增的功能，
 * 不存在旧版本数据可迁移；规则是结构化对象而非纯文本，清洗走 shared/replyActions.ts。
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { REPLY_ACTIONS_FILE_VERSION, sanitizeReplyActionRuleList, sanitizeReplyActionsFile, type ReplyActionsFilePayload } from "../../shared/replyActions";
import type { ReplyActionsSaveResult, ReplyActionsSnapshot } from "../../shared/types/replyActions";
import { renameWithRetry } from "../utils/fsRetry";

type ReadOutcome = { kind: "ok"; text: string } | { kind: "missing" } | { kind: "error"; error: Error };

export class ReplyActionRuleStore {
	constructor(
		private readonly deps: {
			/** 用户规则文件绝对路径（主进程用 userData/reply-actions.json，测试注入临时文件） */
			getConfigPath: () => string;
			/** 出厂规则资源路径（打包态 resourcesPath，开发态仓库 resources 目录） */
			getDefaultConfigPath: () => string;
			/** 日志出口：装配处直接接 appLogger.info（与 QuickMessageStore 一致） */
			log: (scope: string, message: string, detail?: unknown) => void;
		},
	) {}

	/** 规则文件路径（渲染层不拼路径，只发意图）。 */
	resolveFilePath(): string {
		return this.deps.getConfigPath();
	}

	/** 确保规则文件存在（供「打开配置文件」用）。 */
	async ensureFile(): Promise<void> {
		await this.getSnapshot();
	}

	/**
	 * 读取当前生效快照。每次都读盘（不缓存）：规则文件与快捷消息一样支持用户直接编辑，
	 * 缓存会让「改完文件回来就生效」失效。
	 */
	async getSnapshot(): Promise<ReplyActionsSnapshot> {
		const filePath = this.deps.getConfigPath();
		const defaults = await this.readDefaults();
		const outcome = await this.readText(filePath);

		let items: ReplyActionsSnapshot["items"] | null = null;
		// 本次快照是否「不是直接从配置文件读到的」：文件新建、重建或读取失败。
		let seeded = false;

		if (outcome.kind === "ok") {
			const parsed = this.parse(outcome.text, filePath);
			const file = parsed === null ? null : sanitizeReplyActionsFile(parsed);
			if (file) {
				items = file.items;
			} else {
				// 结构不对（缺 items / triggers 写错等）：先备份原文件，避免静默吞掉用户内容。
				seeded = true;
				await this.backupCorrupt(filePath);
			}
		} else if (outcome.kind === "missing") {
			seeded = true;
		} else {
			// 读失败（权限/被占用）：不覆盖文件，只用种子值撑住本次界面。
			seeded = true;
			this.deps.log("reply-actions", "read config failed, using seed", { error: outcome.error.message });
		}

		if (items === null) {
			items = defaults.items;
			if (outcome.kind !== "error") await this.writeSeed(filePath, items);
		}

		return { items, defaults: defaults.items, filePath, seeded, defaultsAvailable: defaults.available };
	}

	/** 保存用户规则：入参来自渲染层（不可信），先清洗再原子写。 */
	async save(input: unknown): Promise<ReplyActionsSaveResult> {
		const items = sanitizeReplyActionRuleList(input);
		const filePath = this.deps.getConfigPath();
		try {
			await this.writeFile(filePath, items);
			this.deps.log("reply-actions", "config saved", { count: items.length });
			return { ok: true, snapshot: await this.getSnapshot() };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.deps.log("reply-actions", "config save failed", { error: message, count: items.length });
			return { ok: false, error: message };
		}
	}

	/** 出厂规则：读随包资源文件；缺失/损坏时告警并返回空。 */
	private async readDefaults(): Promise<{ items: ReplyActionsSnapshot["items"]; available: boolean }> {
		const outcome = await this.readText(this.deps.getDefaultConfigPath());
		if (outcome.kind !== "ok") {
			this.deps.log("reply-actions", "default resource unreadable", { kind: outcome.kind });
			return { items: [], available: false };
		}
		const parsed = this.parse(outcome.text, this.deps.getDefaultConfigPath());
		const file = parsed === null ? null : sanitizeReplyActionsFile(parsed);
		if (!file) {
			this.deps.log("reply-actions", "default resource invalid shape", {});
			return { items: [], available: false };
		}
		return { items: file.items, available: true };
	}

	/** 首次生成：把出厂规则写进配置文件，让用户看得见、能直接编辑（写失败只告警）。 */
	private async writeSeed(filePath: string, items: ReplyActionsSnapshot["items"]): Promise<void> {
		try {
			await this.writeFile(filePath, items);
			this.deps.log("reply-actions", "config file created", { count: items.length });
		} catch (error) {
			this.deps.log("reply-actions", "seed write failed", { error: error instanceof Error ? error.message : String(error) });
		}
	}

	/** 原子写：写 tmp → renameWithRetry 替换。 */
	private async writeFile(filePath: string, items: ReplyActionsSnapshot["items"]): Promise<void> {
		const payload: ReplyActionsFilePayload = { version: REPLY_ACTIONS_FILE_VERSION, items };
		await mkdir(dirname(filePath), { recursive: true });
		const tmpPath = `${filePath}.tmp`;
		await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
		await renameWithRetry(tmpPath, filePath);
	}

	/** 坏文件备份为 `<file>.bak`（失败仅告警：重建仍要继续）。 */
	private async backupCorrupt(filePath: string): Promise<void> {
		try {
			await copyFile(filePath, `${filePath}.bak`);
			this.deps.log("reply-actions", "corrupt config backed up", {});
		} catch (error) {
			this.deps.log("reply-actions", "corrupt backup failed", { error: error instanceof Error ? error.message : String(error) });
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
			this.deps.log("reply-actions", "config parse failed", {
				file: filePath,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}
}
