# 会话分组（PiDeck 内置宿主插件）

把**整个工作区**的会话整理成分组：可以按目录一键建组，也可以手动挑选；不同项目的会话能放进同一个组，点一下就切到那个项目打开。

上游：[Lamb-Yang/pideck-plugin](https://github.com/Lamb-Yang/pideck-plugin) 的 `session-groups/`（本目录是它的随包内置副本，已扩成工作区级 v2）。

## 功能

- **工作区范围**：页头显示「全部项目」与「N 个会话 · M 个目录 · K 个分组」，跨项目的会话可同组
- **按目录建组**：新建分组时直接勾目录（可全选/清空，可多选），选中的目录会成为分组的**目录范围**，目录里所有会话自动入组；提示会显示将加入多少会话
- **目录范围（限制）**：分组可以只收某几个目录的会话，避免一堆无关目录的会话堆进同一个组。卡片上显示范围（如 `T6`、`pi-desktop +1`），悬停看完整路径；分组头「⋯」菜单里的「编辑目录范围」可收窄范围（范围外的会话移出本组，会话本身不删），「按目录补齐」把范围内还没进来的会话一次补进来；范围为空表示不限目录
- **添加时可越界**：添加弹层默认只列范围内的目录，可临时切「显示全部目录」；勾了范围外的会话，那个目录会自动并入本组范围（保证组内会话都属于组范围）
- **按目录分节**：添加会话弹层按目录分节，每节可「全选/清空」；行上显示更新时间与已在的其他分组
- **多组归属**：一个会话可以同时在多个分组里（勾选只加/减当前组，不再互斥）
- **行内可辨识**：两行布局——标题 + 绝对时间（`YYYY-MM-DD HH:mm`）；非 pi 后端显示徽标（DSH / ACP / IMG / VID，与宿主会话列表一致）+ 模型 + 所属目录（中间省略，悬停看全路径）+ 相对时间
- **目录筛选 + 搜索**：顶部搜索按标题过滤（命中自动展开、无命中隐藏）；目录筛选是自绘下拉（键盘 ↑↓ / Home / End / Enter / Esc 可操作），不再用原生 `select`
- 分组可**上移/下移**排序、点颜色点**换色**、重命名、删除（删除前确认，组内会话回到未分组），这些操作收在卡片右上角的「⋯」菜单里
- **批量移出**：分组头「选择」进入批量模式，「本页全选 / 清空」后一次移出本组（跨页已选也生效）
- 拖拽归组：整条会话可拖，落到分组卡片=加入该组，落到未分组=从所有分组移出
- **分页**：每个分组与未分组区按最近更新排序后分页，每页 20 条；底部页码条显示总数、上一页、页码窗口（首尾常驻 + 当前页两侧各 1 页 + 省略号）与下一页，搜索 / 目录筛选会回到第 1 页
- **视觉跟随宿主**：颜色、圆角、阴影、控件高度、字号、字体全部消费 PiDeck 注入的 token，按钮 / 输入框 / 下拉 / 列表 / 弹层与系统同一套语汇；亮暗主题、自定义主题色与自定义字体自动生效
- 每条会话带 ⓘ 详情弹层：所属目录/项目/后端/模型/所属分组/创建与更新时间/状态/会话 ID
- 活跃标记：`updatedAt` ≤ 10 分钟的会话显示绿点（事件驱动 + 每分钟静默重绘）
- 会话被删除/替代后自动清理失效引用，改名后标题自动同步（监听 `sessions.changed`）

## 权限

```json
"permissions": ["sessions.read", "sessions.read.workspace", "workbench.navigate"]
```

- `sessions.read`：只读会话目录与元信息（不读历史正文）。
- `sessions.read.workspace`：把上面的读取与跳转范围从「当前项目」扩到**整个工作区**（所有项目目录）。它是 `sessions.read` 的范围扩展，单独声明无效（清单校验会拒）。
- `workbench.navigate`：点击会话让 PiDeck 切到会话所属项目再打开（DSH/ACP/生图会话没有 JSONL 也能打开）。
- 没有网络权限，不联网、不上传会话、不写密钥。分组数据存**宿主 store**（`<userData>/session-groups.json`，经 `sessionGroups.*` API 读写），只存「组名 + 颜色 + 会话 id 引用 + 目录范围」，不存会话内容；侧栏分组树消费同一份数据，这里的修改实时反映到侧栏。
- `sessionGroups.manage`：读写宿主会话分组（见 `docs/host-boundaries.md` 例外七）。折叠状态是纯 UI 偏好，只存本机 localStorage，不进宿主数据。

## 存储布局

分组数据自 v3 起存**宿主 store**（`<userData>/session-groups.json`，由 PiDeck 主进程持有与落盘），本插件经 `pideck.sessionGroups.*` 读写，不再使用插件私有 `storage`：

| 位置 | 内容 |
|---|---|
| 宿主 store `groups[]` | `{ id, name, color, createdAt, sessionIds, dirs }`，数组顺序即显示顺序；`dirs` 是目录范围（空数组 = 不限目录） |
| 本机 `localStorage["session-groups.collapsed"]` | 折叠的分组 id 列表（纯 UI 偏好，不进宿主数据） |

历史迁移：PiDeck 启动时把 v2 插件私有 storage（`host-plugin-storage/session-groups.json` 的 `ws.meta` / `ws.g.*` 分片键）一次性导入宿主 store（只读、不删旧文件，回退旧版插件不丢分组）。更早的 v1 按项目 `grp.<projectId>` 键未迁移——需要先跑一次 v2 插件完成并组。会话被删除/替代后的失效引用由插件页与侧栏各自按 catalog 过滤，store 不追删。

## 面板形态

`"presentation": "page"`：工作区内联页，非模态，侧栏 `layers` 图标入口再点即关。页面铺满会话列，不设居中限宽（与「定时任务 / 智能体 / 收藏」页一致）。宿主的页面式覆盖层不再叠一条「面板名 + 关闭」的页头：面板名在会话 Tab 栏的伪 Tab 上，关闭走伪 Tab 的 ×。

点击某个会话时工作台会切到它所属的项目，**登记常驻 Tab** 后打开，插件页随之收起——打开的会话必须在 Tab 栏里有归属，否则关不掉、切不回来。

## 安装与升级

- 不随包分发：在「设置 → PiDeck 插件 → 从文件夹安装…」选本目录，再按整包指纹授权并启用；侧栏只列已启用插件的面板，没装就不显示分组树。
- **安装 ≠ 授权**：装完是 `requiresConsent`，要在设置里按整包指纹确认后才生效。
- 升级：装好的是 `userData/host-plugins/session-groups/` 里的副本，换新版要重新安装（启用中先禁用）；内容一变指纹就变，需要重新授权。
- 卸载：删插件目录 + 清授权 + 清本插件私有 storage；分组数据在宿主 store（`<userData>/session-groups.json`），不受插件卸载影响。
- v1.6.0 → v2.0.0 新增了 `sessions.read.workspace` 权限，包的指纹变了：升级后需要在设置里重新授权一次。
- v2.1.0 / v2.1.1 只改界面与分页，未新增权限，但内容变了仍需重新授权。
- **v3.0.0 新增 `sessionGroups.manage` 权限**（分组数据搬到宿主 store，侧栏分组树实时同步）：指纹变化，升级后需要在设置里重新授权一次。
- 样式 token 由宿主 `hostPluginTokens.ts` 的 `HOST_PLUGIN_THEME_TOKENS` 注入（颜色 / 圆角 / 阴影 / 控件高度 / 字号 / 字体）；新增 token 需同步 `docs/host-plugin-dev-guide.md` §5.7。

## 改这个插件

- 目录身份优先用宿主给的 `session.directory`（项目根目录），缺失时退回 `name:<项目名>` / `project:<id>` / `unknown`；改这里要同步 `dirKeyOf()` 与存储里的 `dirs`。
- 只在本目录改：`app.js` / `styles.css` / `app.html`，然后 设置 → PiDeck 插件 → 重新扫描 → 授权并启用（授权绑定整包文件指纹，内容一变就要重新批准）。
- 想同步上游：以上游仓库的 `session-groups/` 为数据源，复制这 4 个文件（`pideck-plugin.json` / `app.html` / `app.js` / `styles.css`），**不要**整个仓库覆盖过来（上游还带别的插件与主题文件）。本目录的工作区范围改造与上游分叉，同步时注意保留 `sessions.read.workspace` 与 v2 存储布局。
- 想调样式可在普通浏览器里把 `app.html` 的 `<script>` 换成假的 `window.pideck`（见 `docs/host-plugin-dev-guide.md`）。
- 约束：只用 `window.pideck`（context / sessions / storage / workbench / onEvent），不用 `innerHTML` 渲染动态文本，不联网。

API 参考见 PiDeck 仓库的 `docs/host-plugin-dev-guide.md`。
