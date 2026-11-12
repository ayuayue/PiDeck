import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { nvmNodeVersionDirs } = loadTsCommonJs("src/main/pi/nvmNodeVersions.ts");

/** 建一个假的 nvm 根：versions/node/<版本> 目录 + alias/<名字> 文件。 */
function withNvm({ versions, aliases = {} }, run) {
	const root = mkdtempSync(join(tmpdir(), "pideck-nvm-order-"));
	try {
		for (const version of versions) mkdirSync(join(root, "versions", "node", version), { recursive: true });
		for (const [name, value] of Object.entries(aliases)) {
			mkdirSync(join(root, "alias", name, ".."), { recursive: true });
			writeFileSync(join(root, "alias", name), `${value}\n`);
		}
		const versionsRoot = join(root, "versions", "node");
		run(() => Array.from(nvmNodeVersionDirs(root), (dir) => dir.slice(versionsRoot.length + 1)));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

const INSTALLED = ["v20.1.0", "v22.22.1", "v24.21.0", "v9.11.2"];

test("没有 default 别名：按版本号新到旧，而不是目录名字母序", () => {
	withNvm({ versions: INSTALLED }, (order) => {
		assert.deepEqual(order(), ["v24.21.0", "v22.22.1", "v20.1.0", "v9.11.2"]);
	});
});

test("default=node / stable 取最新版", () => {
	for (const value of ["node", "stable"]) {
		withNvm({ versions: INSTALLED, aliases: { default: value } }, (order) => {
			assert.equal(order()[0], "v24.21.0");
		});
	}
});

test("default 为版本前缀或完整版本时，该版本排第一，其余仍新到旧", () => {
	withNvm({ versions: [...INSTALLED, "v20.19.0"], aliases: { default: "20" } }, (order) => {
		assert.deepEqual(order(), ["v20.19.0", "v24.21.0", "v22.22.1", "v20.1.0", "v9.11.2"]);
	});
	withNvm({ versions: INSTALLED, aliases: { default: "v22.22.1" } }, (order) => {
		assert.equal(order()[0], "v22.22.1");
	});
});

test("default 沿别名链解析（自定义别名、lts/*）", () => {
	withNvm({ versions: INSTALLED, aliases: { default: "work", work: "v20.1.0" } }, (order) => {
		assert.equal(order()[0], "v20.1.0");
	});
	// nvm 的 `lts/*` 别名是一个带斜杠的文件名；Windows 无法创建含 `*` 的文件，该分支仅 POSIX 可验。
	if (process.platform !== "win32") {
		withNvm({ versions: INSTALLED, aliases: { default: "lts/*", "lts/*": "lts/jod", "lts/jod": "v22.22.1" } }, (order) => {
			assert.equal(order()[0], "v22.22.1");
		});
	}
});

test("default 指向未安装版本、system、越界路径或循环别名时退回最新版", () => {
	for (const aliases of [{ default: "v18.0.0" }, { default: "system" }, { default: "../../outside" }, { default: "loop", loop: "default" }]) {
		withNvm({ versions: INSTALLED, aliases }, (order) => {
			assert.equal(order()[0], "v24.21.0", JSON.stringify(aliases));
		});
	}
});

test("非版本号目录保留在末尾；没有 nvm 目录时返回空", () => {
	withNvm({ versions: ["v20.1.0", "custom-build", "v24.21.0"] }, (order) => {
		assert.deepEqual(order(), ["v24.21.0", "v20.1.0", "custom-build"]);
	});
	assert.equal(nvmNodeVersionDirs(join(tmpdir(), `pideck-no-nvm-${process.pid}`)).length, 0);
});
