> 这是 Kimi 原始审查意见的归档，仅整理 Markdown 格式。部分意见经复核未采纳，
> 包括快照目录缺失误报、缓存计时修正、零预留预算降级和强制双源确认。
> 请先阅读 [综合审查与定稿建议](auto-compact-review.md)，不要直接将本文建议作为执行契约。
> 原文对「未委托其他模型」的自述也不完整：主审记录为 `kimi-for-coding`，
> 源码辅助 Explore 记录为 Kimi `k3`。实际来源以综合报告的审查记录为准。

# Omha Auto Compact 设计独立评审报告（Kimi）

- 评审对象：`/private/tmp/omha-kimi-review.UNH1HU/snapshot/docs/auto-compact-design.md`
- 冻结快照：`/private/tmp/omha-kimi-review.UNH1HU/snapshot`，Git 修订 `fba83a94…`，设计 SHA-256 `ce94a095…`
- 评审日期：2026-10-18；评审路线：配置别名 `kimi-code/kimi-for-coding`（按要求，未切换模型/供应商，未委托其他模型）
- 证据分级：【官方已验证】= 本次审查抓取的官方文档；【本地证据】= 冻结快照源码/文件；【未验证】= 无法建立，已明确标注

---

## 1. 结论与实施就绪度

**总体结论：有条件通过（Conditionally Approve）。设计的核心机制（Mods 进程内调度 + 宿主声明/预算/持久化 + 单一执行者协调 + 业务版本去重不变量）方向正确、与项目安全不变量一致，未发现需要推翻架构的问题。但按冻结快照判断，存在 2 个 P0 实施阻断项、6 个 P1 重要缺口，当前不可直接进入编码阶段。**

就绪度评估：

- 需求层面：57 分钟可配置、20% 可配置、小上下文不触发、无新业务不连续 compact、53 分钟内新输入撤销重排、Mod 或 hooks 均可——**全部覆盖**，且有具体状态机与事件序列支撑（见第 3 节）。
- 事实层面：设计引用的多数官方能力本次已独立复核属实（Mods 版本门槛、`$.clock.after/every`、`$.session.usage()` 形状、`prompt_cache` 状态栏字段、`idleCompaction` 语义等，见第 7 节来源）。设计对"`$.session.usage()` 不含 `prompt_cache`"的克制是正确的。
- 实施层面：**阻断**。设计的两个落地前提——"同一个 omha 插件内注册 Mod"与"宿主启动会话时绑定 `--settings` 覆盖"——在冻结快照中均不成立（P0-1、P0-2）。预算映射与缓存证据滚动语义两个关键集成点仍是"一句话条件"而非可执行契约（P1-1、P1-2）。

建议：先解决 P0，再按第 6 节计划推进；阶段一（运行时契约探测）的产出应当回填本报告第 7 节的未验证清单，再冻结实现契约。

---

## 2. 评审发现（按 P0/P1/P2 排序）

### P0-1 插件分发面在冻结快照中完全缺失，设计的打包与兼容验证路径不可执行

- **位置**：`docs/auto-compact-design.md:372-391`（§13 文件与插件集成）；`package.json:9-24`；`bin/omha.mjs:556`；AGENTS.md "Claude Code Plugin" 一节。
- **触发序列**：按设计 §13 将 `hooks/hooks.json`、`hooks/register.mjs` 加入"同一个 `omha` 插件"→ 需要 `.claude-plugin/plugin.json` 作为插件清单 → 快照根目录下 `.claude-plugin/`、`skills/`、`hooks/` 三个目录**均不存在**（`ls -A` 核实），但 `package.json:13,18` 的 `files` 数组声明打包它们，且 `bin/omha.mjs:556` 的 `omha doctor` 直接 `readFileSync('../.claude-plugin/plugin.json')`——在该快照上 `omha doctor` 必然 ENOENT。
- **后果**：① 设计要求的"旧版 Claude 插件加载兼容离线验证"、双 manifest strict validation、`npm run pack:check` 在当前冻结输入上**无法运行**，交付阶段（§14 阶段四）无标准可验；② "单一插件身份"约束无法核对；③ AGENTS.md 规定的"七个 skills 保持提示词职责、无 CLI 也可用"无从验证。若这是快照裁剪造成的，也必须在实施前恢复/重建该分发面，否则设计的核心集成假设不成立。
- **证据 vs 假设**：设计假设"在同一个 `omha` 插件内的函数 hooks"（§2 表格 S3 行）——【本地证据】快照中不存在该插件实体。【官方已验证】Mod 插件的确切文件布局为 `.claude-plugin/plugin.json` + `hooks/hooks.json`（`modules` 数组指向 hooks 模块，如 `register.js`）+ 可选 `types/index.d.ts`，设计的 `hooks/hooks.json`/`hooks/register.mjs` 命名与该布局一致。
- **具体修正**：实施第 0 阶段先恢复 `.claude-plugin/`、`skills/` 分发面并使 `omha doctor`、双 manifest strict validation、pack check 在快照上全部通过；然后才能按 §13 追加 `hooks/`。在报告与文档中区分"快照缺失"与"设计缺陷"，以仓库 `main` 实际状态复核一次。

### P0-2 "omha 执行者模式"在快照中没有可绑定的启动路径

