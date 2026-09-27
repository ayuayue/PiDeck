/**
 * 真实主机验证：走**产品代码**（`RemoteHostConnectionService`）而不是脚本自拼的流程。
 *
 * 与 `verify-remote-host.mjs` 的分工：
 * - 前者验证**协议与部署链路**（自己拼 pin → probe → bootstrap），已通过；
 * - 本脚本验证**服务层**——`createRemoteHostConnectionService` 能否在真实主机上完成
 *   「自己按登录 shell 找到 node → bootstrap → 交给连接管理器 → 到达 ready」。
 *
 * 为什么必须单独验一次：服务层此前只有注入端口的离线单测，没有任何生产调用方，因此
 * 「离线绿」不等于「真机能连」。它也是唯一能证明 `nodePath` 由服务自行解析（而非调用方注入）
 * 在真实主机上成立的方式。
 *
 * 安全边界与冒烟脚本一致：pin 与 store 写在**一次性临时目录**，绝不触碰 PiDeck 的 userData；
 * 退出时删除临时目录。远端会写 `~/.pideck/remote-host/`（这是被验证对象本身）。
 *
 * 用法：node scripts/verify-remote-connection-service.mjs <IPv4> <user> <ED25519-SHA256-fingerprint>
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "../tests/helpers/loadTsCommonJs.mjs";

const { createSshClientRuntime } = loadTsCommonJs("src/main/remote/SshClientRuntime.ts");
const { SshHostPinStore } = loadTsCommonJs("src/main/remote/SshHostPinStore.ts");
const { RemoteHostStore } = loadTsCommonJs("src/main/remote/RemoteHostStore.ts");
const { fingerprintSshHostKey } = loadTsCommonJs("src/main/remote/SshHostVerifier.ts");
const { createRemoteHostConnectionService } = loadTsCommonJs("src/main/remote/RemoteHostConnectionService.ts");

/** 用独立核验过的指纹建立一个已 pin 的主机，返回其 hostId。 */
async function pinHost(directory, client, host, user, fingerprint) {
	const pinStore = new SshHostPinStore(directory, { client });
	const store = await RemoteHostStore.open(directory, { pinStore });
	const profile = await store.createDraft({ label: "service-smoke", sshHost: host, user, port: 22, connectTimeoutMs: 10_000 }, 0);
	const scanned = execFileSync("/usr/bin/ssh-keyscan", ["-T", "8", "-t", "ed25519", host], { encoding: "utf8", timeout: 12_000, stdio: ["ignore", "pipe", "ignore"] });
	const lines = scanned
		.trim()
		.split("\n")
		.filter((line) => line && !line.startsWith("#"));
	if (lines.length !== 1) throw new Error("KEYSCAN_AMBIGUOUS");
	const [reportedHost, algorithm, blob] = lines[0].split(/\s+/);
	if (reportedHost !== host || algorithm !== "ssh-ed25519" || !blob) throw new Error("KEYSCAN_INVALID");
	const alias = `pideck-${profile.id}`;
	const trusted = { knownHostsBytes: Buffer.from(`${alias} ssh-ed25519 ${blob}\n`), fingerprint };
	if (fingerprintSshHostKey(trusted.knownHostsBytes, alias) !== fingerprint) throw new Error("HOST_FINGERPRINT_MISMATCH");
	const offer = await store.offerPin(profile.id, 1, 1, trusted);
	if (offer.hostKeyFingerprints.length !== 1 || offer.hostKeyFingerprints[0] !== fingerprint) throw new Error("HOST_OFFER_MISMATCH");
	await store.confirmPin({ requestId: offer.requestId, hostId: profile.id, senderId: 1, choice: "approve" }, 1);
	return { hostId: profile.id, pinStore };
}

async function main(host, user, fingerprint) {
	if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || !/^[a-z_][a-z0-9_-]*$/.test(user) || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint)) throw new Error("SMOKE_INPUT_INVALID");
	const directory = await mkdtemp(join(tmpdir(), "pideck-service-e2e-"));
	const client = createSshClientRuntime({ sshPath: "/usr/bin/ssh" });
	let pinStore;
	let service;
	try {
		const pinned = await pinHost(directory, client, host, user, fingerprint);
		pinStore = pinned.pinStore;
		console.log("PINNED_PROFILE_OK", pinned.hostId);
		// 关键：不传 nodePath。服务必须自己经登录 shell 解析出用户的 node。
		service = createRemoteHostConnectionService({ userDataDir: directory, client });
		const result = await service.connect(pinned.hostId);
		if (!result.ok) {
			console.error("SERVICE_CONNECT_FAILED", result.code);
			for (const entry of service.listDiagnostics(pinned.hostId)) console.error("DIAG", entry.code, entry.phase ?? "", entry.state ?? "");
			throw new Error(result.code);
		}
		console.log("SERVICE_CONNECT_OK", result.state);
		for (const entry of service.listDiagnostics(pinned.hostId)) console.log("DIAG", entry.code, entry.phase ?? "", entry.state ?? "");
		// 第二次连接必须复用已持有的会话（不重复发现/引导），且仍到达 ready。
		const again = await service.connect(pinned.hostId);
		console.log("SERVICE_RECONNECT", again.ok ? again.state : `failed:${again.code}`);
		if (!again.ok) throw new Error(again.code);
		await service.disconnect(pinned.hostId, "shutdown");
	} finally {
		await service?.dispose();
		pinStore?.dispose();
		await rm(directory, { recursive: true, force: true });
	}
}

const [host, user, fingerprint] = process.argv.slice(2);
if (process.argv.length !== 5) throw new Error("Usage: node scripts/verify-remote-connection-service.mjs <IPv4> <user> <independently-verified-ED25519-SHA256-fingerprint>");
try {
	await main(host, user, fingerprint);
} catch (error) {
	// 稳定码即完整消息（diagnosticCodeFromError 的判据），细节随之携带，必须显式打印。
	if (typeof error?.nodePath === "string" || typeof error?.observedVersion === "string") console.error("REJECTED_NODE", error.nodePath ?? "unknown", error.observedVersion ?? "unknown");
	throw error;
}
