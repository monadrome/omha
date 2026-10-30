# Omha

可选的 [auto compact](docs/auto-compact.md) 支持缓存过期前压缩原生 Claude 会话：
默认 57 分钟、20% 上下文门槛，新输入立即撤销旧排期，并保留宿主预算与所有权校验。
关键决策见 [ADR 索引](docs/adr/README.md)。

[English](README.md) | [输入协议与 API](docs/contracts.md) | [安全边界](docs/security.md)

Omha 由本地、跨 provider 的 CLI 和 Claude Code plugin 组成。十个提示词 skills
负责预检、规划、决策、代码审查、交接、漂移分析和记忆整理；CLI 提供 Claude/Codex/Kimi 路由、
经过验证的任务 DAG、盲投圆桌、受所有权保护的终端以及分作用域的 Markdown 记忆。

范围尚不明确、方案取舍、证据解释等工作直接由当前 agent 推理。输入、副作用和验收
规则明确后，再使用固定 CLI 工作流；权限、所有权、预算与验收始终由宿主校验。
不必为开放式任务编写脚本。可调用入口及职责边界见[插件指南](docs/plugin.md)。

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

### Claude Code 插件与 Skills

单次加载：`claude --plugin-dir .`。长期安装可使用 Git marketplace：

```bash
claude plugin marketplace add monadrome/omha
claude plugin install omha@omha
```

本地源码安装时，将第一行替换为 `claude plugin marketplace add /源码绝对路径/omha`。
重启 Claude Code 后，可调用 `/omha:leader-agent 任务`、`/omha:roundtable 问题`、
`/omha:task-preflight 任务` 等[十个 skills](skills/README.md)。插件只安装提示词；
调用运行时功能还需要单独安装上面的 CLI。纯提示词任务可以直接完成。

更新使用 `claude plugin marketplace update omha` 和 `claude plugin update omha@omha`，
然后重启。卸载使用 `claude plugin uninstall omha@omha` 和
`claude plugin marketplace remove omha`。其他 Agent Skills host 可发现或复制
`skills/*/SKILL.md`，并保留相邻 references 和 LICENSE。

## 可运行的离线示例

以下命令在本仓库内执行，不需要付费 provider：

```bash
node bin/omha.mjs run --profile fake --prompt '离线检查'
node bin/omha.mjs leader --plan examples/plan.json --config examples/providers.fake.json
node bin/omha.mjs runs list
node bin/omha.mjs roundtable --input examples/decision.json --config examples/providers.fake.json
node bin/omha.mjs preflight --input examples/preflight.json --json
node bin/omha.mjs auto-butterfly --input examples/history.json --handoff --backend file
node bin/omha.mjs memory put --name api-contract --type decision --content '执行前验证任务计划。'
node bin/omha.mjs memory inject --topics api-contract
node bin/omha.mjs memory doctor
```

`preflight` 校验六个显式信号，输出低置信度、数值预测为 null 的建议性影子记录；
目标文本只做哈希，不改变路由，也不写入状态。详见[任务预检](docs/task-preflight.md)。

`npm run pack:check` 会在临时 HOME 安装 tarball，验证已安装 CLI/API 的完整流程和卸载。
本机有 Claude Code 时，还会在隔离配置目录验证两个插件清单、实际安装和发现 skills，
最后卸载；不调用模型。
`npm run probe:terminals` 单独进行真实本地终端探测：创建独有资源，验证 detached printf
与长文本粘贴后单独回车，最后只关闭这些探测资源。如果本机 cmux RPC schema 不兼容，
probe 会保留有限诊断并验证 file fallback；tmux 与离线检查仍是发布门槛，不会无限重试。

## Provider 配置与路由

配置优先级为 `--config`、项目 `.omha/providers.json`、
`$OMHA_HOME/providers.json`。自动发现只使用 `providers.json`，内容必须使用 version 1
协议。无效配置直接失败。参见 [配置示例](examples/providers.json) 与
[JSON Schema](schemas/providers.schema.json)。

