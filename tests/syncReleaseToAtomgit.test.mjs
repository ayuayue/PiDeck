import test from 'node:test';
import assert from 'node:assert/strict';

// 被测模块以 ESM import 加载；脚本有 CLI 直跑守卫，import 时不触发网络/进程副作用
const { planLatestCorrection, pickReleaseStatus, planAssetActions } = await import('../scripts/sync-release-to-atomgit.mjs');

test('planLatestCorrection: AtomGit latest 落后于 GitHub latest 时计划提升+降级', () => {
  const plan = planLatestCorrection(
    [
      { tag_name: 'v0.7.4', release_status: 'none' },
      { tag_name: 'v0.7.3', release_status: 'latest' },
    ],
    'v0.7.4',
  );
  // 7.4 缺 latest 标记要补上；7.3 错误持有 latest 要降为 none
  assert.deepEqual(plan, [
    { tag: 'v0.7.4', release_status: 'latest' },
    { tag: 'v0.7.3', release_status: 'none' },
  ]);
});

test('planLatestCorrection: 无差异时返回空计划（幂等）', () => {
  const plan = planLatestCorrection(
    [
      { tag_name: 'v0.7.4', release_status: 'latest' },
      { tag_name: 'v0.7.3', release_status: 'none' },
    ],
    'v0.7.4',
  );
  assert.deepEqual(plan, []);
});

test('pickReleaseStatus: 仅 GitHub latest 写 latest 标记，旧 tag 不携带该字段', () => {
  assert.equal(pickReleaseStatus(true), 'latest');
  assert.equal(pickReleaseStatus(false), undefined);
});

test('planAssetActions: 同名同大小 → 跳过；远端没有 → 上传（基础断点续传语义）', () => {
  const plan = planAssetActions(
    [
      { name: 'a.exe', size: 100 },
      { name: 'b.exe', size: 200 },
    ],
    [{ name: 'a.exe', size: 100 }],
  );
  assert.deepEqual(plan, {
    uploads: [{ name: 'b.exe', reason: 'new' }],
    skips: [{ name: 'a.exe', reason: 'same-size' }],
    conflicts: [],
  });
});

test('planAssetActions: 同名但大小不同 → 冲突（v0.7.5 事故回归：旧版静默跳过）', () => {
  // 同版本号重建产物重发版：GitHub 上新构建 165302370 字节，远端还是旧构建 165111111 字节
  const plan = planAssetActions(
    [{ name: 'PiDeck-0.7.5-setup.exe', size: 165302370 }],
    [{ name: 'PiDeck-0.7.5-setup.exe', size: 165111111 }],
  );
  assert.deepEqual(plan, {
    uploads: [],
    skips: [],
    conflicts: [{ name: 'PiDeck-0.7.5-setup.exe', githubSize: 165302370, remoteSize: 165111111 }],
  });
});

test('planAssetActions: 远端大小无法校验（HEAD 失败）→ 保守跳过并留痕，不阻断断点续传', () => {
  const plan = planAssetActions(
    [{ name: 'a.exe', size: 100 }],
    [{ name: 'a.exe', size: null }],
  );
  assert.equal(plan.uploads.length, 0);
  assert.deepEqual(plan.skips, [{ name: 'a.exe', reason: 'remote-size-unknown' }]);
  assert.equal(plan.conflicts.length, 0);
});
