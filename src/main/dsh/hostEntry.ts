/**
 * DSH host utilityProcess 入口（v2 形态）。
 *
 * 运行在 Electron utilityProcess 里：`boot()` 引导完整 DSH host（组合与主进程内嵌
 * 形态一致），随后通过 `process.parentPort` 响应主进程的 fetch 桥请求——
 * 每个 fetch-request 交给 `toFetchHandler(ctx.apiProxy).fetch()`，响应体
 * （unary JSON 或 SSE 流）按 dshHostBridge 协议逐帧回传。
 *
 * 启动参数（argv）：
 *   --dsh-home <dir>           DSH_HOME（会话/存储/凭证目录）
 *   --dsh-config <dir>         cordis.yml 与本地插件目录
 *   --dsh-node-modules <dir>   bareModuleBaseUrl 锚点（node_modules 目录 URL）
 *   --dsh-agent-team <0|1>     启用 agent-team 实验预设（设置项 dshAgentTeamPreset；
 *                              仅 fork 时读取，变更后需重启 DSH host 生效）
 *
 * 注意：本文件被 electron-vite 主进程构建打包（rollup 多入口），产物为 CJS；
 * @deepseek-ai/* 全部 externalize，运行时动态 import() 加载（与 DshHost 一致）。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { installHiddenConsolePatch, installHostHiddenConsole, installRunnerNodeModeEnv, installRunnerPreloadEnv, getHiddenConsoleMode, configureDshRunnerNodeSidecar, getDshRunnerNodeSidecar } from "./hideChildConsoles";
import { DSH_RUNNER_NODE_ENV } from "./dshRunnerNodeSidecar";
import { agentPresetsRow, agentTeamPresetPatchPath, dshSubagentModelSelectionSettingsRow, dshWebAgentPlaneDisableRows } from "./dshPresetComposition";
import { prepareDshHostProfile } from "./dshHostProfile";
import { createLegacyPresetPlugin } from "./pideckLegacyPreset";
import { createDshTpsPlugin, type DshTpsSchemaFactory } from "./pideckTpsProjection";
import { PIDECK_PLUGIN_BRIDGE_PATH, handlePluginBridgeFetch } from "./pideckPluginBridge";
import { PIDECK_COMMANDS_BRIDGE_PATH, handleCommandsBridgeFetch } from "./pideckCommandsBridge";
import { PIDECK_SESSION_BRIDGE_PATH, handleSessionBridgeFetch } from "./pideckSessionBridge";
import { loadDshOpenCodeHeaders } from "./dshOpenCodeHeaders";

// utilityProcess 的 parentPort：electron 包类型里有（Electron.ParentPort）。
import type { ParentPort } from "electron";
import type {} from "@deepseek-ai/dsh-client-connection";
// 桥协议消息校验/收窄（fetch-* 与 stream-* 统一入口）。
import { parseDshFetchMessage } from "./dshHostBridge";

/** 解析 argv：支持 `--key value` 与 `--key=value` 两种形式。 */
function parseArgv(argv: string[]): Record<string, string> {
	const result: Record<string, string> = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith("--")) continue;
		const body = arg.slice(2);
		const eq = body.indexOf("=");
		if (eq >= 0) {
			// --key=value
			result[body.slice(0, eq)] = body.slice(eq + 1);
			continue;
		}
		const key = body;
		const value = argv[index + 1];
		if (value !== undefined && !value.startsWith("--")) {
			result[key] = value;
			index += 1;
		} else {
			result[key] = "true";
		}
	}
	return result;
}

