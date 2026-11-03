import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");

/**
 * 单信封不变量守卫（v5 §2 / 审计发现 R2）。
 *
 * 为什么需要一条读源码的守卫：这次改动之前，`codeOf` 有 8 份、`{ok,code}` 有三套说法，
 * 而**每一份单独看都是对的**——所以 review 看不见，只有把「只允许一处」写成断言才挡得住再长。
 * 新增域时如果又想抄一份，这条会当场红。
 */
const CONVERTED_IPC = ["src/main/ipc/remoteProjectEntryIpc.ts", "src/main/ipc/remoteProjectFileIpc.ts", "src/main/ipc/remoteProjectTrustIpc.ts", "src/main/ipc/remoteProjectIpc.ts", "src/main/ipc/remoteProjectCreateIpc.ts", "src/main/ipc/wslHostIpc.ts"];

/** 已迁到 Op<T> 的结果类型所在文件（新增域时往这里加，不是往上面加）。 */
const CONVERTED_TYPES = ["src/shared/types/remoteFiles.ts", "src/shared/types/remoteTrust.ts"];

test("已转换的域不得再自带 codeOf，必须用 shared/op 的那一份", () => {
	for (const path of CONVERTED_IPC) {
		const text = read(path);
		assert.equal(/function codeOf\(/.test(text), false, `${path} 又抄了一份 codeOf`);
		assert.match(text, /from "\.\.\/\.\.\/shared\/op"/, `${path} 必须从 shared/op 取稳定码判据`);
	}
	// hosts 域的共享判据本身就是转出，不许再实现一遍。
	const hostValidation = read("src/main/ipc/remoteHostInputValidation.ts");
	assert.match(hostValidation, /export \{ codeOf \} from "\.\.\/\.\.\/shared\/op";/);
	assert.equal(/function codeOf\(/.test(hostValidation), false);
});

test("已转换的结果类型不再出现「扁平失败分支」", () => {
	for (const path of CONVERTED_TYPES) {
		const text = read(path);
		assert.equal(/\{ ok: false; code: string \}/.test(text), false, `${path} 还有未转换的扁平失败分支`);
		assert.match(text, /\bOp</, `${path} 的结果类型应建立在 Op<T> 上`);
	}
	// project / transfer 域在 remoteHost.ts 里，同文件还留着未迁移的 hosts 与 sessions 类型，
	// 所以按「具体结果类型」断言，而不是整文件。
	const remoteHostTypes = read("src/shared/types/remoteHost.ts");
	for (const name of ["RemoteProjectEnrollResult", "RemoteProjectEnrollAnswerResult", "RemoteProjectCreateAnswerResult", "RemoteProjectListResult", "RemoteProjectReadResult", "RemoteProjectSearchResult", "RemoteProjectRootStatusResult", "RemoteProjectDownloadResult", "RemoteProjectUploadResult"]) {
		assert.match(remoteHostTypes, new RegExp(`export type ${name} = Op<`), `${name} 必须是 Op<T>`);
	}
});

test("闭集与判据只有一处定义（同义实现在别处再出现会立刻红）", () => {
	const owners = {
		OP_UNKNOWN_CODES: "src/shared/op.ts",
		opFailFromCode: "src/shared/op.ts",
		STABLE_CODE_PATTERN: "src/shared/op.ts",
	};
	for (const [symbol, owner] of Object.entries(owners)) {
		const definition = new RegExp(`export (?:const|function) ${symbol}\\b`);
		for (const path of CONVERTED_IPC.concat(CONVERTED_TYPES).concat(["src/main/ipc/remoteHostInputValidation.ts"])) {
			assert.equal(definition.test(read(path)), false, `${path} 不得自己定义 ${symbol}`);
		}
		assert.match(read(owner), definition, `${owner} 必须定义 ${symbol}`);
	}
});
