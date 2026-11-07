# Web API：pi Prompt Templates

移动端或其他 Web 客户端读取桌面端 pi 文件模板时，使用 `/api/prompt-templates`，不要使用 `/api/prompts`。

- `/api/prompt-templates`：由桌面端 `PromptManager` 管理的全局 / 项目 Markdown 模板。
- `/api/prompts`：原有的云端中文提示词库（`XuePromptManager`）；接口与行为保持不变。

以下两个接口均为 **GET 只读**，复用已有 Web 服务的认证。启用认证时，请求携带 `Authorization: Bearer <web-service-token>`。不提供创建、编辑、删除或切换启用状态的接口。

## 列表

```http
GET /api/prompt-templates?projectId=example-project&search=review
Authorization: Bearer <web-service-token>
```

查询参数：

| 参数 | 说明 |
|---|---|
| `projectId` | 可选，桌面端已登记、具有本机可读根目录的项目 ID（包括已配置的 WSL 项目），不是文件路径。不传或为空时仅返回全局模板；传入时合并该项目 `.pi/prompts/` 下的模板。未知 ID 或 SSH 远端项目返回 404，不会发起远端读取。 |
| `search` | 可选，去掉首尾空白后，对名称或描述做不区分大小写的包含匹配。不会搜索正文。 |

示例响应：

```json
{
  "templates": [
    {
      "name": "review",
      "description": "Review code",
      "scope": "project",
      "enabled": true
    }
  ],
  "globalDir": "/home/user/.pi/agent/prompts",
  "projectDir": "/workspace/example/.pi/prompts"
}
```

- 列表仅返回 `name`、`description`、`scope`、`enabled`，**不返回正文或单个文件的绝对路径**；正文按需通过详情接口取得。
- `projectDir` 只在指定有效项目时返回。`globalDir` 跟随桌面端实际配置；WSL 环境使用已配置的 `windowsHome`。
- 项目模板与全局模板同名时，**项目模板覆盖全局模板**，列表按名称排序且不重复。搜索在覆盖之后进行，详情使用相同的优先级。
- 扫描、描述和启用状态复用 `PromptManager`：仅扫描相应目录中的 Markdown 模板，跳过 `.d.md`、空文件、不可读项及越过规范路径边界的项；描述取 frontmatter 的 `description` 或首个非空行。启用状态优先采用 pi 原生资源规则，否则读取相应作用域的 `disabledPrompts`，项目与全局状态互不干扰。
- 禁用的模板仍可查看；此接口不会改变它们是否由 pi 加载。

## 详情

```http
GET /api/prompt-templates/review?projectId=example-project
Authorization: Bearer <web-service-token>
```

路径里的名称使用列表返回的 `name`（不附加 `.md`），并进行 URL 编码，例如 `encodeURIComponent(name)`。`projectId` 的规则与列表相同；不传时可直接读取同名全局模板。

```json
{
  "detail": {
    "name": "review",
    "description": "Review code",
    "content": "---\ndescription: Review code\n---\nReview the supplied code.\n",
    "scope": "project"
  }
}
```

`content` 是完整原始 Markdown，保留 frontmatter，不使用列表扫描时的截断正文。单个详情最多返回 **2 MiB（2,097,152 字节，包含 frontmatter）**；超过上限返回 413，不返回部分正文。

只能按已扫描的模板名称读取，不能传入任意文件路径。读取时会重新核验全局模板 / 项目根目录的规范路径边界，不能通过符号链接绕过边界；`path`、`confirm` 等文件预览参数不会放宽模板访问权限。

## 错误与兼容性

| HTTP 状态 | 错误码 / 场景 |
|---|---|
| 400 | `webError.invalidRequest`：名称无法解码，或含路径分隔符 / NUL。 |
| 401 | 已启用认证，但未提供有效的 Web 服务凭据；沿用现有认证响应。 |
| 404 | `webError.projectNotFound` / `webError.promptNotFound`：项目或模板不存在、详情不可读或越过路径边界。 |
| 413 | `webError.fileTooLarge`：详情超过 2 MiB。 |
| 503 | `webError.promptTemplatesUnavailable`：未装配模板管理器，与云端提示词库是否可用无关。 |
| 500 | `webError.internalError`：读取目录等内部操作失败；响应不包含内部文件系统错误。 |

模板路由的错误响应形如 `{"code":"webError.promptNotFound","error":"prompt template not found"}`，带有已有 Web 服务的 CORS 与 `Cache-Control: no-store` 响应头。不支持的写入方法不会命中这两个只读路由。

现有客户端仍可继续使用 `/api/prompts` 查询云端提示词库。要显示桌面端 pi 模板，客户端需要切换到上述新接口；本改动不迁移云端数据，也不修改外部移动端客户端。
