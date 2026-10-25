/**
 * 会话数据面（Wave 1：Go session-store sidecar 骨架）的链路契约测试。
 *
 * Wave 1 没有 IPC、没有消费者，价值全在「骨架正确 + 接线登记齐全」：
 * - Go 侧协议常量/命令集/忽略目录/行上限与 TS 宿主一一对应（两边手写镜像，靠这些断言钉住）；
 * - 宿主服务的 spawn 形态（argv 只带 statePath，roots 逐请求）与生命周期入口存在；
 * - 装配（二进制定位 + quitCleanup 登记）与构建/CI/打包登记齐全——漏一处就是「装了但拉不起来」。
 * 正则全部空白容忍（biome 重排格式不破坏断言）。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "utf8");

test("Go 侧协议与快照口径：命令集、版本、忽略目录、行上限", () => {
	const mainSource = read("../native/session-store/main.go");
	assert.match(mainSource, /protocolVersion\s*=\s*1/);
	assert.match(mainSource, /case\s*"list-files",\s*"refresh":/);
	assert.match(mainSource, /logPrefix\s*=\s*"\[session-store\]\s?"/);

	const storeSource = read("../native/session-store/store.go");
	assert.match(storeSource, /snapshotFormatVersion\s*=\s*1/);
	// 与 TS 侧扫描口径一致：成品归档与子代理产物不是可读会话
	assert.match(storeSource, /"\.pideck-archive":\s*true/);
	assert.match(storeSource, /"subagent-artifacts":\s*true/);
	// 原子落盘：先写 .tmp 再改名
	assert.match(storeSource, /tmpPath\s*:=\s*s\.statePath\s*\+\s*"\.tmp"/);

	const scanSource = read("../native/session-store/scan.go");
	// 与 jsonlLineStream.ts 的 MAX_JSONL_LINE_BYTES 同口径
	assert.match(scanSource, /maxScanLineBytes\s*=\s*64\s*\*\s*1024\s*\*\s*1024/);
	// 行边界提交：残行不推进已提交字节数
	assert.match(scanSource, /CommittedSize\s*\+=/);
});

test("宿主服务：argv 只有 statePath（+可选 tablesDir），roots 逐请求，生命周期入口齐全", () => {
	const source = read("../src/main/sessions/SessionStoreService.ts");
	const sidecarSource = read("../src/main/sidecar/GoSidecarClient.ts");
	assert.match(source, /SESSION_STORE_PROTOCOL_VERSION\s*=\s*1/);
	// 与两个兄弟服务的差异点：roots 不进 spawn 参数，换根不重启进程。
	// 共享传输层负责 spawn；本服务只把 statePath(+tablesDir) 作为 args 传进去。
	assert.match(source, /const args = this\.tablesDir \? \[this\.statePath, this\.tablesDir\] : \[this\.statePath\];/);
	assert.match(source, /ensureReady\(STORE_PROCESS_KEY, args\)/);
	assert.match(sidecarSource, /spawnFn\(binaryPath, \[\.\.\.args\],/);
	assert.doesNotMatch(source, /spawnFn\(binaryPath/);
	assert.match(source, /cmd:\s*"list-files",\s*roots:/);
	assert.match(source, /cmd:\s*"refresh",\s*roots:/);
	assert.match(source, /isReady\(\):\s*boolean/);
	assert.match(source, /warmup\(\):\s*void/);
	// dispose 收口在共享基类，服务只继承（禁止各服务再写一套杀进程逻辑）
	assert.match(source, /extends\s+GoSidecarClient/);
	assert.match(sidecarSource, /dispose\(\):\s*void/);
	// fail-open：二进制缺失走 binary-missing（调用方降级到 TS 解析）；文案由本服务注入
	assert.match(sidecarSource, /this\.fail\("binary-missing",\s*this\.messages\.binaryMissing\)/);
	assert.match(source, /binaryMissing:/);
});

test("装配：二进制定位（dev 走 resources/session-store/bin）+ statePath 落 userData + quitCleanup", () => {
	const source = read("../src/main/index.ts");
	assert.match(source, /import\s*\{\s*SessionStoreService\s*\}\s*from\s*"\.\/sessions\/SessionStoreService"/);
	assert.match(source, /new SessionStoreService\(\{/);
	assert.match(source, /statePath:\s*join\(app\.getPath\("userData"\),\s*"session-store",\s*"state\.bin"\)/);
	assert.match(source, /join\(app\.getAppPath\(\),\s*"resources",\s*"session-store",\s*"bin"\)/);
	assert.match(source, /join\(process\.resourcesPath,\s*"session-store"\)/);
	assert.match(source, /quitCleanup\.register\("session-store"/);
});

test("构建与打包登记：build 脚本 fail-open、npm script 进 build 链、产物目录被忽略", () => {
	assert.equal(existsSync(new URL("../native/session-store/go.mod", import.meta.url)), true);
	assert.equal(existsSync(new URL("../resources/session-store/bin/.gitkeep", import.meta.url)), true);

	const script = read("../scripts/build-session-store.mjs");
	assert.match(script, /native",\s*"session-store"/);
	assert.match(script, /resources",\s*"session-store",\s*"bin"/);
	// fail-open：Go 工具链缺失/构建失败只告警，不让 CI 红灯
	assert.match(script, /probe\.error\s*\|\|\s*probe\.status\s*!==\s*0/);
	assert.match(script, /process\.exitCode\s*=\s*0/);
	assert.match(script, /SESSION_STORE_OS/);
	// Wave 1 刻意不进 extraResources（无消费者），注释里写明接线时才补
	assert.match(script, /Wave 1 暂不进 extraResources/);

	const pkg = JSON.parse(read("../package.json"));
	assert.equal(typeof pkg.scripts["build:session-store"], "string");
	assert.match(pkg.scripts.build, /npm run build:session-store/);
	assert.match(read("../.gitignore"), /resources\/session-store\/bin\/\*/);
	assert.match(read("../.gitignore"), /!resources\/session-store\/bin\/\.gitkeep/);
	assert.match(read("../scripts/dev.js"), /npm run build:session-store/);
});

