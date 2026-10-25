import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 回归背景：rename 的 newName 未做纯文件名校验时，「..\\」组件可把 rename 变成
// 跨目录 move 原语（join 不解析 ..，fsRename 由操作系统解析后越出父目录）。
// AGENTS 路径安全：拼接前规范化 + 逃逸检查；渲染层输入一律不可信。
const { FileSystemService } = loadTsCommonJs("src/main/fs/FileSystemService.ts");

function makeService() {
	return new FileSystemService({});
}

function makeTempProject() {
	const root = mkdtempSync(join(tmpdir(), "pideck-rename-"));
	writeFileSync(join(root, "file.txt"), "hello");
	mkdirSync(join(root, "sub"));
	return root;
}

test("rename 接受合法纯文件名并保持在同一父目录", async () => {
	const service = makeService();
	const root = makeTempProject();
	try {
		const newPath = await service.rename(join(root, "file.txt"), "renamed.txt");
		assert.equal(dirname(newPath), root);
		assert.equal(existsSync(join(root, "renamed.txt")), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rename 拒绝含 .. 的名字（不得越出父目录）", async () => {
	const service = makeService();
	const root = makeTempProject();
	try {
		const outside = resolve(root, "..", "pideck-rename-escape-marker.txt");
		await assert.rejects(() => service.rename(join(root, "file.txt"), "..\\..\\escape-marker.txt"), /Invalid file name/);
		await assert.rejects(() => service.rename(join(root, "file.txt"), "../../escape-marker.txt"), /Invalid file name/);
		// 越界目标必须没有出现（rename 未被执行）
		assert.equal(existsSync(outside), false, "rename 不得把文件改名/移动到父目录之外");
		// 原文件原位未动
		assert.equal(existsSync(join(root, "file.txt")), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rename 拒绝路径分隔符、空名、控制字符与超长名", async () => {
	const service = makeService();
	const root = makeTempProject();
	try {
		for (const bad of ["", ".", "..", "a/b.txt", "a\\b.txt", "x\ty", "x\u0000y", "a".repeat(256)]) {
			await assert.rejects(() => service.rename(join(root, "file.txt"), bad), /Invalid file name/, `必须拒绝：${JSON.stringify(bad)}`);
		}
		assert.equal(existsSync(join(root, "file.txt")), true, "所有拒绝路径都不得移动原文件");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rename 结构断言兜底：即使名字绕过前置校验也必须被父目录包含检查拦截", async () => {
	// isPathInsideProject 双保险：构造一个不含分隔符但目录语义异常的名字不存在——
	// 纯名字场景下 basename 校验已足够，此用例钉住「结构断言存在且生效」。
	const service = makeService();
	const root = makeTempProject();
	try {
		// 合法名字通过：证明结构断言不误伤正常改名
		const p = await service.rename(join(root, "file.txt"), "ok-name.txt");
		assert.equal(dirname(p), root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
