import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const smoke = require("../scripts/packaged-boot-smoke.js");

/**
 * ldd 归类：误报全都出在「把宿主运行时提供的符号当成缺失」。
 * 真实样本取自 v0.9.0 deb 在缺 GUI 库机器上的 `ldd` 输出。
 */
test("ldd 解析把「目标机缺库」算问题，把宿主提供的符号与跨平台产物放过", () => {
	assert.deepEqual(smoke.classifyLddLine("\tlibnss3.so => not found"), { kind: "missing", lib: "libnss3.so" });
	assert.deepEqual(smoke.classifyLddLine("\tlibc.musl-x86_64.so.1 => not found"), null, "musl 变体在 glibc 机器上永不加载");
	assert.equal(smoke.classifyLddLine("ldd : /tmp/pkg/pty.node: version `GLIBC_2.34' not found (required by /tmp/pkg/pty.node)").kind, "version", "统信/麒麟上的典型死法");
	assert.equal(smoke.classifyLddLine("\t/tmp/lib/libc.so.6 (0x00007f1a)"), null);
	assert.equal(smoke.classifyLddLine("undefined symbol: napi_call_function\t(/tmp/koffi.node)"), null, "napi 符号由 Electron 主程序在 dlopen 时提供");
});

test("extraResources 清单：生成目录缺席不算包的缺陷", () => {
	const { names } = smoke.expectedResourceNames();
	const generated = names.find((entry) => entry.to === "dsh-runtime");
	if (generated) {
		assert.equal(generated.required, false, `源 ${generated.from} 由 npm run runtime:pack 生成，发版走 sidecar`);
	}
	for (const entry of names.filter((item) => item.from.startsWith("resources/"))) {
		assert.equal(entry.required, true, `resources/* 是仓库里的真随包资源，必须算硬要求：${entry.from}`);
	}
});

test("资源完整性检查对缺席的必需资源报错，对可选资源只提示", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-boot-smoke-"));
	try {
		await mkdir(join(root, "resources"), { recursive: true });
		await writeFile(join(root, "resources", "app.asar"), "asar");
		const required = { to: "pi-auth-host.mjs", from: "resources/pi-auth-host.mjs", required: true };
		const optional = { to: "dsh-runtime", from: "dist-runtime/dsh-runtime", required: false };
		const missing = smoke.inspectResources(root, { names: [required, optional], expectsNodePtyUnpack: false });
		assert.equal(missing.problems.length, 1, `应只报必需资源缺席：${missing.problems.join(" | ")}`);
		assert.match(missing.problems[0], /pi-auth-host\.mjs/);
		assert.equal(
			missing.notes.some((note) => note.includes("dsh-runtime")),
			true,
			"可选缺席降级为提示",
		);

		await writeFile(join(root, "resources", "pi-auth-host.mjs"), "// host");
		const complete = smoke.inspectResources(root, { names: [required, optional], expectsNodePtyUnpack: false });
		assert.equal(complete.problems.filter((problem) => problem.includes("pi-auth-host")).length, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
