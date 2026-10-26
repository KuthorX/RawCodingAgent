# Agent 架构深入分析

这篇文档解释 RawCodingAgent **怎样把一句任务变成连续的模型调用、工具操作和可恢复的会话**，以及这些设计目前能保证什么、不能保证什么。系统边界、远程入口和部署方式见[项目架构总览](architecture.md)。

分析基线：`5c86e38`。文中的“确认”指已核对源码；“复现”指本次用假模型或临时 Git 仓库实际运行；“判断 / 建议”是基于实现的分析，不是性能测试结论。本文没有调用真实模型，没有修改 Agent 运行逻辑。

阅读导航：[核心分层](#2-核心分层谁负责什么) · [任务全过程](#4-沿着一个修复任务走完整条链路) · [执行循环](#5-agent-循环怎样推进任务) · [工具与权限](#7-工具系统与权限边界) · [上下文](#8-上下文管理保留什么压掉什么) · [完成验收](#9-完成验收为什么说完成了还不够) · [恢复](#11-持久化与恢复保存的是哪一种状态) · [多-agent](#12-多-agent委派执行与结果整合) · [已复现问题](#15-已复现的两处实现偏差) · [验证与阅读路线](#17-验证证据与源码阅读路线)。

## 1. 先给出架构判断

**它是一套自研的、以工具调用为中心的本地 Agent 运行时。** 模型提出下一步行动；运行时决定行动能否执行、怎样执行、怎样记账和保存，以及什么时候必须停下。模型协议交给 SDK，任务生命周期仍由项目自己控制。

用一次“修复失败测试”的任务来理解：模型可以提出“读这个文件”“改这段代码”“运行测试”，但真正打开文件、启动进程、请求审批、保存执行结果的都是本地 TypeScript 代码。最终是否显示为正常完成，也不完全由模型的结束语决定。

可以从三个层面看它：

| 层面 | 这层回答的问题 | 当前实现 |
| --- | --- | --- |
| 模型决策 | 下一步读什么、改什么、调用哪个工具？ | `Provider.complete` 返回文字、`toolCalls`、停止原因和用量。 |
| 运行时控制 | 允许执行吗？还能继续付费吗？需要压缩或停止吗？ | `runTurn`、权限、预算、上下文和完成检查。 |
| 会话与执行环境 | 历史在哪里？用户插话怎么办？重启后怎么继续？文件实际改在哪里？ | `SessionRunner`、`SessionStore`、事件订阅、文件 / shell / worktree。 |

**判断**：把它称为轻量 Agent runtime / harness 比称为“一个调用模型的聊天界面”更准确。它已有恢复、验收和预算约束；但它也不是具备任务租约、跨进程调度、事务账本和 OS 沙箱的分布式 Agent 平台。

依据：[app.ts / createRuntime](../src/app.ts#L58)、[loop.ts / runTurn](../src/agent/loop.ts#L498)、[runner.ts / SessionRunner](../src/session/runner.ts#L151)、[types.ts / Provider](../src/types.ts#L76)。

## 2. 核心分层：谁负责什么

![核心组件：接入装配、SessionRunner、Agent 循环、模型适配、工具、策略和存储](architecture/components.svg)

图中是进程内运行时调用及回调，不是独立服务之间的网络连接。[可编辑图源](architecture/components.html)。

| 组件 | 负责的状态 / 行为 | 不由它负责 |
| --- | --- | --- |
| `createRuntime` | 加载配置、创建存储、准备 provider 工厂、工具和 prompt，提供 `makeDeps` | 不执行一个完整用户任务。 |
| 接入层：CLI、GUI、eval | 解析输入、选择 / 创建会话、呈现结果；GUI 还做 HTTP 身份校验 | 不各自实现一套模型工具循环。 |
| `SessionRunner` | 历史、会话元数据、插话队列、审批 Promise、停止信号、压缩、模式、子 Agent | 不承担具体厂商协议转换，也不直接实现读写文件。 |
| `runTurn` / `loop` | 用当前历史反复调用模型，调度工具、处理限制，返回 `TurnResult` | 不知道 HTTP 请求、DOM 或具体会话目录结构。 |
| `Provider` | 内部消息与厂商协议转换、流式接收、工具参数拼装、用量归一化 | 不批准工具，也不修改工作区。 |
| `Tool` | 校验自身参数，操作文件、进程、网络或计划，返回字符串 | 不决定下一轮该问模型什么。 |
| 上下文 / 验收 / 限制组件 | 为循环提供预算、压缩、完成判断和进展信号 | 不等同于模型提示词；其中部分是代码强制执行。 |
| Store / Tracer | 保存可继续的上下文、展示事件、执行记录 | 不是数据库事务，也不是独立遥测服务。 |

**这套分层的价值**：CLI、GUI 和 eval 可以复用同一条 `runTurn` 路径；测试可以换掉 provider；SWE-bench 可以只替换 `bash`，让同一个 Agent 在不同执行环境里工作。

**实际耦合**：`SessionRunner` 同时管理很多长期策略，是最集中的复杂度来源；`AgentDeps` 除 provider / tools 外还包含多个 hooks。它便于注入能力，但阅读一次调用时必须沿着装配点找回这些 hooks，不能只看 `loop.ts` 就认为已经理解完整行为。

依据：[app.ts / makeDeps](../src/app.ts#L112)、[cli.ts / runCli](../src/cli.ts#L23)、[gui/manager.ts / get](../src/gui/manager.ts#L222)、[eval/runner.ts / runAgentTurn](../src/eval/runner.ts#L138)、[swebench/runner.ts](../src/eval/swebench/runner.ts#L36)。静态 `import` 关系另见[总览中的依赖表](architecture.md#静态代码依赖)。

## 3. 四个容易混淆的单位

| 单位 | 在项目里的含义 | 修复任务中的例子 |
| --- | --- | --- |
| Session，会话 | 一段可持久化、可恢复的工作上下文；绑定工作区、模型选择、权限、计划等 | 今天修测试，明天继续在同一会话完善说明。 |
| Turn，一轮任务 | 一次用户输入进入 `runTurn`，直到正常结束、未验证、停止、超限或报错 | “修复失败测试并验证”通常先开启一轮。 |
| Step，循环步 | `loop` 的一次迭代，通常包含一次主模型调用和它提出的一批工具调用 | 模型同时提出 `glob` 和 `grep`，仍可属于同一步。 |
| Tool call，工具调用 | 一次带独立 `id`、名称与参数的具体操作 | `read_file` 读取某文件，或 `edit_file` 替换某段文本。 |

**Step 数不等于 API 请求数。** 断连重试、强制压缩重试、上下文摘要以及超限后的总结都可能增加模型请求。费用必须按 `llm` 调用统计，不能用“步数 × 单步费用”推算。

项目实际上有两层循环：

- **内层 `loop`**：在一轮里不断执行“模型提工具、工具回结果、再问模型”。
- **外层 `SessionRunner.drain`**：一轮结束后处理迟到的用户消息；若开启 `/loop`，还可能根据结束原因创建下一轮输入。

`/loop` 默认最多 10 轮、可设 1–50 轮；只有上一轮以 `unverified` 结束才自动继续。它不是忽略所有错误后无限重试，也不是一个固定周期的后台调度器。

依据：[loop.ts / TurnResult](../src/agent/loop.ts#L92)、[runner.ts / drain](../src/session/runner.ts#L621)、[runner.ts / loopTurn](../src/session/runner.ts#L645)。

## 4. 沿着一个修复任务走完整条链路

以下是解释用的任务，不是本次调用真实模型取得的执行轨迹：

> 在目标工作区中修复失败的测试。先读代码，再做最小修改，验证通过后说明原因。

假设会话已经存在、GUI 已连接 SSE，审批模式为 `ask`。

### 4.1 接入层先处理确定性的命令

GUI 将消息 POST 到 `/api/sessions/:id/message`。路由校验正文与附件；如果以 `/` 开头，先交给 `runCommand`。例如 `/plan` 会改变实际工具集合，`/skills` 可以不调用模型直接列出技能。普通任务才进入 `runner.send`。

因此，斜杠命令不是“让模型自行理解 `/plan` 的意思”。命令语义由宿主程序执行，任务正文和界面上显示的原输入可以不同。

依据：[gui/server.ts / POST message](../src/gui/server.ts#L290)、[session/commands.ts / runCommand](../src/session/commands.ts#L39)。

### 4.2 会话层决定立即运行还是插话

空闲时，`send` 检查累计额度、发出用户事件、启动 `drain`。GUI 返回 HTTP 202；它只表示已受理，不表示已修复。

运行中收到“只改业务代码，先别动测试”，这条消息进入内存队列。内层循环在下一步模型调用之前取出它，加上 `User interjection` 标记。已经开始的工具不会因为这条消息自动撤销。如果当前一轮恰好先结束，`drain` 会把未送达的插话合并成下一轮输入。

依据：[runner.ts / send](../src/session/runner.ts#L451)、[loop.ts / interjections](../src/agent/loop.ts#L315)、[runner.ts / drain](../src/session/runner.ts#L621)。

### 4.3 运行器为这一轮准备依赖

`drain` 创建 `AbortController`，刷新 provider 凭据并建立本轮预算。`run` 根据会话模式筛选工具，接入压缩与验收 hooks，最后调用：

```ts
runTurn(this.history, input, deps, control)
```

已有会话不会随全局默认模型变化；但其厂商连接在下一轮重新创建，因此更新凭据可以在下一轮生效。

依据：[runner.ts / refreshProvider](../src/session/runner.ts#L608)、[runner.ts / run](../src/session/runner.ts#L747)、[app.ts / makeProvider](../src/app.ts#L68)。

### 4.4 模型提议行动，运行时执行

模型可能先返回 `glob` / `read_file`，读取后再返回 `edit_file`。每个工具调用都经过名称、参数和审批处理。`ask` 模式下，编辑会等待一个审批 Promise；用户批准后才进入工具实现。

编辑完成不等于整个任务结束。工具结果被放回历史，下一次模型调用才能根据真实执行结果决定继续修改、验证或回答。

### 4.5 验证结果参与结束判断

改过文件后，模型需要调用 `verify_changes`。它运行事先固定的检查命令，记录验证时的工作区指纹。模型最后不再提出工具时，循环检查计划和验收状态；不满足条件便返回 `unverified`。

`SessionRunner` 随后保存最终上下文并发出 `turn_end`。浏览器通过 SSE 获得事件，终端通过同一运行器的订阅获得结果。

对比只读任务的简化消息顺序，可看[任务时序图](architecture/task-sequence.svg)；修复任务在工具执行阶段多了人工审批、文件变更与验证。

## 5. Agent 循环怎样推进任务

下面是**省略细节后的控制顺序**，不是可替换原函数的实现：

```text
以历史 + 本轮用户输入开始
每一步：
  检查停止信号、费用和步数边界
  接收用户插话，检查是否原地打转
  准备上下文，必要时调用模型生成摘要
  调用 provider，接收完整响应与流式文字
  保存模型响应，重新检查费用
  如果没有工具调用：检查计划与验证证据，然后返回
  如果工具参数被输出上限截断：不执行，补错误结果，再决定是否重试
  为整批工具写入“尚未执行”的恢复记录
  执行工具批次，保存结果，更新进展与重复检测
  把 tool_results 交给下一步模型调用
达到限制：保存已有结果，并按限制类型结束
```

需要注意三个设计点：

1. **模型返回的工具调用只是提议。** 它仍可能因为工具不存在、参数无效、用户拒绝、预算耗尽或停止信号而不执行。
2. **所有调用都要有结果。** 即使被拒绝或没开始，也补一条错误结果，维持工具调用和结果的配对。
3. **预算检查不只在循环开头。** 模型返回用量之后、工具批次推进时还会检查，避免已经超额却继续产生副作用。

输出被 `max_tokens` 截断且包含工具调用时，当前批次不执行；运行时最多允许 2 次这种重试，提示模型拆小调用。重试消耗后续循环步。`refusal` 下的工具同样不执行，但不会走这条截断修复路径。

**已复现的偏差**：代码意图是“只读调用并行、写操作保持顺序”，但当前分组只检查后续成员，没有检查组首。`write_file` 后接 `read_file` 时也能进入同一个 `Promise.all`。不能根据注释把所有混合批次描述为安全串行，见[问题 A](#问题-a写操作可能与后续读取并发)。

依据：[loop.ts / loop](../src/agent/loop.ts#L270)、[loop.ts / 批次与 checkpoint](../src/agent/loop.ts#L407)、[multi-agent.test.ts / 只读并行测试](../test/multi-agent.test.ts#L28)。

## 6. Provider 边界：隔离协议，保留必要原始信息

核心契约是 `complete(request, signal, onDelta)`：输入包含 system、消息、工具定义；输出包含完整 assistant 消息、统一停止原因和用量。流式文字通过 `onDelta` 另行交付，工具参数在适配器中拼完整后才交给循环。

内部消息的一小段示意如下：

```json
[
  {"role":"user","content":"读取 README"},
  {"role":"assistant","text":"","toolCalls":[
    {"id":"c1","name":"read_file","input":{"path":"README.md"}}
  ]},
  {"role":"tool_results","results":[
    {"callId":"c1","content":"文件正文……","isError":false}
  ]},
  {"role":"assistant","text":"项目用途是……","toolCalls":[]}
]
```

`tool_results` 在内部是一条批量消息。`OpenAIProvider` 将它转换成协议所需的多条 `tool` 消息；`PiProvider` 转成原生 SDK 的 `toolResult`。因此，核心循环不用为每家厂商复制一遍。

| 适配器 | 当前职责 | 需要保留的边界 |
| --- | --- | --- |
| `OpenAIProvider` | Chat Completions 转换、流式 tool call 拼接、兼容端点模型列表 | 仅在尚未展示 delta 时尝试非流式回退；流式中途断连由循环的重试逻辑处理。 |
| `PiProvider` | 原生模型目录、思考强度、图像能力、流式事件与费用转换 | `OPENAI_STREAM=false` 可以关闭向 UI 发 delta，但底层仍使用 SDK 流式传输。 |

**一个有意保留的耦合**：内部 assistant 消息仍可携带 `piMessage`，其类型来自 SDK。这样可以保留签名 / 加密 reasoning 和原始模型身份，避免恢复对话时丢掉协议要求的信息。因此，系统实现了“核心循环不依赖具体 provider 类”，但消息存储并非完全不含厂商相关数据。

**扩展含义**：如果增加一个已有 SDK 能支持的厂商，通常要处理目录、连接和选择校验；如果引入新的协议，则需要实现 `Provider` 并接入工厂。只实现接口还不够，GUI 的选择校验、凭据存储、费用和上下文能力也必须一致。

依据：[types.ts](../src/types.ts)、[providers/openai.ts](../src/providers/openai.ts)、[providers/pi.ts](../src/providers/pi.ts)、[providers/catalog.ts](../src/providers/catalog.ts)、[providers/store.ts](../src/providers/store.ts)。

## 7. 工具系统与权限边界

工具由三部分组成：给模型看的 `spec`、给运行时看的 `dangerous` / `approvalInput`、真正执行的 `run(input, ctx)`。工具集合决定模型有哪些可用能力；描述和 JSON Schema 不能替代服务端校验。

### 7.1 执行顺序

`runTool` 先找注册工具、检查参数解析错误，再调用 `needsApproval`。批准后检查停止信号，执行 `beforeTool`、工具本体和 `afterTool`。失败通常变成 `isError: true` 的工具结果，让模型有机会修正；未知工具与错误参数也不会直接被当作成功。

工具输出默认保留前后各一半，阈值为 20000 字符，中间插入省略标记。模型获得的是受限结果，不能假定已经看到日志中间的所有错误。循环检测则使用截断前输出的摘要，以免中间内容变化被误判为无进展。

依据：[tools/types.ts](../src/tools/types.ts)、[loop.ts / runTool](../src/agent/loop.ts#L150)、[truncate.ts](../src/agent/truncate.ts)、[cycle-guard.ts / observationHash](../src/agent/cycle-guard.ts#L11)。

### 7.2 权限有四层，各自解决不同问题

| 层次 | 实现 | 能限制什么 | 不能由此推出什么 |
| --- | --- | --- | --- |
| 入口身份 | 本机 token；远程入口身份与配对校验 | 谁能向运行时提交任务 | 已登录用户提交的命令天然安全。 |
| 工具集合 | `turnDeps` 按 `/plan`、多 Agent 开关筛选 | 计划模式没有 bash / 写文件工具 | prompt 里说“只读”就能限制一个仍然开放的 shell。 |
| 审批策略 | `needsApproval`、会话 `ask` / `auto` | 受控操作是否等用户允许 | 它具有 OS 沙箱的隔离能力。 |
| 文件路径与进程环境 | `resolveInWorkspace`、`sanitizeToolEnv` | 文件工具拒绝越界和常见符号链接逃逸；过滤常见凭据环境变量 | bash 不能读取宿主机其他路径、访问网络或使用磁盘上已有凭据。 |

`ask` 模式对部分只读 shell 命令免审，采用命令名和参数规则判断。它是减少审批干扰的便利过滤器，不是完整 shell 语法分析或权限隔离器。`auto` 则直接允许受控工具继续。

在“修复失败测试”的例子里，`read_file` 通常直接执行，`edit_file` 等待审批；`verify_changes` 也需要经过审批，且展示的是运行时固定的实际命令，不接受模型用参数替换检查命令。

依据：[permissions.ts](../src/agent/permissions.ts)、[tools/workspace.ts](../src/tools/workspace.ts#L25)、[config.ts / sanitizeToolEnv](../src/config.ts#L19)、[verification.ts / tool](../src/agent/verification.ts#L149)。

## 8. 上下文管理：保留什么，压掉什么

### 8.1 Prompt 是分层组装的

基础行为、可选实验规则、自定义指令、仓库指令先由 `buildSystemPrompt` 组装；`SessionRunner.systemFor` 再追加用户选中的技能和运行模式说明。仓库指令沿祖先目录到工作区读取，优先识别 `AGENTS.md` / `agents.md`。

技能是**持久化的指令快照**：正文随会话保存在 `meta.json`，压缩和重启后仍能重建。未加载的技能不把完整正文发送给模型。技能加载不会自动安装依赖、执行脚本或授予工具权限。

代价是 system prompt 也占上下文预算。加载技能时，代码同时限制单文件大小、累计字符数和仅 system / schemas 就消耗的输入预算，避免大技能集挤掉任务内容。

依据：[system-prompt.ts](../src/agent/system-prompt.ts)、[skills.ts](../src/agent/skills.ts)、[runner.ts / useSkill](../src/session/runner.ts#L232)、[runner.ts / systemFor](../src/session/runner.ts#L286)。

### 8.2 输入预算覆盖完整请求

输入估算包括 system、工具 schema、序列化后的消息和图片预留，不只是可见聊天文字。当前估算按 ASCII 约 4 字符 / token、非 ASCII 约 1.5 字符 / token；每张图片额外预留 8192 token。这是启发式估算，不是厂商 tokenizer 的精确计数。

`inputLimit` 的公式是：

```text
输入上限 = 模型上下文窗口 - min(8192, ceil(窗口 / 4))
```

例如窗口为 64000 时，输入上限是 55808，剩余部分预留给输出。原生模型窗口来自目录，兼容端点可配置，未知兼容模型采用 64000。

### 8.3 压缩是一条真实的模型调用路径

压缩会把对话转成文本，必要时分块总结，再合并摘要；结果替换成一条摘要消息加最近一段完整消息组。代码还附带从 `write_file` / `edit_file` 调用收集的文件路径。

因此它不是无损压缩：摘要可能漏细节；路径列表记录的是调用中出现过的文件，不是逐个核验过的成功改动账本，也不能覆盖所有 bash 修改。最近上下文会尽量保持 assistant 工具调用与其结果成组，避免剪出非法的半组对话。

压缩失败后，只有原请求仍在硬输入上限内才允许继续。服务端仍报超窗时，循环最多强制压缩并重试一次。摘要调用也经过统一的模型计费入口，不能把它当成免费的本地操作。

依据：[context.ts](../src/agent/context.ts)、[runner.ts / inputLimit](../src/session/runner.ts#L574)、[runner.ts / summarize](../src/session/runner.ts#L684)、[runner.ts / prepareContext](../src/session/runner.ts#L700)、[runner.ts / compactMessages](../src/session/runner.ts#L722)。

## 9. 完成验收：为什么“说完成了”还不够

`Verification` 保存三类信息：是否发生过需要验证的操作 `changed`、已通过检查的工作区指纹 `checked`、固定检查策略 `policy`。这些信息进入会话元数据，重启不会自动把未验证改动变成已完成。

工作流程是：

1. 首次执行前选定检查：优先 `.agent-checks.json`，否则从 `package.json` 找 `npm test` / `npm run typecheck`。
2. 写入开始前就使旧验证失效，避免“写了一半失败”仍沿用之前的通过状态。
3. bash 前后比较指纹；只有被识别为只读且内容没变的命令才恢复原验证状态。
4. `verify_changes` 执行固定命令，要求退出成功、没有超时 / 中止 / 遗留后台进程，且验证前后工作区内容一致。
5. 最终结束前再次检查指纹。验证后又修改文件，原结果不再有效。

检查使用的 npm scripts 定义也会固定，防止把 `npm test` 改成空操作后冒充通过。但这不是完整的防篡改测试环境：测试源文件仍在工作区，指纹也按既定文件范围计算，忽略目录和未跟踪的 ignored 文件不属于全面监控对象。

**验收能证明的是：配置中的命令在被记录的文件状态上成功执行。** 它不能证明需求全部正确、测试没有漏洞或真实设备已经验证。模型更新的计划清单也是状态输入，不是独立的质量证明。

`/clear` 有一个容易忽略的细节：它创建空对话并清除计划 / 已加载技能，但会带上 `verification` 状态。清空聊天不会抹掉同一工作区尚未验证的改动，也不应被当成必然重新选择检查策略的办法。

依据：[verification.ts / commandsFor、fingerprint](../src/agent/verification.ts#L24)、[verification.ts / beforeTool、check](../src/agent/verification.ts#L116)、[runner.ts / freshSession](../src/session/runner.ts#L307)、[runtime-safety.test.ts](../test/runtime-safety.test.ts#L233)。

## 10. 预算、停止、重试与原地打转

### 10.1 预算是多层限制，不是只有一个 maxSteps

单轮限制来自全局设置 / 环境配置，再被会话覆盖；累计额度取会话、工作区、项目剩余额度中的最小值。`SessionRunner` 累计本轮用量，同时向 `SessionManager.budgetFor` 查询已落盘 trace 对应的累计成本。

主任务、子 Agent 和压缩调用都进入费用统计。成本达到上限时使用本地提示结束，不再付费请求一个“我超预算了”的总结。步数、重复或停滞等限制则可在预算允许时请求总结。

**边界**：请求发出前只有估算，最终费用在用量返回后才能确认；并发调用之间也没有预留余额的事务。多个请求可能同时看见还有余额，返回后共同超额。失败或中断而没有拿到用量时标记 `usageUncertain`，不能把统计数字解释为厂商账单的精确硬上限。

依据：[manager.ts / budgetFor](../src/gui/manager.ts#L103)、[runner.ts / spendingLimit](../src/session/runner.ts#L561)、[loop.ts / completeModel](../src/agent/loop.ts#L237)、[pricing.ts](../src/pricing.ts)。

### 10.2 停止是协作式中断，不是撤销

`stop` 触发共享 `AbortController`，拒绝待审批调用、清空未送达插话，并退出自动循环。provider 和长时间工具接收同一个 signal；shell 工具会尝试结束进程组。

已经完成的文件修改保留。某个工具在中止前已经写了一部分时，系统需要靠恢复记录、工作区检查和下一轮处理，不能承诺回滚到任务开始前。

模型断连可按 1 秒、3 秒等待重试；已输出的流式文字会先发 `assistant_reset`，避免 UI 把重复答复拼起来。工具副作用不会套用这条模型重试逻辑自动重放。

依据：[runner.ts / stop](../src/session/runner.ts#L509)、[tools/bash.ts / runShell](../src/tools/bash.ts#L173)、[loop.ts / callModel](../src/agent/loop.ts#L204)、[control.test.ts](../test/control.test.ts)。

### 10.3 两种“原地打转”检测

- **连续相同调用**：工具名和稳定排序后的参数重复到阈值，默认第 3 次不执行。
- **交替循环**：2–6 个调用及结果重复三轮，先警告；再出现一轮旧观察才停止。更新计划不算新证据；新输出、真实修改或用户插话可清除旧记录。

这套检测匹配的是确定性记录，不理解语义。两个等价但写法不同的命令、带不断变化时间戳的输出，可能绕过检测。因此仍需要费用与步数限制兜底。

### 10.4 结束原因需要保留语义

| 结果 | 应怎样理解 |
| --- | --- |
| `end_turn` | 模型正常结束，且启用的完成门槛没有阻止它；不等于所有现实需求已证明正确。 |
| `unverified` | 计划未完成或当前改动没有有效验证证据；`/loop` 可据此继续。 |
| `max_steps`、`max_cost`、`budget` | 撞上对应资源限制；保留已经完成的结果。 |
| `repeated`、`stagnant` | 检测到重复调用或无新证据的循环。 |
| `interrupted` | 用户或上层控制中止。 |
| `max_tokens`、`refusal`、`other` | 模型协议层的非正常结束；不能一律显示为成功。 |
| 会话 `error` 事件 | 某些异常由运行器捕获并记录；它不是 `FinishReason` 中的一个字符串。 |

依据：[loop.ts / FinishReason](../src/agent/loop.ts#L76)、[limits.ts](../src/agent/limits.ts)、[cycle-guard.ts](../src/agent/cycle-guard.ts)、[runner.ts / run](../src/session/runner.ts#L747)。

## 11. 持久化与恢复：保存的是哪一种状态

### 11.1 四份文件服务四种用途

| 文件 / 状态 | 主要消费者 | 重要边界 |
| --- | --- | --- |
| `meta.json` | 会话列表、Runner、模式与验证策略 | 持久化设置和任务状态，不保存正在等待的 Promise。 |
| `messages.json` | 下一次模型调用与恢复 | 当前可继续的模型上下文；压缩后会包含摘要，不是永不变更的完整聊天档案。 |
| `events.jsonl` | GUI / CLI 回放与订阅 | 展示事件；逐字 delta 不落盘，不能把它视为完整的事件溯源状态机。 |
| `trace.jsonl` | 调试、成本与工具统计 | span 和响应记录；常见凭据做尽力脱敏，不等于所有会话文件都经过同一套脱敏。 |
| 内存中的队列、pending、AbortController | 当前 `SessionRunner` | 进程退出即消失；不是持久化任务队列。 |

UI 事件、模型历史、执行 trace 分开保存，使前端展示不必成为模型协议的一部分。但它们也不是一个跨文件原子事务：某份文件写入失败，其他文件可能已经更新。`emit` 先通知订阅者再追加事件，实时看见事件本身也不是落盘确认。

依据：[session/store.ts](../src/session/store.ts)、[runner.ts / emit](../src/session/runner.ts#L804)、[agent/trace.ts](../src/agent/trace.ts)。

### 11.2 恢复记录提前描述不确定性

工具执行前后都会写 checkpoint，整批调用至少区分三种情况：

| 中断时点 | 留给恢复的结果 | 后续策略 |
| --- | --- | --- |
| 工具还没开始 | `not executed` | 不谎称执行成功。 |
| 工具开始但未记录完整结果 | `execution outcome uncertain` | 先检查工作区，再决定是否重试；不自动重复副作用。 |
| 已有完整结果 | 实际 `ToolResult` | 保留结果，恢复后继续使用。 |

`saveStep` 要先写盘成功才更新内存历史；保存失败会阻止继续执行下一项副作用。模型或工具链路异常时，`TurnAbortedError` 携带已完成部分，运行器尽力保留这些消息。

`messages.json` / `meta.json` 采用临时文件加 rename，减少进程中断造成半截 JSON 的风险；会话锁记录 PID，阻止另一个存活进程同时打开同一会话，GUI 的 map 则复用本进程内的运行器。这不等于文件系统断电持久性、跨主机锁或数据库事务保证。

恢复时不会自动重启被杀掉的执行流程。用户继续会话后，模型拿到已保存的上下文与不确定结果，再决定下一步。

依据：[loop.ts / saveResults](../src/agent/loop.ts#L409)、[runner.ts / saveStep](../src/session/runner.ts#L783)、[store.ts / writeJsonAtomic](../src/session/store.ts#L147)、[store.ts / acquireLock](../src/session/store.ts#L331)、[runtime-safety.test.ts / SIGKILL](../test/runtime-safety.test.ts#L181)。

## 12. 多 Agent：委派执行与结果整合

`multi_agent` 是普通工具的一种。父模型提交自包含任务，工具回调 `spawnAgents`，再并发调用多个 `runTurn`。子 Agent 不另起 Node.js 服务，也不是持久化 worker 队列。

| 特征 | scout | worker |
| --- | --- | --- |
| 用途 | 搜索、阅读与侦察 | 相对独立的代码修改 |
| 工作区 | 父工作区当前文件，可看到未提交内容 | 新 Git worktree；父工作区 tracked 未提交改动不复制 |
| 工具 | 只读文件 / 搜索 / 抓取工具 | 文件和 shell 等；排除 `plan`、`verify_changes`、`multi_agent` |
| 当前上限 | 8 步、单轮本地费用阈值 $0.05 | 30 步、单轮本地费用阈值 $0.2 |
| 会话上下文 | 独立历史，只拿委派 prompt | 独立历史，只拿委派 prompt |
| 输出 | 总结、状态、步骤与费用等 | 另含 worktree、分支与改动文件数 |

每批最多 4 个子 Agent，其中最多 2 个 worker；父 turn 的预算和停止信号也约束它们。父工具调用的审批一旦通过，子任务内部使用自动批准。父模型历史只接收合并后的工具结果，子事件以 `agent` 标识记录在展示日志里。

这里有几条重要限制：

- **没有递归委派**：子工具集移除 `multi_agent`，避免层层派生。
- **没有继承整段父对话**：委派 prompt 必须写清任务和必要约束；后来到达的用户插话也不会自动送给子任务。
- **没有独立的子会话恢复快照**：子 deps 将 `onStep` 设为 `undefined`。父会话保留委派调用和子事件，但进程中断后不能像主任务一样从独立的子消息快照接续；留下的 worker 文件仍需检查。
- **父会话技能不会自动原样继承**：`runAgent` 用 `makeSystem(workspace)` / 基础 system 构造子 prompt，不走父会话的 `withSkills` 快照叠加路径。
- **worker 没有父任务同样的自动验收门槛**：子 deps 清除 `completionCheck`、`beforeTool`、`afterTool`，还移除 `verify_changes`。提示词会要求验证，但 `ok: true` 本身不证明测试已通过。
- **返回分支名不表示修改已经提交**：worker 提示词明确要求不要 commit。未提交文件仍在它的 checkout 中，不能只运行一次 `git merge <branch>` 就假定带回这些修改。
- **worktree 是代码版本隔离，不是权限隔离**：worker 的 shell 仍有宿主进程可用的权限。

**基线偏差已复现**：设计目标是从父工作区当前提交开始，但代码在主 worktree 中解析创建命令的 `HEAD`。父会话位于另一个分支的 worktree 时，实际起点可与返回的 `base` 不一致，见[问题 B](#问题-bworker-可能从错误的提交启动)。

依据：[tools/multi-agent.ts](../src/tools/multi-agent.ts)、[runner.ts / runAgent](../src/session/runner.ts#L321)、[runner.ts / agentNote](../src/session/runner.ts#L818)、[workspace/worker.ts](../src/workspace/worker.ts)。

## 13. 评测为什么复用核心，却更换验收方式

两套评测都创建 `SessionRunner` 并复用 `runTurn`，因此能检验相同的消息循环和工具接口；但它们使用自动批准、固定模型选择、自己的预算与独立验收。

| 场景 | 执行环境 | 验收负责人 |
| --- | --- | --- |
| 日常 CLI / GUI | 宿主机目标工作区 | 运行器注入的 `Verification`，加计划完成检查。 |
| 自建任务评测 | 宿主机临时目录，复制题目仓库 | Agent 结束后覆盖隐藏检查，再运行任务指定命令。 |
| SWE-bench | 文件工具在宿主机，bash 在挂载同一路径的容器 | 收集 patch，交给全新容器和官方脚本 / 解析器评分。 |

评测显式设置 `verifyChanges: false`，避免交互式检查策略取代评测自己的隐藏测试。自建 PASS 要求检查成功、Agent 自己正常结束、没有超过步数与费用预算；SWE-bench 另外保留只看测试的 `resolved`。

**复用的好处**是减少“演示运行器”和“评测运行器”行为分叉。**剩余差异**是审批、工具集合、执行环境和验收主体不同。隐藏测试通过率不能直接证明 GUI 审批体验、远程部署或真实项目表现；自建任务关闭联网工具也不等于 shell 网络被隔离。

依据：[eval/runner.ts / runAgentTurn、judge](../src/eval/runner.ts)、[eval/index.ts](../src/eval/index.ts)、[swebench/runner.ts](../src/eval/swebench/runner.ts)、[swebench/docker.ts](../src/eval/swebench/docker.ts)、[swebench/grade.ts](../src/eval/swebench/grade.ts)。

## 14. 这套架构做得扎实的地方，以及代价

| 设计 | 实际收益 | 相应代价 / 适用边界 |
| --- | --- | --- |
| provider / tool 契约与依赖注入 | 可用假模型测试完整循环，也能换执行环境 | hooks 多，需要沿装配链阅读；消息仍保留部分 SDK 类型。 |
| 执行前后的恢复 checkpoint | 中断后知道哪些操作完成、哪些不确定 | 每次保存完整消息数组；长历史时可能增加 I/O 成本。 |
| 验证命令固定 + 文件指纹 | 比“模型口头说测试通过”可靠 | 不是独立测试沙箱；指纹与测试范围仍有边界。 |
| 会话 / 展示事件 / trace 分离 | UI、恢复与统计各有明确输入 | 多份状态没有跨文件事务，排错需同时核对。 |
| 只读计划模式通过工具集合实现 | 能力约束由代码执行 | 模式策略集中于 Runner，新能力容易增加其职责。 |
| 子任务使用独立历史与 worktree | 减少父上下文膨胀和直接文件冲突 | 任务交接、正确基线、验收与整合需要明确契约。 |
| 确定性的重复检测 | 容易测试、解释停止原因 | 无法识别全部语义重复，动态输出可逃过检测。 |

**性能判断，尚未基准测试**：同步文件读写、每步序列化完整历史、`emit` 复制事件数组、预算查询扫描 trace，都可能在长会话和多会话并发时放大开销。源码能确认这些路径存在，但本次没有测量瓶颈，不能据此断言需要数据库或消息队列。

**维护判断**：最先需要明确的是“工具批次顺序”“子任务起点”“完成证据”这些契约。它们直接影响正确性。是否拆分 `SessionRunner`、引入异步存储或预算预留，应由后续功能和测量决定，而不是为了让架构图出现更多模块。

## 15. 已复现的两处实现偏差

这两项是当前版本的实际行为，不是对设计的泛泛担忧。本次只记录，未修复；正常测试全部通过也不能覆盖掉下面的反例。

### 问题 A：写操作可能与后续读取并发

**触发**：同一模型响应先提出写操作，再提出只读工具。分组以首调用建立 `group`，后续只检查 `next.name` 是否只读，没有先要求首调用也只读。

**本次复现**：用内存中的模拟 `write_file` 延迟完成，用 `read_file` 读取同一个值。没有改真实文件，结果为：

```text
write started
read observed before
write finished
tool_results = ["after", "before"]
finishReason = end_turn
```

**影响**：返回顺序仍与模型调用顺序一致，但读取观察到的是写入完成前的旧状态。审批等待也不能保证同批后续读取等待写操作。`test/multi-agent.test.ts` 验证了纯只读并行，没有覆盖这个混合批次。

**建议**：只在组首也属于只读集合时继续扩组；写入、审批中的操作、依赖前一结果的读取保持顺序。补“写后读”和“待审批写后读”回归用例。

依据：[loop.ts / 分组逻辑](../src/agent/loop.ts#L429)、[multi-agent.test.ts](../test/multi-agent.test.ts#L28)。

### 问题 B：worker 可能从错误的提交启动

**触发**：父会话在非主 worktree，且它的 HEAD 与主 worktree 不同。`createWorkerWorkspace` 从父 root 读取 `base`，却在 `mainRoot` 执行 `git worktree add ... HEAD`。

**本次复现**：临时仓库先有 main 提交 A，再在 feature worktree 提交 B；从 feature 创建 worker：

```text
reportedBase = parentHead = B
workerHead = mainHead = A
worker 中 version.txt 的内容仍是 main
```

**影响**：子任务看不到父分支已经提交的新代码；返回的基线描述与实际 checkout 不符，也会干扰按 `base` 计算的改动信息。现有 worker 测试从主工作区启动，因此没有触发这个分支差异。

**建议**：先解析父工作区的明确提交对象，再把该提交作为 `worktree add` 的起点；不要让执行目录决定 `HEAD` 的含义。补“父 feature worktree 与主 worktree 不同提交”的用例。

依据：[workspace/worker.ts / createWorkerWorkspace](../src/workspace/worker.ts#L29)、[multi-agent.test.ts / worker 测试](../test/multi-agent.test.ts#L77)。

### 重复验证这两项

[诊断脚本](architecture/reproduce-findings.mjs)只使用假模型、内存工具和临时 Git 仓库，不加载真实厂商配置、不发送模型请求。临时仓库在结束时删除：

```bash
node docs/architecture/reproduce-findings.mjs
```

脚本断言的是“这两个已知偏差在当前基线上仍可复现”，**不是系统正确性通过证明**。以后修复代码后，应把预期行为写成正式回归测试，并移除或更新这份诊断脚本。

## 16. 后续改进应按什么顺序考虑

以下是建议，不是已经完成的改动。

1. **先修确定的正确性问题**：混合工具批次顺序、worker 的提交起点。它们有小范围复现，不需要先重构整个运行器。
2. **明确子任务交付契约**：返回“已修改 / 已测试 / 已提交 / 待整合”证据，避免把 `ok`、分支名和完成验收混为一谈。
3. **按用途决定执行隔离**：个人可信工作区可接受当前取舍；若要执行不可信仓库或开放多人使用，优先补真实进程 / 文件 / 网络隔离。
4. **按并发需求强化预算**：若需要严格总成本约束，再引入在途请求预留、释放和对账；当前统计不能代替这一机制。
5. **测量后处理长会话开销**：记录上下文保存、trace 汇总和指纹扫描的耗时，再决定增量快照、索引或存储迁移。
6. **按职责增长拆 Runner**：压缩或子任务管理继续变复杂时再提取组件，保持 `runTurn` 的接口和行为测试稳定。

## 17. 验证证据与源码阅读路线

本次重新执行 `npm test`：**322 通过、0 失败**；`npm run typecheck` 通过。另用上述诊断脚本复现两项偏差。没有运行付费模型评测、SWE-bench 容器评测、远程部署或长会话压力测试。

| 要理解 / 验证什么 | 先读实现 | 再读已有测试 |
| --- | --- | --- |
| 输入与内部协议 | [types.ts](../src/types.ts)、[app.ts](../src/app.ts) | [app.test.ts](../test/app.test.ts)、[pi-provider.test.ts](../test/pi-provider.test.ts)、[openai.test.ts](../test/openai.test.ts) |
| 单轮工具循环 | [agent/loop.ts](../src/agent/loop.ts) | [loop.test.ts](../test/loop.test.ts)、[cycle-guard.test.ts](../test/cycle-guard.test.ts) |
| 会话、插话与停止 | [session/runner.ts](../src/session/runner.ts) | [session.test.ts](../test/session.test.ts)、[control.test.ts](../test/control.test.ts) |
| 权限、上下文与验收 | [permissions.ts](../src/agent/permissions.ts)、[context.ts](../src/agent/context.ts)、[verification.ts](../src/agent/verification.ts) | [permissions.test.ts](../test/permissions.test.ts)、[runtime-safety.test.ts](../test/runtime-safety.test.ts) |
| 子 Agent 与工作区 | [tools/multi-agent.ts](../src/tools/multi-agent.ts)、[workspace/worker.ts](../src/workspace/worker.ts) | [multi-agent.test.ts](../test/multi-agent.test.ts)、本次[诊断脚本](architecture/reproduce-findings.mjs) |
| 评测口径 | [eval/runner.ts](../src/eval/runner.ts)、[swebench/grade.ts](../src/eval/swebench/grade.ts) | [eval-runner.test.ts](../test/eval-runner.test.ts)、[swebench.test.ts](../test/swebench.test.ts) |

建议按“消息契约、依赖装配、单轮循环、会话运行器、验收恢复、子任务与评测”的顺序读。每读完一层，都用同一句“修复失败测试”回答三个问题：**这层拿到什么状态、允许产生什么副作用、失败后把什么证据交给下一层。**
