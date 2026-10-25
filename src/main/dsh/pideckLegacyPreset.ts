/** 旧预设的只读 Include；保持资源相对基准，绝不让 Loader teardown 重写用户文件。 */
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import type { PatchOptions } from "@deepseek-ai/cordis-plugin-include";
import { load } from "js-yaml";
import { normalizeLegacyPresetRows } from "./dshLegacyPreset";

interface LegacyConfig {
	path: string;
	patches?: PatchOptions[];
}

/** 依赖取自实际 runtime，不让 lite 安装包或临时构建目录额外解析一份 Cordis。 */
export function createLegacyPresetPlugin(cordis: typeof import("@deepseek-ai/cordis"), loader: typeof import("@deepseek-ai/cordis-plugin-loader"), include: typeof import("@deepseek-ai/cordis-plugin-include"), runtimeBase: string) {
	const { Service } = cordis;
	const { EntryGroup, EntryTree } = loader;
	const { applyEntryPatches, entryListSchema } = include;
	return class PideckLegacyPreset extends EntryTree {
		static inject = ["loader"];
		static [EntryGroup.key] = true;
		private readonly filename: URL;
		constructor(
			ctx: Context,
			private readonly config: LegacyConfig,
		) {
			super(ctx);
			this.filename = isAbsolute(config.path) ? pathToFileURL(config.path) : new URL(config.path, ctx.baseUrl);
			this.ctx.baseUrl = new URL(".", this.filename).href;
		}

		override import(name: string, getOuterStack?: () => string[]): unknown {
			if (isAbsolute(name)) return super.import(pathToFileURL(name).href, getOuterStack);
			if (name.startsWith(".") || name.includes(":")) return super.import(name, getOuterStack);
			return this.ctx.loader.internal?.import(name, runtimeBase, {}) ?? super.import(name, getOuterStack);
		}

		async *[Service.init]() {
			const parsed: unknown = load(await readFile(fileURLToPath(this.filename), "utf8"), { schema: entryListSchema });
			const includeModule = "cordis:pideck-legacy-preset";
			const rows = normalizeLegacyPresetRows(parsed, includeModule);
			yield () => this.root.stop();
			await this.root.update(applyEntryPatches(rows, this.config.patches, (message, ...args: unknown[]) => this.ctx.logger.warn(message, ...args)));
		}

		/** Loader 更新/卸载只能改内存中的树，原预设是输入而非 profile 持久化目标。 */
		write(): void {}
	};
}