- **位置**：`docs/auto-compact-design.md:256-262`（§9）；`lib/terminal.mjs:277-292`；`lib/adapters.mjs:27-45`。
- **触发序列**：配置 `maintenance.autoCompact.enabled=true` → 按 §9，宿主应在"启动已配置的 Claude 会话时"以单次会话 `--settings '{"idleCompaction":false}'` 绑定 → 但快照中 `lib/` 全库**无任何 `--settings` 出现**：唯一的 Claude 启动 argv 是 headless 适配器（`--print --output-format json`，`lib/adapters.mjs:27-45`）；fork 路径**原样复用现有会话 argv**（`lib/terminal.mjs:277-279`）；交互式会话由 `adoptHandoff`（`lib/terminal.mjs:80-139`）收养**已在运行**的会话，无法注入启动旗标。
- **后果**：已运行会话只能靠 `$.settings.read()` 确认 `idleCompaction:false` 才进入执行模式——而该设置从没有任何路径写入。于是"omha 执行者"分支在该快照上**永远不可达**，所有会话停在 `native_idle_conflict` 观察态；设计的交付门槛"原生与 Omha 不双重执行"以"Omha 永不执行"的退化方式被满足。这是设计用散文掩盖的硬缺口，不是实现细节。
- **证据 vs 假设**：设计假设"宿主启动已配置的 Claude 会话"这一路径存在——【本地证据】不存在。
- **具体修正**：二选一并写入设计：① 新增受管启动路径（例如 `omha` 管理的 cmux/tmux 交互会话模板支持追加 `--settings` 文件，仅注入 `idleCompaction`，不改写全局设置），明确该路径的 argv 拼接点与所有权校验；② 首版放弃执行者绑定，明确声明"执行模式仅对由 omha 受管启动的会话可用，收养会话一律观察态"，并把 `native_idle_conflict` 的准入条件写成可测试断言。同时注意：官方文档确认 `idleCompaction` 键需 **v2.1.290+**，旧版忽略该键（"which ignores this key"），设计"不改写全局设置"的立场正确，但这也意味着旧版本上**没有任何**单会话手段停用原生 idle compaction——设计已正确拒绝"关闭 autoCompactEnabled"的降级，应在风险一节写明此约束。

### P1-1 会话→预算账户的映射是未解决的集成点

- **位置**：`docs/auto-compact-design.md:326-332`（§11）；`lib/runner.mjs:98-105,188-235`；`lib/profiles.mjs:56`。
- **触发序列**：Mod 定时器到点 → Mod 请求宿主准入 → 宿主"复用现有 runtime 预算预留和结算"→ 现有 `ProviderRuntime` 账户是 **per-profile 且 per-process**（`this.account`、`this.profileAccounts`，`lib/runner.mjs:98-105`），预留/结算（`:188-235`）按 profile 记账；而 Mod 观察的是一个被收养的原生 Claude 会话，其标识是 Claude 的 `session_id` + cwd，**与任何 omha profile 运行时账户没有现成映射**。设计只写了一句"宿主必须能将会话映射到经验证的维护预算；无法准入就跳过"。
- **后果**：`maxCompactionsPerSession`（§4）缺少可落地的账户轴：按什么维度计数"每会话 8 次"？跨进程重启如何不清零（设计 §10 要求同一 session 维护次数不清零，而 `ProviderRuntime` 账户在进程内）？预留记在谁的头上？跳过条件何时触发？这些不定义，§11 的预算表无法编码。
- **证据 vs 假设**：设计假设"将会话映射到经验证的维护预算"是可直接复用的一步——【本地证据】复用对象存在（reserve/settle、结果不确定时保留预留 `lib/runner.mjs:590` 的语义与设计的 unknown 处理一致），但映射层不存在。
- **具体修正**：在 `lib/terminal.mjs` 的 handoff 记录上新增 maintenance 账户字段（持久化，复用 `atomicWrite`/`lockDir`，owner token 沿用 `lib/terminal.mjs:453` 的 `{uid, token}` 形状），以 `(projectId, sessionId, conversationEpoch)` 为维护预算的持久计数轴；`ProviderRuntime.reserve/settle` 仅在其上叠加 profile 级 token/cost 预留，并明确"会话未映射到任何 profile 时按零预留、仅计次数"或"拒绝准入"的策略（推荐前者+审计事件）。

### P1-2 缓存证据的"滚动刷新"语义未验证，57 分钟倒计时的时钟基准可能错误

- **位置**：`docs/auto-compact-design.md:12-14,130-131,143-144`（§1、§5、§6）；S7、S9。
- **触发序列**：10:00 首次写缓存 → 10:40 一次纯 cache **read** 命中（无写）→ 设计假设"持续命中缓存的正常工作会刷新到期时间"，`expires_at` 滚动到 11:40 → 11:37 评估。若 Claude Code 的 `expires_at` 只在**写缓存**（cache creation）时推进、不因 read 滚动，则 10:57 定时器触发时缓存实际仍热，Omha 在 10:57 发起冷窗口压缩——**恰恰在用户回来后、缓存最可能被复用的时刻之前**把会话压掉，与优化目标相反；反之若读不滚动而设计又依赖滚动，重排期全部偏晚。
- **后果**：这是触发公式的时钟基准问题，直接决定 57 分钟策略对错；当前设计把"滚动"当作已验证前提写入 §1（"持续命中缓存的正常工作会刷新到期时间"），但本次审查未能从官方页面确认 `prompt_cache.expires_at` 是否随 read 滚动。
- **证据 vs 假设**：【官方已验证】`expires_at`="When the cached prefix leaves its TTL"、`warm`/`caching_observed`/`ttl("5m"|"1h")` 字段存在且需 v2.1.251+；【未验证】`expires_at` 的推进是否包含纯 read 命中，以及 Claude Code 内部如何由最近响应的 cache token 计数推导该时间戳。
- **具体修正**：列入阶段一必测项：构造"写后仅读"序列，用状态栏 JSON 桥观察 `expires_at` 是否前进。若读不滚动，把设计的时钟基准改为"最近**写**缓存请求的完成时刻"，或显式接受"读不续期"并调整 `dueAt` 公式与验收用例；禁止在探测前把滚动语义写死进配置文档。

