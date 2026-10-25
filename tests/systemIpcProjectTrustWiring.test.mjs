/**
 * 回归：registerSystemIpc 的 isProjectTrusted 必须在 index.ts 注入。
 *
 * 漏注入时 `isProjectTrusted` 是 undefined → 项目作用域**全部按未信任处理**：
 * 项目 MCP 读写（configGetMcp）、项目 MCP 的 `pi mcp` CLI、piResources 的项目级内置扩展开关
 * 都会报 “Project is not trusted.”，而且与 trust.json 里实际写了什么无关。
 * 用户实测：在信任页把项目标成已信任后，项目资源管理里的「pi 内置扩展」仍然报错。
 *
 * 注意 WSL：信任判定用发行版内 Linux 路径（trust.json 键也是 Linux 路径），
 * 与 storeIpc 的 projectTrustPath 同源，别在这里退化成宿主路径。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("index.ts 必须给 registerSystemIpc 注入 isProjectTrusted", () => {
	const index = readFileSync("src/main/index.ts", "utf8");
	const call = /registerSystemIpc\(\{([\s\S]*?)\n\t\}\);/.exec(index);
	assert.ok(call, "未找到 registerSystemIpc 调用");
	const deps = call[1];
	assert.match(deps, /isProjectTrusted: async \(projectId, projectRoot\) => \{/);
	// 必须读 trust.json 的最近父目录决策，不能用本地缓存或常量
	assert.match(deps, /configManager\.getProjectTrustDecision\(trustPath\)\) === true/);
	// WSL 项目：信任键是发行版内 Linux 路径
	assert.match(deps, /toWslLinuxPath\(projectRoot, \{ distro: settings\.wslDistro \}\)/);
});

test("systemIpc 的项目作用域门禁在未装配时按未信任处理（不得默认放行）", () => {
	const source = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
	assert.match(source, /isProjectTrusted \? await isProjectTrusted\(projectId, root\) : false/);
	assert.match(source, /if \(!isProjectTrusted\) throw new Error\(mainCopy\("mainProjectResource\.projectNotTrusted"\)\)/);
});
