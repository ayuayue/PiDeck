import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { readSessionCatalogSourceOrFile, readSessionCatalogSources } from "./helpers/sessionCatalogSources.mjs";

const { HOST_REFERENCE_SOURCES } = loadTsCommonJs("src/main/remote/RemoteHostReferenceRegistry.ts");

// Each typed or decoded host reference must have an owner in the registry's source vocabulary.
// Production provider registration is a separate gate and is not yet wired.
//
// `runtime` owns the IPC result types below: they echo back the hostId they were called with so a
// response stays attributable to its request, but they are transient and persist nothing, so they
// cannot keep a profile from being retired. That is exactly what the `runtime` source declares
// (`canHoldHostReferences: false`). Recording them here is the point of this test: if a future change
// makes any of them durable, the owner has to be revisited rather than silently inherited.
const COVERED_HOST_ID_FIELDS = new Map([
	["src/shared/types/project.ts:ProjectLocation", "projects"],
	["src/shared/types/project.ts:ProjectLocator", "projects"],
	["src/shared/types/session.ts:SessionLocator", "sessions"],
	["src/main/projects/projectStoreCodec.ts:readSshLocator", "projects"],
	// locator 的唯一判据（写入 / codec 读取 / 引用扫描三处共用）。ProjectStore 落盘与
	// RemoteHostReferenceSources 扫描都经由它，所以持久化引用的真正来源在这里；
	// 漏掉这个文件会让「谁在引用某台主机」的审计凭空少一层。
	["src/shared/projectLocation.ts:readSshProjectLocator", "projects"],
	// 同一文件里的会话判据：catalog 读取 / 远端登记写入 / 主机引用扫描三处共用，hostId 与项目域
	// 同一个 UUID 值域。漏登记它同样会让「谁在引用某台主机」的审计少一层。
	["src/shared/projectLocation.ts:readSshSessionLocator", "sessions"],
	// 登记写入侧的 hostId 判据（shared readSshSessionLocator）也归 sessions：它决定了下一次 catalog
	// 写入里会不会出现一条非法的 host 引用。
	["src/main/sessions/SessionCatalog.ts:isRemoteSessionRegistrationInput", "sessions"],
	["src/main/sessions/SessionCatalog.ts:hostRebindTargetLocator", "sessions"],
	// G3 远端 Session 登记（远端身份 → ssh locator 的匹配与构造）：这四个名字只服务于把远端会话登记进
	// catalog 的那条引用——真正落盘的是 SessionLocator（已由 sessions 源覆盖）。归 sessions 而不是 runtime，
	// 因为它们是「下一次 catalog 写入里那条 host 引用的来源」；hostRebindTargetLocator 是同类先例。
	["src/main/sessions/SessionCatalog.ts:RemoteSessionIdentity", "sessions"],
	["src/main/sessions/SessionCatalog.ts:RemoteSessionRegistrationInput", "sessions"],
	["src/main/sessions/SessionCatalog.ts:remoteSessionIdentity", "sessions"],
	["src/main/sessions/SessionCatalog.ts:remoteSessionLocator", "sessions"],
	// P4.5b 远端归档索引：hostId 与归档条目一起落进 catalog（持久化引用），归 sessions 源。
	// 它是「下一次 catalog 写入里那条 host 引用的来源」，与上面四个远端登记名字同类。
	// P4.5a 的远端墓碑：墓碑条目类型与「(hostId, remoteSessionId) → 墓碑键」的派生函数，属主同为 sessions
	//（与上面的远端归档索引同一份 catalog 文件）。具名类型后 catalog 文件类型本身不再需要单独登记。
	["src/main/sessions/SessionCatalog.ts:DismissedRemoteSessionEntry", "sessions"],
	["src/main/sessions/SessionCatalog.ts:readRemoteDismissalKey", "sessions"],
	["src/main/sessions/SessionCatalog.ts:ArchivedRemoteSessionEntry", "sessions"],
	["src/main/sessions/SessionCatalog.ts:readArchivedRemoteSessionEntry", "sessions"],
	["src/shared/types/remoteHost.ts:RemoteHostConnectResult", "runtime"],
	["src/shared/types/remoteHost.ts:RemoteHostDisconnectResult", "runtime"],
	["src/shared/types/remoteHost.ts:RemoteHostDiagnosticsResult", "runtime"],
	["src/shared/types/remoteHost.ts:RemoteHostOperationFailure", "runtime"],
	// 添加主机的结果只是回显 hostId（一个刚建的 draft/刚验证的主机），不持久化引用。
	["src/shared/types/remoteHost.ts:RemoteHostAddResult", "runtime"],
	// 编辑结果回显被编辑的主机 id；编辑本身是原位更新，不新建引用。
	["src/shared/types/remoteHost.ts:RemoteHostUpdateResult", "runtime"],
	// 编辑表单初值只回显「正在编辑哪台主机」，口令与字段都不落盘（口令走系统密钥库）。
	["src/shared/types/remoteHost.ts:RemoteHostEditDraftResult", "runtime"],
	// 移除主机的结果只回显刚移除的 id；真正的清理由 store 完成，不形成新的持久化引用。
	["src/shared/types/remoteHost.ts:RemoteHostRemoveResult", "runtime"],
	// 状态推送只是告诉界面「哪台主机变成什么状态」，不持久化任何东西。
	["src/shared/types/remoteHost.ts:RemoteHostStateChange", "runtime"],
	// 修复确认请求只是告知界面「要修哪台主机」，不持久化引用。
	["src/shared/types/remoteHost.ts:RemoteHostRepairRequest", "runtime"],
	// 项目登记确认请求/结果：告知界面「把哪台主机的哪个目录登记为项目」，hostId 只是回显，
	// 真正持久化的引用写在 ProjectStore 的 ssh locator（由 projects 源扫描）。
	["src/shared/types/remoteHost.ts:RemoteProjectEnrollRequest", "runtime"],
	["src/shared/types/remoteHost.ts:RemoteProjectEnrollResult", "runtime"],
	// 新建空目录确认请求：hostId 只是回显「在哪台主机上创建」，不落盘；真正持久化的引用仍是 ProjectStore 的 ssh locator。
	["src/shared/types/remoteHost.ts:RemoteProjectCreateRequest", "runtime"],
	// 目录浏览结果只回显 hostId + 一次探针结果，不持久化引用；项目登记仍写 ProjectStore 的 ssh locator。
	["src/shared/types/remoteHost.ts:RemoteDirectoryListResult", "runtime"],
	// 远端 pi 探测结果只回显调用方的主机 id + 一次只读探测事实（版本/路径），不写任何东西；
	// 手填的 pi 路径写在主机档案自己的字段上（随档案生命周期），不形成新的引用。
	["src/shared/types/remoteHost.ts:RemoteHostPiProbeResult", "runtime"],
	// Phase 5 模型目录探测（task-18）：结果只回显调用方的 hostId，不持久化任何引用；真正的模型
	// catalog 数据来自远端 runtime，随会话生命周期消失。归 runtime 源（canHoldHostReferences: false）。
	["src/shared/types/remoteModel.ts:RemoteModelProbeResult", "runtime"],
	// 远端项目 trust 决策（P4.4b）：这两个结构真的落盘（桌面 settings.json 的 remoteProjectTrust 段，
	// 随配置备份一起走），但归 host-profiles 而不是新开一个源，理由就是它们的生命周期完全绑在主机档案上：
	//   - hostId 之外，每条记录还绑了 pin 密码学事实的摘要（endpointDigest）与规范项目根 ⇒ 换了 endpoint
	//     就命中不到（fail-closed），换了主机就命中不到（id 永不复用）；
	//   - 主机退役时由 RemoteHostStore 的 onHostRetired 钩子（与 pin 清理同一位置、同一重试语义）清掉，
	//     因此它**不参与**引用扫描、也不该阻塞 retire——把它登记成 projects/sessions 那种引用源会把
	//     「删主机前先撤销信任」变成硬前置，而产品语义是随主机一起清。
	// 若将来「主机退役不再清理 trust」或「trust 记录可以被另一台主机命中」，这个属主必须重新审视。
	["src/shared/types/remoteTrust.ts:RemoteProjectTrustRecord", "host-profiles"],
	["src/shared/types/remoteTrust.ts:RemoteProjectTrustEntry", "host-profiles"],
	// 决策请求 DTO（remote:trust-set 的入参）：只是渲染层回显 hostId 的一次调用，不持久化任何东西，
	// 与上面那批 RemoteHost*Result 同类。真正落盘的是 Record（已在上面登记）。
	["src/shared/types/remoteTrust.ts:RemoteProjectTrustSetInput", "runtime"],
]);

