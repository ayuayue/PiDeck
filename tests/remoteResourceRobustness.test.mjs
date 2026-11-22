import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 远端 Agent 能力（skills / prompts / extensions）的列表不能因为「一个文件读不了」就整页挂掉。
 *
 * 2026-11-19 用户实测：远端装了 `npm:@cortexkit/pi-magic-context`，它的 `dist/index.js` 超过 1 MiB 且被
 * 声明为 `pi.extensions`；helper 的 discover() 在 bytes() 处报 RESOURCE_TOO_LARGE，而 resources.list 是
 * 全有全无——主进程把该码映射成 PI_RESOURCE_FILE_INVALID，于是「扩展 / 技能 / 提示词模板」连同
 * 「Pi 内置扩展」一起报错，用户只能把包卸掉才能恢复。
 *
 * 同一条链上还有第二个洞：helper 用 TextDecoder 默认行为解码（丢掉 UTF-8 BOM），而版本号是**原始字节**的
 * sha256，主进程按 content 重算必然不等 —— 任何一个 BOM 开头的 SKILL.md / .md 都会让整页失败。
 *
 * 这里同时钉住三件事：
 * 1. BOM 文件保字节（version == sha256(content)），主进程校验通过；
 * 2. 超过单文件上限的包内条目被跳过，其余条目照常返回；
 * 3. 非 UTF-8 文本被跳过，不牵连整份列表。
 */
const { REMOTE_CONFIG_SOURCE } = loadTsCommonJs("src/main/remote/RemoteConfigSource.ts");
const { REMOTE_RESOURCE_SOURCE } = loadTsCommonJs("src/main/remote/RemoteResourceSource.ts");
const { createRemotePiResourceBackend } = loadTsCommonJs("src/main/config/RemotePiResourceBackend.ts");

const HOST = "11111111-1111-4111-8111-111111111111";
const HOME = "/home/tester";
const factory = (source, name) => new Function(source.replace("export function " + name, "function " + name) + "\nreturn " + name + ";")();

/** HOME 的父目录也一起映射：discover() 的 safe() 从 "/" 逐段 lstat，只映射 HOME 会让它一路返回 null。 */
function fixture(t) {
	const root = fs.mkdtempSync(path.join(tmpdir(), "pideck-remote-resources-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const home = path.join(root, "tester");
	const agent = path.join(home, ".pi/agent");
	fs.mkdirSync(agent, { recursive: true });
	const map = (value) => (typeof value === "string" && value.startsWith("/home") ? root + value.slice("/home".length) : value);
	const mappedFs = new Proxy(fs, {
		get(target, key) {
			const value = target[key];
			if (key === "lstatSync") return (p, options) => fs.lstatSync(map(p), options ?? { bigint: true });
			return typeof value === "function" ? (...args) => value(...args.map(map)) : value;
		},
	});
	const config = factory(REMOTE_CONFIG_SOURCE, "createConfigScope")(HOME, mappedFs, path.posix, crypto);
	const resources = factory(REMOTE_RESOURCE_SOURCE, "createResourceScope")(HOME, path.posix.join(HOME, "project"), mappedFs, path.posix, crypto, factory(REMOTE_CONFIG_SOURCE, "createConfigScope"), config);
	const write = (rel, content) => {
		const target = path.join(agent, rel);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
	};
	/** 走一遍主进程侧的真实校验：本站拒绝任何 helper 结果时，页面就是这个码。 */
	const accept = async (result) => {
		const backend = createRemotePiResourceBackend({
			request: async () => result,
			resolveFacts: async () => ({ piPath: "/usr/bin/pi", nodePath: "/usr/bin/node", version: "1.5.2", home: HOME }),
			run: async () => ({ exitCode: 0, stdout: "" }),
		});
		return backend.execute(HOST, { action: "list" });
	};
	return { resources, accept, write, agent, settings: (value) => fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify(value)) };
}

test("a UTF-8 BOM keeps its bytes, so the main-side version check agrees", async (t) => {
	const f = fixture(t);
	f.settings({});
	f.write("skills/bom/SKILL.md", '\uFEFF---\nname: bom\ndescription: "带 BOM 的技能"\n---\n\n正文\n');
	f.write("prompts/bom.md", "\uFEFF---\ndescription: 带 BOM 的提示词\n---\n正文\n");
	const list = f.resources.list();
	assert.equal(list.files.length, 2);
	for (const file of list.files) {
		assert.equal(file.content.charCodeAt(0), 0xfeff, file.path + " 必须原样保留 BOM");
		assert.equal(crypto.createHash("sha256").update(file.content, "utf8").digest("hex"), file.version, file.path + " 的版本号必须是原始字节的 sha256");
	}
	// frontmatter 解析要能穿过 BOM，否则技能名会是空的（发现结果同样按 BOM 容忍解析）。
	assert.deepEqual(
		list.discovery.skills.map((entry) => entry.name),
		[],
		"未在 settings 里声明时不进入发现结果",
	);
	const accepted = await f.accept(list);
	assert.equal(accepted.files.length, 2);
});

test("an oversized declared extension is skipped instead of failing the whole listing", async (t) => {
	const f = fixture(t);
	const pkg = "npm/node_modules/big-extension-package";
	f.write(pkg + "/package.json", JSON.stringify({ name: "big-extension-package", pi: { extensions: ["./dist"] } }));
	// pi-extensions 里单个文件的上限是 1 MiB：一个打包后的 dist 很容易越过它。
	f.write(pkg + "/dist/index.js", "x".repeat(1048577));
	f.write(pkg + "/dist/small.js", "export default {};\n");
	f.settings({ packages: ["npm:big-extension-package"] });
	f.write("skills/keep/SKILL.md", '---\nname: keep\ndescription: "还在"\n---\n');
	const list = f.resources.list();
	assert.deepEqual(
		list.discovery.extensions.map((entry) => path.posix.basename(entry.path)),
		["small.js"],
		"只有超限的那一条被跳过",
	);
	const accepted = await f.accept(list);
	assert.equal(accepted.files.length, 1, "技能列表不受包内超限条目影响");
});

test("a file that is not UTF-8 text is skipped, not fatal", async (t) => {
	const f = fixture(t);
	f.settings({});
	f.write("prompts/good.md", "---\ndescription: ok\n---\n正文\n");
	// latin-1 字节：pi 自己也读不成文本，不能因此让整份列表失败。
	fs.writeFileSync(path.join(f.agent, "prompts/legacy.md"), Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0x64, 0x65, 0x73, 0x63, 0x3a, 0x20, 0xe9, 0x0a, 0x2d, 0x2d, 0x2d, 0x0a]));
	const list = f.resources.list();
	assert.deepEqual(
		list.files.map((file) => file.path),
		["good.md"],
	);
	const accepted = await f.accept(list);
	assert.equal(accepted.files.length, 1);
});
