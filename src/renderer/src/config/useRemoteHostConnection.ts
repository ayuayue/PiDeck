import { useEffect, useState } from "react";
import { createRemoteHostConnectionStore, type RemoteHostConnectionPorts, type RemoteHostConnectionSnapshot, type RemoteHostConnectionStore } from "./remoteHostConnectionModel";

/**
 * 渲染层单例：远端主机连接状态 + 自动连接。
 *
 * 一份状态同时服务两个消费者——配置目标选择器（动画/状态点/密码提示）与远端配置面板（读之前确保
 * 主机在线）。各自按需订阅，共享同一次 connect：选择器触发的连接不会被面板再发一遍。
 *
 * 为什么端口是结构收窄而不是 import desktopApi：`desktopApi` 在模块求值时就引用 window，
 * 而选择器要能在 SSR/纯 Node 单测里渲染；这里只在窗口存在时读 `window.piDesktop.remoteHosts`，
 * 其余环境退化成未接线（状态机对未接线明确「不启动请求」）。
 */

function readDesktopHostPorts(): RemoteHostConnectionPorts | undefined {
	if (typeof window === "undefined") return undefined;
	const preload = (window as unknown as { piDesktop?: unknown }).piDesktop;
	if (typeof preload !== "object" || preload === null) return undefined;
	const hosts = Reflect.get(preload, "remoteHosts");
	if (typeof hosts !== "object" || hosts === null) return undefined;
	const list = Reflect.get(hosts, "list");
	const connect = Reflect.get(hosts, "connect");
	const onStateChange = Reflect.get(hosts, "onStateChange");
	return {
		...(typeof list === "function" ? { list: () => Promise.resolve(list.call(hosts) as Promise<unknown>) } : {}),
		...(typeof connect === "function" ? { connect: (hostId: string, password?: string) => Promise.resolve(connect.call(hosts, hostId, password) as Promise<unknown>) } : {}),
		...(typeof onStateChange === "function" ? { onStateChange: (listener: (change: unknown) => void) => onStateChange.call(hosts, listener) as () => void } : {}),
	};
}

export function createDesktopRemoteHostConnectionStore(): RemoteHostConnectionStore {
	const ports = readDesktopHostPorts();
	return createRemoteHostConnectionStore(ports === undefined ? {} : ports);
}

let shared: RemoteHostConnectionStore | undefined;

/** 单例（首个调用方创建；未接线时也返回一个可用的空状态机，调用方无需判空）。 */
export function remoteHostConnectionStore(): RemoteHostConnectionStore {
	shared ??= createDesktopRemoteHostConnectionStore();
	return shared;
}

export type RemoteHostConnectionView = {
	snapshot: RemoteHostConnectionSnapshot;
	ensureConnected: RemoteHostConnectionStore["ensureConnected"];
};

/** 组件侧订阅：一条 useEffect 接目录 + 推送，卸载只退订（状态保持，下一个消费者直接复用）。 */
export function useRemoteHostConnection(): RemoteHostConnectionView {
	const store = remoteHostConnectionStore();
	const [snapshot, setSnapshot] = useState<RemoteHostConnectionSnapshot>(() => store.snapshot());
	useEffect(() => {
		store.start();
		const sync = (): void => setSnapshot(store.snapshot());
		sync();
		return store.subscribe(sync);
	}, [store]);
	return { snapshot, ensureConnected: store.ensureConnected };
}
