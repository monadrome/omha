# Omha

[English](README.md) | [输入协议与 API](docs/contracts.md) | [安全边界](docs/security.md)

Omha 是本地、跨 provider 的 agent 协作执行器。它提供 Claude/Codex/Kimi
路由、经过验证的任务 DAG、盲投圆桌决策、受所有权保护的终端交接、基于返工证据的
蝴蝶效应分析，以及分作用域的 Markdown 记忆。CLI 附带七个可移植的 Agent Skills。

当前版本 **0.2.0-rc.2** 为候选版本。默认测试离线运行，不调用收费模型。
真实模型行为、账单和沙箱约束仍依赖安装的 provider CLI。成功退出代表输出通过协议
验证，不代表代码任务已经正确完成；项目自身的验收检查仍需要执行。

## 安装、更新与卸载

需要 Node 20+ 和 npm。Git、provider CLI、tmux、cmux 都是可选组件。
在 checkout 中构建并安装候选 tarball：

```bash
npm ci --ignore-scripts
npm run check
npm pack
npm install -g ./huatalk-omha-0.2.0-rc.2.tgz --ignore-scripts
omha doctor --json
```

也可执行 `./install.sh`，安装到 `$HOME/.local`，再将 `$HOME/.local/bin` 加入 PATH。
通过 `OMHA_NPM_PREFIX` 调整安装前缀。脚本只安装 CLI，不覆盖 Claude marketplace；
checkout 安装后请保留源码目录。

发布到 npm 后，可用 `npm install -g @huatalk/omha@<版本> --ignore-scripts`
安装或更新。当前候选版本按上面的步骤重新打包并安装。仓库存在不表示已经发布。

```bash
npm uninstall -g @huatalk/omha --ignore-scripts
# 使用 install.sh 时：
npm uninstall -g --prefix "$HOME/.local" @huatalk/omha --ignore-scripts
```

卸载保留记忆与运行记录。先用 `omha handoff close --id <id>` 关闭自己创建的交接。
`omha doctor --json` 会显示状态目录；确认内容后再手动删除保留的数据。

Claude 单次加载：`claude --plugin-dir .`。长期安装可在 checkout 中执行
`claude plugin marketplace add .` 和 `claude plugin install omha@omha`。
更新用 `claude plugin marketplace update omha`，并按 host 要求重新安装插件。
卸载用 `claude plugin uninstall omha@omha` 和
`claude plugin marketplace remove omha`。其他 Agent Skills host 可发现或复制
`skills/*/SKILL.md`，并保留相邻 references 和 LICENSE。技能是操作协议，实际运行需 CLI。

## 可运行的离线示例

以下命令在本仓库内执行，不需要付费 provider：

```bash
node bin/omha.mjs run --profile fake --prompt '离线检查'
node bin/omha.mjs leader --plan examples/plan.json --config examples/providers.fake.json
node bin/omha.mjs runs list
node bin/omha.mjs roundtable --input examples/decision.json --config examples/providers.fake.json
node bin/omha.mjs auto-butterfly --input examples/history.json --handoff --backend file
node bin/omha.mjs memory put --name api-contract --type decision --content '执行前验证任务计划。'
node bin/omha.mjs memory inject --topics api-contract
node bin/omha.mjs memory doctor
```

`npm run pack:check` 会在临时 HOME 安装 tarball，验证已安装 CLI/API 的完整流程和卸载。
`npm run probe:terminals` 单独进行真实本地终端探测：创建独有资源，验证 detached printf
与长文本粘贴后单独回车，最后只关闭这些探测资源。如果本机 cmux RPC schema 不兼容，
probe 会保留有限诊断并验证 file fallback；tmux 与离线检查仍是发布门槛，不会无限重试。

## Provider 配置与路由

配置优先级为 `--config`、项目 `.omha/providers.json`、
`$OMHA_HOME/providers.json`。`agents.json` 兼容旧文件名，但内容必须使用 version 1
协议。无效配置直接失败。参见 [配置示例](examples/providers.json) 与
[JSON Schema](schemas/providers.schema.json)。

Profile 明确配置 executable/argv、adapter、model、effort、sandbox、timeout、concurrency、
预算预留、环境变量白名单、retry、circuit cooldown、fallback 顺序及由宿主校验的
`interactive`、`headless`、`tool-free`、`read-only` 能力；路由可在启动 provider 前声明必需能力。
`sandboxCommand`/`sandboxArgs` 可包装外部只读沙箱，Kimi 只读 profile 必须配置它。白名单只记录
变量名。密钥应放在 CLI 凭据存储或明确允许的环境变量中，不能放进 JSON、参数、提示词
或记忆。模型名称需按当前账户和 CLI 调整。

```bash
# 这会调用真实 provider，可能收费：
omha run --profile reviewer --config examples/providers.json --prompt '检查公开任务证据'
```

