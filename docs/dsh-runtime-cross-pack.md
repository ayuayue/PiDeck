# DSH Runtime 交叉打包方案（单 runner 出全平台）

> 状态：已落地。`pack-dsh-runtime.mjs` 支持 `--target-os/--target-arch/--target-libc`
> 交叉解析模式；`release.yml` 用单个 ubuntu runner 打满 6 平台；`post-release-sidecars.yml`
> 的原生补发职责移除。默认（无 --target-*）行为不变：从项目 node_modules 收集闭包。
>
> 前置调研结论（2026-09-18 实证）：「npm registry 直装」路线不可行（无预编译归档、
> 版本漂移、私有包缺失、需引 pacote），本文档的交叉打包路线是「npm 分发 + 自有校验链」
> 的折中：下载源仍是 npm registry，但版本钉死在 lock、归档走既有 sha256 + boot 门禁。

## 1. 背景与旧链路的成本

旧发版链路里 runtime tgz 的产出方式是「每个平台一台原生 runner 跑 `npm ci` +
`runtime:pack`」，原因有两点：

1. 原生模块（node-pty / sharp / koffi / rg）需要本机平台 prebuild，误以为不能交叉；
2. 闭包收集从项目 node_modules 读取，node_modules 只在本机 `npm ci` 后才完整。

由此产生的维护成本：

| 成本项 | 说明 |
| --- | --- |
| release.yml 5 个构建 job 顺带打 runtime | macOS x64 构建跑在 arm64 runner 上，产出的是 darwin-arm64 |
| post-release-sidecars.yml 专用 workflow | 原生补 win32-arm64 / darwin-x64 两个「天然缺口」，windows-11-arm 上 npm ci 10 分钟+ |
| publish-dsh-runtime.yml 手动补发 | 6 平台原生矩阵，给旧版本补发/重试 |
| 平台缺口风险 | v0.7.6 发版时 win32-arm64 缺口真实发生过，需手动补跑 workflow + 重跑 sync-atomgit |

## 2. 可行性根因（为什么现在能交叉）

对 runtime 闭包内全部原生依赖的逐包核查（2026-09-18）：

| 原生依赖 | 分发形态 | 交叉解析表现 |
| --- | --- | --- |
| node-pty（仅 dsh-subprocess-local 嵌套 1.2.0-beta.15；项目自身 1.1.0 只为 Electron 终端服务，本地 pwsh 工具下线后不再进 runtime 闭包） | tarball 自带全平台 `prebuilds/<os>-<arch>/`（含 conpty.dll / OpenConsole.exe） | ✅ 与原生安装文件级一致 |
| koffi | `@koromix/koffi-<os>-<arch>` optional 平台包 | ✅ `--ignore-scripts` 下 require 成功（cnoke 编译脚本不触发） |
| sharp | `@img/sharp-<os>-<arch>` + `@img/sharp-libvips-*` optional 平台包 | ✅ |
| @vscode/ripgrep | `@vscode/ripgrep-<os>-<arch>` optional 平台包 | ✅ Mach-O/ELF/PE 二进制均可解包（不需要执行） |
| @deepseek-ai/node-addon-system | `node-addon-system-<os>-<arch>` optional 平台包 | ✅ |

结论：**闭包内不存在需要本机编译的包**。npm 的 `--os/--cpu/--libc` 过滤 + prebuild
分发使「任意宿主交叉解析任意平台树」成立。

## 3. 实证记录（2026-09-18）

| 实验 | 结果 |
| --- | --- |
| Windows x64 上 `npm install --os=linux --cpu=x64 --ignore-scripts` | 25486 文件 / 224MB |
| 同树与 WSL 内原生 `npm install` 的文件级 diff | **零缺失**；差异仅 Windows 多出的 `.bin/*.cmd`、`*.ps1` shim |
| 交叉产物 linux-x64 归档在 WSL 真实 boot（check-dsh-boot 同款插件组合） | **BOOT OK** |
| 交叉产物 win32-x64 归档在本机 boot | **BOOT OK**（check-dsh-boot.mjs） |
| 体积 | linux-x64 28.0MB / win32-x64 31.5MB（旧本机模式 56MB） |

体积下降 ~24MB 的来源是**去重**而非缺包：旧链路从项目 dev node_modules 打包，同一份
`zod@4.6.1` 被嵌套复制约 90 份（每份 3.9MB）；npm 全新解析把 zod hoist 到顶层一份。
19 基线包 + 9 入口包 + 522 个包目录入口解析全部通过。

## 4. 实现要点

### 4.1 scripts/dshRuntimeLockClosure.mjs（新增，纯函数）

- `collectLockClosure(lockPackages, seedNames)`：从 lock 遍历闭包（种子 = @deepseek-ai
  作用域全集 + dsh-bill + dsh-tool-pwsh-persistent），只跟 dependencies +
  optionalDependencies，不跟 peer/dev。
- `resolveLockPackageKey(fromKey, name, lockPackages, range)`：**关键语义**——同名多版本
  时 lock 里同时存在顶层与嵌套条目，必须按**声明范围**（semver.satisfies）选候选，
  不能沿用 Node 模块解析的「先向上命中即返回」。典型场景：顶层 node-pty@1.1.0 被
  项目 production 依赖占用，dsh-subprocess-local 要求精确 `1.2.0-beta.15`，lock 里
  是嵌套副本；按顶层解析会丢嵌套副本，host 里 subprocess 加载到错误版本的 node-pty。
- `isPlatformGatedEntry(entry)`：带 `os/cpu/libc` 字段或 `optional:true` 的条目是
  平台门控包，写进临时 package.json 的 `optionalDependencies`。