### P1-3 观察模式在本机（Claude 2.1.220）上不可行，设计未显式声明这一全量降级

- **位置**：`docs/auto-compact-design.md:26,36`（§2）；本机版本由任务给定（Claude 2.1.220，Kimi CLI 2.2.0）。
- **触发序列**：本机 Claude 2.1.220 → ① Mods 需终端版 **2.1.287+**（官方明确）；② `prompt_cache` 状态栏字段需 **2.1.251+**；③ 一小时 TTL 的 `promptCacheTtl:"1h"` 设置需 **2.1.242+**；④ `idleCompaction` 键需 **2.1.290+** → 四项全部不满足。
- **后果**：设计的"观察模式"（只有 Mods 没有执行协调）在本机同样无法启动——不是"降级到观察"，而是**降级到纯提示词 skills**。设计 §15 与故障表没有给出"本机版本 2.1.220 时用户看到什么"的明确陈述，用户会误以为自动维护在运行。
- **证据 vs 假设**：【官方已验证】上述四个版本门槛均来自本次抓取的官方文档，非从版本号推断。
- **具体修正**：在 `omha compact status` 与 `omha doctor` 中输出显式的版本门槛矩阵（当前版本 / 所需版本 / 缺口项），状态显示 `mods_unsupported_by_version` 而非笼统的 unknown；docs/plugin.md 写明"2.1.220 这类旧版机器上本功能完全不可用，skills 不受影响"。

### P1-4 `session.compact` 事件是事前事件，"执行后区分结果"的能力未验证

- **位置**：`docs/auto-compact-design.md:29,234,241-245`（§2、§8）；S6。
- **触发序列**：Omha 调用 `$.session.compact()` → 设计依赖 `session.compact` 事件区分"已应用/仅预计算/skip/unknown"→ 官方参考对 `session.compact` 事件的描述只有一句："The conversation is about to be compacted"，返回 `{ skip: reason }`——**事前**拦截语义，未描述事后结果载荷；`$.session.compact()` 方法本身存在于 `$.session` 命名空间（已验证），但返回契约、忙碌拒绝、`skip` 的区分均未在官方页给出。
- **后果**：去重不变量依赖 `lastCompactedWorkRevision` 与"仅预计算不推进版本"的判定（§8），若目标版本无法区分"已应用"与"仅预计算"，条件 9（不重复生成摘要）无法可靠实现，可能重复消费维护次数或错误推进边界。
- **证据 vs 假设**：【官方已验证】方法存在、事件为事前语义；【未验证】结果返回契约、与 `/compact` 的等价性、忙碌拒绝行为。
- **具体修正**：阶段一对目标版本生成类型快照（官方建议"以目标版本生成的副本为准"），离线断言 `$.session.compact()` 的返回联合类型；同时用 `classic.PostCompact`（`classic.<Event>` 形式已在官方参考确认）作独立完成证据源，与 Mod 事件交叉去重——设计已列入 §8，需提升为"结果判定的强制双源"而非"补充"。

### P1-5 Mod→CLI 宿主通道与 CLI 缺席时的准入路径未定义

- **位置**：`docs/auto-compact-design.md:43-56`（§3 架构图）；`docs/auto-compact-design.md:334-348`（§11 故障表）。
- **触发序列**：`$.clock.after` 到点回调 → Mod 需要宿主做策略校验 + 声明写入（唯一执行者准入）→ 设计未说明通道：每次派生 `omha` 进程（`$.process.run`，默认 30s 超时上限 10 分钟）？常驻守护？命名管道？→ 若 CLI 未安装/不在 PATH，回调里 `$.process.run(['omha',...])` 的拒绝语义、重试与 `omha_final` 之外的输出解析均未定义。
- **后果**：声明的时效性（提交前版本比较）依赖该通道的延迟上界；通道不明则"检查与调用之间可能收到用户输入"（§8 已意识到）之外的第二个竞态——"准入往返期间缓存到期/窗口关闭"——无处理规则。
- **具体修正**：明确写为：Mod 仅在到点回调时通过 `$.process.run` 调用 `omha compact evaluate --session <id> --epoch <n> --revision <n>`（只读评估+一次性声明原子完成，CLI 内部完成策略校验、锁、预算、持久化并 stdout 输出结构化 JSON），往返预算 ≤5s，超时按 unknown 处理且**不消耗**维护次数（与设计"结果未知也消耗一次"区分：未知于未提交 vs 未知于已提交）；CLI 缺席时 Mod 直接进入只观察态并一次性 `$.ui.status` 提示，不再每次定时器重试。

