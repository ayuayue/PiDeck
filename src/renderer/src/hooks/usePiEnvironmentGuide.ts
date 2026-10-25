import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import type { PiInstallation, PiRuntimeNodeStatus } from "../../../shared/types";
import type { PiDesktopApi } from "../../../preload";
import { runPiOneClickInstall, type PiOneClickFailureReason, type PiOneClickStep } from "../utils/piOneClickInstall";

/**
 * pi 环境引导（检测 Node/npm → 安装 pi → 重新检测）的域状态与命令。
 *
 * 职责边界：只管理「引导流程」自身的状态机（检测/安装中/结果），不持有
 * EnvironmentDialog 的开关（那是 App 装配层的事）；按项目 hook 约定，
 * 副作用收敛在 hook 内，组件只做呈现与事件转发。
 *
 * 产品取舍（2026-10 用户要求）：
 * - 默认只提供「一键安装」：Node/npm 检测、安装 pi、重新检测一次跑完，
 *   用户不需要理解步骤顺序。
 * - 尽量不用 PiDeck 内置的便携 Node/npm：编排层只在系统完全没有 Node、
 *   或系统 Node 缺 npm 时才安装便携副本（见 piOneClickInstall.ts）。
 * - 重新检测交给装配层注入（弹窗的已安装状态由 usePiUpdate 持有），因此
 *   `recheckPi` 用 ref 保存，避免回调更新导致 useCallback 依赖抖动。
 */
