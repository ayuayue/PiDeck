import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Check, ChevronDown, Circle, CircleCheck, Copy, Eye, EyeOff, FileCode, FolderOpen, LoaderCircle, Search, Server, TerminalSquare, TriangleAlert, X } from "lucide-react";
import { detectRendererPlatform } from "../../../lib/detectRendererPlatform";
import { desktopApi } from "../../../desktopApi";
import { t, type TranslationKey } from "../../../i18n";
import { remoteHostFailureReason, remotePiProbeReason } from "../../../utils/remoteHostFailureCopy";
import { cn } from "../../../lib/utils";
import { Button } from "../../ui-shadcn/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui-shadcn/dialog";
import { Input } from "../../ui-shadcn/input";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "../../ui-shadcn/popover";
import { Label } from "../../ui-shadcn/label";
import type { RemoteHostAddInput, RemoteHostConfigCandidate } from "../../../../../shared/types/remoteHost";
import type { WslHostListItem } from "../../../../../shared/types/wslHost";

/** 跳过原因是稳定枚举；这里显式映射而不是拼接 key，否则远端回来的任意字符串会拼出不存在的 key。 */
function skipReasonLabel(reason: string): string {
	switch (reason) {
		case "wildcard":
			return t("settings.connections.add.skipReason.wildcard");
		case "invalid":
			return t("settings.connections.add.skipReason.invalid");
		case "unsupported-directive":
			return t("settings.connections.add.skipReason.unsupported-directive");
		default:
			return reason;
	}
}

type AuthMode = "agent" | "key" | "password";
type ConnectionKind = "ssh" | "wsl";

/** 内联环境检测的四步（就是「保存并检测」真正做的事，不再是弹窗里的装饰阶段）。 */
type SetupStepKey = "test" | "save" | "connect" | "pi";
type SetupStepStatus = "pending" | "active" | "done" | "failed";
const SETUP_STEPS: readonly SetupStepKey[] = ["test", "save", "connect", "pi"];
const EMPTY_STEPS: Record<SetupStepKey, SetupStepStatus> = { test: "pending", save: "pending", connect: "pending", pi: "pending" };
const SETUP_STEP_LABEL: Record<SetupStepKey, TranslationKey> = {
	test: "settings.connections.add.step.test",
	save: "settings.connections.add.step.save",
	connect: "settings.connections.add.step.connect",
	pi: "settings.connections.add.step.pi",
};
const SETUP_STEP_ICON: Record<SetupStepStatus, typeof Circle> = { pending: Circle, active: LoaderCircle, done: Check, failed: X };
const SETUP_STEP_TONE: Record<SetupStepStatus, string> = { pending: "text-muted-foreground/50", active: "text-warning", done: "text-success", failed: "text-destructive" };
/** 远端 pi 探测：成功只回版本/路径，失败只回稳定码（与主进程的脱敏结果同形）。 */
type PiProbeOutcome = { state: "found"; version: string; piPath: string; warning?: string } | { state: "failed"; code: string };
/** 远端安装 pi 的命令：只给用户复制，不在远端替用户执行安装（远端副作用必须由用户自己按）。 */
const PI_INSTALL_COMMAND = "npm i -g @earendil-works/pi-coding-agent";

/** 表单初值：端口默认 22，认证默认交给 ssh-agent / 默认密钥（与 Transport 的 BatchMode 一致）。 */
const EMPTY_FORM = { label: "", hostName: "", port: "22", user: "", auth: "agent" as AuthMode, identityFile: "", password: "", passphrase: "" };
type FormState = typeof EMPTY_FORM;

/**
 * 「新建连接」面板。
 *
 * 结构照 ZCode 的远程配置面板：**类型切换 + 实时目标预览 + 表单 + 从 SSH config 导入**。
 * SSH 与 WSL 都在这里创建：SSH 建远端主机（pin/TOFU），WSL 建本机档案（distro/user）。
 * 两者信任模型不同，但入口与表单骨架共用；Docker 没有后端，保持 disabled 并说明。
 *
 * 认证提供「自动（ssh-agent/默认密钥）」「指定私钥」与「密码」：密码模式由主进程用一次性
 * askpass 桥回答 OpenSSH 的 password 提问，口令只在本次运行的内存里，既不落盘也不进 argv/env。
 *
 * 远程环境的检测**全部在这张表单里完成**（不再开独立进度弹窗）：点「保存并检测」后依次做
 * 握手测试 → 保存主机 → 建立会话 → 探测远端 pi，四步状态内联显示。pi 探测要在远端执行命令，
 * 而执行命令必须有一台已落库、已 pin 的主机，所以「测试通过就直接检测」意味着测试一过就保存；
 * 用户没点「完成」就关闭时由 close() 移除这条刚建的记录（取消 = 什么都没留下）。
 *
 * 远端没有 pi 时给安装命令（可复制）与手填绝对路径两条出路；手填路径写进主机档案，
 * 之后每次会话都用它，不再靠登录 shell 的 PATH 猜。
 */
/** 编辑一台已添加主机时的初值：字段来自 store，口令来自系统加密存储（可能为空）。 */
export type AddHostEditSeed = { hostId: string; label: string; hostName: string; user?: string; port?: number; identityFile?: string; authMethod?: "password"; secret?: string; remotePiCommand?: string };