Profile 明确配置 executable/argv、adapter、model、effort、sandbox、timeout、concurrency、
预算预留、环境变量白名单、retry、circuit cooldown、fallback 顺序及由宿主校验的
`interactive`、`headless`、`tool-free`、`read-only` 能力；路由可在启动 provider 前声明必需能力。
`sandboxCommand`/`sandboxArgs` 可包装外部只读沙箱，上游 Kimi 的只读 profile 必须配置它。
支持 `kimi capabilities` 的个人 Kimi 可声明 `kimiProtocol: "kimi-personal/1"` 与
`sandbox: "read-only"`，启用原生只读和 tool-free 路由；Omha 会校验运行事件中的请求模式。
`kiro` 适配器以 `kiro-cli chat --agent-engine v3 --output-format stream-json` 运行，提示词走
stdin。只读请求不信任任何工具，非交互 CLI 会拒绝写入和 shell；宿主还会拒绝出现已完成非读取
工具调用的结果。Kiro 会自动批准读取，因此不具备 tool-free 能力。白名单只记录
变量名。密钥应放在 CLI 凭据存储或明确允许的环境变量中，不能放进 JSON、参数、提示词
或记忆。模型名称需按当前账户和 CLI 调整。

Headless JSON/JSONL provider 会通过 runtime 回调和结果 envelope 暴露有界事件摘要，
包括轮次类型、工具/文件证据、usage 与等待输入信号；原始 provider payload 不会写入事件摘要。
API 传入 `streamEvents: true` 后，Codex、Kimi 或 Kiro 的 JSONL 进程运行期间也会收到同样的脱敏摘要；
流是显式开启且有界的，`result.stream` 会记录是否支持、投递和完成。Claude 继续使用原生 JSON 调用。
事件流只提供观察证据；完成解析、host 验收、预算闸门和计费通道仍是最终依据。

完成的 DAG 结果可通过 `reviewTask()` 接受冻结 diff、测试证据和复核标准。宿主强制使用不同的
reviewer profile，校验每项标准；失败或格式错误的复核会记录为未批准，不会改变任务结果。

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

`omha status` 汇总运行、决策门控、自有交接与结果指标。
`omha status --watch --wait-ms 30000` 限时输出变化的 JSONL 快照，可用 Ctrl-C 停止。
执行、宿主验收与评审分开统计；缺少验收证据的旧运行保持未知。

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
  可配置 `supervision: {stallMs, inputWaitMs, maxTakeovers}`，消费实时 JSONL 进展，
  检测停滞与输入等待，并将升级通知写入 stderr。默认值均为 0（关闭），最多接管 3 次，
  只读任务仅能转给已有 fallback；写任务保持 interrupted，不能自动接管。
  任务 deadline、取消和 worktree 租约覆盖执行、宿主验收与独立评审。
  规划模型不能指定宿主策略；自动规划时用 `leader --policy host-policy.json` 绑定
  `decision`、`supervision`、`memory` 和 `tasks: {taskId: {acceptance, review}}`。
  恢复待评审任务时仅继续独立评审，不重放已经完成的写入。
- 圆桌使用 2-3 个独立 voter，共享相同公开证据与各自私有提示。在盲收集结束前不持久化
  任何投票。证据引文必须匹配 anchor。多数或权重结果须超过全部票权的一半，弃权和
  无效票也计入分母。Chair 随后综合，不能修改 host 计票结果；少数理由和失败记录保留。
  Human gate 为建议性门槛，下游系统应等待 `decision approve`；Omha 不自动执行决策。