### P1-6 状态栏桥接在用户**没有**状态栏时的行为未规定

- **位置**：`docs/auto-compact-design.md:112-115`（§5）。
- **触发序列**：用户未配置 `statusLine` → 启用桥接 = 由插件写入 `statusLine` 设置 → 官方文档确认自定义状态栏会使 Claude Code **隐藏大部分 footer 键盘提示**（esc/?/语音等），并引入 300ms 防抖、脚本取消、退出码显示等一整套行为变化。
- **后果**：设计只规定"不能覆盖用户已有状态栏"，但对"用户没有状态栏"这一更显常见的情形，桥接等于**改变用户的 UI**，属于未授权的可见副作用；这与 AGENTS.md"自动化不降低既有保证"精神相冲突（虽非安全保证，但是体验保证）。
- **具体修正**：把桥接提升为需要显式配置同意（`bridgeStatusLine: true` 单独开关，默认 false），文档写明 UI 副作用；同时给出无桥接时的完整降级（`cache_observation_unavailable`，设计已有）并作为默认路径。已验证官方事实：状态栏 JSON 的 `prompt_cache` 仅在主会话首次 API 响应后出现、子代理不计入、`current_usage` 在 `/compact` 后为 null 直到下次请求——设计"摘要完成后测量未知"的故障行与官方行为一致。

### P2-1 版本探测是全新能力，仓库目前没有任何 provider 版本检测

- **位置**：`docs/auto-compact-design.md:33-36`；【本地证据】`lib/` 中仅有 `commandExists('claude')`（`bin/omha.mjs:552-554`）与 git 版本探测（`lib/arena.mjs:509`）。
- **后果**：2.1.287/2.1.290 门槛需要解析 `claude --version` 输出并处理非 semver、wrapper 脚本、多版本并存。工作量小但属于新基础设施，应列入阶段一并补离线测试（fake claude 二进制）。

### P2-2 状态机图缺少 `Deferred` 的窗口过期出口

- **位置**：`docs/auto-compact-design.md:278-298`（§10 状态图）。
- **触发序列**：到点忙碌 → `Due --> Deferred` → 权限等待持续、无任何活动事件 → 窗口（`latestStartAt`）过期 → 图中 Deferred 只有 `Deferred --> Due`（活动变化且窗口仍有效）一条出边，**没有 `Deferred --> Observing` 的过期转移**；谁来在 Deferred 期间重新触发评估（§6 说"有限的重新检查"）也未落到定时器语义上。
- **后果**：实现者照图编码会产生无出口状态或依赖未声明的隐式重检；验收表"57 分钟忙碌到 60 分钟以后 → 不补发"虽有行为要求，但状态机不支持推导该行为。
- **具体修正**：补 `Deferred --> Observing: 窗口过期或缓存周期失效`，并写明 Deferred 的有限重检由 `$.clock.after` 单次预约实现（重检间隔与最大次数入配置或常量，例如 ≤3 次、间隔 20s）。

### P2-3 `minIntervalMinutes` 的冷却基准含混

- **位置**：`docs/auto-compact-design.md:90,185`（§4、§6 条件 6）。
- **触发序列**：原生 idle compaction 在 54 分钟抢先完成 → 是否以它为冷却起点？文本"任意两次已确认压缩之间的自动维护冷却期"读作包含非 Omha 压缩，但条件 6"最近一次压缩之后确有新的有效业务对话"又以"新业务"为必要前提——两者组合下，原生压缩后 + 无新业务 → 被不变量挡住；原生压缩后 + 有业务 → 冷却期起算点不明。
- **修正**：明确一句：冷却期从**任意来源**最近确认的压缩边界起算（与 §7"手动/原生/Omha 压缩共同推进去重边界"一致），并补一条验收用例。

### P2-4 忙碌/权限等待/待处理输入的判定来源未指定

- **位置**：`docs/auto-compact-design.md:110,183-184`（§5、§6 条件 5）。
- **说明**：官方参考确认 `$.agent.list()` 可列出子代理状态（`pending/running/waiting/idle/...`），但"权限等待""队列中的业务请求"没有对应 API 出现在已验证文档中。设计的保守默认"活动状态不明确则视为忙碌"是可接受的 fail-closed 处理，但应把"哪些信号可判、哪些一律视为忙碌"写成显式清单，避免实现时凭感觉放宽。

### P2-5 Mod 侧约束提醒（不构成设计变更）

- 官方限制：单个 hook 自执行时限 10s（`prompt.edit` 仅 50ms）——`prompt.submit` 撤销处理必须只做内存操作+单次定时器取消，不得内联等待宿主往返；【官方已验证】`$.fs.write` 非原子——Mod 侧不落恢复事实（设计已正确规定恢复事实只在 CLI）；【官方已验证】`disableAllHooks` 会同时停掉插件 Mod 与 settings hooks——§11 故障表"hooks 被关闭"一行应同时覆盖该设置。

---

## 3. 需求覆盖核对

