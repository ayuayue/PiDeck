import { ipcMain, BrowserWindow, dialog } from "electron";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ipcChannels } from "../../shared/ipc";
import type { RemoteHostEditDraftResult, RemoteHostPickIdentityFileResult, RemoteHostUpdateResult } from "../../shared/types/remoteHost";
import type { RemoteHostConnectionService } from "../remote/RemoteHostConnectionService";
import { normalizeRemoteHostIdentityFile, REMOTE_HOST_IDENTITY_FILE_INVALID } from "../remote/RemoteHostIdentityFile";
import type { RemoteHostStore } from "../remote/RemoteHostStore";
import { HOST_ID, HOST_NAME, MAX_LABEL, SAFE_USER, senderIdOf } from "./remoteHostInputValidation";

/**
 * 主机编辑域：编辑已添加的主机 + 读取编辑表单初值。
 *
 * 从 `remoteHostIpc` 拆出来的理由只有一个：那个文件已经接近体量红线，而这两个 handler 与
 * 连接/修复/诊断无关。依赖全部由调用方注入，两个模块共用同一份 store 与 service 实例。
 */
export function registerRemoteHostEditIpc(input: { enabled: boolean; openStores: () => Promise<{ store: RemoteHostStore; pinStore: unknown }>; resolveService: () => Promise<{ service: RemoteHostConnectionService } | { code: string }> }): void {
	/** 编辑补丁的边界校验：只接受已知字段，逐项按新增时的同一套规则检查。 */
	type UpdateInput = { hostId: string; patch: { label?: string; sshHost?: string; user?: string; port?: number; identityFile?: string; authMethod?: "password" }; secret?: string };
	function readUpdateInput(value: unknown): { ok: true; input: UpdateInput } | { ok: false; code: string } {
		if (typeof value !== "object" || value === null) return { ok: false, code: "REMOTE_HOST_EDIT_INVALID" };
		const raw = value as Record<string, unknown>;
		const hostId = typeof raw.hostId === "string" ? raw.hostId : "";
		if (!HOST_ID.test(hostId)) return { ok: false, code: "REMOTE_HOST_EDIT_INVALID" };
		const patch = typeof raw.patch === "object" && raw.patch !== null ? (raw.patch as Record<string, unknown>) : {};
		const out: UpdateInput["patch"] = {};
		if (Object.hasOwn(patch, "label")) {
			const label = typeof patch.label === "string" ? patch.label.trim() : "";
			if (label.length === 0 || label.length > MAX_LABEL || /[\x00-\x1f\x7f]/.test(label)) return { ok: false, code: "REMOTE_HOST_EDIT_INVALID" };
			out.label = label;
		}
		if (Object.hasOwn(patch, "hostName")) {
			const hostName = typeof patch.hostName === "string" ? patch.hostName.trim() : "";
			if (hostName.length === 0 || hostName.length > 1024 || !HOST_NAME.test(hostName)) return { ok: false, code: "REMOTE_HOST_EDIT_INVALID" };
			out.sshHost = hostName;
		}
		if (Object.hasOwn(patch, "user")) {
			const user = typeof patch.user === "string" ? patch.user.trim() : "";
			if (user.length > 0 && (user.length > 256 || !SAFE_USER.test(user))) return { ok: false, code: "REMOTE_HOST_EDIT_INVALID" };
			// 空串表示「回到默认用户」，所以这里显式写入 undefined 而不是跳过。
			out.user = user.length > 0 ? user : undefined;
		}
		if (Object.hasOwn(patch, "port")) {
			const rawPort = patch.port;
			if (rawPort === undefined || rawPort === null || rawPort === "") out.port = undefined;
			else {
				const parsed = typeof rawPort === "number" ? rawPort : Number(rawPort);
				if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) return { ok: false, code: "REMOTE_HOST_EDIT_INVALID" };
				out.port = parsed;
			}
		}
		if (Object.hasOwn(patch, "identityFile")) {
			const rawIdentity = typeof patch.identityFile === "string" && patch.identityFile.trim().length > 0 ? patch.identityFile : undefined;
			if (rawIdentity === undefined) out.identityFile = undefined;
			else {
				const identityFile = normalizeRemoteHostIdentityFile(rawIdentity);
				if (identityFile === undefined) return { ok: false, code: REMOTE_HOST_IDENTITY_FILE_INVALID };
				out.identityFile = identityFile;
			}
		}
		if (Object.hasOwn(patch, "authMethod")) out.authMethod = patch.authMethod === "password" ? "password" : undefined;
		const secret = typeof raw.secret === "string" && raw.secret.length > 0 ? raw.secret : undefined;
		if (secret !== undefined && (secret.length > 4096 || secret.includes(String.fromCharCode(0)))) return { ok: false, code: "REMOTE_HOST_EDIT_INVALID" };
		return { ok: true, input: { hostId, patch: out, ...(secret === undefined ? {} : { secret }) } };
	}

	/**
	 * 原生文件选择器（挑私钥）。只有本机绝对路径会回到渲染层：这里不读文件、不涉及口令，
	 * 取消就是普通的 `ok: false`。
	 *
	 * 放在编辑域而不是 `remoteHostIpc`：它是「填/改私钥」这条路的一部分，与连接开关、修复、诊断无关；
	 * 而 `remoteHostIpc` 有体量红线（<600 行），两个域的 handler 不该挤在同一个文件里。
	 */
	ipcMain.handle(ipcChannels.remoteHostPickIdentityFile, async (event): Promise<RemoteHostPickIdentityFileResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		const window = BrowserWindow.fromWebContents(event.sender);
		const options = { title: "SSH 私钥", defaultPath: join(homedir(), ".ssh"), properties: ["openFile" as const] };
		const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
		const picked = result.filePaths[0];
		if (result.canceled || picked === undefined) return { ok: false, code: "REMOTE_HOST_IDENTITY_FILE_CANCELLED" };
		// store 只接受本机绝对路径；边界处就先拒掉别的形状。
		if (!isAbsolute(picked) || /[\x00-\x1f\x7f]/.test(picked)) return { ok: false, code: "REMOTE_HOST_IDENTITY_FILE_INVALID" };
		return { ok: true, path: picked };
	});

	/**
	 * 编辑一台已添加的主机：同一个 hostId 原位更新，项目和会话引用保持有效。
	 *
	 * 端点（host/user/port/proxyJump）变化时旧的 pin 与 verifiedEndpoint 描述的是另一台机器，store 会在
	 * 同一次写入里清掉它们；这里随后对新地址重跑一次探针并 pin，语义与首次添加完全一致（TOFU + 确认）。
	 * 口令只在显式提交时覆盖，留空表示沿用已保存的值。
	 */
	ipcMain.handle(ipcChannels.remoteHostUpdate, async (event, value: unknown): Promise<RemoteHostUpdateResult> => {
		if (!input.enabled) return { ok: false, hostId: "", code: "REMOTE_FEATURE_DISABLED" };
		const parsed = readUpdateInput(value);
		if (!parsed.ok) return { ok: false, hostId: "", code: parsed.code };
		const { hostId, patch, secret } = parsed.input;
		const senderId = senderIdOf(event.sender);
		if (senderId === undefined) return { ok: false, hostId, code: "REMOTE_HOST_EDIT_INVALID" };
		let store: Awaited<ReturnType<typeof input.openStores>>["store"];
		try {
			({ store } = await input.openStores());
		} catch {
			return { ok: false, hostId, code: "REMOTE_HOST_STORE_UNAVAILABLE" };
		}
		let updated: Awaited<ReturnType<typeof store.updateProfile>>;
		try {
			updated = await store.updateProfile(hostId, patch, store.getSnapshot().revision);
		} catch (error) {
			const code = typeof error === "object" && error !== null && "message" in error ? (error as { message?: unknown }).message : undefined;
			return { ok: false, hostId, code: typeof code === "string" && /^REMOTE_HOST_[A-Z0-9_]{1,64}$/.test(code) ? code : "REMOTE_HOST_EDIT_INVALID" };
		}
		// 未验证的连接（上次握手失败被保留下来的草稿）同样要重跑一次探针：
		// 用户点编辑改的就是那把钥/那个口令，改完必须能真正变成可连接，而不是停在一行「未验证」。
		if (updated.endpointChanged || updated.profile.verifiedEndpoint === undefined) {
			try {
				const offer = await store.offerPin(hostId, senderId, store.getSnapshot().revision);
				await store.confirmPin({ requestId: offer.requestId, hostId, senderId, choice: "approve" }, store.getSnapshot().revision);
			} catch (error) {
				// The edit itself is already committed; report the stable verification code so the UI can show
				// "saved but needs re-verification" instead of pretending the host is usable.
				const code = typeof error === "object" && error !== null && "message" in error ? (error as { message?: unknown }).message : undefined;
				return { ok: false, hostId, saved: true, code: typeof code === "string" && /^SSH_[A-Z0-9_]{1,64}$/.test(code) ? code : "REMOTE_HOST_VERIFY_FAILED" };
			}
		}
		if (secret !== undefined) {
			const resolved = await input.resolveService();
			if (!("service" in resolved)) return { ok: false, hostId, code: resolved.code };
			try {
				await resolved.service.setHostSecret(hostId, secret);
			} catch {
				return { ok: false, hostId, code: "SSH_PASSWORD_INVALID" };
			}
		}
		return { ok: true, hostId, endpointChanged: updated.endpointChanged, verified: store.getSnapshot().profiles.some((profile: { id: string; verifiedEndpoint?: unknown }) => profile.id === hostId && profile.verifiedEndpoint !== undefined) };
	});

	/**
	 * The edit form's starting values: the profile's endpoint fields plus the stored secret.
	 *
	 * This is the one place a plaintext secret is handed to the renderer. It is scoped to an explicit
	 * "open the editor" action, and the value never enters the host store, a log line or a process argv.
	 */
	ipcMain.handle(ipcChannels.remoteHostEditDraft, async (_event, rawHostId: unknown): Promise<RemoteHostEditDraftResult> => {
		const hostId = typeof rawHostId === "string" ? rawHostId : "";
		if (!HOST_ID.test(hostId)) return { ok: false, hostId, code: "REMOTE_HOST_EDIT_INVALID" };
		if (!input.enabled) return { ok: false, hostId, code: "REMOTE_FEATURE_DISABLED" };
		let store: Awaited<ReturnType<typeof input.openStores>>["store"];
		try {
			({ store } = await input.openStores());
		} catch {
			return { ok: false, hostId, code: "REMOTE_HOST_STORE_UNAVAILABLE" };
		}
		const profile = store.getSnapshot().profiles.find((item: { id: string }) => item.id === hostId);
		if (profile === undefined) return { ok: false, hostId, code: "REMOTE_HOST_NOT_FOUND" };
		const resolved = await input.resolveService();
		if (!("service" in resolved)) return { ok: false, hostId, code: resolved.code };
		const secret = await resolved.service.readStoredSecret(hostId).catch(() => undefined);
		return {
			ok: true,
			hostId,
			draft: {
				label: profile.label,
				hostName: profile.sshHost,
				...(profile.user === undefined ? {} : { user: profile.user }),
				...(profile.port === undefined ? {} : { port: profile.port }),
				...(profile.identityFile === undefined ? {} : { identityFile: profile.identityFile }),
				...(profile.authMethod === undefined ? {} : { authMethod: profile.authMethod }),
				...(profile.remotePiCommand === undefined ? {} : { remotePiCommand: profile.remotePiCommand }),
			},
			secret: secret ?? null,
		};
	});
}