- Handoff 先写提示词，再按 cmux、tmux、file 降级。记录完整 cmux UUID 或私有 tmux
  socket、所有权、PID 和哈希。`handoff read|poll|send|resume|cancel|close --id <id>`
  只操作自身资源。终端 worker 必须有完成记录或经过 token 验证的最终 JSON marker；
  file 交接可显式 `handoff complete`。结束后 resume 会创建新交接。正常完成的终端保留
  供查看，需 close；超时和取消会清理。交互模式适合行式程序，不支持任意全屏 TUI。
  `--requests-file`（可选 `--brief-file`）生成结构化交接说明，把用户原话与上一个 agent
  未经验证的自述分开；`--agent NAME` 启动全局注册表中的命名 agent，注册表由
  `omha agents add|list|show|remove` 维护，审查角色的 agent 也会加入 `omha review`。
  见[agent 注册表](docs/contracts.md#agent-registry-and-handoff-notes)。
- 多 agent 审查：`omha review prepare|start|wait|merge|vote|tally|close` 把 diff 冻结到
  一次性 worktree，每个已安装的 reviewer CLI（Claude、Codex、Kimi Code、Kiro、Open Code
  Review 或 `.omha/review.json` 里配置的命令）各自作为受所有权保护的交接运行，按 cmux、
  tmux、file 降级。缺少命令或模型的 reviewer 跳过并记录原因。默认等待 51 分钟，到点不终止
  仍在运行的 reviewer。争议项交给盲投 voter，至少两张有效票且 `fix` 严格过半才修。见
  `/omha:multi-review`。
- Leader 默认自动观察带冻结验收检查的写任务：同一候选产物在验收失败后发生真实返工，
  会自动调用现有蝴蝶效应检测器并生成有上限的 file 交接，不需要手写历史 JSON，
  不额外调用模型。宿主 `plan.butterfly` 控制开关与上限，详见
  [自动蝴蝶效应](docs/automatic-butterfly.md)。
  手工历史仍要求明确的时间顺序、产物版本、针对既有要求的用户反馈和实际返工。
  单个哈希变化、正常演进、验收后的新工作、缺失历史均为 no-op。
  独立产物保留独立边界。`--analyze` 仅对可靠证据调用保留的 upstream contract。
  输出是回溯建议，**不会真的回退会话**。
  已登记的原生 cmux Claude/Codex 会话还支持按真实 checkpoint/turn fork，
  发送结构化续写消息，并由新会话确认接管后关闭来源 surface。使用
  `handoff adopt|checkpoints|fork|message|accept` 或 `auto-butterfly --fork`；
  需要明确的历史位置绑定与写入授权，保留原终端权限和计费通道。只复制新会话的
  历史，不恢复文件。可选 `--compact source|target`（仅以结构化事件确认完成，不支持的
  provider 直接拒绝）与 `--rename-target|--rename-source` 按固定顺序在投递续写前执行，
  关闭来源仍需新会话 accept 之后；详见 [cmux 历史接续](docs/cmux-fork.md)。
- 任务目标和验收完成后，以 `omha auto-close --completed --reason 'Goal completed'`
  作为最后的完成钩子，或在插件中使用 `/omha:auto-close`。独立进程先记录再关闭当前
  cmux 标签页，保留其他标签与分屏；可用 `--run-id` 绑定宿主验收与评审，不把普通回复
  结束视为目标完成。详见 [自动关闭](docs/auto-close.md)。
- 标签页恢复：`omha auto-recover check` 通过 cmux 的结构化 agent/surface 投影枚举
  所有本地终端标签，只分类当前屏幕尾部。加 `--allow-send` 后，对因可恢复连接错误
  停在空闲状态的 agent 标签发送一次有上限的 `go on`，并按 surface 应用冷却和尝试
  次数上限；认证/额度错误、正在工作的 agent 和未注册 agent 的标签只报告、不注入。
  `--watch --interval-ms 1500000` 每 25 分钟执行一次。详见
  [自动恢复](docs/auto-recover.md)。

## 记忆与安全边界

Markdown/frontmatter 是事实来源；`MEMORY.md` 是确定性的指针索引，最多 200 行 / 24,000
字节。注入最多 200 行 / 16,000 字节，只包含明确选择的 topic，并返回过期告警。
命令为 `memory init|status|list|read|search|put|forget|inject|doctor`。
Leader 会自动选择相关且未过期的 project/worktree topic，将来源 hash 冻结到运行上下文。
宿主验收和配置的评审均通过后，会记录含验收过程与运行来源的 worktree 经验，不复制
provider 输出或原始对话。`plan.memory` 可配置注入上限、有效期及读写开关；私有作用域
仍需显式选择。

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
进程的隔离沙箱。POSIX 使用进程组监督；仅支持 macOS 与 Linux，不支持 Windows。上游 Kimi 只读调用需外部沙箱，不能用于 tool-free 盲投或规划。显式启用的个人协议
提供模型工具限制，仍会写入自身 session/config 文件，不是 OS 沙箱。
Kiro 写入 profile（`sandbox: "workspace-write"`）传 `--trust-all-tools`，不限制在工作区内；
Kiro 只读是权限拒绝，不是 OS 沙箱。

详见 [安全与限制](docs/security.md)、[API/协议](docs/contracts.md)、
[兼容矩阵](docs/compatibility.md)、[贡献指南](CONTRIBUTING.md) 与
[发布检查](docs/releasing.md)。CI 覆盖 Node 20/22、Linux/macOS，检查格式、语法、
manifest、技能发现、离线测试和安装包。唯一运行依赖是解析 frontmatter 的 `yaml`。
[优化验收审计](docs/optimization-audit.md) 列出各项生命周期改动、离线证据和仍保留的协议边界。

Session Fork 复用 Open Arena 执行规范与冻结知识包，在同一逐字节 prefix 后创建 2-8 路
自动命名、相互隔离的分支，但不声称复制 provider session 或命中 KV cache。CLI、cache
证据与失败契约见 [Session Fork v1](docs/session-fork.md)。

Apache-2.0 许可；[NOTICE](NOTICE) 与 [THIRD_PARTY.md](THIRD_PARTY.md) 区分保留的 upstream 技能与
新编写的 Omha 代码。