| 用户要求                                          | 设计覆盖                                                                                                                   | 依据      | 判定                                 |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------ |
| 一小时缓存仍热时自动压缩、降冷压缩成本            | §1、§2（S1 未在本次独立复核，保留为设计引用）                                                                              | §1 目标段 | 覆盖（前提：S1 与滚动语义，见 P1-2） |
| 可配置定时，默认 57 分钟                          | `afterMinutes` 默认 57，整数 1–59，`afterMinutes*60+minRemainingSeconds<3600`                                              | §4 表     | 覆盖                                 |
| 可配置上下文下限，默认 20%                        | `minContextPercent` 默认 20，0–100，**等于阈值放行**、原始计数比较不取整                                                   | §4、§5    | 覆盖                                 |
| 小上下文不触发                                    | 19.99% 拒绝、unknown 拒绝、原始计数边界按 unknown                                                                          | §5、§14   | 覆盖                                 |
| 防止无新业务的连续自动 compact                    | `workRevision > lastCompactedWorkRevision` 且当前版本无未结清提交；手动/原生/Omha 压缩、仅预计算、状态查询均不推进业务版本 | §7        | 覆盖（结果判定依赖 P1-4 的双源确认） |
| 53 分钟内新输入必须撤销旧计划并按实际缓存刷新重排 | 两阶段：`prompt.submit` 立即撤销（不等响应完成）→ 对应请求产生 `expires_at` 证据后重排；无证据不伪造、不恢复旧计划         | §6        | 覆盖（见下方时间线推演）             |
| Mod 或 hooks 设计均可接受                         | Mod 首版 + classic hooks 仅作观察补充，不实现第二套调度                                                                    | §3        | 覆盖                                 |

**53 分钟重排时间线（基于设计规则逐步推演，含边界）**：

```
10:00:00  主请求写缓存           expiresAt=11:00:00  dueAt=10:57:00  latestStartAt=10:59:30
10:52:59  接受新指令             撤销（早于 53:00，必然撤销）→ AwaitingRefresh
10:53:00  接受新指令（含第 53 分钟）inputRevision++，取消旧 timer，撤销未提交 claim
10:53:20  对应请求读写缓存        新 expiresAt=11:53:20 → 新 dueAt=11:50:20（从请求起点计，非回车时刻）
10:58:00  模型回答完成            不改动排期（设计明确：不得按回答结束改算 11:55）
— 变体 A：请求 10:54:00 才读写缓存 → dueAt=11:51:00（以实际证据为准）
— 变体 B：请求失败/取消、无刷新证据 → 不恢复 10:57 旧计划，AwaitingRefresh→Observing，
          旧周期 11:00 到期后跳过，不补发
— 变体 C：10:56:30 又一次接受输入（提交前）→ 再次撤销，以最新证据重排
— 变体 D：10:57:05 已 Submitted 后输入 → 不可撤销，按原生并发排队（53 分钟窗口已过，符合要求语义）
```

该推演与设计 §6 示例及 §14 验收表一致；要求中"based on the associated actual cache refresh"通过变体 A/B 的区分得到满足。**未发现需求级缺口。**

**项目保证核对**：宿主校验（策略由 CLI 验证并冻结哈希，planner/skill 不可覆盖，§4）✅；fail-closed（无证据跳过、不明忙碌、unknown 不重试）✅；所有权 token（沿用 `lockDir` 的 `{pid,host,token}` 与 handoff owner，§10）✅；有界预算/并发（每会话 8 次、单次执行者声明、预留结算）✅，但预算账户轴需按 P1-1 落地；追加审计（事件清单 §12、达到上限停止准入而非截断）✅；离线默认检查（阶段二虚拟时钟、默认检查不调真实模型）✅；计费通道保留（压缩留在原生会话，不切 API、不起第二 provider，§11）✅；单一插件身份（不新增第二个 manifest，§13）——方向正确，但依赖 P0-1 的分发面实际存在；CLI 退出码不证明正确性（显式禁止以退出码/UI 文本确认完成，§8）✅。

---

## 4. 架构建议：原生 idle vs classic hooks vs Mods

**结论：维持设计选择——Mods 首版、classic hooks 仅作观察补充；但执行者绑定机制须按 P0-2 补齐，观察证据链须按 P1-2/P1-4/P1-6 加固。**

- **原生 idle compaction（不做 Omha 侧）**：官方已验证其行为——交互会话、1h TTL、可拉取 feature flags、上下文达阈值（默认 200K，最低 100K）、最后请求后约 54 分钟、机器醒着。它无法表达"57 分钟"与"20% 窗口"（200K 阈值在 200K 窗口模型上≈100% 才触发，且 1M 窗口下 20%=200K 恰好踩在原生默认阈值上，行为不可控），且原生门槛不可低于 100K——**小上下文场景（本需求的核心收益区）原生完全不覆盖**。仅当用户愿意接受原生语义时可作为零成本降级，不能作为主方案。
- **classic hooks（Stop/PostCompact 等）**：只能在事件发生时运行，本身无定时能力；一个等待 57 分钟的 `Stop` hook 会阻塞 Claude 或根本无法自持（无 `$.clock`）；用外部守护进程轮询又回到屏幕抓取/额外进程的老路，违背"优先结构化通道"。结论：只能做完成证据与生命周期观察（设计的 `classic.PostCompact` 定位正确），**不能承载调度**。
- **Mods**：官方已验证 `$.clock.after/every`（带 `cancel()`，模块重载取消定时器，与设计 §2 一致）、`prompt.submit`/`turn.start`/`turn.step`/`turn.complete`/`session.start`/`session.end`/`session.compact` 事件族、`$.session.usage()` 返回 `{startedAt, context:{tokens,window,percent}, rateLimits, cost}`、`$.settings.read()`、`$.session.compact()` 方法存在。进程内运行、无外部守护、无模拟按键，是三者中唯一同时满足"定时 + 观察 + 原生执行 + 可列举能力（`claude plugin validate`）"的路线。**未验证项（API/版本）**：`$.session.compact()` 返回契约与忙碌拒绝（P1-4）；`expires_at` 滚动语义（P1-2）；`usage()` 是否在某版本暴露缓存字段（设计已正确预判为不承诺）；本机 2.1.220 无任何 Mods 能力（P1-3）。

