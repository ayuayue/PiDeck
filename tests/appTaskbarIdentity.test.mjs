import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const MODULE_PATH = "src/main/appTaskbarIdentity.ts";
const AUMID = "com.ayuayue.pi-desktop";
const EXEC_PATH = "C:\\Program Files\\PiDeck\\PiDeck.exe";

/** vm 沙箱里造出来的对象与宿主对象原型不同，比较前统一过一遍 JSON（数组也一并用）。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** 假 NativeImage：resize 按最长边等比缩，toPNG 返回给定字节。 */
function createFakeImage({ width, height, png = Buffer.from("fake-logo-png") }) {
	const resizeCalls = [];
	const image = {
		getSize: () => ({ width, height }),
		resize: (options) => {
			resizeCalls.push(options);
			const next = { width, height };
			if (options.width !== undefined) {
				next.width = options.width;
				next.height = Math.max(1, Math.round((height * options.width) / width));
			} else if (options.height !== undefined) {
				next.height = options.height;
				next.width = Math.max(1, Math.round((width * options.height) / height));
			}
			return createFakeImage({ ...next, png }).image;
		},
		toPNG: () => png,
	};
	return { image, resizeCalls };
}

function createHarness({ platform = "win32", logoStyle = "custom", logoEntry, image, failWrites = false, readErrors = [] } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pideck-taskbar-"));
	const userDataDir = join(root, "userData");
	const roaming = join(root, "roaming");
	const programData = join(root, "programData");
	// 开始菜单两级目录 + 任务栏固定项目录都要真的存在：扫描按目录走
	const menuDir = join(roaming, "Microsoft", "Windows", "Start Menu", "Programs");
	const commonMenuDir = join(programData, "Microsoft", "Windows", "Start Menu", "Programs");
	const pinnedDir = join(roaming, "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar");
	mkdirSync(userDataDir, { recursive: true });
	mkdirSync(menuDir, { recursive: true });
	mkdirSync(commonMenuDir, { recursive: true });
	mkdirSync(pinnedDir, { recursive: true });

	const shortcuts = new Map();
	const writes = [];
	const warnings = [];
	const infos = [];
	const resolvedImage = image ?? createFakeImage({ width: 512, height: 512 }).image;
	// logoRef 可换：同一程序运行中用户换 logo 时，resolveLogoImage 会返回另一张图
	const logoRef = { current: logoEntry === undefined ? { resolved: logoStyle, image: resolvedImage } : logoEntry };

	const module = loadTsCommonJs(MODULE_PATH, {
		stubs: {
			electron: {
				app: { getPath: (name) => (name === "userData" ? userDataDir : userDataDir) },
				shell: {
					readShortcutLink: (file) => {
						if (readErrors.includes(file)) throw new Error("shortcut is corrupt");
						const details = shortcuts.get(file);
						if (!details) throw new Error("shortcut not found");
						return { ...details };
					},
					writeShortcutLink: (file, operation, details) => {
						if (failWrites) return false;
						writes.push({ file, operation, details: { ...details } });
						shortcuts.set(file, { ...details });
						return true;
					},
				},
			},
			"./appWindowLogo": { resolveLogoImage: () => logoRef.current },
			"./logging/sharedLogger": {
				getAppLogger: () => ({
					warn: (...args) => warnings.push(args),
					info: (...args) => infos.push(args),
				}),
			},
		},
		globals: {
			process: {
				...process,
				platform,
				execPath: EXEC_PATH,
				env: { ...process.env, APPDATA: roaming, ProgramData: programData },
			},
		},
	});

	/** 造一条开始菜单快捷方式：文件真实存在（扫描走 fs），内容由 stub 提供。 */
	const addShortcut = (name, details, dir = menuDir) => {
		const file = join(dir, name);
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, "dummy-lnk");
		shortcuts.set(file, { target: EXEC_PATH, ...details });
		return file;
	};

	return {
		module,
		userDataDir,
		logoRef,
		menuDir,
		commonMenuDir,
		pinnedDir,
		shortcuts,
		addShortcut,
		writes,
		warnings,
		infos,
		logoDir: join(userDataDir, "logos"),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

/** 解出单条目 ICO 的目录项与数据，顺带做结构断言。 */
function icoEntry(ico) {
	assert.equal(ico.readUInt16LE(0), 0, "ICO reserved");
	assert.equal(ico.readUInt16LE(2), 1, "ICO type=icon");
	assert.equal(ico.readUInt16LE(4), 1, "单条目");
	const bytesInRes = ico.readUInt32LE(14);
	assert.equal(ico.readUInt32LE(18), 22, "数据必须紧跟 22 字节头部");
	assert.equal(ico.length, 22 + bytesInRes, "数据长度与目录项一致");
	return {
		widthByte: ico.readUInt8(6),
		heightByte: ico.readUInt8(7),
		planes: ico.readUInt16LE(10),
		bits: ico.readUInt16LE(12),
		payload: ico.subarray(22),
	};
}

test("resolveAppUserModelId: 打包版固定身份，dev 按分支隔离", () => {
	const { module, cleanup } = createHarness();
	try {
		assert.equal(module.resolveAppUserModelId({ isDevBuild: false, devUserDataDirName: "PiDeck", devGitBranch: "feat/taskbar" }), "com.ayuayue.pi-desktop");
		assert.equal(module.resolveAppUserModelId({ isDevBuild: true, devUserDataDirName: "PiDeck-dev", devGitBranch: "dev" }), "com.ayuayue.pi-desktop-dev");
		assert.equal(module.resolveAppUserModelId({ isDevBuild: true, devUserDataDirName: "PiDeck-dev-feat-taskbar-logo", devGitBranch: "Feat/Taskbar Logo!" }), "com.ayuayue.pi-desktop-dev.feat-taskbar-logo");
	} finally {
		cleanup();
	}
});

test("buildIcoFromPng: PNG 直接当 ICO 条目，256 的宽高字节写 0", () => {
	const { module, cleanup } = createHarness();
	try {
		const png = Buffer.from("png-payload");
		const entry = icoEntry(module.buildIcoFromPng(png, { width: 256, height: 256 }));
		assert.equal(entry.widthByte, 0, "1 字节字段装不下 256，按规范写 0");
		assert.equal(entry.heightByte, 0);
		assert.equal(entry.planes, 1);
		assert.equal(entry.bits, 32);
		assert.equal(Buffer.compare(entry.payload, png), 0, "条目数据就是 PNG 原字节");

		const wide = icoEntry(module.buildIcoFromPng(png, { width: 256, height: 41 }));
		assert.equal(wide.widthByte, 0, "非正方形照实写两个边长");
		assert.equal(wide.heightByte, 41);
	} finally {
		cleanup();
	}
});

test("taskbarLogoIcoFileName: 内容寻址，同内容同名", () => {
	const { module, cleanup } = createHarness();
	try {
		const first = module.taskbarLogoIcoFileName(Buffer.from("a"));
		assert.equal(first, module.taskbarLogoIcoFileName(Buffer.from("a")));
		assert.notEqual(first, module.taskbarLogoIcoFileName(Buffer.from("b")));
		assert.match(first, /^taskbar-logo-[0-9a-f]{12}\.ico$/);
	} finally {
		cleanup();
	}
});

test("planShortcutIconUpdate: 只换图标，其余属性原样保留", () => {
	const { module, cleanup } = createHarness();
	try {
		const details = { target: EXEC_PATH, args: "--open", cwd: "C:\\work", description: "PiDeck", appUserModelId: AUMID, icon: "C:\\old\\app.exe", iconIndex: 3 };
		const next = module.planShortcutIconUpdate({ details, execPath: EXEC_PATH, aumid: AUMID, iconPath: "C:\\logo\\taskbar-logo-1.ico" });
		assert.deepEqual(plain(next), {
			target: EXEC_PATH,
			args: "--open",
			cwd: "C:\\work",
			description: "PiDeck",
			appUserModelId: AUMID,
			icon: "C:\\logo\\taskbar-logo-1.ico",
			iconIndex: 0,
		});
	} finally {
		cleanup();
	}
});

test("planShortcutIconUpdate: 大小写/分隔符不同视为同一个 exe；无 AUMID 也算本程序", () => {
	const { module, cleanup } = createHarness();
	try {
		const details = { target: "c:/program files/pideck/PiDeck.EXE", appUserModelId: null };
		const next = module.planShortcutIconUpdate({ details, execPath: EXEC_PATH, aumid: AUMID, iconPath: "C:\\logo\\a.ico" });
		assert.equal(next?.icon, "C:\\logo\\a.ico", "旧快捷方式没有 AUMID：按目标 exe 认成自己的");

		assert.equal(
			module.planShortcutIconUpdate({
				details: { ...details, icon: "C:/logo/a.ico", iconIndex: 0 },
				execPath: EXEC_PATH,
				aumid: AUMID,
				iconPath: "C:\\logo\\a.ico",
			}),
			null,
			"图标已是当前文件：不重复改用户快捷方式",
		);
	} finally {
		cleanup();
	}
});

test("planShortcutIconUpdate: 别人的快捷方式一律不碰", () => {
	const { module, cleanup } = createHarness();
	try {
		const otherTarget = module.planShortcutIconUpdate({ details: { target: "C:\\other\\App.exe" }, execPath: EXEC_PATH, aumid: AUMID, iconPath: "C:\\logo\\a.ico" });
		assert.equal(otherTarget, null, "目标不是本程序");
		const otherAumid = module.planShortcutIconUpdate({ details: { target: EXEC_PATH, appUserModelId: "com.electron.Feishu" }, execPath: EXEC_PATH, aumid: AUMID, iconPath: "C:\\logo\\a.ico" });
		assert.equal(otherAumid, null, "带着别人的 AUMID：不是本程序身份");
		assert.equal(module.planShortcutIconUpdate({ details: { target: null }, execPath: EXEC_PATH, aumid: AUMID, iconPath: "C:\\logo\\a.ico" }), null);
	} finally {
		cleanup();
	}
});

test("listShortcutFiles: 递归收集 .lnk，读不动的目录跳过", () => {
	const { module, menuDir, addShortcut, cleanup } = createHarness();
	try {
		addShortcut("PiDeck.lnk", {});
		addShortcut("Nested/Nested.lnk", {});
		writeFileSync(join(menuDir, "readme.txt"), "not a shortcut");
		const files = module.listShortcutFiles([menuDir, join(menuDir, "does-not-exist")]).map((file) => file.split("\\").join("/"));
		assert.deepEqual(plain(files.map((file) => file.split("/").pop())).sort(), ["Nested.lnk", "PiDeck.lnk"]);
	} finally {
		cleanup();
	}
});

test("syncTaskbarShortcutIcon: 目标为本程序的快捷方式换成当前 logo 的 ICO", () => {
	const harness = createHarness();
	try {
		const own = harness.addShortcut("PiDeck.lnk", { args: "--open", cwd: "C:\\work", description: "PiDeck", appUserModelId: AUMID });
		const ownNoAumid = harness.addShortcut("Nested/PiDeck Copy.lnk", {});
		const other = harness.addShortcut("Other.lnk", { target: "C:\\other\\App.exe" });
		const otherAumid = harness.addShortcut("WorkBuddy.lnk", { appUserModelId: "WorkBuddy.WorkBuddy" });
		const conflict = harness.addShortcut("Stale Electron.lnk", { target: "C:\\electron\\electron.exe", appUserModelId: AUMID });
		const common = harness.addShortcut("PiDeck Common.lnk", {}, harness.commonMenuDir);
		const pinned = harness.addShortcut("PiDeck.lnk", {}, harness.pinnedDir);
		const pinnedOther = harness.addShortcut("Microsoft Edge.lnk", { target: "C:\\edge\\msedge.exe" }, harness.pinnedDir);
		mkdirSync(harness.logoDir, { recursive: true });
		writeFileSync(join(harness.logoDir, "unrelated.png"), "keep");

		harness.module.registerTaskbarIdentityAumid(AUMID);
		harness.module.syncTaskbarShortcutIcon({ style: "custom", customLogoDataUrl: "data:image/png;base64,AAA" });

		assert.equal(harness.warnings.length, 1, "同 AUMID 却指向别的程序：要指认得出来（正是任务栏图标被接管的现场）");
		assert.match(String(harness.warnings[0][2].file), /Stale Electron\.lnk$/);
		assert.equal(
			harness.writes.some((write) => write.file === conflict),
			false,
		);
		assert.equal(
			harness.writes.some((write) => write.file === other),
			false,
		);
		assert.equal(
			harness.writes.some((write) => write.file === pinnedOther),
			false,
			"任务栏固定项里的其它应用不能碰",
		);
		assert.deepEqual(harness.writes.map((write) => write.file).sort(), [own, ownNoAumid, common, pinned].sort(), "只更新目标 exe 是自己的快捷方式（用户级 + 公共级 + 任务栏固定项）");
		for (const write of harness.writes) {
			assert.equal(write.operation, "update", "不能重建快捷方式，要保留原属性");
			assert.equal(write.details.iconIndex, 0);
			assert.ok(write.details.target === EXEC_PATH);
			assert.match(write.details.icon, /logos[\\/]taskbar-logo-[0-9a-f]{12}\.ico$/);
		}
		assert.deepEqual(plain(harness.shortcuts.get(own)), {
			target: EXEC_PATH,
			args: "--open",
			cwd: "C:\\work",
			description: "PiDeck",
			appUserModelId: AUMID,
			icon: harness.writes.find((write) => write.file === own).details.icon,
			iconIndex: 0,
		});

		const files = readdirSync(harness.logoDir);
		const icoName = files.find((name) => name.startsWith("taskbar-logo-"));
		assert.ok(icoName, "任务栏图标应落盘");
		const entry = icoEntry(readFileSync(join(harness.logoDir, icoName)));
		assert.equal(entry.widthByte, 0, "512 的 logo 缩到 256 后宽高字节写 0");
		assert.equal(files.includes("unrelated.png"), true, "只清自己的图标文件");
		assert.equal(harness.infos.length, 4, "每条更新都要留日志");
	} finally {
		harness.cleanup();
	}
});

test("syncTaskbarShortcutIcon: 同一次运行里重复同步不重写，换 logo 才重写并清理旧图标", () => {
	const harness = createHarness();
	try {
		harness.addShortcut("PiDeck.lnk", {});
		mkdirSync(harness.logoDir, { recursive: true });
		writeFileSync(join(harness.logoDir, "taskbar-logo-deadbeef0000.ico"), "stale");
		harness.module.registerTaskbarIdentityAumid(AUMID);
		harness.module.syncTaskbarShortcutIcon({ style: "custom", customLogoDataUrl: null });
		assert.equal(harness.writes.length, 1);
		assert.equal(readdirSync(harness.logoDir).includes("taskbar-logo-deadbeef0000.ico"), false, "上一版图标要清掉");

		harness.module.syncTaskbarShortcutIcon({ style: "custom", customLogoDataUrl: null });
		assert.equal(harness.writes.length, 1, "同一份 logo 不重复改快捷方式");

		// 换成另一份 logo：内容寻址的新路径 ⇒ 再写一次，旧文件清掉
		harness.logoRef.current = { resolved: "custom", image: createFakeImage({ width: 64, height: 64, png: Buffer.from("v2") }).image };
		harness.module.syncTaskbarShortcutIcon({ style: "custom", customLogoDataUrl: null });
		assert.equal(harness.writes.length, 2, "logo 换了要重写");
		assert.equal(readdirSync(harness.logoDir).filter((name) => name.startsWith("taskbar-logo-")).length, 1);
	} finally {
		harness.cleanup();
	}
});

test("syncTaskbarShortcutIcon: 大图按最长边等比缩到 256，小图不放大", () => {
	const wide = createFakeImage({ width: 1700, height: 275, png: Buffer.from("wide") });
	const harness = createHarness({ image: wide.image });
	try {
		harness.addShortcut("PiDeck.lnk", {});
		harness.module.registerTaskbarIdentityAumid(AUMID);
		harness.module.syncTaskbarShortcutIcon({ style: "custom", customLogoDataUrl: null });
		assert.deepEqual(plain(wide.resizeCalls), [{ width: 256, quality: "best" }]);
		const ico = readFileSync(harness.writes[0].details.icon);
		const entry = icoEntry(ico);
		assert.equal(entry.widthByte, 0, "256 写 0");
		assert.equal(entry.heightByte, 41, "高按比例 275*256/1700");
		assert.equal(Buffer.compare(entry.payload, Buffer.from("wide")), 0);
	} finally {
		harness.cleanup();
	}

	const small = createFakeImage({ width: 128, height: 256, png: Buffer.from("small") });
	const smallHarness = createHarness({ image: small.image });
	try {
		smallHarness.addShortcut("PiDeck.lnk", {});
		smallHarness.module.registerTaskbarIdentityAumid(AUMID);
		smallHarness.module.syncTaskbarShortcutIcon({ style: "pi-tui", customLogoDataUrl: null });
		assert.deepEqual(plain(small.resizeCalls), [], "256 边以内直接用原图");
	} finally {
		smallHarness.cleanup();
	}
});

test("syncTaskbarShortcutIcon: 非 Windows、未登记 AUMID、logo 不可解析都不产生副作用", () => {
	const linux = createHarness({ platform: "linux" });
	try {
		linux.addShortcut("PiDeck.lnk", {});
		linux.module.registerTaskbarIdentityAumid(AUMID);
		linux.module.syncTaskbarShortcutIcon({ style: "custom", customLogoDataUrl: null });
		assert.equal(linux.writes.length, 0);
		assert.equal(existsSync(linux.logoDir), false);
	} finally {
		linux.cleanup();
	}

	const unregistered = createHarness();
	try {
		unregistered.addShortcut("PiDeck.lnk", {});
		unregistered.module.syncTaskbarShortcutIcon({ style: "custom", customLogoDataUrl: null });
		assert.equal(unregistered.writes.length, 0);
		assert.equal(existsSync(unregistered.logoDir), false);
	} finally {
		unregistered.cleanup();
	}

	const noLogo = createHarness({ logoEntry: null });
	try {
		noLogo.addShortcut("PiDeck.lnk", {});
		noLogo.module.registerTaskbarIdentityAumid(AUMID);
		noLogo.module.syncTaskbarShortcutIcon({ style: "unknown", customLogoDataUrl: null });
		assert.equal(noLogo.writes.length, 0);
		assert.equal(noLogo.warnings.length, 0);
	} finally {
		noLogo.cleanup();
	}
});

test("syncTaskbarShortcutIcon: 单条快捷方式失败只告警，旧图标文件保留，其余条目照常更新", () => {
	const failing = createHarness({ failWrites: true });
	try {
		failing.addShortcut("PiDeck.lnk", {});
		mkdirSync(failing.logoDir, { recursive: true });
		writeFileSync(join(failing.logoDir, "taskbar-logo-deadbeef0000.ico"), "stale");
		failing.module.registerTaskbarIdentityAumid(AUMID);
		failing.module.syncTaskbarShortcutIcon({ style: "custom", customLogoDataUrl: null });
		assert.equal(failing.warnings.length, 1, "写失败要留日志");
		assert.equal(readdirSync(failing.logoDir).includes("taskbar-logo-deadbeef0000.ico"), true, "写失败时别删旧图标：它可能还被引用");
	} finally {
		failing.cleanup();
	}

	const readErrors = [];
	const corrupt = createHarness({ readErrors });
	try {
		const broken = corrupt.addShortcut("Broken.lnk", {});
		const good = corrupt.addShortcut("PiDeck.lnk", {});
		readErrors.push(broken);
		corrupt.module.registerTaskbarIdentityAumid(AUMID);
		corrupt.module.syncTaskbarShortcutIcon({ style: "custom", customLogoDataUrl: null });
		assert.deepEqual(plain(corrupt.writes.map((write) => write.file)), [good]);
		assert.equal(corrupt.warnings.length, 0, "坏快捷方式跳过不算失败");
	} finally {
		corrupt.cleanup();
	}
});