test("CI：三平台都跑 session-store 的 Go 单测并注入交叉编译目标", () => {
	for (const workflow of ["build-linux.yml", "build-windows.yml", "build-macos.yml"]) {
		const source = read(`../.github/workflows/${workflow}`);
		assert.match(source, /go -C native\/session-store test \.\/\.\.\./, `${workflow} 缺 session-store 单测`);
		assert.match(source, /SESSION_STORE_OS:\s*\w+/, `${workflow} 缺 SESSION_STORE_OS`);
		assert.match(source, /SESSION_STORE_ARCH:\s*\$\{\{\s*matrix\.arch\s*\}\}/, `${workflow} 缺 SESSION_STORE_ARCH`);
	}
});

test("Wave 2 Go 侧：get-index 命令 + 条目表镜像 + 缓存边界", () => {
	const mainSource = read("../native/session-store/main.go");
	assert.match(mainSource, /case\s*"get-index":/);
	assert.match(mainSource, /getIndexTable\(/);

	const tableSource = read("../native/session-store/table.go");
	// 行级镜像：与 TS 的 parseIndexLine 同口径（过渡语义见 tests/sessionStoreIndexParity.test.mjs）
	assert.match(tableSource, /func parseIndexEntry\(line string, offset int64, byteLength int64\)/);
	assert.match(tableSource, /func scanTable\(path string, size int64, mtimeMs float64\)/);
	// assistantModel 取自 message.provider/message.model（不是 message.model.provider 对象）
	assert.match(tableSource, /rawString\(message,\s*"provider"\)/);
	assert.match(tableSource, /rawString\(message,\s*"model"\)/);
	// 可选字段用指针 + omitempty：空字符串是保留值，不能被省略
	assert.match(tableSource, /json:"toolName,omitempty"/);

	const cacheSource = read("../native/session-store/indexcache.go");
	assert.match(cacheSource, /maxCachedTables\s*=/);
	assert.match(cacheSource, /maxCachedTableBytes\s*=/);
	assert.match(cacheSource, /func getIndexTable\(cache \*tableCache, path string\)/);
});

test("Wave 2 TS 侧：宿主 getIndex + 读者校验分支 + 装配注入", () => {
	const service = read("../src/main/sessions/SessionStoreService.ts");
	// 命令帧仍由本服务定义（共享基类只负责传输）；三种命令逐条钉住
	assert.match(service, /cmd:\s*"list-files",\s*roots:/);
	assert.match(service, /cmd:\s*"refresh",\s*roots:/);
	assert.match(service, /cmd:\s*"get-index",\s*roots:\s*\[\],\s*path:/);
	assert.match(service, /async getIndex\(hostPath: string\)/);
	// 条目表可能到几十 MB：单行上限放宽到 32MiB（仍是有界）
	assert.match(service, /MAX_SESSION_STORE_LINE_CHARS\s*=\s*32\s*\*\s*1024\s*\*\s*1024/);

	const reader = read("../src/main/pi/SessionHistoryReader.ts");
	// 子进程输出不可信：整体校验，形状不符即回退 TS 逐行解析
	assert.match(reader, /readIndexTable\?:\s*\(hostPath: string, version: \{ size: number; mtimeMs: number \}\) => Promise<unknown>/);
	assert.match(reader, /function parseIndexTableRows\(value: unknown\)/);
	assert.match(reader, /function parseIndexTableEntry\(value: unknown\)/);
	assert.match(reader, /const sidecarTable = this\.parseIndexTable\(await this\.requestIndexTable\(hostPath, version\), hostPath\)/);
	// 末尾无完整行时忽略 sidecar（残行口径不同）
	assert.match(reader, /table\.endsWithNewline === false\) return null/);

	const manager = read("../src/main/pi/AgentManager.ts");
	assert.match(manager, /setSessionStoreIndexReader\(/);
	assert.match(manager, /readIndexTable: \(hostPath, version\) => this\.sessionStoreIndexReader\?\.\(hostPath, version\) \?\? Promise\.resolve\(null\)/);

	const index = read("../src/main/index.ts");
	assert.match(index, /agentManager\.setSessionStoreIndexReader\(async \(hostPath\) => \{/);
	assert.match(index, /if \(!service \|\| !service\.isReady\(\)\) return null;/);
	assert.match(index, /const result = await service\.getIndex\(hostPath\)/);
});

test("Wave 2 parity 资产：fixture/基准/生成脚本齐备，基准与 fixture 配对", () => {
	assert.equal(existsSync(new URL("../tests/fixtures/sessionStoreIndexParity.jsonl", import.meta.url)), true);
	const goldenPath = new URL("../tests/fixtures/sessionStoreIndexParity.golden.json", import.meta.url);
	assert.equal(existsSync(goldenPath), true);
	const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
	assert.equal(golden.endsWithNewline, true);
	assert.equal(golden.entries.length >= 18, true);
	assert.equal(golden.path, "tests/fixtures/sessionStoreIndexParity.jsonl");
	assert.equal(golden.mtimeMs, 0);
	// 基准必须覆盖关键条目形态，避免 fixture 被改瘦后门禁变成空转
	for (const type of ["session", "message", "model_change", "thinking_level_change", "custom_message", "compaction", "context_edit", "custom"]) {
		assert.equal(
			golden.entries.some((entry) => entry.type === type),
			true,
			`基准缺少 ${type} 条目`,
		);
	}
	assert.equal(
		golden.entries.some((entry) => entry.assistantModel?.modelId === "gpt-5.2-codex"),
		true,
	);
	assert.equal(
		golden.entries.some((entry) => entry.toolName === ""),
		true,
	);
	assert.match(read("../scripts/genSessionStoreIndexGolden.mjs"), /tests",\s*"fixtures",\s*"sessionStoreIndexParity\.golden\.json"/);
	assert.match(read("../native/session-store/parity_test.go"), /TestIndexTableMatchesGolden/);
});

test("Wave 2b：条目表落盘默认开启（可闸），落盘目录与 extraResources 已登记", () => {
	// Wave 2 门禁未过 → Wave 2b 把条目表落盘后重启首次打开 14–20ms（§8.11），因此默认开；
	// 开关仍在：settings.json 置 false 即回退纯 TS 解析。
	const settingsStore = read("../src/main/settings/SettingsStore.ts");
	assert.match(settingsStore, /sessionStoreEnabled:\s*true/);
	const sharedSettings = read("../src/shared/types/settings.ts");
	assert.match(sharedSettings, /sessionStoreEnabled\?:\s*boolean;/);
	assert.match(sharedSettings, /sessionStoreEnabled:\s*true/);
	const index = read("../src/main/index.ts");
	assert.match(index, /if \(!settingsStore\.get\(\)\.sessionStoreEnabled\) return null;/);
	// 默认开时必须预热，否则「只在已就绪时问」的读者路径永远不会生效
	assert.match(index, /if \(settingsStore\.get\(\)\.sessionStoreEnabled\) sessionStoreService\.warmup\(\);/);
	// 条目表目录必须接进装配，否则 sidecar 退化成纯内存缓存（等于回到 Wave 2）
	assert.match(index, /tablesDir:\s*join\(app\.getPath\("userData"\),\s*"session-store",\s*"tables"\)/);
	// 打包：二进制必须随包，否则打包后永远 binary-missing
	const pkg = JSON.parse(read("../package.json"));
	const entry = (pkg.build.extraResources ?? []).find((item) => item.to === "session-store");
	assert.ok(entry, "session-store 必须进 extraResources");
	assert.deepEqual(entry.filter, ["session-store", "session-store.exe"]);
	assert.match(String(pkg.scripts.build), /npm run build:session-store/);
	// 收益结论必须留档，否则默认值没人知道为什么开
	const plan = read("../docs/session-data-plane-plan.md");
	assert.match(plan, /### 8\.11/);
});