---

## 5. 修订后的端到端设计（解决交互，而非单个开关）

在保留设计主干的前提下，按下述整合修订；标注〔修订〕者为相对原设计的实质变更。

**配置**（`lib/profiles.mjs` allowlist + `schemas/providers.schema.json` 同步新增 `maintenance.autoCompact`，沿用 `keys()` 未知字段拒绝，`lib/profiles.mjs:71-99`）：

```json
{
  "maintenance": {
    "autoCompact": {
      "enabled": false,
      "afterMinutes": 57,
      "minContextPercent": 20,
      "minIntervalMinutes": 10,
      "minRemainingSeconds": 30,
      "maxCompactionsPerSession": 8,
      "bridgeStatusLine": false, // 〔修订〕P1-6：桥接默认关，显式开启
      "maxDeferredRechecks": 3 // 〔修订〕P2-2：Deferred 有界重检
    }
  }
}
```

校验不变：`afterMinutes*60 + minRemainingSeconds < 3600`；未知字段/非有限数/越界直接失败；策略哈希随声明绑定。

**观察**：主证据链 = `turn.step`（主请求身份，排除子代理与 compact 内部请求，`e.agentId` 区分主/子会话）+ `turn.complete`（usage 与上下文采样）；缓存证据优先级：① 目标版本 Mods 原生缓存字段（若探测存在）→ ② 显式开启的状态栏桥接（v2.1.251+ 才有 `prompt_cache`，桥接脚本只提交最小元数据并原样转发用户脚本）→ ③ 无证据则 `cache_observation_unavailable`，只观察。上下文准入一律用 `context.tokens*100 >= minContextPercent*window` 原始计数比较；仅显示百分比时边界按 unknown。**时钟基准**〔修订〕：探测结论二选一写死——读命中滚动则沿用 `expires_at`；否则改用"最近写缓存请求完成时刻 + TTL"。

**调度**：每个 cacheEpoch 用 `$.clock.after` 预约单次 `dueAt` 评估；执行窗口 `dueAt <= now < latestStartAt`（`latestStartAt = expiresAt - minRemainingSeconds`）；忙碌进入 Deferred，用单次 `$.clock.after` 做 ≤`maxDeferredRechecks` 次、间隔 20s 的重检，窗口过期无条件转 Observing 并记 `expired`，任何路径不补发冷压缩。

**新输入撤销（两阶段，不变）**：`prompt.submit`（去重后）立即 `inputRevision++`、取消 timer、撤销未提交 claim → 等待绑定该 inputRevision 的缓存证据 → 证据到达后以该请求实际刷新时刻重排；迟到快照与旧请求证据按 `(inputRevision, cacheEpoch)` 版本比较拒绝；请求失败/取消无证据则旧计划不恢复。

**上下文门槛与去重**：不变量保持 `workRevision > lastCompactedWorkRevision` 且无未结清提交；冷却期基准明确为**任意来源**最近确认压缩边界（P2-3）；`session.compact` 结果判定强制双源：Mods 事件/API 返回 + `classic.PostCompact`，二者都无法确认 → unknown（消耗次数、不重试、不推进版本）。

**原生协调（单一执行者）**：执行模式准入 = 会话由 omha 受管启动路径拉起且 argv 携带一次性 `--settings '{"idleCompaction":false}'` 文件（〔修订〕P0-2：新增该启动路径或明确首版仅观察）；收养会话一律 `native_idle_conflict` 观察。运行中用 `$.settings.read()` 复核；不关闭 `autoCompactEnabled`（官方确认关闭它会连带关闭 idle compaction，且是旧版唯一降级手段——不采用）。原生上下文超限恢复不被冷却/去重阻断（设计已有，保留为最高优先级例外）。

**执行确认**：提交前原子完成"策略哈希+版本三元组+会话身份+窗口+预算"复检（CLI 内完成，见 P1-5 通道）；仅接受 API 成功结果或双源完成边界为 confirmed，`skip` 非成功；忙碌拒绝只有经双源证明未发送摘要请求才释放声明。

**恢复**：声明先持久化（`atomicWrite`）后执行；唯一键 `(projectId, sessionId, conversationEpoch, workRevision)`；崩溃窗口 → unknown，不盲目重发；恢复时读取持久 `inputRevision`，存在等待中的新输入则不得重建旧 timer（设计已有，保留）。