async function main(): Promise<void> {
	const port = process.parentPort as ParentPort | undefined;
	if (!port) {
		console.error("[dsh-host-entry] no parentPort; this entry must run inside Electron utilityProcess");
		process.exit(1);
	}
	const args = parseArgv(process.argv.slice(2));
	const dshHome = args["dsh-home"];
	const configDir = args["dsh-config"];
	const nodeModulesUrl = args["dsh-node-modules"];
	if (!dshHome || !configDir || !nodeModulesUrl) {
		console.error("[dsh-host-entry] missing required args", { dshHome, configDir, nodeModulesUrl });
		process.exit(1);
	}
	mkdirSync(dshHome, { recursive: true });
	mkdirSync(configDir, { recursive: true });
	process.env.DSH_HOME = dshHome;
	process.env.DSH_TELEMETRY_DISABLED = "1";

	// Windows 黑窗口治理（必须在下面任何 @deepseek-ai/* 动态 import 之前安装——
	// dsh-subprocess-local 等模块加载时会捕获 child_process.spawn 的引用，
	// 补丁先于加载才覆盖得到）：
	// 0) koffi 解析（2026-09-14 黑窗口根因）：koffi 是 @deepseek-ai/dsh-subprocess-local
	//    的传递依赖，此前不在应用 dependencies 里——开发态从仓库 node_modules 向上
	//    解析没问题，打包版 app.asar 里根本没有它 → installHostHiddenConsole 与
	//    runnerConsolePreload 里的 koffi 加载全部静默失败（日志实证 mode=failed）→
	//    host 与 runner 都拿不到隐藏控制台 → runner（electron.exe GUI，不继承控制台）
	//    用 CreateProcessW(1028) 拉起 rg/pwsh 时 Windows 新建【可见】控制台 = 黑窗口。
	//    修复分三层：a) koffi 进应用 dependencies（随包分发，见 package.json）；
	//    b) 这里优先从 runtime node_modules 解析（runtime 必带 koffi，最可靠），
	//       并把解析结果写进 PIDECK_KOFFI_MODULE 供 runner preload 兜底；
	//    c) preload 侧按 PIDECK_KOFFI_MODULE → __dirname 解析链兜底（见
	//       runnerConsolePreload.ts）。
	// 1) installHostHiddenConsole：不再 AllocConsole（conhost 异步建窗会闪黑窗）。
	//    host 自身不需要控制台；mode=create-no-window。
	// 2) installHiddenConsolePatch：win32 子进程一律 windowsHide（CREATE_NO_WINDOW
	//    无窗口可继承控制台）。sidecar 把 runner 改成 node.exe；无 sidecar 时
	//    注入 NODE_OPTIONS preload；无 sidecar 时 runner 在私有窗口站上 AllocConsole。
	// 3) installRunnerNodeModeEnv：把 ELECTRON_RUN_AS_NODE=1 写进 host 自己的
	//    process.env。沙箱链路是 host → subprocess-local runner → windows-acl runner
	//    的两级 electron.exe，第二级（ACL runner）的 env 由 dsh-subprocess-local 从
	//    **host 进程环境**经 IPC 下发，spawn 补丁够不着；不置该变量它就以 GUI 模式跑
	//    → 事件循环永不退出 → 每条沙箱命令挂满 120s 工具超时（2026-09-12 进程树实证，
	//    详见 hideChildConsoles.installRunnerNodeModeEnv）。
	// 4) installRunnerPreloadEnv：把 runner preload 的 NODE_OPTIONS 同样写进 host
	//    process.env（与 3) 同一缺口）：第二级 ACL runner 拿不到 preload 就没有
	//    可继承的控制台，它用 CreateProcessAsUserW（无 CREATE_NO_WINDOW）拉起 pwsh
	//    时 Windows 会新建【可见】控制台——命令秒回但每条弹黑窗口（2026-09-12 实测）。
	try {
		const runtimeRequire = createRequire(join(fileURLToPath(nodeModulesUrl), "package.json"));
		// npm 0.2 依赖树可能把 koffi 留在 subprocess-local 下；沿实际 consumer 解析，
		// 不依赖顶层提升，也不让 runner 回退到不属于该 runtime 的 native 版本。
		const consumerRequire = createRequire(runtimeRequire.resolve("@deepseek-ai/dsh-subprocess-local/package.json"));
		const koffiEntry = consumerRequire.resolve("koffi");
		process.env.PIDECK_KOFFI_MODULE = koffiEntry;
	} catch {
		// runtime 里没有 koffi（异常形态）：退回 app 内解析——koffi 已进应用依赖，
		// 打包版从 asar 内 createRequire(__dirname) 可解析（native 落 asar.unpacked）。
	}
	configureDshRunnerNodeSidecar(process.env[DSH_RUNNER_NODE_ENV]);
	installHostHiddenConsole();
	installHiddenConsolePatch();
	installRunnerNodeModeEnv();
	installRunnerPreloadEnv();
	// 诊断（黑窗口排查入口）：host 的 stdout 不被 DshHostProcess 转发（只接 stderr），
	// 因此这条也用 console.error 落主进程日志。mode=create-no-window 是现行策略；
	// 若仍弹窗，下一步看 runner spawn policy 与 sidecar 是否解析到。
	console.error(
		`[dsh-host-entry] windows console policy: mode=${getHiddenConsoleMode()} ` +
			`runnerNodeMode=${process.env.ELECTRON_RUN_AS_NODE === "1"} ` +
			`runnerPreloadEnv=${String(process.env.NODE_OPTIONS?.includes("runnerConsolePreload") === true)} ` +
			`runnerSidecar=${getDshRunnerNodeSidecar() ?? "none"} ` +
			`koffiModule=${process.env.PIDECK_KOFFI_MODULE ?? "unresolved"}`,
	);

	// ── 组合：base 补丁 + 覆盖层（Connection/Gateway/remotes + storage + picker stub + 遥测关）──
	// require base 用宿主 node_modules 目录（DshHost 传 --dsh-node-modules 的 file URL）：
	// 打包后是 app.asar/node_modules（Electron asar patch 生效）；不能用 DSH_HOME（数据目录无包）。
	// 注意：CJS 产物里的裸 import("@deepseek-ai/...") 会走 Node 默认解析（out/main 向上找
	// node_modules），找不到 app 根 node_modules → ERR_MODULE_NOT_FOUND → exit(1)。
	// 必须先用 createRequire 解析出真实文件路径，再按 file URL 动态 import。
	// Typert Remote 契约（docs/dsh-remote-contract.md）：dsh-host-apiproxy 已被官方移除
	// （Typert Remote 架构），fetch handler 改由 dsh-client-connection 的
	// HostConnectionHandle.createSharedFetchHandler('/api') 提供（见下方 apiHandler）。
	const require = createRequire(join(fileURLToPath(nodeModulesUrl), "package.json"));
	const importFromApp = (specifier: string) => import(pathToFileURL(require.resolve(specifier)).href);
	const [appBoot, { provideCmdline }]: [typeof import("@deepseek-ai/dsh-app-boot"), typeof import("@deepseek-ai/dsh-cmdline")] = await Promise.all([importFromApp("@deepseek-ai/dsh-app-boot"), importFromApp("@deepseek-ai/dsh-cmdline")]);
	const { boot, loadOverlayPatches, PluginPackages } = appBoot;

	const basePatchPath = require.resolve("@deepseek-ai/dsh-base/cordis.patch.yml");
	const patches = loadOverlayPatches("pideck-dsh", basePatchPath);
	patches.push({ id: "hmr", disabled: true });
	patches.push({ id: "session-telemetry-otel", disabled: true });
	// 复刻 dsh-web-app/cordis.patch.yml 的「agent plane moves behind agent presets」：
	// 基础层工具必须禁用，否则 minimal/standard/ptc 等 preset 只是叠加自己的工具，
	// dsh-base 的进程级全局工具仍会对所有会话可见（极简模式失效的根因）。
	for (const row of dshWebAgentPlaneDisableRows()) {
		patches.push(row);
	}
	patches.push({
		insert: [
			// 0.1.5：storage / storage-json / storage-domain / session-projection-cache
			// 已由 dsh-base 补丁自带（配置与本处原注入完全一致），重复 insert 会报
			// duplicate loader entry id——只保留 base 之外的行。
			// 整段日志回合/步骤计数（sessionStats 投影）：dsh-web StatsLine 同源。
			// 不挂这行，host 不会产出 sessionStats，输入框底下就没有「N 轮 · M 步」。
			{ id: "session-stats", name: "@deepseek-ai/dsh-session-stats" },
			{ id: "workspace", name: "@deepseek-ai/dsh-workspace" },
			// 0.1.5 Typert Remote 传输层（替代旧 dsh-host-apiproxy / api-gateway 行，
			// typert/typert-loader/typert-gateway 由 dsh-base 补丁自带）：
			// - connection：载体无关 RPC 注册表，提供 ctx.connection 与
			//   createSharedFetchHandler('/api')（主进程 fetch 桥的 host 半）。
			// - api-remotes：把 Host 能力装配为 Remote（转发事件源注册到 gateway）。
			// - session-controller：session/approval/subagent 域 Remote 端点。
			// - settings/workspace 控制器：settings.* 与 workspace.* 端点。
			{ id: "connection", name: "@deepseek-ai/dsh-client-connection" },
			// fileUploads 服务（session-controller 的附件上传依赖；尽管叫 client-*，
			// 这个包提供的是 host 侧服务）。
			{ id: "file-upload", name: "@deepseek-ai/dsh-client-file-upload" },
			{ id: "api-remotes", name: "@deepseek-ai/dsh-api-remotes" },
			{ id: "session-controller", name: "@deepseek-ai/dsh-api-session-controller" },
			{ id: "settings-controller", name: "@deepseek-ai/dsh-api-settings-controller" },
			{ id: "workspace-controller", name: "@deepseek-ai/dsh-api-workspace-controller" },
			{ id: "pideck-directory-picker", name: pathToFileURL(join(configDir, "pideck-directory-picker.js")).href },
			{ id: "pideck-slash-bridge", name: pathToFileURL(join(configDir, "pideck-slash-bridge.js")).href },
			// 持久 pwsh 工具：继续用本地 dsh-tool-pwsh-persistent，不要换成官方
			// `@deepseek-ai/dsh-tool-pwsh-persistent`。官方工具名是 `pwsh`，会和
			// 一次性沙箱 pwsh 抢名字，且依赖 ctx.terminals + terminal-bash
			//（shellDialect: pwsh），base/standard/code 预设都没挂。绝对路径：
			// utilityProcess 的模块锚在 app node_modules，裸名不一定解析到同一目录。
			{
				id: "tool-pwsh-persistent",
				name: require.resolve("dsh-tool-pwsh-persistent"),
			},
			// 0.2 registry 与预设声明分离：此处登记服务，官方 bundle 的声明在
			// prepareDshHostProfile 装配；配置页与会话使用同一组稳定 ID。
			agentPresetsRow(),
			// subagent 模型选择开关（Host 作用域服务）：standard/code 预设的 tool-subagent
			// 行带 modelSelectionSettings: true，Host 缺该服务时整棵 preset 挂载失败
			// （agent-preset/invalid），见 dshSubagentModelSelectionSettingsRow 注释。
			dshSubagentModelSelectionSettingsRow(),
			// 动态 Cordis 插件管理（G13 深化）：运行器（define/run/stop/undefine，
			// 进程内临时扩展、按会话归属）+ 只读静态 Loader 清单 + PiDeck 管理桥。
			// 与 dsh-web-app 的 cordis.patch.yml 同一挂载形态（无 config 的普通行）。
			{ id: "plugin-inventory", name: "@deepseek-ai/dsh-host-plugin-inventory" },
			{ id: "cordis-host-runner", name: "@deepseek-ai/dsh-cordis-host-runner" },
			{ id: "pideck-plugin-bridge", name: join(__dirname, "pideckPluginBridge.js") },
			// 会话命令枚举桥（D15）：host 命令注册表（ctx.commands.list）经
			// /pideck-command/rpc 暴露给主进程，Composer `/` 补全拿到 live 命令
			// （含用户/插件注册的命令），执行仍走 pideck-slash-bridge。
			{ id: "pideck-command-bridge", name: join(__dirname, "pideckCommandsBridge.js") },
			// 会话冷读元数据桥（0.1.5 历史分页 cursor）：/pideck-session/rpc 暴露
			// sessionQuery observation cursor（不激活会话），供历史浏览/补帧等
			// 冷读路径计算 session/page 的合法 throughSeq。
			{ id: "pideck-session-bridge", name: join(__dirname, "pideckSessionBridge.js") },
			// 用量采集（G16）：成熟第三方 dsh-bill。无 web 硬依赖，钩 llm/stream
			// 落盘 $DSH_HOME/dsh-bill/records.jsonl；PiDeck 费用页只读该日志。
			// inject 为空：headless host 没有 webServer 也能继续记账。
			// name 用绝对路径：host 的模块解析锚在 app node_modules，裸名在
			// utilityProcess 里不一定能走到同一目录。
			{ id: "bill", name: require.resolve("dsh-bill") },
			// PiDeck 最小化收敛：host 层仍保留 bill_stats / pwsh_persistent 供
			// 非 minimal 预设使用，但 minimal 会话必须挡掉这两个全局扩展，
			// 保持与官方 minimal（Windows 为持久 pwsh + 文件工具）一致。
			{
				id: "pideck-minimal-tool-filter",
				// 文件本体在下方 writeFileSync 落盘（boot 前必已存在），这里只内联绝对路径。
				name: pathToFileURL(join(configDir, "pideck-minimal-tool-filter.js")).href,
			},
		],
	});

	// 0.2 配置由官方 profile/config-editor 持有。共享 home patch 最后加载，
	// 遥测禁用再压到最终层；非法用户补丁必须报错，不能静默丢配置。
	// agent-team 实验预设（--dsh-agent-team=1，设置项 dshAgentTeamPreset，默认关）：
	// 仅影响 host 组合层，会话/存储层无感知。
	const profile = await prepareDshHostProfile(dshHome, require, appBoot, patches, args["dsh-agent-team"] === "1");
	const pickerPath = join(configDir, "pideck-directory-picker.js");
	if (!existsSync(pickerPath)) {
		writeFileSync(pickerPath, ["export default {", "  apply(ctx) {", "    ctx.provide('directoryPicker', {", "      capability() { return { kind: 'none' }; },", "    });", "  },", "};", ""].join("\n"));
	}
	// Slash 命令桥：dsh-web 的命令执行（/permission /plan /compact 等）走浏览器
	// 客户端通道（commands.execute Remote），PiDeck 只有 api-proxy RPC 通道，拿不到
	// 该 Remote。本插件把「以 / 开头的单条用户消息」在 agent/pre-step（步骤组装前）
	// 拦截下来，经 ctx.commands.execute 执行：命中则 reject 该步骤（命令日志事件
	// command/run + command/done 由执行器落盘，消息不进模型、不上时间线），
	// 未命中（未知命令/非命令）原样放行。与 dsh-web 的客户端语义一致。
	const slashBridgePath = join(configDir, "pideck-slash-bridge.js");
	// 该桥是应用修复命令语义的运行时代码，不能只在首次启动时写入；否则已有
	// ~/.dsh 用户会继续使用旧桥，权限切换仍可能退化成普通 prompt。
	writeFileSync(
		slashBridgePath,
		[
			"export default {",
			"  apply(ctx) {",
			"    ctx.inject(['commands'], (commandCtx) => {",
			"      commandCtx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {",
			"        try {",
			"          // 只认 source.kind === 'user' 的输入：回合注入的运行时上下文等",
			"          // 系统消息也作为 user/message 进 claimed 批次，必须排除。",
			"          const userMessages = Array.isArray(messages)",
			"            ? messages.filter((m) => m && m.source && m.source.kind === 'user')",
			"            : [];",
			"          if (userMessages.length !== 1) return next();",
			"          const content = userMessages[0] && userMessages[0].content;",
			"          const block = Array.isArray(content) && content.length === 1 ? content[0] : undefined;",
			"          const line = block && block.type === 'text' && typeof block.text === 'string'",
			"            ? block.text.trim()",
			"            : '';",
			"          if (!line.startsWith('/')) return next();",
			"          // execute 的第三个参数是图片数组，第四个才是取消信号；参数错位会",
			"          // 让命令执行器把 AbortSignal 当数组处理，权限命令随后退化成普通消息。",
			"          const result = await commandCtx.commands.execute(agent, line, [], signal);",
			"          // 未知命令 execute 返回 undefined，只有这种情况才允许模型接管文本。",
			"          // 已知命令无论成功还是失败都必须 reject，避免 slash 行进入时间线/模型。",
			"          if (result === undefined) return next();",
			"          return { kind: 'reject' };",
			"        } catch (error) {",
			"          // 已解析的命令执行失败也不能作为普通用户问题重试一次；命令执行器",
			"          // 会记录 command/done error，reject 可以保持 DSH 的命令语义闭环。",
			"          return { kind: 'reject' };",
			"        }",
			"      });",
			"    });",
			"  }",
			"};",
			"",
		].join("\n"),
	);

	// 极简工具过滤插件：挂在 host 组合里，minimal agent 创建时把 PiDeck 全局
	// 扩展（bill_stats / pwsh_persistent）从继承工具目录中剔除；非 minimal 预设
	// 仍保留这两个扩展。只拦继承层，不动 minimal 自身注册的 bash/pwsh/editor。
	const minimalToolFilterPath = join(configDir, "pideck-minimal-tool-filter.js");
	writeFileSync(
		minimalToolFilterPath,
		[
			"export default {",
			"  name: 'pideck-minimal-tool-filter',",
			"  apply(ctx) {",
			"    ctx.on('agent/created', ({ agent }) => {",
			"      try {",
			"        const presets = ctx.get('agentPresets');",
			"        if (!presets || typeof presets.composedPreset !== 'function') return;",
			"        if (presets.composedPreset(agent.ctx) !== 'minimal') return;",
			"        agent.ctx.tools.restrict({ deny: ['bill_stats', 'pwsh_persistent'] });",
			"      } catch (error) {",
			"        console.warn('[pideck-minimal-tool-filter] failed:', error?.message ?? String(error));",
			"      }",
			"    });",
			"  }",
			"};",
			"",
		].join("\n"),
	);

	const startedAt = Date.now();
	const ctx = await boot(
		"pideck-dsh",
		profile.configPath,
		profile.patches,
		async (hostCtx: import("@deepseek-ai/cordis").Context) => {
			// prepare 早于所有 config-tree 插件挂载；用 runtime adapter 的依赖，
			// 不用 app 顶层 pi-ai。随 host fiber 清理，不改安装包/共享 profile。
			try {
				const dispose = await loadDshOpenCodeHeaders(require.resolve("@deepseek-ai/dsh-llm-pi-ai"));
				hostCtx.effect(() => dispose, "pideck-opencode-headers");
			} catch (error) {
				// runtime API 变化最多让兼容头缺席，不能阻断其它供应商与 host 启动。
				hostCtx.logger("pideck-opencode-headers").warn("Request header compatibility unavailable: %s", error instanceof Error ? error.message : String(error));
			}
			const [cordis, loader, include]: [typeof import("@deepseek-ai/cordis"), typeof import("@deepseek-ai/cordis-plugin-loader"), typeof import("@deepseek-ai/cordis-plugin-include")] = await Promise.all([
				importFromApp("@deepseek-ai/cordis"),
				importFromApp("@deepseek-ai/cordis-plugin-loader"),
				importFromApp("@deepseek-ai/cordis-plugin-include"),
			]);
			hostCtx.loader.builtins["pideck-legacy-preset"] = createLegacyPresetPlugin(cordis, loader, include, nodeModulesUrl);
			try {
				// 投影和 Zod 都取自选中的 runtime；app 顶层 Zod 3 不能交给 DSH 的 Zod 4 registry。
				const projectionRequire = createRequire(require.resolve("@deepseek-ai/dsh-session-projection"));
				const [{ z }, { assistantStreamFirstTokenTime }]: [{ z: DshTpsSchemaFactory }, typeof import("@deepseek-ai/dsh-llm")] = await Promise.all([import(pathToFileURL(projectionRequire.resolve("zod")).href), importFromApp("@deepseek-ai/dsh-llm")]);
				hostCtx.plugin(createDshTpsPlugin(z, assistantStreamFirstTokenTime));
			} catch (error) {
				// 统计依赖缺失只让端到端 TPS 不可用，不能阻断 host 启动与会话功能。
				hostCtx.logger("pideck-tps").warn("TPS projection unavailable: %s", error instanceof Error ? error.message : String(error));
			}
			hostCtx.provide("profileContext", profile.profileContext);
			hostCtx.plugin(PluginPackages, { resolution: profile.resolution });
			provideCmdline(hostCtx, {
				args: [],
				exit: (code: number) => {
					console.log(`[dsh-host-entry] host requested exit code=${code}`);
					port.postMessage({ type: "host-exit", code });
				},
			});
		},
		nodeModulesUrl,
	);
	// 0.1.5：fetch handler 来自 Connection（载体无关 /api 通道），语义与旧
	// toFetchHandler(ctx.apiProxy) 等价——接受标准 Request，返回 Response。
	// 注意取用路径：HostConnectionHandle 挂在 ctx.connection（cordis Context 增广，
	// 见 dsh-client-connection rpc-host.d.ts 的 declare module），不是混在 ctx 根上——
	// 直接 ctx.createSharedFetchHandler 运行时必然 undefined（曾用
	// `ctx as Context & HostConnectionHandle` 的交叉断言掩盖了这一点）。
	const apiHandler = ctx.connection.createSharedFetchHandler("/api");
	// Gateway 流派发器：与官方 RemoteStreamMuxServer 使用的 open 等价——
	// wireStream.open 处理普通 Remote 流端点与内部 $events 转发事件流（含瀑布）。
	// typertGateway 由 dsh-base 补丁的 typert-gateway 行提供（Context 增广见
	// dsh-api-gateway/types）。
	const wireStream = ctx.typertGateway.wireStream;
	// PiDeck 插件管理桥（G13 深化）：/pideck-plugin/rpc 走桥插件服务（动态插件
	// 生命周期 + 静态 Loader 清单），其余路径原样交给 Connection RPC handler。
	const handler = (url: URL, init?: RequestInit): Promise<Response> => {
		if (url.pathname === PIDECK_PLUGIN_BRIDGE_PATH) {
			return handlePluginBridgeFetch(ctx, {
				method: init?.method,
				// 桥协议 headers 是 Record<string,string>（见 DshFetchMessage）；RequestInit
				// 的 HeadersInit 形状更宽，此处收窄到桥协议形状。body 同理只透传字符串。
				headers: init?.headers as Record<string, string> | undefined,
				body: typeof init?.body === "string" ? init.body : undefined,
			});
		}
		if (url.pathname === PIDECK_COMMANDS_BRIDGE_PATH) {
			return handleCommandsBridgeFetch(ctx, {
				method: init?.method,
				headers: init?.headers as Record<string, string> | undefined,
				body: typeof init?.body === "string" ? init.body : undefined,
			});
		}
		// 会话冷读元数据桥（0.1.5 历史分页 throughSeq cursor 的来源；不激活会话）：
		// 读 cursor 走 observeSession（与 session/page 内部同一数据源），冷读不 promote。
		if (url.pathname === PIDECK_SESSION_BRIDGE_PATH) {
			return handleSessionBridgeFetch(ctx, {
				method: init?.method,
				headers: init?.headers as Record<string, string> | undefined,
				body: typeof init?.body === "string" ? init.body : undefined,
			});
		}
		// ConnectionFetchHandler.fetch 只收 Request（0.1.5 契约）；init 里的
		// method/headers/body/signal 原样进构造器，abort 语义由 Request 继承。
		return apiHandler.fetch(new Request(url, init));
	};
	console.log(`[dsh-host-entry] boot OK in ${Date.now() - startedAt}ms`);
	port.postMessage({ type: "host-ready" });

	// ── fetch 桥循环：每请求一个 Response，SSE 流逐帧回传 ──
	// 逻辑流注册表（stream-open → AbortController），stream-cancel 时 abort。
	const openStreams = new Map<string, AbortController>();
	port.on("message", (message: unknown) => {
		void (async () => {
			// utilityProcess 的 parentPort 消息是 MessageEvent 风格：载荷在 data 字段
			// （{ data: {...}, ports: [...] }）。兼容直接对象两种形状。
			const raw = (message as { data?: unknown } | null)?.data ?? message;
			const msg = parseDshFetchMessage(raw);
			if (!msg) return;
			if (msg.type === "stream-open") {
				openGatewayStream(port, wireStream, openStreams, msg.id, msg.endpoint, msg.payload);
				return;
			}
			if (msg.type === "stream-cancel") {
				openStreams.get(msg.id)?.abort();
				openStreams.delete(msg.id);
				return;
			}
			if (msg.type !== "fetch-request") return;
			const id = msg.id;
			if (!id) return;
			const url = new URL(msg.path ?? "/", "http://dsh.internal");
			const init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {
				method: msg.method ?? "GET",
				...(msg.headers ? { headers: msg.headers } : {}),
				...(msg.body !== undefined ? { body: msg.body } : {}),
			};
			const controller = new AbortController();
			init.signal = controller.signal;
			// 主进程 abort 转发：取消 host 侧进行中的请求（SSE 流 / 超时）。
			// 注册必须在任何 await 之前（E9）：fetch-abort 是独立消息，若注册晚于
			// handler.fetch 的同步段，先到的 abort 会丢失 → unary 请求无取消路径。
			const onAbortMessage = (abortMessage: unknown) => {
				const abortRaw = (abortMessage as { data?: unknown } | null)?.data ?? abortMessage;
				const parsed = parseDshFetchMessage(abortRaw);
				if (parsed?.type === "fetch-abort" && parsed.id === id) controller.abort();
			};
			port.on("message", onAbortMessage);
			try {
				const response = await handler(url, init);
				const status = response.status;
				const headers: Record<string, string> = {};
				response.headers.forEach((value: string, key: string) => {
					headers[key] = value;
				});
				const isStream = response.body !== null && !(response.headers.get("content-type") ?? "").includes("application/json");
				if (!isStream) {
					const body = await response.text();
					port.postMessage({ type: "fetch-response", id, status, headers, body });
					return;
				}
				port.postMessage({ type: "fetch-stream-start", id, status, headers });
				const reader = response.body!.getReader();
				const decoder = new TextDecoder();
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						port.postMessage({ type: "fetch-chunk", id, data: decoder.decode(value, { stream: true }) });
					}
				} catch (error) {
					port.postMessage({ type: "fetch-error", id, message: String(error) });
					return;
				} finally {
					await reader.cancel().catch(() => undefined);
				}
				port.postMessage({ type: "fetch-end", id });
			} catch (error) {
				port.postMessage({ type: "fetch-error", id, message: String(error) });
			} finally {
				port.off("message", onAbortMessage);
			}
		})();
	});
}