仅限流、容量不足、超时、传输故障、缺失 executable 和熔断可触发 fallback。
鉴权、配置、任务、预算与格式错误停止路由。重试尊重 Retry-After，使用有抖动且有界的
指数退避。相同状态目录中的本地进程共享 provider 并发与熔断状态。
结果保留请求/实际 profile、provider、model、request ID、每次尝试、延迟、退出状态、
响应哈希、失败阶段和预算账本。实际模型无法确认时 `servedModel:null`，不会冒充已确认。
缺少 usage 时按预留额记账；预算预留是准入限制，无法替代 provider 的实际账单上限。

## 生命周期

- **Open Arena：**将经过审核的 `OPEN_ARENA.md` 与 references 导入为冻结知识包，
  导入时不启动 provider。独立授权的 Git/POSIX 批次从同一 bundle 创建两份 clone，
  每路只写一次，共享持久预算并由 host 验证。报告保留全部终态和多份产物；strict
  要求经过验证的外部写执行器。参见 [契约与 CLI](docs/open-arena.md)。
- Leader 用低 effort 的规划调用输出 JSON DAG；`--plan` 可直接使用已有计划。
  Host 验证依赖、profile、写权限和 deadline，再执行并行就绪的只读任务。
  同一 worktree 的写任务必须依赖有序且独占执行。
  `runs cancel --id <id>` 持久化取消请求；`leader --resume <id>` 复用成功结果与稳定前缀。
  中断且无法确定是否完成的写任务不会自动重放；检查变更后显式使用
  `--allow-write --retry-failed --retry-interrupted-writes`。
- 圆桌使用 2-3 个独立 voter，共享相同公开证据与各自私有提示。在盲收集结束前不持久化
  任何投票。证据引文必须匹配 anchor。多数或权重结果须超过全部票权的一半，弃权和
  无效票也计入分母。Chair 随后综合，不能修改 host 计票结果；少数理由和失败记录保留。
  Human gate 为建议性门槛，下游系统应等待 `decision approve`；Omha 不自动执行决策。
- Handoff 先写提示词，再按 cmux、tmux、file 降级。记录完整 cmux UUID 或私有 tmux
  socket、所有权、PID 和哈希。`handoff read|poll|send|resume|cancel|close --id <id>`
  只操作自身资源。终端 worker 必须有完成记录或经过 token 验证的最终 JSON marker；
  file 交接可显式 `handoff complete`。结束后 resume 会创建新交接。正常完成的终端保留
  供查看，需 close；超时和取消会清理。交互模式适合行式程序，不支持任意全屏 TUI。
- 蝴蝶效应要求明确的时间顺序、产物版本、针对既有要求的用户反馈和实际返工。
  单个哈希变化、正常演进、验收后的新工作、缺失历史均为 no-op。
  独立产物保留独立边界。`--analyze` 仅对可靠证据调用保留的 upstream contract。
  输出是回溯建议，**不会真的回退会话**。

## 记忆与安全边界

Markdown/frontmatter 是事实来源；`MEMORY.md` 是确定性的指针索引，最多 200 行 / 24,000
字节。注入最多 200 行 / 16,000 字节，只包含明确选择的 topic，并返回过期告警。
命令为 `memory init|status|list|read|search|put|forget|inject|doctor`。

| 作用域                   | 隔离边界                                             |
| ------------------------ | ---------------------------------------------------- |
| `project` 默认           | Git common directory；同仓库的 sibling worktree 共享 |
| `worktree`               | 单个真实 worktree 路径                               |
| `user`                   | 当前 OS 用户；只有显式选择才跨项目读取               |
| `session --session <id>` | 项目与明确 session ID                                |
| `role --role <id>`       | 项目与明确 agent role                                |

无 Git 时按真实路径隔离。Project shared 指同一状态目录下的本地 agents，不是网络或
多用户服务。User 注入还需 `--include-private`。Topic 带类型、来源、时间、freshness 和
status。`--expected-hash` 检查并发冲突，`--create-only` 禁止覆盖，
`memory doctor --rebuild` 重建索引。共享记忆拒绝原始 transcript 和凭据；拒绝路径穿越、
空字节、符号链接和硬链接；原子写入使用 fsync/rename，仍存活的锁所有者不会因锁老化被删除。

状态目录为 `$XDG_STATE_HOME/omha` 或 `$HOME/.local/state/omha`，可通过
`OMHA_HOME` 调整。本工具信任当前 OS 用户与配置的 executable，不是对同 UID 恶意
进程的隔离沙箱。POSIX 使用进程组监督；Windows 降级到 fake provider、记忆、技能和
file 交接。Kimi 只读调用需外部沙箱；未验证 tool-free CLI 前不能用于盲投或规划。

详见 [安全与限制](docs/security.md)、[API/协议](docs/contracts.md)、
[兼容矩阵](docs/compatibility.md)、[贡献指南](CONTRIBUTING.md) 与
[发布检查](docs/releasing.md)。CI 覆盖 Node 20/22、Linux/macOS/Windows，检查格式、语法、
manifest、技能发现、离线测试和安装包。唯一运行依赖是解析 frontmatter 的 `yaml`。

Apache-2.0 许可；[NOTICE](NOTICE) 与 [THIRD_PARTY.md](THIRD_PARTY.md) 区分保留的 upstream 技能与
新编写的 Omha 代码。
