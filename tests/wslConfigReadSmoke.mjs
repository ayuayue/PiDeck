/**
 * WSL 配置只读 smoke（本轮验证用，**不是默认单测**，不进 npm test 的 glob）。
 *
 * 做什么：
 * 1) 用临时 userData 写一份 wsl-hosts.json（只含一个档案：发行版 + Linux 用户）；
 * 2) 用**真实** WslPiConfigStore（createWslPiConfigStoreFor：WslHostStore 档案 + resolveWslEnvironment）
 *    读发行版 HOME 下 .pi/agent/models.json 与 settings.json；
 * 3) 记录这两个文件在**读之前/读之后**的 sha256，证明只读不写（缺失则记 absent）。
 *
 * 纪律：不调用任何 save*；不写用户真实配置；输出里不含主机名/用户名/绝对路径（home 只写 "~"）。
 *
 * 用法：node tests/wslConfigReadSmoke.mjs [distro] [user]
 *   缺省 distro=Ubuntu-26.04，user 缺省从发行版里问（printenv USER）。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const storeModule = loadTsCommonJs("src/main/config/WslPiConfigStore.ts");
const wslPaths = loadTsCommonJs("src/main/wsl/WslPaths.ts");

const distro = process.argv[2] ?? "Ubuntu-26.04";

function wslExec(args) {
	return execFileSync("wsl.exe", ["-d", distro, "-e", ...args], { encoding: "utf8" }).trim();
}

async function sha256OrAbsent(path) {
	try {
		const bytes = await readFile(path);
		return "sha256:" + createHash("sha256").update(bytes).digest("hex");
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
		return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unreadable:" + code;
	}
}

const result = { distro, user: "<distro-user>", home: "~", files: {}, readOk: false, errorCode: null };
let userDataDir = "";
try {
	const user = process.argv[3] ?? wslExec(["printenv", "USER"]);
	const home = wslExec(["printenv", "HOME"]);
	result.home = home === "" ? "~" : "~";
	result.user = user === "" ? "<empty>" : "<distro-user>";

	const uncHome = wslPaths.linuxPathToWslUnc(home, distro);
	const configDir = join(uncHome, ".pi", "agent");

	userDataDir = await mkdtemp(join(tmpdir(), "pideck-wsl-smoke-"));

	const before = {
		models: await sha256OrAbsent(join(configDir, "models.json")),
		settings: await sha256OrAbsent(join(configDir, "settings.json")),
	};

	const store = storeModule.createWslPiConfigStoreFor(userDataDir, { readWslIdentity: async () => ({ distro, user }) });
	const reads = {};
	for (const file of ["models", "settings"]) {
		try {
			const snapshot = await store.read({ file });
			reads[file] = {
				ok: true,
				kind: snapshot.kind,
				distro: snapshot.distro,
				dataKeys: Object.keys(snapshot.data ?? {}).length,
				providers: file === "models" ? Object.keys(snapshot.data?.providers ?? {}).length : undefined,
			};
			result.readOk = true;
		} catch (error) {
			reads[file] = { ok: false, code: typeof error?.message === "string" ? error.message : String(error) };
			result.errorCode = reads[file].code;
		}
	}

	const after = {
		models: await sha256OrAbsent(join(configDir, "models.json")),
		settings: await sha256OrAbsent(join(configDir, "settings.json")),
	};

	for (const file of ["models", "settings"]) {
		result.files[file] = {
			read: reads[file],
			shaBefore: before[file],
			shaAfter: after[file],
			unchanged: before[file] === after[file],
		};
	}
} catch (error) {
	result.errorCode = typeof error?.message === "string" ? error.message.split("\n")[0].slice(0, 200) : String(error);
} finally {
	if (userDataDir !== "") await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
}

console.log(JSON.stringify(result));
const ok = result.readOk && Object.values(result.files).every((entry) => entry.unchanged);
process.exit(ok ? 0 : 1);
