# SIGN-OFF · 依赖类型理论作为唯一元理论

本文件钉住三件事：元理论写在 `boundaries.md`、判据能跑、指纹对得上。指纹一变，签名作废。

| 项 | 值 |
| --- | --- |
| 目标 | `resources/skills/pideck/references/web-api`（PiDeck 仓） |
| 文档 | `boundaries.md` |
| 判据 | `node verify-dtt.mjs` → 期望 rc=0 |
| 坏样本 | `node verify-dtt.mjs --selftest` → 期望 5/5 全红 |
| 指纹 | `9664fdb34f06daf11f5f4ec2cee027f014acbcb2ab21d8c7bc9a16d6a2e9820d` |
| 既有判据 | `node scripts/skills/pideck/check-doc.mjs`（路由台账比对，见 endpoints.md） |
| sorry | 无 |

## 乙方（改动方）

- 元理论节、判据脚本、五个坏样本：写了，跑了，rc 见上表。
- 指纹取法：`node verify-dtt.mjs --fingerprint`，算的是 `boundaries.md` 与 `verify-dtt.mjs` 两个文件的 sha256。
- 技能副本（`~/.agents/skills/pideck/`）只带文档，不带判据脚本——副本跑不了判据，能跑的是源码这一侧。
- 乙方宣布不了收敛。下表空着等甲方。

## 甲方（复核方）

复核命令只有一条：`node verify-dtt.mjs --fingerprint`，输出与上表逐字符相同才算盘上没有事后改动。

| 项 | 填什么 |
| --- | --- |
| 复核时刻 | 2026-11-22T09:08Z |
| 结论 | 全部认可 |
| 签名 | 6f3e0a1b |