- `normalizeTarget`：linux 目标**缺省强制 glibc**（见 4.3）。

### 4.2 pack-dsh-runtime.mjs（--target-* 模式）

```
lock 闭包遍历 → 临时 package.json（lock 精确版本钉死 + 平台包进 optionalDependencies
+ file: 本地包指回仓库 packages/）→ 隔离目录 npm install --os --cpu --libc
--ignore-scripts → 复用既有闭包收集/裁剪/零复制打包 → 产出 dsh-runtime-<os>-<arch>.tgz
```

- 版本钉死：临时 package.json 写 lock **精确版本**。dsh 子包互引用 `^0.1.5-rc.1`，
  npm 对 prerelease 的 caret 语义会浮动到更新 rc（实测 230/240 包漂移）；隔离目录里
  顶层钉死后子范围命中即去重，从根上消除漂移。
- `--ignore-scripts`：prebuild 已足够，且收窄供应链面（不在打包机上跑第三方
  postinstall）。
- 默认模式（无 --target-*）行为不变：项目 node_modules 收集闭包，本机平台产物。
  `npm run build` 内的 `runtime:pack` 走默认模式，本地/离线打包体验不变。

### 4.3 两个必须的防御（都踩过/差点踩）

1. **libc 静默缺包**：linux 平台包（`@img/sharp-linux-x64` 等）声明 `libc:["glibc"]`，
   npm 在非 Linux 宿主上检测不到 libc → 这些包被**静默过滤**（只剩 wasm32 兜底），
   归档体积还会变小（看似优化实为缺陷）。防御两层：
   - `normalizeTarget` 对 linux 缺省强制 `--libc glibc`；
   - `check-dsh-asar.mjs` 按 `--target-*` 断言 sharp/koffi/rg 平台包与 node-pty
     `prebuilds/<os>-<arch>/` 在位（npm 对 EBADPLATFORM 静默跳过是 optional 语义，
     只有归档侧断言能拦住）；node-pty 按「任意位置的完整包」判定（顶层或嵌套在
     dsh-subprocess-local 下均可，不要求 npm 提升），缺 package.json 同样判红。
2. **EBADPLATFORM 硬错误**：把平台包写进 `dependencies`（而非 optionalDependencies）
   会让 npm 在非目标平台报 `notsup` 硬错误退出（node-addon-system-darwin-arm64 实证）。

### 4.4 check-dsh-asar.mjs

- 新增 `--target-os/--target-arch`（与 pack 同源解析），默认路径随之取
  `dsh-runtime-<target-os>-<target-arch>.tgz`；
- 新增原生包在位断言（见上）。

## 5. CI 改造

### release.yml

新增 `pack-dsh-runtime` job：单 `ubuntu-latest` runner，矩阵 6 平台，每平台
`pack --target-os/--target-arch` → `check-dsh-asar --target-*` → `gh release upload`。
只需 semver（curl 解包到 node_modules，不用全量 npm ci）。安装包构建 job 的
files 列表移除 `dist-runtime/dsh-runtime-*`（不再顺带产出 runtime）。

### post-release-sidecars.yml

原生补发职责移除，只保留「PAT 触发 sync-atomgit」收尾（release:published → sync）。

### publish-dsh-runtime.yml（手动补发入口）

新增 `cross_pack` 输入（默认 false）：勾选后走单 runner 交叉打全 6 平台；不勾走
原生矩阵（保留作为交叉链路出问题时的回退路径）。

## 6. boot 门禁的分工取舍

boot 是平台绑定的，单 runner 只能 boot linux-x64（ubuntu runner 本机）。分工：

| 归档 | boot 验证 | 结构校验 |
| --- | --- | --- |
| linux-x64（runner 本机） | ✅ runner 上 `runtime:check:boot` 可直接跑 | ✅ --target 断言 |
| 其余 5 平台 | ❌ 无对应真机（首次上线建议手动 pre-release 观察） | ✅ --target 断言（包存在 + 入口解析 + 原生包在位） |

降级门禁的依据：交叉解析树与原生树**文件级 diff 为零**（除 .bin shim），且原生二进制
来自与原生安装完全相同的 registry tarball（integrity 校验），boot 失败的剩余风险主要
在「裁剪规则误裁」——这层由入口解析校验 + 原生包断言覆盖。如需完全回补，可在
release.yml 的对应安装包构建 job（原生 macOS/Windows runner）里加一步
「下载本平台归档 + check-dsh-boot」，代价是每个 job 多一次 30MB 下载 + 20s 解压。

## 7. 回滚开关

- CI 层：publish-dsh-runtime.yml 的 `cross_pack=false` 走原生矩阵（原链路完整保留）；
- 临时禁用交叉 job：release.yml 的 `pack-dsh-runtime` job 加 `if: false`，恢复由
  安装包 job 顺带产 runtime（把 files 列表里的 `dist-runtime/dsh-runtime-*` 加回来）；
- 脚本层：默认模式（无 --target-*）与改造前行为一致，`npm run build` 链路无感。

## 8. 验证命令

```bash
node scripts/pack-dsh-runtime.mjs --target-os linux --target-arch x64   # 交叉打包
node scripts/check-dsh-asar.mjs --target-os linux --target-arch x64     # 结构 + 原生断言
node --test tests/dshRuntimeLockClosure.test.mjs                        # 闭包/平台过滤单测
node --test tests/packDshRuntimeCross.test.mjs                          # 交叉模式冒烟
node --test tests/dshRuntimePack.test.mjs                               # 链路契约回归
npm run typecheck
```
