import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, sep } from "node:path";
import test from "node:test";
import { parsePetSpriteUrl, isSpritePathAllowed } from "../src/main/pet/petSpriteUrl.ts";
import { petSpriteUrl } from "../src/main/pet/petPackageScanner.ts";

/**
 * pideck-pet:// 协议解析与路径校验契约：
 * - 只接受 pideck-pet://local/<petId> 单段 id；
 * - 最终读取路径必须位于允许根目录内（防 ../ 逃逸）。
 */

test("parsePetSpriteUrl accepts well-formed pet ids", () => {
	assert.equal(parsePetSpriteUrl("pideck-pet://local/clawd"), "clawd");
	assert.equal(parsePetSpriteUrl("pideck-pet://local/cache-capy"), "cache-capy");
	assert.equal(parsePetSpriteUrl("pideck-pet://local/octo%20x"), "octo x");
});

test("parsePetSpriteUrl rejects wrong host/protocol and path injection", () => {
	assert.equal(parsePetSpriteUrl("pideck-pet://evil/clawd"), null, "host 必须为 local");
	assert.equal(parsePetSpriteUrl("https://local/clawd"), null, "协议必须为 pideck-pet");
	assert.equal(parsePetSpriteUrl("pideck-pet://local/../etc/passwd"), null, "拒绝路径分隔符");
	assert.equal(parsePetSpriteUrl("pideck-pet://local/a/b"), null, "只接受单段 id");
	assert.equal(parsePetSpriteUrl("pideck-pet://local/"), null, "空 id 拒绝");
	assert.equal(parsePetSpriteUrl("not a url"), null);
});

test("isSpritePathAllowed confines reads to the allowed roots", () => {
	const root = join(sep, "tmp", "petdex");
	const roots = [root];
	assert.equal(isSpritePathAllowed(join(root, "capy", "sprite.bin"), roots), true);
	assert.equal(isSpritePathAllowed(join(root, "..", "outside.bin"), roots), false, "父目录逃逸拒绝");
	assert.equal(isSpritePathAllowed(join(root, "capy", "..", "..", "outside.bin"), roots), false);
	// 前缀相似但不属于根的目录必须拒绝（防 /tmp/petdex-evil 匹配 /tmp/petdex）
	assert.equal(isSpritePathAllowed(join(sep, "tmp", "petdex-evil", "sprite.bin"), roots), false);
	// 根自身允许（兜底）
	assert.equal(isSpritePathAllowed(root, roots), true);
});

test("pet sprite protocol is registered on the persist:pet session used by PetWindow", () => {
	const windowSrc = readFileSync("src/main/pet/PetWindow.ts", "utf8");
	const protocolSrc = readFileSync("src/main/pet/petSpriteProtocol.ts", "utf8");
	// 宠物窗用独立 partition；protocol.handle 只挂 defaultSession 时，
	// persist:pet 里 Image 加载 pideck-pet:// 会失败并掉进 emoji 兜底。
	assert.match(windowSrc, /partition:\s*PET_WINDOW_PARTITION/);
	assert.match(protocolSrc, /export const PET_WINDOW_PARTITION = "persist:pet"/);
	assert.match(protocolSrc, /session\.fromPartition\(PET_WINDOW_PARTITION\)\.protocol\.handle/);
	assert.match(protocolSrc, /protocol\.handle\("pideck-pet"/);
});

test("sprite url encodes pet ids for manifest embedding", () => {
	assert.equal(petSpriteUrl("clawd"), "pideck-pet://local/clawd");
	assert.equal(petSpriteUrl("a b"), "pideck-pet://local/a%20b");
	// 编码后的 id 可被 parsePetSpriteUrl 还原（manifest → 协议请求闭环）
	assert.equal(parsePetSpriteUrl(petSpriteUrl("a b")), "a b");
});
