import net from "node:net";
import tls from "node:tls";
import { Buffer } from "node:buffer";
import type { AppSettings, PiProxyTestResult } from "../../shared/types";
import { mainProcessT, type MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";

type PiProxySettings = Pick<AppSettings, "piProxyEnabled" | "piProxyUrl" | "piProxyBypass">;

const DEFAULT_PROXY_TEST_URL = "https://api.openai.com/v1/models";
const PROXY_TEST_TIMEOUT_MS = 8_000;

type ProxyCopy = (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string;

class ProxyTestError extends Error {
	constructor(
		readonly key: MainProcessTranslationKey,
		readonly params?: Record<string, string | number>,
	) {
		super(key);
	}
}

export async function testPiProxy(settings: PiProxySettings, testUrl = DEFAULT_PROXY_TEST_URL, translate: ProxyCopy = (key, params) => mainProcessT("zh-CN", key, params)): Promise<PiProxyTestResult> {
	const startedAt = Date.now();

	try {
		const target = new URL(testUrl);
		// 配置与开关解耦：不再要求全局启用才可测试。测试验证的是「已配置的代理地址」
		// 是否可用——单会话代理（on 模式）会复用同一地址，即使全局开关关闭也走代理。

		const proxyValue = settings.piProxyUrl.trim();
		if (!proxyValue) {
			return failure(translate("mainProxy.addressRequired"), startedAt, testUrl);
		}

		if (matchesNoProxy(target.hostname, getUrlPort(target), settings.piProxyBypass)) {
			return {
				...failure(translate("mainProxy.bypassed"), startedAt, testUrl),
				bypassed: true,
			};
		}

		const proxy = new URL(normalizeProxyUrl(proxyValue));
		const result = await requestThroughProxy(proxy, target);
		return {
			success: true,
			url: testUrl,
			statusCode: result.statusCode,
			elapsedMs: Date.now() - startedAt,
			message: translate("mainProxy.success", { status: result.statusCode }),
		};
	} catch (error) {
		return failure(formatProxyError(error, translate), startedAt, testUrl);
	}
}

function normalizeProxyUrl(value: string) {
	return /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`;
}

async function requestThroughProxy(proxy: URL, target: URL) {
	if (proxy.protocol !== "http:" && proxy.protocol !== "https:") {
		throw new ProxyTestError("mainProxy.proxyProtocolUnsupported");
	}
	if (target.protocol !== "http:" && target.protocol !== "https:") {
		throw new ProxyTestError("mainProxy.targetProtocolUnsupported");
	}

	if (target.protocol === "http:") {
		return requestHttpTargetThroughProxy(proxy, target);
	}
	return requestHttpsTargetThroughProxy(proxy, target);
}

async function requestHttpsTargetThroughProxy(proxy: URL, target: URL) {
	const socket = await connectProxySocket(proxy);
	const targetAuthority = `${target.hostname}:${getUrlPort(target)}`;

	try {
		// HTTPS 目标通过 HTTP CONNECT 建立隧道；这和大多数 Node/undici 代理客户端的实际路径一致。
		socket.write(`CONNECT ${targetAuthority} HTTP/1.1\r\n` + `Host: ${targetAuthority}\r\n` + `Proxy-Connection: Keep-Alive\r\n` + proxyAuthHeader(proxy) + `\r\n`);

		const connectHead = await readHttpHead(socket);
		if (connectHead.statusCode !== 200) {
			throw new ProxyTestError("mainProxy.connectStatus", { status: connectHead.statusCode });
		}

		const secureSocket = await upgradeToTls(socket, target.hostname);
		try {
			secureSocket.write(buildOriginGetRequest(target));
			return await readHttpHead(secureSocket);
		} finally {
			secureSocket.destroy();
		}
	} catch (error) {
		socket.destroy();
		throw error;
	}
}

async function requestHttpTargetThroughProxy(proxy: URL, target: URL) {
	const socket = await connectProxySocket(proxy);
	try {
		socket.write(buildProxyGetRequest(target, proxy));
		return await readHttpHead(socket);
	} finally {
		socket.destroy();
	}
}

function connectProxySocket(proxy: URL): Promise<net.Socket | tls.TLSSocket> {
	const port = getUrlPort(proxy);
	const host = proxy.hostname;

	return new Promise((resolve, reject) => {
		const socket = proxy.protocol === "https:" ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new ProxyTestError("mainProxy.connectTimeout"));
		}, PROXY_TEST_TIMEOUT_MS);

		function cleanup() {
			clearTimeout(timer);
			socket.off("error", onError);
			socket.off("connect", onConnect);
			socket.off("secureConnect", onConnect);
		}
		function onConnect() {
			cleanup();
			resolve(socket);
		}
		function onError(error: Error) {
			cleanup();
			reject(error);
		}

		socket.once("error", onError);
		if (proxy.protocol === "https:") {
			(socket as tls.TLSSocket).once("secureConnect", onConnect);
		} else {
			socket.once("connect", onConnect);
		}
	});
}

function upgradeToTls(socket: net.Socket | tls.TLSSocket, servername: string) {
	return new Promise<tls.TLSSocket>((resolve, reject) => {
		const secureSocket = tls.connect({ socket, servername });
		const timer = setTimeout(() => {
			secureSocket.destroy();
			reject(new ProxyTestError("mainProxy.tlsTimeout"));
		}, PROXY_TEST_TIMEOUT_MS);

		function cleanup() {
			clearTimeout(timer);
			secureSocket.off("error", onError);
			secureSocket.off("secureConnect", onConnect);
		}
		function onConnect() {
			cleanup();
			resolve(secureSocket);
		}
		function onError(error: Error) {
			cleanup();
			reject(error);
		}

		secureSocket.once("secureConnect", onConnect);
		secureSocket.once("error", onError);
	});
}

function readHttpHead(socket: net.Socket | tls.TLSSocket) {
	return new Promise<{ statusCode: number }>((resolve, reject) => {
		let buffer = "";
		const timer = setTimeout(() => {
			cleanup();
			reject(new ProxyTestError("mainProxy.responseTimeout"));
		}, PROXY_TEST_TIMEOUT_MS);

		function cleanup() {
			clearTimeout(timer);
			socket.off("data", onData);
			socket.off("error", onError);
			socket.off("end", onEnd);
		}
		function onData(chunk: Buffer) {
			buffer += chunk.toString("latin1");
			if (buffer.length > 64 * 1024) {
				cleanup();
				reject(new ProxyTestError("mainProxy.headerTooLarge"));
				return;
			}
			const headEnd = buffer.indexOf("\r\n\r\n");
			if (headEnd < 0) return;
			const statusLine = buffer.slice(0, buffer.indexOf("\r\n"));
			const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/.exec(statusLine);
			cleanup();
			if (!match) {
				reject(new ProxyTestError("mainProxy.invalidResponse"));
				return;
			}
			resolve({ statusCode: Number(match[1]) });
		}
		function onError(error: Error) {
			cleanup();
			reject(error);
		}
		function onEnd() {
			cleanup();
			reject(new ProxyTestError("mainProxy.closedEarly"));
		}

		socket.on("data", onData);
		socket.once("error", onError);
		socket.once("end", onEnd);
	});
}

function buildOriginGetRequest(target: URL) {
	return `GET ${getRequestPath(target)} HTTP/1.1\r\n` + `Host: ${target.host}\r\n` + `User-Agent: pi-desktop-proxy-test\r\n` + `Connection: close\r\n` + `\r\n`;
}

function buildProxyGetRequest(target: URL, proxy: URL) {
	return `GET ${target.href} HTTP/1.1\r\n` + `Host: ${target.host}\r\n` + `User-Agent: pi-desktop-proxy-test\r\n` + proxyAuthHeader(proxy) + `Connection: close\r\n` + `\r\n`;
}

function proxyAuthHeader(proxy: URL) {
	if (!proxy.username) return "";
	const auth = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
	return `Proxy-Authorization: Basic ${Buffer.from(auth).toString("base64")}\r\n`;
}

function getRequestPath(url: URL) {
	return `${url.pathname || "/"}${url.search}`;
}

function getUrlPort(url: URL) {
	if (url.port) return Number(url.port);
	return url.protocol === "https:" ? 443 : 80;
}

function matchesNoProxy(hostname: string, port: number, bypass: string) {
	const host = hostname.toLowerCase();
	return bypass
		.split(",")
		.map((item) => item.trim().toLowerCase())
		.filter(Boolean)
		.some((entry) => matchesNoProxyEntry(host, port, entry));
}

function matchesNoProxyEntry(host: string, port: number, entry: string) {
	if (entry === "*") return true;
	const [pattern, entryPort] = splitNoProxyPort(entry);
	if (entryPort && entryPort !== String(port)) return false;
	if (pattern.startsWith("*.")) {
		const suffix = pattern.slice(1);
		return host.endsWith(suffix);
	}
	if (pattern.startsWith(".")) {
		return host === pattern.slice(1) || host.endsWith(pattern);
	}
	return host === pattern || host.endsWith(`.${pattern}`);
}

function splitNoProxyPort(entry: string) {
	const lastColon = entry.lastIndexOf(":");
	if (lastColon <= 0 || entry.includes("::")) return [entry, ""] as const;
	return [entry.slice(0, lastColon), entry.slice(lastColon + 1)] as const;
}

function failure(error: string, startedAt: number, url: string): PiProxyTestResult {
	return {
		success: false,
		url,
		elapsedMs: Date.now() - startedAt,
		error,
	};
}

function formatProxyError(error: unknown, translate: ProxyCopy) {
	if (error instanceof ProxyTestError) return translate(error.key, error.params);
	if (error instanceof Error) {
		if (error.message === "Invalid URL") return translate("mainProxy.invalidUrl");
		if (error.message.includes("ECONNREFUSED")) return translate("mainProxy.connectionRefused");
		if (error.message.includes("ENOTFOUND")) return translate("mainProxy.hostNotFound");
		if (error.message.includes("ECONNRESET")) return translate("mainProxy.connectionReset");
		if (error.message.includes("ETIMEDOUT")) return translate("mainProxy.connectionTimeout");
	}
	console.error("[PiProxyTester] Proxy test failed", error);
	return translate("mainProxy.unknownError");
}
