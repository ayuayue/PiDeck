import { useEffect, useRef, type MutableRefObject } from "react";
import { useAtomValue } from "jotai";
import type { PiConfigTarget } from "../../../../shared/piConfig";
import { projectByIdAtomFamily } from "../../atoms";
import { hasUnsavedConfigDrafts, preferredConfigTargetForProject, samePiConfigTarget, type PiConfigTargetHost } from "../piConfigTargetModel";

type ConfigTargetAutoSelectDeps = {
	/** 配置弹窗的 props（只读 projectId：自动落点按当前项目所在主机决定）。 */
	props: { projectId?: string };
	open: boolean;
	/** 嵌入分区也是「打开」：设置窗口内嵌时深度链与自动落点同样生效。 */
	embedded: boolean | undefined;
	/** 项目资源管理器只渲染技能/提示词/扩展，与配置目标无关。 */
	resourceOnly: boolean;
	remoteConfigHosts: PiConfigTargetHost[];
	remoteConfigHostsLoaded: boolean;
	configTarget: PiConfigTarget;
	remoteConfigDirty: boolean;
	commitTargetSwitch: (target: PiConfigTarget) => void;
	/** 判「有未保存草稿」用 ref：自动落点不能因为脏集合变化就重跑决策。 */
	dirtyTabsRef: MutableRefObject<Set<string>>;
};

/**
 * 打开配置管理时的目标选择（两个 ref 闩锁、各只决定一次）：
 * 1) 默认落在当前远端项目所在主机——远端项目里展示本机配置等于把用户引到错误的机器上写盘；
 * 2) 记住的环境若已不存在（主机被删/禁用、档案被删）静默回本机，否则用户看到一屏连接错误。
 */
export function useConfigTargetAutoSelect(deps: ConfigTargetAutoSelectDeps) {
	const { props, open, embedded, resourceOnly, remoteConfigHosts, remoteConfigHostsLoaded, configTarget, remoteConfigDirty, commitTargetSwitch, dirtyTabsRef } = deps;
	/**
	 * 打开配置管理时默认落在当前远端项目所在主机：「模型配置 / Pi 设置」展示的是当前环境的 pi 配置，
	 * 远端项目里默认展示本机配置等于把用户引到错误的机器上写盘。
	 *
	 * 只在本次打开的第一个决定生效（ref 闩）：用户随后主动切回本机的情况不能被打开动作改写。
	 * 主机清单未到齐时不决定（否则会先渲染本机再自己跳一次）；有未保存草稿时不打断用户。
	 */
	const activeProjectForTarget = useAtomValue(projectByIdAtomFamily(props.projectId ?? ""));
	const configSurfaceOpen = open || embedded === true;
	const autoConfigTargetAppliedRef = useRef(false);
	useEffect(() => {
		if (!configSurfaceOpen) {
			autoConfigTargetAppliedRef.current = false;
			return;
		}
		// 项目资源管理器（resourceOnly）只渲染技能/提示词/扩展，与配置目标无关：不改写那边的状态。
		if (resourceOnly) return;
		if (autoConfigTargetAppliedRef.current) return;
		if (!remoteConfigHostsLoaded) return;
		autoConfigTargetAppliedRef.current = true;
		const next = preferredConfigTargetForProject(activeProjectForTarget, remoteConfigHosts, configTarget);
		if (samePiConfigTarget(next, configTarget)) return;
		if (hasUnsavedConfigDrafts(dirtyTabsRef.current) || remoteConfigDirty) return;
		commitTargetSwitch(next);
	}, [configSurfaceOpen, resourceOnly, activeProjectForTarget, remoteConfigHosts, remoteConfigHostsLoaded, configTarget, remoteConfigDirty, commitTargetSwitch, dirtyTabsRef]);
	/**
	 * 记住的环境若已不存在（主机被删/被禁用、档案被删），静默回本机：
	 * 停在一个读不到的机器上，用户看到的是一屏连接错误，而回本机是唯一有意义的安全落点。
	 */
	const rememberedTargetCheckedRef = useRef(false);
	useEffect(() => {
		if (!configSurfaceOpen) {
			rememberedTargetCheckedRef.current = false;
			return;
		}
		if (resourceOnly) {
			rememberedTargetCheckedRef.current = true;
			return;
		}
		if (rememberedTargetCheckedRef.current || !remoteConfigHostsLoaded) return;
		rememberedTargetCheckedRef.current = true;
		if (configTarget.kind === "local") return;
		const exists = remoteConfigHosts.some((host) => (configTarget.kind === "ssh" ? host.kind === "ssh" && host.id === configTarget.hostId : host.kind === "wsl"));
		if (!exists) commitTargetSwitch({ kind: "local" });
	}, [configSurfaceOpen, resourceOnly, remoteConfigHostsLoaded, remoteConfigHosts, configTarget, commitTargetSwitch]);
}
