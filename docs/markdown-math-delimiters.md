# LaTeX 括号分隔符兼容

## Summary

MarkdownStream 在渲染副本中把 `\(...\)` 转为行内数学，把 `\[...\]` 转为块级数学，继续使用 remark-math / KaTeX。不修改会话原文或持久化，不将普通括号自动识别为数学。

保护代码围栏、行内代码、已有美元公式和未闭合公式；允许更长的关闭围栏，确保块级数学结束符独占一行。

## Checklist

- [x] `npm run typecheck`
- [x] `npm run build`
- [x] `npm run test:serial -- --test-timeout=120000 --test-force-exit`：5675 通过、5 跳过、0 失败
- [x] `npx playwright test e2e/math-delimiters.spec.ts`：真实 Electron + mock stdio，通过
- [x] 非显然逻辑注释及真实 remark-math / KaTeX 回归测试

验证工作区 `PiDeck-math-pr` 从修复提交独立创建，不包含原工作区其他未提交的 Ask UI 改动。依赖通过本机 node_modules junction 复用。

此前原工作区全量测试超时；独立工作区直接以 node 启动测试出现打包测试无法找到 tsc 等失败，使用上述 npm 脚本完整重跑后通过。最终 E2E 增补只涉及测试 mock 与测试用例，不改变生产实现。

## Screenshots

E2E 覆盖正文、三行表格、块级公式后正文、方框答案、代码原样显示、窄窗口、主题切换和刷新后重新打开历史。截图见 `images/math-delimiters/`。

限制：没有真实用户会话原文；使用与截图等价的合成内容复现。未专门断言流式每个中间帧或双栏分屏，这些不声明已验证。