main().catch((error) => {
	console.error("[dsh-host-entry] fatal:", error);
	// 错误经 parentPort 回传主进程（utilityProcess 的 stderr 不可靠），
	// DshHostProcess 收到 host-error 后记入主进程日志。
	try {
		process.parentPort?.postMessage({
			type: "host-error",
			message: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
		});
	} catch {
		// parentPort 不可用（ELECTRON_RUN_AS_NODE 等）时只能靠 stderr
	}
	process.exit(1);
});

/**
 * 打开一条 Gateway 逻辑流并把宿主值泵回主进程（stream-item/end/error 帧）。
 * 帧形状与官方 RemoteStreamMuxServer 的 WebSocket 协议一致，主进程侧
 * DshApiClient.openStream 按同一协议消费。
 */
function openGatewayStream(port: ParentPort, wireStream: import("@deepseek-ai/dsh-api-gateway/types").TypertGatewayWireStream, openStreams: Map<string, AbortController>, id: string, endpoint: string, payload: unknown): void {
	if (!id || !endpoint) return;
	const controller = new AbortController();
	openStreams.set(id, controller);
	void (async () => {
		try {
			// 本载体尚无客户端 uplink；显式传空流，undefined peer 是官方进程内 operator。
			const uplink: AsyncIterable<unknown> = { async *[Symbol.asyncIterator]() {} };
			const items = await wireStream.open(endpoint, payload, uplink, undefined, controller.signal);
			for await (const value of items) {
				if (controller.signal.aborted) return;
				port.postMessage({ type: "stream-item", id, value });
			}
			port.postMessage({ type: "stream-end", id });
		} catch (error) {
			if (controller.signal.aborted) return;
			// wireStream.failure 把任意失败收敛为稳定的 {code,message,details} 三元组。
			const failure = wireStream.failure(error);
			port.postMessage({ type: "stream-error", id, code: failure.code, message: failure.message, details: failure.details });
		} finally {
			openStreams.delete(id);
		}
	})();
}
