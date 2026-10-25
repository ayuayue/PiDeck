/** Headless DSH profile：由官方 profile/config-editor 持久化，不改 runtime 安装目录。 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { createRequire } from "node:module";
import { load } from "js-yaml";
import type { PatchOptions } from "@deepseek-ai/cordis-plugin-include";
import type * as AppBoot from "@deepseek-ai/dsh-app-boot";
import { pideckDshHome } from "./pideckDshHome";
import { describePrunedProfileLinks, pruneStaleRuntimeLinks } from "./dshProfileLinkPrune";
import { rewriteLoaderExprPackageResolves } from "./dshProfileExprRewrite";
import { agentTeamPresetPatchPath, shippedPresetPatchPaths } from "./dshPresetComposition";
import { dshProfileDir, dumpProfilePatches, initializeDshProfileSettings, isRecord } from "./dshProfileSettings";

const BUNDLE_NAME = "@pideck/dsh-host-composition";

/** 旧 ID 由目录名定义；metadata 仅展示，缺失/损坏都不应让已有会话丢失身份。 */
function legacyPresetRows(home: string): PatchOptions[] {
	const root = join(home, ".agent-presets");
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((item) => item.isDirectory())
		.map((item) => {
			const directory = join(root, item.name);
			let metadata: Record<string, unknown> = {};
			try {
				const value: unknown = load(readFileSync(join(directory, "preset.yml"), "utf8"));
				if (isRecord(value)) metadata = value;
			} catch {
				/* 与旧 registry 一致：展示元数据可缺省，不影响组合加载。 */
			}
			const id = item.name;
			if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`Invalid legacy DSH preset identity: ${id}`);
			return {
				insert: [
					{
						id: `pideck-legacy-preset-${id}`,
						name: "@deepseek-ai/dsh-agent-preset",
						config: {
							id,
							...(typeof metadata.name === "string" ? { name: metadata.name } : {}),
							...(typeof metadata.description === "string" ? { description: metadata.description } : {}),
							plugins: [{ id: `legacy-${id}`, name: "cordis:pideck-legacy-preset", config: { path: join(directory, "agent.cordis.yml") } }],
						},
					},
				],
			};
		});
}

/** agent-team 实验预设（默认关）：整份官方 profile patch 追加。包缺失时 fail-safe
 *  跳过（日志留痕）而不是拒绝启动——设置开关指向的依赖不存在只应损失实验功能。 */
function agentTeamPresetRows(runtimeRequire: ReturnType<typeof createRequire>, appBoot: typeof AppBoot): PatchOptions[] {
	const patchPath = agentTeamPresetPatchPath((specifier) => runtimeRequire.resolve(specifier));
	if (!patchPath) {
		console.error("[dsh-host-profile] agent-team preset enabled but profile package missing; skipping");
		return [];
	}
	return appBoot.loadOverlayPatches("pideck-dsh", patchPath);
}

/** 生成部署 bundle；用户 patch 与共享 HOME 覆盖层不写进生成物。 */
export async function prepareDshHostProfile(home: string, runtimeRequire: ReturnType<typeof createRequire>, appBoot: typeof AppBoot, deployment: PatchOptions[], agentTeamPreset = false) {
	const webManifestPath = runtimeRequire.resolve("@deepseek-ai/dsh-web-app/package.json");
	const manifest: unknown = JSON.parse(readFileSync(webManifestPath, "utf8"));
	const files = isRecord(manifest) && isRecord(manifest.dsh) && isRecord(manifest.dsh.bundle) ? manifest.dsh.bundle.patch : undefined;
	if (!Array.isArray(files) || !files.every((file: unknown): file is string => typeof file === "string")) throw new Error("Invalid DSH preset bundle manifest");
	const presets = shippedPresetPatchPaths(dirname(webManifestPath), files).flatMap((path) => appBoot.loadOverlayPatches("pideck-dsh", path));
	// agent-team 预设排在最后：官方 patch 自述「Apply after dsh-base」——cordis 后行覆盖先行，
	// 其 tool-subagent* 禁用行必须晚于 preset/legacy 行才能压住 standard 等预设对这些工具的再启用。
	const composed = [...deployment, ...presets, ...legacyPresetRows(home), ...(agentTeamPreset ? agentTeamPresetRows(runtimeRequire, appBoot) : [])];
	// 官方 cordis 预设的 createRequire(baseUrl).resolve(...) 表达式在 PiDeck 的
	// profile 布局下解析不到外置 runtime 包，dump 前改写为预解析路径（详见 dshProfileExprRewrite）。
	const composition = rewriteLoaderExprPackageResolves(composed, (specifier) => {
		try {
			return runtimeRequire.resolve(specifier);
		} catch {
			return undefined;
		}
	});
	const dir = dshProfileDir(home);
	// runtime 升级后 profile 可能残留指向上一个 runtime 的包链接（详见 dshProfileLinkPrune）：
	// 不清掉会让 app-boot preflight 读到旧版 manifest 并禁用 preset 行。
	const installAnchor = runtimeRequire.resolve("@deepseek-ai/dsh/package.json");
	const prunedLinks = pruneStaleRuntimeLinks(dir, join(dirname(installAnchor), "..", ".."));
	if (prunedLinks.length) console.error(`[dsh-host-profile] pruned stale runtime links: ${describePrunedProfileLinks(prunedLinks)}`);
	const bundleDir = join(dir, "node_modules", "@pideck", "dsh-host-composition");
	mkdirSync(bundleDir, { recursive: true });
	writeFileSync(join(bundleDir, "package.json"), JSON.stringify({ name: BUNDLE_NAME, version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } }));
	writeFileSync(join(bundleDir, "cordis.patch.yml"), dumpProfilePatches(composition));
	// 先导入旧配置，再 initProfile；后者只创建缺失文件，不覆盖用户保存值。
	initializeDshProfileSettings(
		home,
		appBoot.composeEntries([composition]).map((row) => ({ id: row.id, config: row.config })),
	);
	appBoot.initProfile(dir, [BUNDLE_NAME]);
	const profile = appBoot.loadProfileDirectory("pideck-dsh", dir, installAnchor);
	if (profile.skippedBundles.length) throw new Error(`DSH profile bundle unavailable: ${profile.skippedBundles.map((entry) => `${entry.packageName}: ${entry.reason}`).join("; ")}`);
	const profileContext: AppBoot.ProfileContext = {
		name: "pideck",
		dir,
		patchPath: profile.patchPath,
		installAnchor,
		cwd: dir,
		// 隔离上游 importLegacyDocument，避免重命名 CLI 仍在使用的 HOME/settings.yaml。
		home: pideckDshHome(home),
		startedBundles: [BUNDLE_NAME],
		// 上游每次重载读取 overlays；不能把共享 HOME 补丁冻结成启动快照。
		// home 仍指向私有目录以隔离旧 settings 导入，隐私禁用层永远排在共享补丁之后。
		get overlays(): PatchOptions[] {
			return [...(appBoot.loadOptionalPatches("pideck-dsh", join(home, appBoot.PROFILE_PATCH_FILENAME)) ?? []), { id: "hmr", disabled: true }, { id: "session-telemetry-otel", disabled: true }];
		},
		telemetryDisabledEnv: "1",
	};
	const resolution = await appBoot.createRuntimeResolution({ installAnchor, profile, home });
	const configPath = join(dir, "cordis.yml");
	if (!existsSync(configPath)) writeFileSync(configPath, "[]\n");
	return { profileContext, resolution, configPath, patches: appBoot.readProfilePatches("pideck-dsh", profileContext, profile) };
}
