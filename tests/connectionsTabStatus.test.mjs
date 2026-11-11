import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 设置页主机列表的状态点与侧栏项目行必须用同一套语义/配色；失败后还要能就地重试，
// 不能只在页面底部留一句共享 message。

const tab = readFileSync("src/renderer/src/components/app/settings/ConnectionsTab.tsx", "utf8");
const tag = readFileSync("src/renderer/src/components/sidebar/RemoteProjectHostTag.tsx", "utf8");
const utils = readFileSync("src/renderer/src/utils/remoteHostIdentity.ts", "utf8");

test("one tone source feeds both host rows", () => {
	assert.match(utils, /export const REMOTE_HOST_TONE_DOT_CLASS/);
	assert.match(tag, /REMOTE_HOST_TONE_DOT_CLASS\[tone\]/);
	assert.match(tab, /resolveRemoteHostConnectionTone\(state\)/);
	assert.match(tab, /REMOTE_HOST_TONE_DOT_CLASS\[tone\]/);
	// 连接中用转圈而不是黄点：黄点在会话行已经表示 Agent 在跑。
	assert.match(tab, /animate-pideck-spin/);
});

test("a failed connect keeps a per-host code and offers inline retry", () => {
	assert.match(tab, /const \[failures, setFailures\] = useState<Record<string, string>>\(\{\}\)/);
	assert.match(tab, /setFailures\(\(current\) => \(\{ \.\.\.current, \[hostId\]: result\.code \}\)\)/);
	assert.match(tab, /settings\.connections\.lastFailure/);
	// 重试：已验证主机直接重连，未验证主机先走编辑重新验证（直连必然失败，不静默置灰）。
	assert.match(tab, /host\.verified \? void toggle\(host\.id, true, host\.label\) : void openEditor\(host\.id\)/);
	// 成功或主动断开后清除失败码，避免旧错误挂在已恢复的主机上。
	assert.equal((tab.match(/delete next\[hostId\]/g) ?? []).length, 5);
});
