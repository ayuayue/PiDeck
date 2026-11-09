// latest-mac.yml 合并脚本 + 发布 workflow 接线守卫。
//
// mac x64 / arm64 分 job 打包，各自的 latest-mac.yml 只含一半文件；同名上传互相覆盖后
// electron-updater 会给 x64 用户报 ZIP file not provided、给 arm64 用户装 x64 包。
// 合并脚本不依赖 yaml 库，只认 electron-builder 产出的固定形状，形状不符必须抛错而不是猜。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mergeLatestYml, parseLatestYml, serializeLatestYml } from "../scripts/merge-latest-mac-yml.mjs";

const X64 = `version: 0.10.0
files:
  - url: PiDeck-0.10.0-x64.zip
    sha512: aa/+bb==
    size: 100
    blockMapSize: 10
  - url: PiDeck-0.10.0-x64.dmg
    sha512: cc==
    size: 200
path: PiDeck-0.10.0-x64.zip
sha512: aa/+bb==
releaseDate: '2026-01-01T00:00:00.000Z'
`;
const ARM64 = X64.replaceAll("x64", "arm64").replaceAll("aa/+bb==", "zz==").replace("2026-01-01", "2026-01-02");

test("同名资产校验信息冲突时拒绝合并，防止架构资产被同名覆盖", () => {
	assert.throws(() => mergeLatestYml([{ text: X64 }, { text: X64.replaceAll("aa/+bb==", "different==") }]), /冲突/);
	assert.throws(() => mergeLatestYml([{ text: X64 }, { text: X64.replace("size: 100", "size: 300") }]), /冲突/);
});

test("合并后 files 含两架构全部条目（x64 在前），顶层 path/sha512/releaseDate 取第一份", () => {
	const merged = serializeLatestYml(mergeLatestYml([{ text: X64 }, { text: ARM64 }]));
	const urls = [...merged.matchAll(/^  - url: (.*)$/gm)].map((match) => match[1]);
	assert.deepEqual(urls, ["PiDeck-0.10.0-x64.zip", "PiDeck-0.10.0-x64.dmg", "PiDeck-0.10.0-arm64.zip", "PiDeck-0.10.0-arm64.dmg"]);
	assert.match(merged, /^path: PiDeck-0\.10\.0-x64\.zip$/m);
	assert.match(merged, /^sha512: aa\/\+bb==$/m);
	assert.match(merged, /^releaseDate: '2026-01-01T00:00:00\.000Z'$/m);
	// 条目字段原样保留（sha512 的 base64 不被改写、blockMapSize 不丢）
	assert.match(merged, /^    sha512: zz==$/m);
	assert.equal((merged.match(/blockMapSize: 10/g) ?? []).length, 2);
	// 单输入 round-trip 等价
	assert.equal(serializeLatestYml(parseLatestYml(X64)), X64);
});

test("同 url 去重；版本不一致 / 缺 version / 形状不符一律抛错", () => {
	const dedup = mergeLatestYml([{ text: X64 }, { text: X64 }]);
	assert.equal(dedup.files.length, 2);
	assert.throws(() => mergeLatestYml([{ text: X64 }, { text: ARM64.replace("0.10.0", "0.10.1") }]), /版本不一致/);
	assert.throws(() => mergeLatestYml([{ text: X64.replace("version: 0.10.0\n", "") }]), /缺少 version/);
	assert.throws(() => parseLatestYml("version: 1\nfiles:\n  - url: a\n    nested:\n      deep: 1\n"), /格式不符/);
	assert.throws(() => parseLatestYml("version: 1\nfiles:\n  - sha512: x\n"), /缺少 url/);
	assert.throws(() => parseLatestYml("version: 1\nfiles: []\nweird\n"), /files 必须是列表/);
});

test("接线：release.yml / build-dev.yml 的 mac job 不直接上传 yml，改由 merge-mac-update-manifest 合并后上传", () => {
	for (const file of ["release.yml", "build-dev.yml"]) {
		const text = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
		const macBlocks = text.split("- platform: macos").slice(1);
		assert.equal(macBlocks.length, 2, `${file} 应有 x64 + arm64 两个 mac 矩阵项`);
		for (const block of macBlocks) {
			const head = block.split("- platform:")[0];
			assert.match(head, /skip_yml: true/, `${file} 的 mac 矩阵项必须 skip_yml`);
			assert.match(head, /mac_arch: (x64|arm64)/);
		}
		assert.match(text, /name: latest-mac-yml-\$\{\{ matrix\.mac_arch \}\}/);
		assert.match(text, /merge-mac-update-manifest:/);
		assert.match(text, /scripts\/merge-latest-mac-yml\.mjs --out release\/latest-mac\.yml mac-manifests\/latest-mac-yml-x64\/latest-mac\.yml mac-manifests\/latest-mac-yml-arm64\/latest-mac\.yml/);
		assert.match(text, /gh release upload "\$TAG" release\/latest-mac\.yml --clobber/);
	}
});
