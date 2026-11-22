import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 远端（SSH）项目只认「项目根 + 项目内相对路径」这组身份；会话里的远端绝对路径必须先归一，
// 否则打开文件会落进本机 fs，远端存在的文件被报成「路径不存在或已失效」。
const { normalizeRemoteAbsolutePath, remoteProjectRelativePath, remoteProjectTarget } = loadTsCommonJs("src/renderer/src/utils/remoteProjectPath.ts");

const remoteProject = (id, remotePath) => ({ id, name: id, lastOpenedAt: 0, locator: { kind: "ssh", hostId: "host-1", remotePath } });
const localProject = (id, path) => ({ id, name: id, lastOpenedAt: 0, path });

test("normalizes POSIX absolute paths lexically", () => {
	assert.equal(normalizeRemoteAbsolutePath("/home/u/proj/"), "/home/u/proj");
	assert.equal(normalizeRemoteAbsolutePath("/home//u/./proj/a.ts"), "/home/u/proj/a.ts");
	assert.equal(normalizeRemoteAbsolutePath("/home/u/proj/sub/../a.ts"), "/home/u/proj/a.ts");
	assert.equal(normalizeRemoteAbsolutePath("/"), "/");
	// 根处再 `..` 截断，不会逃出 `/`
	assert.equal(normalizeRemoteAbsolutePath("/../etc/passwd"), "/etc/passwd");
});

test("rejects anything that is not a POSIX absolute path", () => {
	assert.equal(normalizeRemoteAbsolutePath(""), null);
	assert.equal(normalizeRemoteAbsolutePath("src/a.ts"), null);
	assert.equal(normalizeRemoteAbsolutePath("./src/a.ts"), null);
	assert.equal(normalizeRemoteAbsolutePath("C:\\proj\\a.ts"), null);
	assert.equal(normalizeRemoteAbsolutePath("/home/u/a\u0000.ts"), null);
	assert.equal(normalizeRemoteAbsolutePath(`/${"a".repeat(4096)}`), null);
});

test("maps absolute paths inside the remote project to project-relative identities", () => {
	assert.equal(remoteProjectRelativePath("/home/u/proj/src/a.ts", "/home/u/proj"), "src/a.ts");
	assert.equal(remoteProjectRelativePath("/home/u/proj/src/a.ts", "/home/u/proj/"), "src/a.ts");
	assert.equal(remoteProjectRelativePath("/home/u/proj//./src/../src/a.ts", "/home/u/proj"), "src/a.ts");
	// 项目根自身是 `""`（ProjectFileTarget 的根口径）
	assert.equal(remoteProjectRelativePath("/home/u/proj", "/home/u/proj"), "");
	// 根为 `/` 的远端项目：去掉前导斜杠
	assert.equal(remoteProjectRelativePath("/etc/hosts", "/"), "etc/hosts");
});

test("refuses paths outside the remote project instead of guessing", () => {
	// 前缀相似的兄弟目录不能算项目内
	assert.equal(remoteProjectRelativePath("/home/u/proj2/a.ts", "/home/u/proj"), null);
	assert.equal(remoteProjectRelativePath("/home/u/other/a.ts", "/home/u/proj"), null);
	// 大小写不同即不同文件（Linux 远端）
	assert.equal(remoteProjectRelativePath("/home/u/Proj/a.ts", "/home/u/proj"), null);
	// 相对路径与非法根都不得命中
	assert.equal(remoteProjectRelativePath("src/a.ts", "/home/u/proj"), null);
	assert.equal(remoteProjectRelativePath("/home/u/proj/a.ts", ""), null);
	assert.equal(remoteProjectRelativePath("/home/u/proj/a.ts", "home/u/proj"), null);
});

test("picks the remote project that owns the path, preferring the pane project", () => {
	const projects = [localProject("local", "/home/u/proj"), remoteProject("outer", "/srv"), remoteProject("inner", "/srv/app")];
	// 嵌套远端根：本栏项目的根更深时按本栏项目身份走，不被外层项目抢走
	assert.equal(JSON.stringify(remoteProjectTarget(projects, "/srv/app/src/a.ts", "inner")), JSON.stringify({ projectId: "inner", relativePath: "src/a.ts" }));
	// 无本栏偏好时按项目列表顺序
	assert.equal(JSON.stringify(remoteProjectTarget(projects, "/srv/app/src/a.ts")), JSON.stringify({ projectId: "outer", relativePath: "app/src/a.ts" }));
	// 项目根本身
	assert.equal(JSON.stringify(remoteProjectTarget(projects, "/srv", "outer")), JSON.stringify({ projectId: "outer", relativePath: "" }));
});

test("never claims a local project path for a remote project", () => {
	const projects = [localProject("local", "/home/u/proj"), remoteProject("remote", "/srv/app")];
	// 本机项目的路径不是远端身份，不能当 target 打开
	assert.equal(remoteProjectTarget(projects, "/home/u/proj/src/a.ts"), null);
	// 哪里都不在的路径同样返回 null（调用方拒绝，不猜）
	assert.equal(remoteProjectTarget(projects, "/tmp/a.ts", "remote"), null);
});