export function AddHostDialog(props: {
	/** 关闭对话框：宿主只负责卸载，记录的新增/移除由这里自己完成。 */
	onClose: () => void;
	/** 主机档案变了（新增/编辑/移除）：宿主据此刷新列表。 */
	onChanged?: () => void;
	onWslSubmitted?: (host: WslHostListItem) => void;
	initialKind?: ConnectionKind;
	edit?: AddHostEditSeed;
}) {
	const editing = props.edit;
	const [kind, setKind] = useState<ConnectionKind>(props.initialKind ?? "ssh");
	const [candidates, setCandidates] = useState<RemoteHostConfigCandidate[]>([]);
	const [skipped, setSkipped] = useState<{ alias: string; reason: string }[]>([]);
	const [identityFiles, setIdentityFiles] = useState<string[]>([]);
	const [currentUser, setCurrentUser] = useState("");
	const [scanNote, setScanNote] = useState<string | null>(null);
	const [importing, setImporting] = useState(false);
	/** 私钥候选下拉：点输入框或右侧箭头打开，选中即填入。 */
	const [identityOpen, setIdentityOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [form, setForm] = useState<FormState>(() => {
		if (editing === undefined) return EMPTY_FORM;
		// 口令按认证方式回到它原本的输入框：密码模式是登录口令，私钥模式是私钥口令。
		const secret = editing.secret ?? "";
		return {
			label: editing.label,
			hostName: editing.hostName,
			port: editing.port === undefined ? "22" : String(editing.port),
			user: editing.user ?? "",
			auth: editing.authMethod === "password" ? "password" : editing.identityFile === undefined ? "agent" : "key",
			identityFile: editing.identityFile ?? "",
			password: editing.authMethod === "password" ? secret : "",
			passphrase: editing.authMethod === "password" ? "" : secret,
		};
	});
	const [showSecret, setShowSecret] = useState(false);
	// 密码与密钥口令是两个独立字段：共用一个可见态会让「看密码」顺手把口令也揭开。
	const [showPassword, setShowPassword] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// WSL 档案：只保存显示名/发行版/Linux 用户，目录在「添加项目」时选。
	const [wsl, setWsl] = useState({ label: "", distro: "", user: "" });
	const [wslBusy, setWslBusy] = useState(false);
	// 「测试连接」：只握手不落库。结果分成功（带主机密钥指纹）与失败（已翻译成行动建议）。
	const [testing, setTesting] = useState(false);
	const [testResult, setTestResult] = useState<{ ok: true; fingerprint: string } | { ok: false; reason: string } | null>(null);
	const [wslError, setWslError] = useState<string | null>(null);
	// WSL 发行版自动检测：切到 WSL 页即拉一次本机发行版列表，列表可选、输入框仍可手填（设置页同通道）。
	const [wslDistros, setWslDistros] = useState<string[]>([]);
	const [wslDistrosLoading, setWslDistrosLoading] = useState(false);
	const [wslDistrosAttempted, setWslDistrosAttempted] = useState(false);
	// 内联环境检测：四步状态 + pi 结果。所有结论只来自主进程的稳定码。
	const [steps, setSteps] = useState<Record<SetupStepKey, SetupStepStatus>>(EMPTY_STEPS);
	const [piOutcome, setPiOutcome] = useState<PiProbeOutcome | null>(null);
	// 手填的 pi 路径：编辑时回填已保存值，探测成功后回填探测到的路径（用户可以直接改）。
	const [piPathDraft, setPiPathDraft] = useState(editing?.remotePiCommand ?? "");
	const [piPathError, setPiPathError] = useState<string | null>(null);
	const [savingPiPath, setSavingPiPath] = useState(false);
	const [copiedInstall, setCopiedInstall] = useState(false);
	/** 本对话框对应/新建的主机 id（重试和手填路径都用它，不重复 add）。 */
	const hostIdRef = useRef<string | null>(editing?.hostId ?? null);
	/** 对话框关闭后仍可能在飞的请求不得再回写状态或改动记录。 */
	const aliveRef = useRef(true);
	useEffect(
		() => () => {
			aliveRef.current = false;
		},
		[],
	);
	const setupRunning = SETUP_STEPS.some((key) => steps[key] === "active");
	const setupStarted = SETUP_STEPS.some((key) => steps[key] !== "pending");
	const setupSettled = setupStarted && !setupRunning;
	/** 已经保存过的连接不再允许改字段：改完就不再是这条记录了（要改请取消后重建，或在列表里编辑）。 */
	const formLocked = setupRunning || steps.save === "done";
	const piFound = piOutcome?.state === "found";

	useEffect(() => {
		let active = true;
		void (async () => {
			const result = await desktopApi.remoteHosts.scanConfig();
			if (!active) return;
			if (!result.ok) {
				// 功能被关闭时直接说明；config 读不到时表单仍然可用，不把用户堵在错误页。
				setScanNote(result.code === "REMOTE_FEATURE_DISABLED" ? t("settings.connections.add.disabled") : t("settings.connections.add.scanFailed"));
				return;
			}
			setCandidates(result.candidates);
			setSkipped(result.skipped);
			setIdentityFiles(result.identityFiles);
			setCurrentUser(result.user);
		})();
		return () => {
			active = false;
		};
	}, []);

	/** 表单唯一的校验点（与 ZCode 的 collectRemoteFormFieldErrors 同一思路：先报第一个错，不发请求）。 */
	const validate = useCallback((): RemoteHostAddInput | string => {
		const label = form.label.trim();
		const hostName = form.hostName.trim();
		if (label.length === 0 || hostName.length === 0) return t("settings.connections.add.required");
		const rawPort = form.port.trim();
		const port = rawPort.length === 0 ? undefined : Number(rawPort);
		if (port !== undefined && (!Number.isSafeInteger(port) || port < 1 || port > 65535)) return t("settings.connections.add.badPort");
		const identityFile = form.auth === "key" ? form.identityFile.trim() : "";
		if (form.auth === "key" && identityFile.length === 0) return t("settings.connections.add.keyRequired");
		// The password is only carried by this request: it is never persisted, and main keeps it in memory
		// for the lifetime of the connection only.
		const password = form.auth === "password" ? form.password : "";
		// 编辑时留空表示「沿用已保存的口令」，只有新建才要求当场填写。
		if (form.auth === "password" && password.length === 0 && editing === undefined) return t("settings.connections.add.passwordRequired");
		const user = form.user.trim();
		return { label, hostName, ...(port === undefined ? {} : { port }), ...(user.length > 0 ? { user } : {}), ...(identityFile.length > 0 ? { identityFile } : {}), ...(form.auth === "password" ? { authMethod: "password" as const } : {}) };
	}, [form]);

	/** 当前表单值对应的口令：密码模式是登录口令，私钥模式是私钥口令（只随本次请求进 main 内存）。 */
	const currentSecret = useCallback(() => (form.auth === "password" ? form.password : form.auth === "key" ? form.passphrase : ""), [form]);

	/** 把一次探测结果落到状态：成功/失败都只认主进程的脱敏结果。 */
	const applyPiOutcome = useCallback((result: { ok: true; piPath: string; version: string; warning?: string } | { ok: false; code: string }) => {
		if (result.ok) {
			setPiOutcome({ state: "found", version: result.version, piPath: result.piPath, ...(result.warning === undefined ? {} : { warning: result.warning }) });
			setPiPathDraft(result.piPath);
			setSteps((current) => ({ ...current, pi: "done" }));
		} else {
			setPiOutcome({ state: "failed", code: result.code });
			setSteps((current) => ({ ...current, pi: "failed" }));
		}
	}, []);

	/** 只探测 pi（会话已经在时成本是两次远端往返）。 */
	const probePi = useCallback(
		async (hostId: string) => {
			setSteps((current) => ({ ...current, pi: "active" }));
			const result = await desktopApi.remoteHosts.probePi(hostId);
			if (!aliveRef.current) return;
			applyPiOutcome(result);
		},
		[applyPiOutcome],
	);

	/**
	 * 一次完整的连接准备：握手测试 → 保存主机 → 建立会话 → 探测远端 pi。
	 *
	 * `reconnect` 跳过测试与保存，只重做「建立会话 + 探测」：连接抖动失败后重试不该再写一次库。
	 * 所有中断点都用稳定码回到表单，不抛异常，也不关框——失败要停在让它失败的那一步。
	 */
	const runSetup = useCallback(
		async (mode: "full" | "reconnect") => {
			if (setupRunning) return;
			const input = validate();
			if (typeof input === "string") {
				setError(input);
				return;
			}
			setError(null);
			setTestResult(null);
			setPiPathError(null);
			if (mode === "full") setPiOutcome(null);
			// 密码认证不能用探针预检（探针固定 BatchMode=yes，没有非交互凭据），直接把第一步记完成：
			// 密码对不对由紧接着的 connect 验证，不能因此把密码主机拦在添加流程外。
			const skipTest = form.auth === "password";
			setSteps((current) => (mode === "full" ? { test: skipTest ? "done" : "active", save: skipTest ? "active" : "pending", connect: "pending", pi: "pending" } : { ...current, connect: "active", pi: "pending" }));
			const secret = currentSecret();
			if (mode === "full") {
				const tested = skipTest ? null : await desktopApi.remoteHosts.test(input);
				if (!aliveRef.current) return;
				if (tested !== null && !tested.ok) {
					setSteps((current) => ({ ...current, test: "failed" }));
					// 失败也要把草稿留下（用户反馈：失败了就丢，下次还得把主机名/用户/私钥全填一遍）。
					// add 会再握手一次，失败时返回 saved + hostId；拿到 id 后就是一条「未验证连接」，
					// 用户可以关掉对话框，在列表里点编辑改错的那一项再重试。
					const persisted = await desktopApi.remoteHosts.add(input);
					if (!aliveRef.current) return;
					if (!persisted.ok && persisted.saved === true && persisted.hostId !== undefined) {
						hostIdRef.current = persisted.hostId;
						setError(t("settings.connections.add.savedUnverified", { host: input.label, reason: remoteHostFailureReason(tested.code) }));
					} else {
						setError(t("settings.connections.add.testFailed", { reason: remoteHostFailureReason(tested.code) }));
					}
					return;
				}
				if (tested !== null) setTestResult({ ok: true, fingerprint: tested.fingerprint });
				setSteps((current) => ({ ...current, test: "done", save: "active" }));
				// 重试时不能重复 add：已经有一条记录（新建成功或握手失败留下来的草稿）就原地修改。
				const existingHostId = hostIdRef.current;
				if (existingHostId !== null) {
					const updated = await desktopApi.remoteHosts.update({
						hostId: existingHostId,
						patch: {
							label: input.label,
							hostName: input.hostName,
							user: input.user ?? "",
							port: typeof input.port === "number" ? input.port : undefined,
							identityFile: input.identityFile ?? "",
							// 显式写入 undefined：从密码切回密钥/agent 时必须清掉旧的 authMethod。
							authMethod: input.authMethod === "password" ? ("password" as const) : undefined,
						},
						// 空口令 = 不覆盖；用户显式输入了才更新存储。
						...(secret.length > 0 ? { secret } : {}),
					});
					if (!aliveRef.current) return;
					if (!updated.ok) {
						setSteps((current) => ({ ...current, save: "failed" }));
						setError(updated.saved === true ? t("settings.connections.edit.savedUnverifiedReason", { reason: remoteHostFailureReason(updated.code) }) : remoteHostFailureReason(updated.code));
						return;
					}
					hostIdRef.current = existingHostId;
					props.onChanged?.();
				} else {
					const added = await desktopApi.remoteHosts.add(input);
					// 对话框已经关了：记录照样保留（用户可在列表里查看/编辑/删除），只是不再回写界面。
					if (!aliveRef.current) return;
					if (!added.ok) {
						// 草稿已保存：记下 id，重试时原地 update（否则每失败一次就多一条同名记录）。
						if (added.saved === true && added.hostId !== undefined) hostIdRef.current = added.hostId;
						setSteps((current) => ({ ...current, save: "failed" }));
						setError(added.saved === true ? t("settings.connections.add.savedUnverified", { host: input.label, reason: remoteHostFailureReason(added.code) }) : remoteHostFailureReason(added.code));
						return;
					}
					hostIdRef.current = added.hostId;
					props.onChanged?.();
				}
				setSteps((current) => ({ ...current, save: "done", connect: "active" }));
			}
			const hostId = hostIdRef.current;
			if (hostId === null) return;
			const connected = await desktopApi.remoteHosts.connect(hostId, secret.length > 0 ? secret : undefined);
			if (!aliveRef.current) return;
			if (!connected.ok) {
				setSteps((current) => ({ ...current, connect: "failed" }));
				setError(t("settings.connections.add.connectFailed", { reason: remoteHostFailureReason(connected.code) }));
				return;
			}
			setSteps((current) => ({ ...current, connect: "done", pi: "active" }));
			await probePi(hostId);
		},
		[currentSecret, form.auth, probePi, props, setupRunning, validate],
	);

	/** 手填路径：写进主机档案并立刻重探（null/空串 = 回到自动探测）。 */
	const savePiPath = useCallback(async () => {
		const hostId = hostIdRef.current;
		if (hostId === null) return;
		const value = piPathDraft.trim();
		// 与主进程同一份形状（绝对路径 + 限定字符集）：不合法就不发请求，错误定位在输入框。
		if (value.length > 0 && (!value.startsWith("/") || value.endsWith("/") || !/^\/[A-Za-z0-9._/-]+$/.test(value))) {
			setPiPathError(t("settings.connections.add.piPathInvalid"));
			return;
		}
		setPiPathError(null);
		setSavingPiPath(true);
		try {
			const result = await desktopApi.remoteHosts.setPiPath(hostId, value.length === 0 ? null : value);
			if (!aliveRef.current) return;
			applyPiOutcome(result);
		} finally {
			setSavingPiPath(false);
		}
	}, [applyPiOutcome, piPathDraft]);

	/** 重试：还没建会话就从连接开始，否则整条重跑（不重复写库）。 */
	const retrySetup = useCallback(() => {
		const hostId = hostIdRef.current;
		if (hostId !== null && steps.save === "done") void runSetup("reconnect");
		else void runSetup("full");
	}, [runSetup, steps.save]);

	const copyInstallCommand = useCallback(async () => {
		try {
			await navigator.clipboard.writeText(PI_INSTALL_COMMAND);
			setCopiedInstall(true);
			setTimeout(() => setCopiedInstall(false), 2000);
		} catch {
			// 剪贴板不可用时静默失败：命令本身就在旁边，可以手选复制。
		}
	}, []);

	/**
	 * 关闭对话框。**不再删除**本次新建的记录（2026-11 用户反馈）：握手失败时草稿已经保存，
	 * 关掉对话框就把它删了等于「下次还得重填」。留着的行在列表里显示「未验证」，连不上也删得掉，
	 * 点编辑就能接着改——记录的去留交给列表里的删除按钮。
	 */
	const close = useCallback(() => {
		aliveRef.current = false;
		props.onChanged?.();
		props.onClose();
	}, [props]);

	/** 点「完成」：刷新列表并关闭（记录早已保存，这里只是收尾）。 */
	const complete = useCallback(() => {
		props.onChanged?.();
		props.onClose();
	}, [props]);

	// 表单里的连接参数一变，上一次「测试连接」的结论就作废：留着旧的「连接成功」会让人以为新配置也通了。
	useEffect(() => {
		setTestResult(null);
	}, [form.hostName, form.port, form.user, form.identityFile, form.auth, form.passphrase]);

	/** 用当前表单值做一次真实握手（不保存、不写 pin），把失败定位到字段而不是保存后的连接进度框。 */
	const testConnection = useCallback(async () => {
		const input = validate();
		if (typeof input === "string") {
			setError(input);
			return;
		}
		setError(null);
		setTestResult(null);
		setTesting(true);
		try {
			const result = await desktopApi.remoteHosts.test(input);
			setTestResult(result.ok ? { ok: true, fingerprint: result.fingerprint } : { ok: false, reason: remoteHostFailureReason(result.code) });
		} finally {
			setTesting(false);
		}
	}, [validate]);

	/** 选中一条 config 候选 = 把字段填进表单，仍然由用户确认后再添加（不隐式提交）。 */
	const applyCandidate = useCallback((candidate: RemoteHostConfigCandidate) => {
		setForm({
			label: candidate.alias,
			hostName: candidate.hostName,
			port: candidate.port === null ? "22" : String(candidate.port),
			user: candidate.user,
			auth: candidate.identityFile === null ? "agent" : "key",
			identityFile: candidate.identityFile ?? "",
			password: "",
			passphrase: "",
		});
		setError(null);
		setImporting(false);
		setQuery("");
	}, []);

	// 从 SSH config 里已经出现的私钥路径作为候选；用户不必再去文件管理器里翻一遍。
	// 两个来源合并：config 里显式写过的私钥优先，其次是 ~/.ssh 里按命名约定扫描到的文件。
	const identitySuggestions = useMemo(() => {
		const fromConfig = candidates.map((candidate) => candidate.identityFile).filter((path): path is string => typeof path === "string" && path.length > 0);
		return [...new Set([...fromConfig, ...identityFiles])].slice(0, 8);
	}, [candidates, identityFiles]);

	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (needle.length === 0) return candidates;
		return candidates.filter((candidate) => `${candidate.alias} ${candidate.hostName} ${candidate.user}`.toLowerCase().includes(needle));
	}, [candidates, query]);

	const previewHost = form.hostName.trim();
	const previewUser = form.user.trim();
	const previewPort = form.port.trim() || "22";
	const preview = kind === "wsl" ? t("settings.connections.add.wsl.preview") : previewHost.length === 0 ? t("settings.connections.add.previewPlaceholder") : `${previewUser.length > 0 ? `${previewUser}@` : ""}${previewHost}:${previewPort}`;
	// WSL 只有 Windows 宿主才有：其它平台不渲染这一页（与 ZCode buildAvailableKinds 同判据）。
	const wslSupported = detectRendererPlatform() === "win32";

	// 切到 WSL 页自动检测一次本机发行版（仅 Windows）：检出且输入框为空时预填第一个，检测不到也不拦手填。
	useEffect(() => {
		if (kind !== "wsl" || !wslSupported || wslDistrosAttempted || wslDistrosLoading) return;
		let cancelled = false;
		setWslDistrosLoading(true);
		void desktopApi.wsl
			.listDistros()
			.then((list) => {
				if (cancelled) return;
				setWslDistros(list);
				if (list.length > 0) setWsl((current) => (current.distro.trim().length === 0 ? { ...current, distro: list[0] } : current));
			})
			.catch(() => {
				if (!cancelled) setWslDistros([]);
			})
			.finally(() => {
				if (cancelled) return;
				setWslDistrosAttempted(true);
				setWslDistrosLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [kind, wslSupported, wslDistrosAttempted, wslDistrosLoading]);

	/** 创建 WSL 档案：主进程只写本机清单，不启动 wsl.exe；引用保护在移除时生效。 */
	const submitWsl = useCallback(async () => {
		const label = wsl.label.trim();
		const distro = wsl.distro.trim();
		const user = wsl.user.trim();
		if (label.length === 0 || !/^[A-Za-z0-9._-]{1,64}$/u.test(distro) || !/^[A-Za-z_][A-Za-z0-9._-]{0,31}$/u.test(user)) {
			setWslError(t("settings.connections.add.wsl.invalid"));
			return;
		}
		setWslBusy(true);
		setWslError(null);
		try {
			const result = await desktopApi.remoteHosts.addWslHost({ label, distro, user });
			if (result.ok) props.onWslSubmitted?.(result.host);
			else setWslError(t("settings.connections.add.wsl.failed", { code: result.code }));
		} finally {
			setWslBusy(false);
		}
	}, [props, wsl]);

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) close();
			}}
		>
			{/* scroll-ok: bounded 表单对话框整页滚动，字段数量固定且由 max-h 收束 */}
			<DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto p-6 sm:max-w-3xl sm:p-8">
				<DialogHeader className="pr-8">
					<DialogTitle className="text-lg font-medium">{editing === undefined ? t("settings.connections.add.title") : t("settings.connections.edit.title")}</DialogTitle>
					<DialogDescription className={cn("break-all font-mono text-label", kind === "ssh" && previewHost.length > 0 ? "text-foreground" : "text-muted-foreground")}>{preview}</DialogDescription>
				</DialogHeader>

				{/* 类型切换：SSH 建远端主机，WSL 建本机档案；Docker 还没有后端。 */}
				<div className={cn("flex flex-wrap items-center justify-between gap-2", editing !== undefined && "hidden")}>
					<div role="group" aria-label={t("settings.connections.add.typeLabel")} className="flex w-fit overflow-hidden rounded-lg border border-input">
						<button type="button" aria-pressed={kind === "ssh"} className={cn("inline-flex min-h-8 items-center gap-1.5 px-3 text-body", kind === "ssh" ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-bg-hover")} onClick={() => setKind("ssh")}>
							<Server className="size-3.5" aria-hidden="true" />
							{t("settings.connections.add.kind.ssh")}
						</button>
						{wslSupported ? (
							<button type="button" aria-pressed={kind === "wsl"} className={cn("inline-flex min-h-8 items-center gap-1.5 border-l border-input px-3 text-body", kind === "wsl" ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-bg-hover")} onClick={() => setKind("wsl")}>
								<TerminalSquare className="size-3.5" aria-hidden="true" />
								{t("settings.connections.add.kind.wsl")}
							</button>
						) : null}
						<button
							type="button"
							aria-pressed="false"
							disabled
							aria-label={`${t("settings.connections.add.kind.docker")} — ${t("settings.connections.add.kindUnavailable")}`}
							title={t("settings.connections.add.kindUnavailable")}
							className="inline-flex min-h-8 cursor-not-allowed items-center gap-1.5 border-l border-input px-3 text-body text-muted-foreground opacity-50"
						>
							<Box className="size-3.5" aria-hidden="true" />
							{t("settings.connections.add.kind.docker")}
						</button>
					</div>
					{kind === "ssh" ? (
						<Popover open={importing} onOpenChange={setImporting}>
							<PopoverTrigger asChild>
								<Button type="button" variant="ghost" size="sm" className={cn("text-muted-foreground", importing && "bg-bg-hover text-foreground")} aria-expanded={importing}>
									<FileCode className="size-4" aria-hidden="true" />
									{t("settings.connections.add.import")}
									<ChevronDown className={cn("size-3.5 transition-transform", importing && "rotate-180")} aria-hidden="true" />
								</Button>
							</PopoverTrigger>
							{/* 小浮层：只覆盖在表单之上，不把下面的字段推下去。 */}
							<PopoverContent align="end" sideOffset={6} className="w-[21rem] p-0">
								<div className="overflow-hidden" data-testid="ssh-config-import">
									<div className="relative border-b border-border-subtle/70 p-1.5">
										<Search className="pointer-events-none absolute left-3.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
										<Input autoFocus value={query} placeholder={t("settings.connections.add.importSearch")} aria-label={t("settings.connections.add.importSearch")} onChange={(event) => setQuery(event.target.value)} className="h-8 border-0 bg-transparent pl-7 text-body shadow-none focus-visible:ring-0" />
									</div>
									{/* scroll-ok: bounded SSH config 候选，扫描结果由 max-h 收束 */}
									<div className="max-h-56 overflow-y-auto p-1">
										{filtered.length === 0 ? (
											<div className="flex flex-col items-center gap-1.5 px-3 py-7 text-center">
												<Search className="size-4 text-muted-foreground/60" aria-hidden="true" />
												<p className="text-body text-muted-foreground">{t("settings.connections.add.importEmpty")}</p>
											</div>
										) : (
											<ul className="flex flex-col gap-0.5">
												{filtered.map((candidate) => (
													<li key={candidate.alias}>
														<button type="button" className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left outline-none transition-colors hover:bg-bg-hover focus-visible:bg-bg-hover" onClick={() => applyCandidate(candidate)}>
															<span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-bg-input text-muted-foreground transition-colors group-hover:text-foreground">
																<Server className="size-4" aria-hidden="true" />
															</span>
															<span className="flex min-w-0 flex-1 flex-col gap-0.5">
																<span className="truncate text-body font-medium text-foreground">{candidate.alias}</span>
																<span className="truncate font-mono text-label text-muted-foreground">
																	{candidate.user.length > 0 ? candidate.user : currentUser}@{candidate.hostName}
																	{candidate.port !== null ? `:${candidate.port}` : ""}
																</span>
															</span>
														</button>
													</li>
												))}
											</ul>
										)}
									</div>
									{/* 被跳过的条目要说明原因：静默少一项会让用户以为自己的配置丢了。 */}
									{skipped.length > 0 || scanNote !== null ? (
										<div className="border-t border-border-subtle/70 px-3 py-1.5">
											{skipped.length > 0 ? (
												<details className="text-label text-muted-foreground">
													<summary className="cursor-pointer select-none py-0.5">{t("settings.connections.add.skipped", { count: String(skipped.length) })}</summary>
													<ul className="flex flex-col gap-0.5 pb-1">
														{skipped.map((entry) => (
															<li key={`${entry.alias}-${entry.reason}`}>
																{entry.alias} — {skipReasonLabel(entry.reason)}
															</li>
														))}
													</ul>
												</details>
											) : null}
											{scanNote !== null ? <p className="py-0.5 text-label text-muted-foreground">{scanNote}</p> : null}
										</div>
									) : null}
								</div>
							</PopoverContent>
						</Popover>
					) : null}
				</div>

				{kind === "wsl" ? (
					<div className="flex flex-col gap-3">
						<p className="text-label text-muted-foreground">{t("settings.connections.add.wsl.hint")}</p>
						<div className="flex flex-col gap-1">
							<Label htmlFor="wsl-host-label">{t("settings.connections.add.wsl.label")}</Label>
							<Input id="wsl-host-label" value={wsl.label} onChange={(event) => setWsl((current) => ({ ...current, label: event.target.value }))} />
						</div>
						<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
							<div className="flex min-w-0 flex-col gap-1">
								<Label htmlFor="wsl-host-distro">{t("settings.connections.add.wsl.distro")}</Label>
								<Input id="wsl-host-distro" list="wsl-distro-options" placeholder="Ubuntu" value={wsl.distro} onChange={(event) => setWsl((current) => ({ ...current, distro: event.target.value }))} />
								{wslDistros.length > 0 ? (
									<datalist id="wsl-distro-options">
										{wslDistros.map((distro) => (
											<option key={distro} value={distro} />
									))}
									</datalist>
								) : null}
							</div>
							<div className="flex min-w-0 flex-col gap-1">
								<Label htmlFor="wsl-host-user">{t("settings.connections.add.wsl.user")}</Label>
								<Input id="wsl-host-user" autoComplete="off" spellCheck={false} placeholder="dev" value={wsl.user} onChange={(event) => setWsl((current) => ({ ...current, user: event.target.value }))} />
							</div>
						</div>
						{wslDistrosLoading ? (
							<p className="flex items-center gap-1.5 text-label text-muted-foreground">
								<LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
								{t("settings.connections.add.wsl.detecting")}
							</p>
						) : wslDistrosAttempted ? (
							<p className="text-label text-muted-foreground">{wslDistros.length > 0 ? t("settings.connections.add.wsl.detected", { count: String(wslDistros.length) }) : t("settings.connections.add.wsl.noneDetected")}</p>
						) : null}
						{wslError !== null ? <p className="text-label text-destructive">{wslError}</p> : null}
					</div>
				) : (
					<>
						{/* 保存成功后锁住字段：这条记录已经落库，再改字段就不再是它了（要改请在列表里编辑）。 */}
						<fieldset disabled={formLocked} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
							<div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
								<div className="flex min-w-0 flex-col gap-1">
									<Label htmlFor="remote-host-name">{t("settings.connections.add.hostName")}</Label>
									<Input id="remote-host-name" placeholder="host.com" value={form.hostName} onChange={(event) => setForm((current) => ({ ...current, hostName: event.target.value }))} />
								</div>
								<div className="flex min-w-0 flex-col gap-1">
									<Label htmlFor="remote-host-port">{t("settings.connections.add.port")}</Label>
									<Input id="remote-host-port" inputMode="numeric" placeholder="22" value={form.port} onChange={(event) => setForm((current) => ({ ...current, port: event.target.value }))} />
								</div>
							</div>
							<div className="flex flex-col gap-1">
								<Label htmlFor="remote-host-user">{t("settings.connections.add.user")}</Label>
								<Input id="remote-host-user" autoComplete="off" spellCheck={false} placeholder={t("settings.connections.add.userPlaceholder")} value={form.user} onChange={(event) => setForm((current) => ({ ...current, user: event.target.value }))} />
							</div>
							<div className="flex flex-col gap-1">
								<Label htmlFor="remote-host-label">{t("settings.connections.add.label")}</Label>
								<Input id="remote-host-label" value={form.label} onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))} />
							</div>
							<div className="flex flex-wrap items-center gap-3">
								<span className="text-label text-muted-foreground">{t("settings.connections.add.authLabel")}</span>
								<div role="group" aria-label={t("settings.connections.add.authLabel")} className="flex w-fit overflow-hidden rounded-lg border border-input">
									<button
										type="button"
										aria-pressed={form.auth === "agent"}
										className={cn("inline-flex min-h-8 items-center px-3 text-body", form.auth === "agent" ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-bg-hover")}
										onClick={() => setForm((current) => ({ ...current, auth: "agent", identityFile: "" }))}
									>
										{t("settings.connections.add.auth.agent")}
									</button>
									<button
										type="button"
										aria-pressed={form.auth === "key"}
										className={cn("inline-flex min-h-8 items-center border-l border-input px-3 text-body", form.auth === "key" ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-bg-hover")}
										onClick={() => setForm((current) => ({ ...current, auth: "key" }))}
									>
										{t("settings.connections.add.auth.key")}
									</button>
									<button
										type="button"
										aria-pressed={form.auth === "password"}
										className={cn("inline-flex min-h-8 items-center border-l border-input px-3 text-body", form.auth === "password" ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-bg-hover")}
										onClick={() => setForm((current) => ({ ...current, auth: "password", identityFile: "" }))}
									>
										{t("settings.connections.add.auth.password")}
									</button>
								</div>
							</div>
							{form.auth === "password" ? (
								<div className="flex flex-col gap-1">
									<Label htmlFor="remote-host-password">{t("settings.connections.add.password")}</Label>
									<div className="relative">
										<Input id="remote-host-password" type={showPassword ? "text" : "password"} autoComplete="off" spellCheck={false} className="pr-10" value={form.password} onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))} />
										<button
											type="button"
											aria-label={t(showPassword ? "settings.connections.add.hidePassword" : "settings.connections.add.showPassword")}
											aria-pressed={showPassword}
											className="absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-bg-hover hover:text-foreground"
											onClick={() => setShowPassword((current) => !current)}
										>
											{showPassword ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
										</button>
									</div>
								</div>
							) : null}
							{form.auth === "key" ? (
								<div className="flex flex-col gap-3">
									<div className="flex flex-col gap-1">
										<Label htmlFor="remote-host-identity">{t("settings.connections.add.identityFile")}</Label>
										<Popover open={identityOpen} onOpenChange={setIdentityOpen}>
											<PopoverAnchor asChild>
												<div className="relative">
													<Input
														id="remote-host-identity"
														autoComplete="off"
														spellCheck={false}
														placeholder={t("settings.connections.add.identityFilePlaceholder")}
														className="pr-16"
														value={form.identityFile}
														onChange={(event) => setForm((current) => ({ ...current, identityFile: event.target.value }))}
														onClick={() => {
															if (identitySuggestions.length > 0) setIdentityOpen(true);
														}}
													/>
													{identitySuggestions.length > 0 ? (
														<button
															type="button"
															aria-label={t("settings.connections.add.identitySuggestions")}
															aria-expanded={identityOpen}
															className="absolute right-8 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-bg-hover hover:text-foreground"
															onClick={() => setIdentityOpen((current) => !current)}
														>
															<ChevronDown className={cn("size-4 transition-transform", identityOpen && "rotate-180")} aria-hidden="true" />
														</button>
													) : null}
													<button
														type="button"
														aria-label={t("settings.connections.add.identityBrowse")}
														title={t("settings.connections.add.identityBrowse")}
														className="absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-bg-hover hover:text-foreground"
														onClick={() => {
															void (async () => {
																const picked = await desktopApi.remoteHosts.pickIdentityFile();
																if (picked.ok) setForm((current) => ({ ...current, identityFile: picked.path }));
															})();
														}}
													>
														<FolderOpen className="size-4" aria-hidden="true" />
													</button>
												</div>
											</PopoverAnchor>
											{/* 扫描到的私钥放进下拉里：默认不占版面，点开才出现。 */}
											<PopoverContent align="start" sideOffset={4} className="w-[26rem] max-w-[var(--radix-popover-content-available-width)] p-1">
												{/* scroll-ok: bounded 私钥候选，条目有限且由 max-h 收束 */}
												<ul className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
													{identitySuggestions.map((path) => (
														<li key={path}>
															<button
																type="button"
																className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-label text-muted-foreground outline-none transition-colors hover:bg-bg-hover hover:text-foreground focus-visible:bg-bg-hover", form.identityFile === path && "bg-bg-hover text-foreground")}
																title={path}
																onClick={() => {
																	setForm((current) => ({ ...current, identityFile: path }));
																	setIdentityOpen(false);
																}}
															>
																<FileCode className="size-3.5 shrink-0" aria-hidden="true" />
																<span className="truncate">{path}</span>
															</button>
														</li>
													))}
												</ul>
											</PopoverContent>
										</Popover>
									</div>
									<div className="flex flex-col gap-1">
										<Label htmlFor="remote-host-passphrase">{t("settings.connections.add.passphrase")}</Label>
										<div className="relative">
											<Input
												id="remote-host-passphrase"
												type={showSecret ? "text" : "password"}
												autoComplete="off"
												spellCheck={false}
												placeholder={t("settings.connections.add.passphrasePlaceholder")}
												className="pr-10"
												value={form.passphrase}
												onChange={(event) => setForm((current) => ({ ...current, passphrase: event.target.value }))}
											/>
											<button
												type="button"
												aria-label={t(showSecret ? "settings.connections.add.hideSecret" : "settings.connections.add.showSecret")}
												aria-pressed={showSecret}
												className="absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-bg-hover hover:text-foreground"
												onClick={() => setShowSecret((current) => !current)}
											>
												{showSecret ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
											</button>
										</div>
									</div>
								</div>
							) : null}
							<p className="text-label text-muted-foreground">{t("settings.connections.add.credentialsHint")}</p>
						</fieldset>

						{/* 内联环境检测：四步状态 + pi 结论。整个过程就在这张表单里，不再弹独立进度框。 */}
						{setupStarted ? (
							<div className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-bg-input/40 p-3">
								<ol aria-live="polite" className="flex flex-col gap-1.5">
									{SETUP_STEPS.map((key) => {
										const status = steps[key];
										const Icon = SETUP_STEP_ICON[status];
										return (
											<li key={key} aria-current={status === "active" ? "step" : undefined} className="flex min-w-0 items-center gap-2 text-body">
												<Icon className={cn("size-3.5 shrink-0", SETUP_STEP_TONE[status], status === "active" && "animate-pideck-spin motion-reduce:animate-none")} aria-hidden="true" />
												<span className={cn("min-w-0 truncate", status === "pending" ? "text-muted-foreground" : "text-foreground")}>{t(SETUP_STEP_LABEL[key])}</span>
												<span className="ml-auto shrink-0 text-label text-muted-foreground">{status === "active" ? t("settings.connections.add.stepState.running") : status === "done" ? t("settings.connections.add.stepState.done") : status === "failed" ? t("settings.connections.add.stepState.failed") : null}</span>
											</li>
										);
									})}
								</ol>

								{piOutcome?.state === "found" ? (
									<div className="flex flex-col gap-0.5 border-t border-border-subtle/70 pt-2">
										<p role="status" className="flex items-start gap-1.5 text-label text-[var(--color-success)]">
											<CircleCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
											<span className="min-w-0">{t("settings.connections.add.piFound", { version: piOutcome.version })}</span>
										</p>
										<p className="break-all pl-5 font-mono text-label text-muted-foreground">{piOutcome.piPath}</p>
										{piOutcome.warning === undefined ? null : <p className="pl-5 text-label text-warning">{t("settings.connections.add.piWarning")}</p>}
									</div>
								) : null}

								{piOutcome?.state === "failed" ? (
									<div className="flex flex-col gap-2 border-t border-border-subtle/70 pt-2">
										<p role="status" className="flex items-start gap-1.5 text-label text-destructive">
											<TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
											<span className="min-w-0">{remotePiProbeReason(piOutcome.code)}</span>
										</p>
										{piOutcome.code === "REMOTE_PI_NOT_FOUND" ? (
											<div className="flex flex-col gap-1.5 rounded-md bg-bg-panel p-2">
												<span className="text-label text-muted-foreground">{t("settings.connections.add.piInstallHint")}</span>
												<div className="flex flex-wrap items-center gap-2">
													<code className="min-w-0 flex-1 select-all break-all rounded bg-muted px-2 py-1 font-mono text-label">{PI_INSTALL_COMMAND}</code>
													<Button type="button" variant="outline" size="sm" onClick={() => void copyInstallCommand()}>
														<Copy className="size-3.5" aria-hidden="true" />
														{copiedInstall ? t("settings.connections.add.piCopied") : t("settings.connections.add.piCopy")}
													</Button>
												</div>
											</div>
										) : null}
									</div>
								) : null}

								{/* 手填路径：探测失败时的出路，探测成功时也能改成另一个 pi。 */}
								{steps.pi === "failed" || steps.pi === "done" ? (
									<div className="flex flex-col gap-1.5 border-t border-border-subtle/70 pt-2">
										<Label htmlFor="remote-pi-path">{t("settings.connections.add.piPathLabel")}</Label>
										<div className="flex flex-wrap items-center gap-2">
											<Input
												id="remote-pi-path"
												autoComplete="off"
												spellCheck={false}
												className="min-w-0 flex-1 font-mono"
												placeholder={t("settings.connections.add.piPathPlaceholder")}
												value={piPathDraft}
												disabled={savingPiPath || setupRunning}
												onChange={(event) => {
													setPiPathDraft(event.target.value);
													setPiPathError(null);
												}}
											/>
											<Button type="button" variant="outline" disabled={savingPiPath || setupRunning} onClick={() => void savePiPath()}>
												{savingPiPath ? t("settings.connections.add.piPathSaving") : t("settings.connections.add.piPathSave")}
											</Button>
										</div>
										<p className="text-label text-muted-foreground">{t("settings.connections.add.piPathHint")}</p>
										{piPathError === null ? null : <p className="text-label text-destructive">{piPathError}</p>}
									</div>
								) : null}
							</div>
						) : null}

						{testResult !== null ? (
							<div role="status" className={cn("flex flex-col gap-1 text-label", testResult.ok ? "text-[var(--color-success)]" : "text-destructive")}>
								<p className="flex items-start gap-1.5">
									{testResult.ok ? <CircleCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /> : <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />}
									<span className="min-w-0">{testResult.ok ? t("settings.connections.add.testOk", { fingerprint: testResult.fingerprint }) : t("settings.connections.add.testFailed", { reason: testResult.reason })}</span>
								</p>
								{testResult.ok ? <p className="pl-5 text-label text-muted-foreground">{t("settings.connections.add.testOkHint")}</p> : null}
							</div>
						) : null}
						{error !== null ? <p className="text-label text-destructive">{error}</p> : null}
					</>
				)}

				<DialogFooter className="flex-row items-center justify-between gap-2 border-t border-border-subtle pt-4 sm:justify-between">
					<span className="min-w-0 truncate text-label text-muted-foreground">{kind === "ssh" && importing ? t("settings.connections.add.importHint") : null}</span>
					<div className="flex items-center gap-2">
						<Button variant="ghost" onClick={close}>
							{t("common.cancel")}
						</Button>
						{kind === "ssh" ? (
							<>
								{setupRunning || setupSettled ? null : (
									<Button variant="outline" disabled={testing || form.auth === "password"} title={form.auth === "password" ? t("settings.connections.add.testPasswordUnsupported") : undefined} onClick={() => void testConnection()}>
										{testing ? t("settings.connections.add.testing") : t("settings.connections.add.test")}
									</Button>
								)}
								{setupRunning ? null : piFound ? (
									<Button onClick={complete}>{t("settings.connections.add.doneAction")}</Button>
								) : setupSettled ? (
									<Button disabled={savingPiPath} onClick={retrySetup}>
										{t("settings.connections.add.retry")}
									</Button>
								) : (
									<Button disabled={testing} onClick={() => void runSetup("full")}>
										{editing === undefined ? t("settings.connections.add.setup") : t("settings.connections.add.setupEdit")}
									</Button>
								)}
							</>
						) : (
							<Button disabled={wslBusy} onClick={() => void submitWsl()}>
								{t("settings.connections.add.wsl.submit")}
							</Button>
						)}
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
