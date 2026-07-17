# PiDeck 协作说明

> 仓库：https://github.com/ayuayue/PiDeck

---

## 一、开始工作前

### 1. 克隆仓库

```bash
git clone https://github.com/ayuayue/PiDeck.git
cd PiDeck
```

### 2. 配置 Git（首次使用）

```bash
git config user.name "你的名字"
git config user.email "你的邮箱"
```

---

## 二、分支规范

| 分支类型 | 命名格式 | 说明 |
|----------|----------|------|
| 功能分支 | `feature/xxx` | 开发新功能 |
| 修复分支 | `bugfix/xxx` | 修复 bug |
| 优化分支 | `refactor/xxx` | 代码重构/优化 |
| 文档分支 | `docs/xxx` | 文档变更 |

**⚠️ 禁止直接推送 `main` 分支！所有变更必须通过 PR 合并。**

---

## 三、开发流程

### 第 1 步：创建分支

```bash
# 先同步最新 main
git checkout main
git pull origin main

# 创建功能分支
git checkout -b feature/你的功能名
```

**示例：**
```bash
git checkout -b feature/add-login-page
git checkout -b bugfix/fix-date-format
```

### 第 2 步：开发并提交

```bash
# 查看变更
git status

# 添加文件
git add .

# 提交（见下方 Commit 规范）
git commit -m "feat: 添加登录页面"
```

### 第 3 步：推送到远程

```bash
# 推送到你自己的功能分支
git push -u origin feature/你的功能名
```

---

## 四、Commit 提交规范

格式：`<type>(<scope>): <subject>`

| Type | 说明 | 示例 |
|------|------|------|
| `feat` | 新功能 | `feat: 添加用户注册功能` |
| `fix` | 修复 bug | `fix: 修复日期格式化错误` |
| `docs` | 文档变更 | `docs: 更新 README` |
| `style` | 代码格式（不影响逻辑） | `style: 格式化代码` |
| `refactor` | 重构 | `refactor: 优化 API 调用逻辑` |
| `perf` | 性能优化 | `perf: 减少重复渲染` |
| `test` | 测试相关 | `test: 添加登录单元测试` |
| `chore` | 构建/工具变更 | `chore: 更新依赖版本` |

**示例：**
```bash
git commit -m "feat(auth): 添加 JWT 登录接口"
git commit -m "fix(table): 修复分页参数为空时的错误"
git commit -m "docs: 补充 API 文档说明"
```

---

## 五、提交 PR（Pull Request）

### 1. 在 GitHub 上创建 PR

推送完成后，访问仓库页面，点击 **"Compare & pull request"**。

### 2. PR 标题格式

与 commit 一致：
```
feat(auth): 添加 JWT 登录接口
```

### 3. PR 描述模板

```markdown
## 变更内容

简要描述做了什么变更。

## 变更类型

- [ ] 新功能
- [ ] Bug 修复
- [ ] 代码重构
- [ ] 文档更新

## 测试情况

- [ ] 本地已测试
- [ ] 已自测通过

## 关联 Issue

Closes #xxx（如有）
```

### 4. 等待审核

- PR 提交后，维护者会在 **1 个工作日内** 审核
- 如有修改意见，会在 PR 评论区留言
- 按意见修改后，再次 push 到同一分支，PR 会自动更新

```bash
# 本地修改后
git add .
git commit -m "fix: 根据审核意见修改"
git push origin feature/你的功能名
```

---

## 六、注意事项

| ✅ 可以 | ❌ 禁止 |
|---------|---------|
| 推送 `feature/*` 分支 | 直接推送 `main` 分支 |
| 提交 PR 请求合并 | 强制推送（force push）到任何分支 |
| 在 PR 中继续 push 更新 | 删除 `main` 分支 |
| 合并其他协作者的分支到自己的分支 | 未经审核擅自合并到 main |

---

## 七、常见问题

**Q：推送时报错 `remote: Permission denied`？**
A：确认你已被添加为仓库协作者。联系管理员确认权限。

**Q：PR 合并后，如何同步本地 main？**
```bash
git checkout main
git pull origin main
```

**Q：如何更新自己的功能分支到最新 main？**
```bash
git checkout main
git pull origin main
git checkout feature/你的功能名
git rebase main
git push -f origin feature/你的功能名
```

**Q：提交了错误的 commit，想修改怎么办？**
```bash
# 修改最近一次 commit 消息
git commit --amend

# 修改最近 N 次 commit（谨慎使用）
git rebase -i HEAD~N
```

---

如有疑问，请随时联系 **ayuayue**。