export function usePiEnvironmentGuide(api: PiDesktopApi, recheckPi?: () => Promise<boolean>) {
	// Node 状态（便携副本 + 系统 node 合并视图）
	const [nodeStatus, setNodeStatus] = useState<PiRuntimeNodeStatus | null>(null);
	const [nodeChecking, setNodeChecking] = useState(false);

	// npm 检测状态（一键安装的第 2 步，也用于面板上展示「已有 npm」）
	const [npmVersion, setNpmVersion] = useState<string | null>(null);
	const [npmChecking, setNpmChecking] = useState(false);
	const [npmError, setNpmError] = useState<string | null>(null);

	// 镜像只影响 npm registry（不写全局配置），默认开：国内网络下首次安装成功率更高。
	const [piUseMirror, setPiUseMirror] = useState(true);

	// 一键安装状态
	const [installing, setInstalling] = useState(false);
	const [activeStep, setActiveStep] = useState<PiOneClickStep | null>(null);
	const [completedSteps, setCompletedSteps] = useState<PiOneClickStep[]>([]);
	const [failure, setFailure] = useState<{ step: PiOneClickStep; reason: PiOneClickFailureReason; detail?: string } | null>(null);
	const [installed, setInstalled] = useState(false);
	/**
	 * 主进程拦下安装时的现场：本机已经装了 pi，因此没有安装新副本。
	 * 非空且 installed=false 时说明「有安装但当前环境用不了」，界面引导手动指定路径。
	 */
	const [alreadyInstalled, setAlreadyInstalled] = useState<PiInstallation[]>([]);

	const mountedRef = useRef(true);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	const recheckPiRef = useRef(recheckPi);
	useEffect(() => {
		recheckPiRef.current = recheckPi;
	}, [recheckPi]);

	/** 检测引导环境：便携 node 副本 + 系统 node。打开弹窗时调用。 */
	const checkNode = useCallback(async () => {
		setNodeChecking(true);
		try {
			const next = await api.pi.runtimeNodeCheck();
			if (mountedRef.current) setNodeStatus(next);
		} catch (error) {
			if (mountedRef.current) {
				setNodeStatus({
					installed: false,
					systemNodeAvailable: false,
					installSupported: true,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		} finally {
			if (mountedRef.current) setNodeChecking(false);
		}
	}, [api]);

	/** 检测 npm 可用性（系统 npm 优先；主进程的搜索目录已把系统目录排在便携目录之前）。 */
	const checkNpmForGuide = useCallback(async () => {
		setNpmChecking(true);
		setNpmError(null);
		try {
			const result = await api.pi.checkNpm();
			if (!mountedRef.current) return;
			if (result.available && result.version) {
				setNpmVersion(result.version);
			} else {
				setNpmVersion(null);
				setNpmError(result.error ?? t("environment.guideNpmMissing"));
			}
		} catch (error) {
			if (mountedRef.current) {
				setNpmVersion(null);
				setNpmError(error instanceof Error ? error.message : String(error));
			}
		} finally {
			if (mountedRef.current) setNpmChecking(false);
		}
	}, [api]);

	/**
	 * 一键安装：检测 Node/npm → 安装 pi → 重新检测。
	 * 具体决策（何时才用便携 Node、何时算「已有安装」）在 piOneClickInstall.ts 的纯函数里，
	 * 这里只负责把结果落进 React 状态。
	 */
	const installAll = useCallback(async () => {
		setInstalling(true);
		setFailure(null);
		setInstalled(false);
		setAlreadyInstalled([]);
		setCompletedSteps([]);
		setActiveStep("node");
		try {
			const recheck = async () => {
				const injected = recheckPiRef.current;
				if (injected) return await injected();
				// 没有装配层回调（如独立渲染/测试）：自己跑一次环境检测。
				const status = await api.pi.check(false);
				return Boolean(status.installed);
			};
			const outcome = await runPiOneClickInstall(
				{
					runtimeNodeCheck: () => api.pi.runtimeNodeCheck(),
					runtimeNodeInstall: () => api.pi.runtimeNodeInstall(),
					checkNpm: () => api.pi.checkNpm(),
					runtimePiInstall: (useMirror) => api.pi.runtimePiInstall(useMirror),
					recheck,
				},
				{
					useMirror: piUseMirror,
					onProgress: ({ step, status }) => {
						if (!mountedRef.current) return;
						if (status === "running") {
							setActiveStep(step);
						} else {
							setCompletedSteps((prev) => (prev.includes(step) ? prev : [...prev, step]));
						}
					},
				},
			);
			if (!mountedRef.current) return;
			if (outcome.status === "installed") {
				setInstalled(true);
				// 装完顺手刷新面板上的 Node/npm 状态（便携 Node 可能是这一步才装上的）。
				void checkNode();
				void checkNpmForGuide();
			} else if (outcome.status === "already-installed") {
				setAlreadyInstalled(outcome.installations);
				if (outcome.detected) setInstalled(true);
				else setFailure({ step: "recheck", reason: "pi-undetected" });
			} else {
				setFailure({ step: outcome.step, reason: outcome.reason, detail: outcome.detail });
			}
		} catch (error) {
			if (mountedRef.current) {
				setFailure({ step: "pi", reason: "pi-install", detail: error instanceof Error ? error.message : String(error) });
			}
		} finally {
			if (mountedRef.current) {
				setInstalling(false);
				setActiveStep(null);
			}
		}
	}, [api, checkNode, checkNpmForGuide, piUseMirror]);

	/** 关闭弹窗时重置一次性状态（检测结果保留会让下次打开看到过期数据）。 */
	const resetGuide = useCallback(() => {
		setNodeStatus(null);
		setNodeChecking(false);
		setNpmVersion(null);
		setNpmChecking(false);
		setNpmError(null);
		setInstalling(false);
		setActiveStep(null);
		setCompletedSteps([]);
		setFailure(null);
		setInstalled(false);
		setAlreadyInstalled([]);
	}, []);

	return {
		// state
		nodeStatus,
		nodeChecking,
		npmVersion,
		npmChecking,
		npmError,
		piUseMirror,
		installing,
		activeStep,
		completedSteps,
		failure,
		installed,
		alreadyInstalled,
		// setters
		setPiUseMirror,
		// commands
		checkNode,
		checkNpmForGuide,
		installAll,
		resetGuide,
	};
}

export type PiEnvironmentGuide = ReturnType<typeof usePiEnvironmentGuide>;
