import { useEffect, type Dispatch, type SetStateAction } from "react";
import type { PiDesktopApi } from "../../../../preload";
import type { PiConfigTarget, PiResourceTarget } from "../../../../shared/piConfig";
import type { ConfigTab } from "../configTypes";
import { configTargetKey } from "../configEnvironmentModel";
import { resourceTargetErrorMessage } from "../resourceTargetErrorCopy";
import { toSshTargetHosts, toWslTargetHosts, type PiConfigTargetHost } from "../piConfigTargetModel";
import type { ResourceScope } from "../resourceScopeModel";
import { sameConfigTargetHosts, type ConfigSection } from "./configModalStorage";

const api: PiDesktopApi = (window as unknown as { piDesktop: PiDesktopApi }).piDesktop;

type ConfigLoadEffectsDeps = {
	open: boolean;
	/** 分区可见性：独立弹窗/资源管理器恒为可见；嵌入时由宿主（设置窗口）逐次告知。 */
	paneVisible: boolean;
	setRemoteConfigHosts: Dispatch<SetStateAction<PiConfigTargetHost[]>>;
	setRemoteConfigHostsLoaded: Dispatch<SetStateAction<boolean>>;
	loadConfig: (target: ConfigTab) => Promise<void>;
	section: ConfigSection;
	tab: ConfigTab;
	resourceScope: ResourceScope;
	effectiveProjectId: string | undefined;
	bumpResourceGeneration: () => void;
	resourceTarget: PiResourceTarget;
	configTarget: PiConfigTarget;
	refreshSkills: () => Promise<unknown>;
	refreshPrompts: () => Promise<unknown>;
	refreshExtensions: (checkVersions?: boolean) => void;
	setError: Dispatch<SetStateAction<string | null>>;
};

/**
 * 配置弹窗的取数副作用：主机清单重读、资源页/配置页刷新、provider 迁移后重读。
 * 三者都跟着「打开 + 当前分区 + 当前环境」走，集中在这里避免 ConfigModal 里散落三个 effect。
 */
export function useConfigLoadEffects(deps: ConfigLoadEffectsDeps) {
	const { open, paneVisible, setRemoteConfigHosts, setRemoteConfigHostsLoaded, loadConfig, section, tab, resourceScope, effectiveProjectId, bumpResourceGeneration, resourceTarget, configTarget, refreshSkills, refreshPrompts, refreshExtensions, setError } = deps;

	useEffect(() => {
		if (!open) return;
		const onMigrated = () => {
			void loadConfig("models");
		};
		window.addEventListener("pideck:provider-migrated", onMigrated);
		return () => window.removeEventListener("pideck:provider-migrated", onMigrated);
	}, [open, loadConfig]);

	// 配置目标选择器（Batch B + WS2）：ssh 只列已验证且未禁用的主机；WSL 项来自开发设置里的那一个环境；
	// 两边都失败也保留「本机」。
	// 主机清单会从别处变（设置 → 连接里的新建/编辑/移除）：分区重新可见时重读一次。
	// 从挂载到关闭只读一次的写法会让下拉漏掉刚添加的主机，只能关掉整个设置重开才能看到（2026-11 实机反馈）。
	useEffect(() => {
		if (!open || !paneVisible) return;
		let cancelled = false;
		void Promise.all([api.remoteHosts.list(), api.settings.get()])
			.then(([sshResult, settings]) => {
				if (cancelled) return;
				// WSL 身份只认开发设置：开关打开且 distro/user 都有才出现这一项（主进程同样会 fail closed）。
				const distro = (settings.wslDistro ?? "").trim();
				const user = (settings.wslUser ?? "").trim();
				const wslIdentity = settings.wslEnabled === true && distro.length > 0 && user.length > 0 ? { distro, user } : undefined;
				setRemoteConfigHosts((previous) => {
					const next = [...toSshTargetHosts(sshResult.ok ? sshResult.hosts.filter((host) => host.verified && !host.disabled) : []), ...toWslTargetHosts(wslIdentity)];
					// 重读没带来变化时保留旧数组：状态条按 hosts 身份变化自动确保连接，不能因一次无变化的刷新
					// 重新弹密码框/重发连接。真正新增/删除/改名的主机仍会换上新的清单。
					return sameConfigTargetHosts(previous, next) ? previous : next;
				});
				setRemoteConfigHostsLoaded(true);
			})
			.catch(() => {
				if (cancelled) return;
				setRemoteConfigHosts([]);
				setRemoteConfigHostsLoaded(true);
			});
		return () => {
			cancelled = true;
		};
	}, [open, paneVisible]);

	/** 环境的稳定身份：切换时用它驱动一次整页重读（local↔ssh 的 target 选项都是 undefined，必须单独判）。 */
	const configTargetIdentity = configTargetKey(configTarget);
	// 资源页在进入/scope/project 变化时刷新；generation 变化让在途旧响应失效。
	useEffect(() => {
		if (!open) return;
		bumpResourceGeneration();
		if (section === "skills") {
			void refreshSkills().catch((e) => setError(resourceTargetErrorMessage(e)));
			return;
		}
		if (section === "prompts") {
			void refreshPrompts().catch((e) => setError(resourceTargetErrorMessage(e)));
			return;
		}
		if (section === "extensions") {
			// 扩展页需要显示当前/最新版本与可更新状态，首次进入强制查一次版本；
			// 主进程 listCacheHasVersionInfo 会让后续进入直接吃带版本的缓存，不重复打 npm view。
			void refreshExtensions(true);
			return;
		}
		void loadConfig(tab);
		// 环境切换必须触发一次重读：local↔ssh 时 configTargetOption 都是 undefined，只靠 loadConfig 的
		// 身份变化不会重新取数（例如在 ssh 上停过信任页，切回本机后 trustData 还是未加载的空对象）。
	}, [open, section, tab, loadConfig, resourceScope, effectiveProjectId, bumpResourceGeneration, resourceTarget, configTargetIdentity]);
}
