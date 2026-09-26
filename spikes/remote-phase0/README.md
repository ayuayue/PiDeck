# Phase 0：SSH 上的 Pi RPC 试验

状态：本地 fake Pi 验证通过；Linux 真机 SSH/RPC/断线回收通过；`jiyuan/deepseek-flash` 已通过 `set_model → get_state → prompt → agent_end` 完成精确短回答。**Phase 0 仍缺 macOS/Linux OpenSSH 客户端的 fingerprint 矩阵验证，暂不标整体完成**。此目录不包含产品实现。

## 目的

验证系统 OpenSSH 能否透明承载 Pi 的 stdio JSONL RPC：`get_state`、活动中的 `prompt → abort`、正常 EOF 退出，以及 SSH 断开后远端 Pi 是否留下孤儿进程。fingerprint 测试只使用已完成 SSH 用户认证的临时 `known_hosts`，不用 `ssh-keyscan`。

## 本地自测

```powershell
node spikes/remote-phase0/pi-rpc-over-ssh.mjs --self-test
```

假 Pi 只模拟本次用到的 RPC 帧；自测通过不代表真机门禁通过。

## 真机前置

- 一个用户授权的 Linux/macOS SSH config alias（或 `user@host`），可使用 SSH key/agent 非交互登录；脚本启用 `BatchMode=yes`，不处理密码输入。
- 远端已有可执行的 `pi`、兼容的 Node、已配置的 provider，以及**已存在**的 POSIX 工作目录（默认 `/tmp`）；Pi 可能写入它自己的会话目录和日志，prompt 可能产生模型费用。
- 独立渠道取得主机的 SSH host key fingerprint，例如管理员提供，或经主机控制台运行 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256`。不要把 `--fingerprint-only` 的观察值当作自身的可信依据。
- 不要在聊天中发送私钥、密码、API key 或其他凭据；只需提供 SSH alias、远端 cwd、Node/Pi 是否可执行以及独立核对的 `SHA256:...` fingerprint。

先观察候选 fingerprint，此操作仅建立一次 SSH 认证连接并执行 `true`，不启动 Pi：

```powershell
node spikes/remote-phase0/pi-rpc-over-ssh.mjs --host <alias> --fingerprint-only
```

通过独立渠道核对后再执行真机测试（会发送 prompt）。脚本先用临时 pin 校验 SSH 端点，然后读取远端 `pwd`/OS/arch/Node/Pi 版本；预检失败时不会发送 prompt：

```powershell
node spikes/remote-phase0/pi-rpc-over-ssh.mjs --host <alias> --expected-fingerprint SHA256:<fingerprint> --cwd /tmp --check-orphan
```

也可传 `--pi /absolute/path/to/pi` 处理非交互 SSH 找不到 nvm/asdf 下的 Pi；绝对路径形式会仅在本次 SSH 子进程的 PATH 前置 Pi 所在目录，使其 shebang 找到同目录 Node，不会修改远端配置。脚本先认证并验证候选 key 与期望 fingerprint 一致，再将临时 pin 文件用于后续所有 SSH 连接；退出时清理该临时文件。检查孤儿进程时只用本次启动日志记录的远端 PID，经第二条已 pin 的 SSH 连接查询，不会全局 `pgrep` 或杀其他进程。

## 无生成模型选择检查

若要确认 RPC 能否选择用户的模型而不调用模型、不计生成费用，可运行 `set_model → get_state` 探针：

```powershell
node spikes/remote-phase0/pi-rpc-over-ssh.mjs --host serve --expected-fingerprint SHA256:<fingerprint> --pi /home/<user>/.nvm/versions/node/<version>/bin/pi --probe-model jiyuan/deepseek-flash
```

这会启动 Pi RPC 子进程并改变该进程的当前模型，但不会修改 Pi 的全局设置或发送 prompt；Pi 仍可能在自己的 session 目录写生命周期元数据。

## 完整回答验证

必须经用户明确授权后才运行，会产生一次真实模型调用并写入 Pi 会话历史：

```powershell
node spikes/remote-phase0/pi-rpc-over-ssh.mjs --host serve --expected-fingerprint SHA256:<fingerprint> --pi /home/<user>/.nvm/versions/node/<version>/bin/pi --probe-model jiyuan/deepseek-flash --verify-model-output
```

脚本要求 `set_model → get_state` 确认选中目标，再发送单条精确文本 prompt，检查 `agent_end`、assistant `stopReason` 和返回文本是否为 `PIDECK-PHASE0-OK`。本地 fake Pi 可用 `--self-test --probe-model jiyuan/deepseek-flash --verify-model-output` 覆盖响应解析，不构成真实模型可用性的证据。

## 本次真机观察

- Windows OpenSSH → Linux x86_64；远端 cwd `/tmp`，Node `v24.11.0`，Pi `0.85.1`。主机 fingerprint 经独立渠道确认后，所有后续连接使用同一临时 pin。
- 非交互 SSH 的默认 PATH 找不到 `pi`；即使直接调用 nvm 下的 Pi，旧的系统 Node 也无法解析其入口。指定绝对 Pi 路径并在本次 SSH 命令中前置同目录 Node 后，预检才通过；远端全局配置未修改。
- `get_state`、`agent_start` 后活动中 `abort`、prompt RPC 结算、stdout JSONL、stdin EOF 退出、强制断开后本次远端 PID 回收均通过（12/12）。独立完整回答测试中，`set_model → get_state` 确认 `jiyuan/deepseek-flash`，一条不取消的短 prompt 得到成功 `agent_end` 且 assistant 文本精确匹配（9/9）。
- stderr 警告 `No models match pattern "jiyuan/deepseek-v4-flash-0731"` 的来源已用只读检查确认：远端 Pi 的 `~/.pi/agent/settings.json` 里 `enabledModels` 尚含旧 pattern；它不是本 spike 的启动参数，也不是用户提供的 `jiyuan/deepseek-flash` 模型定义。**远端配置未修改**。实际 `deepseek-flash` 选择与一次模型生成均成功；该旧 pattern warning 不阻断此模型调用。

## 解释结果

- 本地自测 7/7 只能证明脚本的基本帧定界、活动中取消、响应匹配和 EOF 路径。
- 真机必须记录 Linux/macOS 发行版、`node --version`、`pi --version`、远端 cwd 与结果。若 stdout 被启动脚本/banner 污染，或断线后 PID 仍存在，应先修正 launcher 方案，不推进 Phase 1。
- 当前只是有限时间内的一次 PID 回收观察，不是对子进程树、PID 复用或网络异常的形式化证明。完整安全/生命周期保证由后续 runner + lease 的集成测试承担。
- 脚本修改仍在当前 worktree 未提交；真机结果需回填 [远程开发计划](../../docs/remote-development-plan.md) 的 Phase 0 状态。