**预算**〔修订，P1-1〕：handoff 记录新增持久 maintenance 账户（次数轴按 `(projectId, sessionId, conversationEpoch)`，跨重启不清零）；profile 级 token/cost 走 `ProviderRuntime.reserve/settle`，会话未映射 profile 时按零预留仅计次数；未提交即失败/超时不消耗次数，已提交或提交结果未知消耗一次；usage 可得时结算，不可得保留预留并记 unknown；订阅额度不伪造美元成本。

---

## 6. 离线验收测试矩阵与分阶段实施计划

### 测试矩阵（全部离线；fake Mod 宿主/虚拟时钟/fixture 状态栏 JSON，不调用计费模型）

| #   | 场景                                                              | 输入/操作序列                                    | 预期                                                                         | 对应发现                           |
| --- | ----------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------- | ---------------------------------- |
| T1  | 56:59 到点，ctx 80%                                               | 虚拟时钟到 dueAt-1s 触发回调                     | 不评估/不执行                                                                | 基线                               |
| T2  | 57:00，ctx 19.99%（原始计数 79960/400000…窗口 200K→39980/200000） | 边界计数                                         | 拒绝，不调用计数 API                                                         | §5 取整规则                        |
| T3  | 57:00，ctx 恰好 20%                                               | 其余条件满足                                     | 恰好一次 claim+submit                                                        | 阈值等于放行                       |
| T4  | 57:00，ctx 未知（usage 缺失）                                     | —                                                | 跳过，记 reason                                                              | §11 表                             |
| T5  | TTL="5m" / ttl 缺失 / caching_observed=false                      | —                                                | 跳过，不改时长                                                               | §4 分 TTL 策略                     |
| T6  | 周期内 10:40 纯 cache read                                        | fixture `expires_at` 两种行为（滚动/不滚动）     | 若滚动：旧 timer 作废；实现必须按探测结论选一分支并有测试钉住                | P1-2                               |
| T7  | 53 分钟重排主线（第 3 节时间线）                                  | 10:00 写缓存→10:53 输入→10:53:20 刷新            | 旧 10:57 撤销，新 dueAt=11:50:20                                             | 核心需求                           |
| T8  | T7 变体：请求失败无证据                                           | 提交后 API 失败                                  | AwaitingRefresh→Observing，不恢复旧计划，不伪造 TTL                          | §6                                 |
| T9  | 提交前并发输入                                                    | timer 回调已排队 vs prompt.submit 先到           | inputRevision 比较拒绝旧回调                                                 | §6 版本校验                        |
| T10 | 迟到的旧请求缓存快照                                              | 新排期后旧 turn 证据到达                         | 不覆盖新排期                                                                 | §6                                 |
| T11 | 手动 /compact 后旧 timer 到点                                     | PostCompact 先于 timer                           | 不执行；lastCompacted 推进                                                   | §7                                 |
| T12 | 原生 compact 后                                                   | session.compact 事件                             | 同上；双源缺一→unknown                                                       | P1-4                               |
| T13 | Omha compact 后 ctx 仍 35%，无新业务                              | —                                                | 不再触发                                                                     | 连续 compact 防护                  |
| T14 | 仅状态查询/心跳/重载                                              | —                                                | workRevision 不增                                                            | §7                                 |
| T15 | 新业务完成 ctx 25%，冷却已过                                      | —                                                | 重新评估并可执行                                                             | §7                                 |
| T16 | 输入与到点回调并发                                                | 交错调度 fixture                                 | 最多一个声明（锁竞争测试）                                                   | §10                                |
| T17 | 双 Mod 实例/热重载                                                | 两实例同 dueAt                                   | 锁+owner token 仅一胜出；败方 unknown 不重试                                 | §10                                |
| T18 | API 执行后崩溃                                                    | submit 成功→进程死→重启                          | unknown，同业务版本不重发，预算保留预留                                      | §10/§11                            |
| T19 | 忙碌贯穿窗口                                                      | Deferred 重检 3 次后仍忙                         | Deferred→Observing，记 expired，不补发                                       | P2-2                               |
| T20 | 休眠 65 分钟恢复                                                  | 时钟跳变                                         | 过期跳过，不补偿                                                             | §10                                |
| T21 | session/模型/目录/策略哈希变化                                    | 恢复旧声明                                       | 拒绝，重绑                                                                   | §11                                |
| T22 | skip/结果未知                                                     | API 返回 skip                                    | 不计成功、不重试；预计算不推进版本                                           | §8                                 |
| T23 | 原生上下文超限恢复                                                | 与冷却期重叠                                     | 不被阻断                                                                     | §7                                 |
| T24 | 次数/预算耗尽                                                     | 第 9 次请求                                      | 零新增提交，审计 reason                                                      | §4                                 |
| T25 | 无 CLI / Mod 不支持 / 策略关闭                                    | evaluate 派生失败                                | skills 可用；一次性提示，不每周期重试                                        | P1-5/P1-3                          |
| T26 | 配置未知字段/越界                                                 | `maintenance.autoCompact` 加杂项                 | validateProfiles 拒绝                                                        | §4（复用 `lib/validation.mjs:19`） |
| T27 | 配置修改                                                          | 运行中改策略                                     | 撤销未用声明、不重放 unknown                                                 | §4                                 |
| T28 | 桥接脚本契约                                                      | fixture 状态栏 JSON                              | 取消/退出码/输出保持；用户脚本被原样转发；无用户脚本且 bridge=false 时不安装 | P1-6                               |
| T29 | 版本探测                                                          | fake `claude` 输出 2.1.220 / 2.1.290 / 非 semver | 门槛矩阵正确，2.1.220 全降级                                                 | P1-3/P2-1                          |

