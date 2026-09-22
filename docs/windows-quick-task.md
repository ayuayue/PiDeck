# Windows 右键小任务 / Explorer quick tasks

在设置的常用设置中启用「右键发起小任务」。这会为当前 Windows 用户注册独立菜单，不需要管理员权限。原有「用 PiDeck 打开」开关继续控制打开完整项目的菜单。

1. 在桌面空白处、资源管理器空白处或文件夹图标上右键，选择小任务菜单。Windows 11 可能需要先点「显示更多选项」。
2. 确认小窗口顶部显示的工作目录。未添加过的目录会先询问是否添加为项目。
3. 在现有会话输入框中输入任务并发送。沿用当前 backend、模型配置和权限审批，可查看输出或停止任务。
4. 点击「完整工作台」回到同一会话。关闭小窗口也会返回工作台，任务继续；要终止任务请使用停止按钮。

重复右键会保留当前任务和草稿；不同目录会提示是否新建任务。新建任务保留原会话，可在完整工作台中找回。退出应用前仍应发送或自行保存未发送草稿，草稿不是磁盘备份。

桌面入口使用 Windows 实际桌面路径（含重定向桌面），不是硬编码 `%USERPROFILE%\Desktop`。单个文件、多选文件和任意应用的选中文本不在本功能范围。

小窗口是当前工作台的紧凑模式；切回后恢复窗口尺寸。它复用同一会话、消息发送、权限确认和取消链路，不提供独立模型调用实现。需要先配置可用的 Pi/DSH 等 backend 和模型凭据；打开菜单本身不发送任务。

## 本地运行与关闭入口

从仓库启动（将示例目录换成自己的已有项目目录）：

```powershell
npm ci
npm run dev -- --quick-task 'C:\Projects\My Project'
```

已构建后也可测试启动参数，无须先注册菜单：

```powershell
npm run build
npx electron . --quick-task 'C:\Projects\My Project'
npx electron . --quick-task-desktop
```

便携版示例（替换应用和项目路径）：

```powershell
& 'C:\Apps\PiDeck\PiDeck.exe' --quick-task 'C:\Projects\My Project'
```

在设置中关闭小任务开关可移除三个菜单入口。移动/删除便携版前先关闭入口；在新位置启动后重新启用，更新菜单指向的可执行文件。开发版与打包版共用当前用户菜单键，最后启用的一方拥有菜单入口；不要同时把它们当成两个独立菜单。

## English

Enable the quick-task context-menu switch in Common settings. Right-click a folder, Explorer background, or desktop background (Windows 11 may require **Show more options**). Check the working directory, confirm adding an unknown project, then enter and send a task using the regular composer.

This is a compact presentation of the existing workbench, with the same session, backend, model configuration, approval prompts, streaming output, and Stop control. Opening the menu never submits a prompt. Repeated invocations preserve the current session and draft; a different directory requires an explicit new-task action. Opening the full workbench or closing the compact window restores the workbench and keeps the task running. Stop the task explicitly to cancel it.

The desktop entry resolves the actual Windows desktop known folder. Individual files, multi-selection and text selections in other applications are outside this feature. Disable the switch before moving a portable executable, and enable it again from its new location. Development and packaged builds share the current-user menu keys.

## Verification

```powershell
npm run typecheck
node --test tests/quickTask*.test.mjs tests/focusTarget.test.mjs tests/shellContextMenu.test.mjs
npm run build
npx playwright test e2e/quick-task.spec.ts
```

The end-to-end tests use isolated temporary profiles and a mock Pi process over real JSON-RPC. They do not send paid model requests or register Explorer menus. Actual Explorer placement, Windows permissions, redirected desktop and installation/portable paths should also be checked on the target machine.
