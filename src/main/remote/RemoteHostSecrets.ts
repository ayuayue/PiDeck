import { createSshAskpassBridge, type SshAskpassBridge } from "./SshAskpass";
import { RemoteHostCredentialStore } from "./RemoteHostCredentialStore";
import { withClientEnv, type SshClientRuntime } from "./SshClientRuntime";

/**
 * 远端主机的内存密钥与 per-host client 视图。
 *
 * 状态只有这四张表（密码、askpass 桥、client 视图、加密存储），除 `clientFor` 外的出口都是
 * 「设置/读取/遗忘这台主机的密钥」，连接状态机不参与——所以能整组搬出服务闭包。
 */
export function createRemoteHostSecrets(options: { userDataDir: string; client: SshClientRuntime }) {
	/**
	 * In-memory password material for hosts that authenticate with one.
	 *
	 * The secret never leaves this process: it is (a) not persisted, (b) not logged, (c) not passed to `ssh` as
	 * an argument or an environment value. Each host gets its own askpass bridge and its own client view, so
	 * `SSH_ASKPASS` is only inherited by the ssh processes of the host that actually holds a secret.
	 */
	const hostPasswords = new Map<string, string>();
	const askpassBridges = new Map<string, SshAskpassBridge>();
	const hostClients = new Map<string, SshClientRuntime>();
	const credentials = new RemoteHostCredentialStore(options.userDataDir);

	/** The client every pinned invocation of this host must use. */
	function hostClient(hostId: string): SshClientRuntime {
		return hostClients.get(hostId) ?? options.client;
	}

	async function releaseHostPassword(hostId: string): Promise<void> {
		hostPasswords.delete(hostId);
		hostClients.delete(hostId);
		const bridge = askpassBridges.get(hostId);
		askpassBridges.delete(hostId);
		await bridge?.dispose();
	}

	async function applyHostPassword(hostId: string, secret: string): Promise<void> {
		if (typeof secret !== "string" || secret.length === 0 || secret.length > 4096 || secret.includes(String.fromCharCode(0))) throw new Error("SSH_PASSWORD_INVALID");
		await releaseHostPassword(hostId);
		const bridge = await createSshAskpassBridge({ secret, executable: process.execPath });
		try {
			hostClients.set(hostId, withClientEnv(options.client, bridge.env));
		} catch (error) {
			await bridge.dispose();
			throw error;
		}
		askpassBridges.set(hostId, bridge);
		hostPasswords.set(hostId, secret);
		// Persist a copy (OS-encrypted) so the next run does not ask again. A platform that cannot encrypt
		// simply keeps the secret for this session; `set` returning false is not an error.
		await credentials.set(hostId, secret).catch(() => false);
	}

	return {
		clientFor: hostClient,
		/** 该主机是否已持有可用密钥（密码主机在驱动 ssh 前必须为 true）。 */
		hasClient: (hostId: string): boolean => hostClients.has(hostId),
		/** 加密存储里已有的密钥；读不到（无存储/无法解密）时 undefined。 */
		readStored: (hostId: string): Promise<string | undefined> => credentials.get(hostId),
		apply: applyHostPassword,
		release: releaseHostPassword,
		/** 服务关闭时释放全部 askpass 桥：密钥不跨进程存活。 */
		async releaseAll(): Promise<void> {
			await Promise.all([...askpassBridges.keys()].map((hostId) => releaseHostPassword(hostId)));
		},
		/** 编辑表单的「保存」：只换密钥，不开连接。是否同时落盘由调用方据 `persisted` 声明。 */
		async setHostSecret(hostId: string, secret: string): Promise<{ persisted: boolean }> {
			await applyHostPassword(hostId, secret);
			return { persisted: await credentials.available() };
		},
		/** 加密存储里的副本，供编辑表单回显；不进日志、不进 host store 明文。 */
		async readStoredSecret(hostId: string): Promise<string | undefined> {
			return credentials.get(hostId);
		},
		/** 删除主机时连密钥一起丢；普通断开保留给下一次连接。 */
		async forgetHost(hostId: string): Promise<void> {
			await releaseHostPassword(hostId);
			await credentials.delete(hostId).catch(() => undefined);
		},
	};
}