const TYPE_FILES = readdirSync("src/shared/types")
	.filter((name) => name.endsWith(".ts"))
	.map((name) => `src/shared/types/${name}`);
const CODEC_FILES = ["src/main/projects/projectStoreCodec.ts", "src/main/sessions/SessionCatalog.ts", "src/shared/projectLocation.ts"];

function hostIdFields(filePath, content = readSessionCatalogSourceOrFile(filePath)) {
	const source = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
	assert.equal(source.parseDiagnostics.length, 0, `${filePath} must parse before its references can be audited`);
	const fields = [];
	const isCodec = CODEC_FILES.includes(filePath);
	function visit(node) {
		const isTypedField = ts.isPropertySignature(node);
		const isField = isTypedField || (isCodec && (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)));
		if (isField && node.name.text === "hostId") {
			let owner = node.parent;
			while (owner && !(isTypedField ? ts.isTypeAliasDeclaration(owner) || ts.isInterfaceDeclaration(owner) : ts.isFunctionDeclaration(owner))) owner = owner.parent;
			fields.push(`${filePath}:${owner?.name?.text ?? "<unscoped>"}`);
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
	return fields;
}

function assertReferenceSourcesCovered(overrides = new Map()) {
	// 一个联合类型里两个分支都可以带 hostId（如 RemoteHostAddResult 的 verified / saved-failed）时，
	// 扫描会产生同名条目——按「哪个类型持有 hostId」去重，属主登记仍是每类型一条。
	const fields = [...new Set([...TYPE_FILES, ...CODEC_FILES].flatMap((filePath) => hostIdFields(filePath, overrides.get(filePath))))].sort();
	const declared = [...COVERED_HOST_ID_FIELDS.keys()].sort();
	assert.deepEqual(fields, declared, "Every hostId field in shared types and store codecs needs an explicit reference-source owner");
	for (const source of COVERED_HOST_ID_FIELDS.values()) assert.ok(HOST_REFERENCE_SOURCES.includes(source), `${source} is not a registered reference-source kind`);
}

test("every typed or decoded hostId has a declared reference-source owner", () => {
	assertReferenceSourcesCovered();
});

test("a new hostId field without a reference-source owner fails the contract", () => {
	const typePath = "src/shared/types/session.ts";
	const mutatedType = `${readFileSync(typePath, "utf8")}\nexport type FuturePersistentEntry = { hostId: string };\n`;
	assert.throws(() => assertReferenceSourcesCovered(new Map([[typePath, mutatedType]])), /Every hostId field/);

	const codecPath = "src/main/sessions/SessionCatalog.ts";
	const mutatedCodec = `${readSessionCatalogSources()}\nfunction futureDecoder() { return { hostId: "new-id" }; }\n`;
	assert.throws(() => assertReferenceSourcesCovered(new Map([[codecPath, mutatedCodec]])), /Every hostId field/);
});