### 分阶段实施计划

- **阶段 0（新增，解 P0-1）**：恢复/重建 `.claude-plugin/`、`skills/` 分发面；`omha doctor`、双 manifest strict validation、pack check 全绿；确认快照缺失是否等于仓库现状。
- **阶段 1 运行时契约探测**（不真实模型、不自动升级用户 CLI）：装目标版本（≥2.1.290）于隔离环境；生成类型快照；探测并回填：§5 时钟基准（T6）、`$.session.compact()` 返回与忙碌拒绝（P1-4）、usage 缓存字段、`precompute` 语义、原生/Mod 互斥、热重载定时器行为、状态栏桥接全契约（T28）。产出《契约确认表》，未确认项一律按观察模式降级。
- **阶段 2 宿主与策略（纯离线）**：配置 schema（T26/T27）、触发判断、两阶段撤销、状态机（含 T19 的 Deferred 出口）、声明/锁/持久化（复用 `lib/storage.mjs:75,122,183`）、maintenance 预算账户（P1-1）、`omha compact status` 只读入口、版本门槛矩阵（T29）。虚拟时钟跑完 T1–T25 的宿主侧子集。
- **阶段 3 Mod 集成**：`hooks/hooks.json`+`register.mjs`、事件接线、evaluate 通道（P1-5）、双源完成判定、单一执行者绑定（P0-2 选定的路径）；旧版提示词 skills 兼容加载离线验证。
- **阶段 4 交付**：docs/plugin.md、skills/README.md、CLI 帮助、changelog；全量离线检查 + 两个 manifest strict validation + pack check；真实收费压缩实验作为单独明确步骤，默认不跑，报告未运行项。按仓库约定提交推送。

---

## 7. 遗留技术问题、所需探测与来源

**未验证问题（按风险排序）**：

1. `prompt_cache.expires_at` 是否随纯 cache read 滚动（P1-2）——决定时钟基准。
2. `$.session.compact()` 返回契约：成功/仅预计算/skip/忙碌拒绝的区分（P1-4）——决定去重正确性。
3. Mods 原生途径能否取得缓存证据（`usage()` 扩展字段或事件载荷）——决定桥接是否必需。
4. 原生自动 compact 与 Mod 触发 compact 的互斥语义——决定单一执行者是否还需运行时防御。
5. 冻结快照缺失 `.claude-plugin/`、`skills/` 是裁剪还是仓库现状（P0-1）。
6. S1（Claude Code prompt caching 与 compaction 文档）与 S9（API 缓存 TTL 计时起点）未在本次审查中独立复核，保留为设计引用；S9 的"读续期"若成立将支持滚动假设，但 Claude Code 的 `expires_at` 实现仍须实测。

**所需探测**：目标版本类型快照（官方建议以本机生成副本为准）；T6/T28 两组 fixture 实验；fake claude 版本探测（T29）；旧版（<2.1.287）插件加载行为。

**来源**：

- 【官方已验证·本次抓取】[Mods overview](https://code.claude.com/docs/en/plugins/mods/overview)（终端 2.1.287+；插件文件布局；`disableAllHooks` 行为）；[Mods API](https://code.claude.com/docs/en/plugins/mods/api)（`$.clock.after/every`+cancel、`$.session.usage` 形状说明、`$.settings.read`、`$.prompt.submit` 语义）；[Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)（事件族表、`$.session` 方法清单含 `compact`、hook 10s 时限、`$.fs.write` 非原子、classic hook 事件形式）；[Settings reference](https://code.claude.com/docs/en/settings-reference)（`idleCompaction` 默认开/条件/54 分钟/需 2.1.290+、阈值默认 200K 最低 100K、`autoCompactEnabled` 默认 true 且关闭会连带关 idle compaction、`promptCacheTtl` 需 2.1.242+）；[Statusline](https://code.claude.com/docs/en/statusline)（`prompt_cache` 全字段/需 2.1.251+/子代理不计入/`current_usage` 在 compact 后为 null/自定义状态栏隐藏 footer 提示）。
- 【本地证据】`lib/profiles.mjs:71-99,201-207`、`lib/validation.mjs:19-23`（未知字段拒绝）；`lib/storage.mjs:75-97,122-154,183-263`（原子写/追加日志/带 token 锁）；`lib/terminal.mjs:29-42,52-58,80-139,277-292,402-525,641-700`（生命周期、owner token、argv 复用）；`lib/runner.mjs:98-105,157-186,188-235,590`（per-profile 预算、并发租约、预留保留语义）；`bin/omha.mjs:265-276,552-556`（`omha status`、doctor 读 plugin.json）；`lib/adapters.mjs:27-45`（无 `--settings`）；`schemas/providers.schema.json:5,42`（closed schema）；快照根目录无 `.claude-plugin/`、`skills/`、`hooks/`。
- 【设计引用·未独立复核】[S1](https://code.claude.com/docs/en/prompt-caching#compacting-the-conversation)、[S6 类型快照](https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts)（raw 抓取网络失败）、[S8](https://code.claude.com/docs/en/hooks#precompact)、[S9](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#when-does-the-cache-lifetime-start)。
