import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import type { useCloudSync } from "./useCloudSync";

/**
 * 云同步 provider 浏览器授权流程（GitHub Device Flow / OneDrive PKCE / Google PKCE）。
 * token 只在主进程换取并配置，渲染层只持有验证 URL/设备码与轮询结果；
 * 轮询链与定时器全部在本 hook 内管理，卸载时统一清理（生命周期配对）。
 */

/** GitHub Device Flow 进行中展示信息。 */
export interface CloudSyncGithubFlow {
	userCode: string;
	verificationUrl: string;
	interval: number;
}

/** 浏览器授权（PKCE）进行中展示信息。 */
export interface CloudSyncBrowserFlow {
	verificationUrl: string;
}

/** useCloudSync 中 OAuth 相关的稳定回调集合（窄接口，避免整包透传）。 */
export type CloudSyncOAuthApi = Pick<ReturnType<typeof useCloudSync>, "githubDeviceStart" | "githubDevicePoll" | "oneDriveStart" | "oneDrivePoll" | "googleStart" | "googlePoll">;

/**
 * GitHub Device Flow：串行 setTimeout 轮询链（RFC 8628）。
 * 每轮结果决定下一跳等待时长（retryAfterMs，slow_down 累加已由主进程完成）；
 * 流程代数保证 start/poll 的迟到响应与旧定时器整体失效（防双击/重启叠加）。
 */
export function useGithubDeviceFlow(api: CloudSyncOAuthApi) {
	const [clientId, setClientId] = useState("");
	const [flow, setFlow] = useState<CloudSyncGithubFlow | null>(null);
	const [flowError, setFlowError] = useState<string | null>(null);
	const pollTimer = useRef<number | null>(null);
	/** 流程代数：每次发起连接 +1，使 in-flight 的 start/poll 迟到结果与旧定时器整体失效。 */
	const generation = useRef(0);

	const runPoll = useCallback(async () => {
		// 记录发起本轮的代数；等待期间若启动了新流程或组件卸载，代数已变，迟到结果一律丢弃。
		const current = generation.current;
		const result = await api.githubDevicePoll();
		if (current !== generation.current) return;
		if (!result) {
			// IPC 调用失败：useCloudSync 已写入全局 error；这里给出可见的流程失败提示并结束轮询。
			setFlow(null);
			setFlowError(t("cloudSync.provider.githubFlowFailed"));
			return;
		}
		if (result.status === "ok") {
			setFlow(null);
			setFlowError(null);
			return;
		}
		if (result.status === "error") {
			setFlow(null);
			setFlowError(result.error ?? t("cloudSync.provider.githubFlowFailed"));
			return;
		}
		// pending：按主进程返回的 retryAfterMs 安排下一跳（slow_down 累加已由主进程完成）。
		pollTimer.current = window.setTimeout(
			() => {
				pollTimer.current = null;
				if (current !== generation.current) return;
				void runPoll();
			},
			Math.max(0, result.retryAfterMs ?? 5000),
		);
	}, [api]);

	const start = useCallback(async () => {
		// 推进代数并清掉旧定时器：上一轮 in-flight 的 start/poll 响应即使稍后 resolve，
		// 也会因代数不符被丢弃，无法再调度新定时器或改写状态。
		generation.current += 1;
		const current = generation.current;
		setFlowError(null);
		if (pollTimer.current !== null) {
			window.clearTimeout(pollTimer.current);
			pollTimer.current = null;
		}
		const started = await api.githubDeviceStart(clientId.trim());
		// 等待期间用户再次连接（双击）或组件已卸载：这次响应已过期，直接丢弃。
		if (current !== generation.current) return;
		if (!started) return;
		setFlow({ userCode: started.userCode, verificationUrl: started.verificationUrl, interval: Math.max(5, started.interval) });
		// 首次轮询前先等一个服务端建议的间隔（RFC 8628：interval 内不应轮询）。
		pollTimer.current = window.setTimeout(() => {
			pollTimer.current = null;
			if (current !== generation.current) return;
			void runPoll();
		}, Math.max(5, started.interval) * 1000);
	}, [api, clientId, runPoll]);

	// 卸载时推进代数并清理定时器（生命周期配对）。
	useEffect(() => {
		return () => {
			generation.current += 1;
			if (pollTimer.current !== null) {
				window.clearTimeout(pollTimer.current);
				pollTimer.current = null;
			}
		};
	}, []);

	return { clientId, setClientId, flow, flowError, start };
}

/**
 * 浏览器授权（PKCE）流程：固定间隔 setInterval 轮询，终态（ok/error）即停；
 * error 时给出可展示文案（i18n），挂载期间定时器与组件同生命周期。
 */
export function useBrowserAuthFlow(options: {
	/** 发起授权（clientId 已在调用方 trim）。 */
	startAction: (clientId: string) => Promise<{ verificationUrl: string } | null | undefined>;
	/** 轮询授权状态。 */
	pollAction: () => Promise<{ status: "pending" | "ok" | "error"; error?: string } | undefined>;
	/** 轮询返回 error 且无 message 时的兜底文案。 */
	failedMessage: string;
}) {
	const [clientId, setClientId] = useState("");
	const [flow, setFlow] = useState<CloudSyncBrowserFlow | null>(null);
	const [flowError, setFlowError] = useState<string | null>(null);
	const pollTimer = useRef<number | null>(null);
	// options 每次渲染都是新对象；用 ref 快照持有最新回调，避免 start 依赖漂移。
	const optionsRef = useRef(options);
	optionsRef.current = options;

	const start = useCallback(async () => {
		const { startAction, pollAction, failedMessage } = optionsRef.current;
		setFlowError(null);
		const started = await startAction(clientId.trim());
		if (!started) return;
		setFlow({ verificationUrl: started.verificationUrl });
		if (pollTimer.current !== null) window.clearInterval(pollTimer.current);
		pollTimer.current = window.setInterval(async () => {
			const result = await pollAction();
			if (!result) return;
			if (result.status !== "pending") {
				if (pollTimer.current !== null) window.clearInterval(pollTimer.current);
				pollTimer.current = null;
				setFlow(null);
				if (result.status === "error") {
					setFlowError(result.error ?? failedMessage);
				}
			}
		}, 5000);
	}, [clientId]);

	// 卸载时清理轮询定时器（生命周期配对）。
	useEffect(() => {
		return () => {
			if (pollTimer.current !== null) {
				window.clearInterval(pollTimer.current);
				pollTimer.current = null;
			}
		};
	}, []);

	return { clientId, setClientId, flow, flowError, start };
}

/** OneDrive PKCE 浏览器授权流程。 */
export function useOneDriveFlow(api: CloudSyncOAuthApi) {
	return useBrowserAuthFlow({
		startAction: (clientId) => api.oneDriveStart(clientId),
		pollAction: () => api.oneDrivePoll(),
		failedMessage: t("cloudSync.provider.onedriveFlowFailed"),
	});
}

/** Google PKCE 浏览器授权流程（额外可选 clientSecret）。 */
export function useGoogleFlow(api: CloudSyncOAuthApi) {
	const [clientSecret, setClientSecret] = useState("");
	const flow = useBrowserAuthFlow({
		startAction: (clientId) => api.googleStart(clientId, clientSecret.trim() || undefined),
		pollAction: () => api.googlePoll(),
		failedMessage: t("cloudSync.provider.googleFlowFailed"),
	});
	return { ...flow, clientSecret, setClientSecret };
}
