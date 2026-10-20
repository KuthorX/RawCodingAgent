# raw-coding-agent

从零搭的 coding agent，用于学习。不依赖任何 agent 框架，只用 `openai` SDK 发请求，兼容任何 OpenAI Chat Completions 协议的服务（OpenAI、DeepSeek、Qwen、Kimi 等）。

## 运行

```bash
npm install
cp .env.example .env        # 填入凭证
```

需要 Node 24+（原生运行 `.ts`，无需编译）。

`.env` 里填了 `TAVILY_API_KEY`（[Tavily](https://tavily.com)，每月 1000 次免费）就会多一个 `web_search` 工具，用来查文档、报错信息等工作区里没有的资料。它只读、不需要审批，但查询内容会发到 Tavily；key 会从 agent 的 bash 能看到的环境变量里删掉。

### 网页界面

```bash
npm run gui                              # 终端会打印带 token 的地址，用它打开
npm run gui -- --cwd ../some-repo        # 可选：顺便把这个目录加入工作区列表
```

- **工作区**：在侧边栏点"+ 打开工作区"，再点"选择…"弹出系统的文件夹选择框（macOS 用 `osascript`，Windows 用 PowerShell，Linux 需要 `zenity`），也可以在输入框里填路径（支持 `~`）后点"打开"，可以同时打开多个，列表保存在 `.workspaces.json`，下次启动不用再给 `--cwd`。会话按工作区分组，在某个工作区下点"+ 新会话"即在该目录工作。移除工作区只是从列表拿掉，不删文件和会话（它们会出现在"其他"分组）。
- **对话**（`/`）：点任意历史会话即可继续之前的工作。bash 调用会在页面上请求批准。在会话列表里右键可以复制 session id、复制工作区路径或 fork。
- **图片**：在输入框里粘贴（或拖进来）图片，发送前显示在输入框上方，可以逐张移除；一条消息最多 8 张、每张 5 MB 以内（png / jpeg / gif / webp）。图片存在会话目录的 `attachments/` 里，`messages.json` 只记路径，每次请求时再读出来。模型支持图片时（`.env` 里设 `OPENAI_VISION=true`）以图片发给模型；不支持时（比如 `deepseek-chat`）只告诉模型图片保存在哪里。agent 运行中只能插话文字，图片要等这一轮结束或停止后再发。
- **Fork**：对话页顶部的"Fork"或右键菜单。新会话复制原会话的对话历史（到最后一轮结束为止，正在运行的那一轮不算）、图片附件和审批模式，之后两边各自继续，互不影响。trace 从空开始，所以统计只算 fork 之后的花费；`meta.json` 的 `forkedFrom` 记录来源。原会话正在运行时不能 fork。注意两个会话仍然在同一个目录里改文件。
- **停止与插话**：agent 运行时输入框仍可用，发出的内容是"插话"，在它下一步调用模型之前送达；如果这一轮先结束了，插话会作为下一轮自动发送。"停止"按钮（或 Esc）会中断模型请求、kill 正在运行的命令（连同子进程）、拒绝正在等待的审批、丢弃未送达的插话；已完成的步骤保留在历史里，可以接着聊。
- **会话权限**：每个会话有自己的审批模式，`每次询问` 或 `自动批准`，保存在 `meta.json`。可以在新建时勾选，可以随时用对话页顶部的开关切换，也可以在审批卡片上点"允许，本会话不再询问"。切换立即生效；切成自动批准时，正在等待批准的调用也会放行。
- **统计**（`/stats`）：所有会话的 token、模型调用、工具调用汇总；进入单个会话可以看到工具统计和每轮的 span 瀑布图，点击任意 span 能看到它的原始记录。
- **原文件**（`/raw`）：每个统计数据旁都有"查看内容"（带行号、可逐行格式化 JSON、可跳到指定行）和"在 Finder 中显示"。

服务只监听 `127.0.0.1`，所有接口都要求启动时随机生成的 token，并校验 Host 头。因为页面能触发 bash，不要把这个地址分享出去。

### 终端

```bash
npm start -- --cwd ../some-repo                    # 交互模式（/exit 退出）
npm start -- --cwd ../some-repo "修复失败的测试"      # 单次任务
npm start -- --resume 20261020-065311-5d6230       # 继续某个历史会话（终端和网页的会话互通）
npm start -- --yes ...                             # 新会话（或 --resume 的会话）设为自动批准（危险）
```

终端里 agent 运行时直接输入就是插话，Ctrl-C 停止当前这一轮（空闲时 Ctrl-C 退出）。审批时输入 `a` 表示"本次允许，且本会话不再询问"；交互模式下 `/auto on`、`/auto off` 切换当前会话的审批模式。`--yes` 只决定新会话的默认模式，不再是全局开关。

### 测试

```bash
npm test         # 单元 + 集成测试（假模型，不调用 API）
npm run typecheck
```

### 评测

```bash
npm run eval -- --list                 # 任务与预算
npm run eval -- --validate             # 不调用模型：检查每个任务"原仓库不过、参考答案能过"
npm run eval                           # 全部任务各跑 1 次（约 $0.02，deepseek-chat）
npm run eval -- --repeat 3             # 每个任务跑 3 次，减少随机性
npm run eval -- --only py-paginate,py-lru-cache
npm run eval -- --report <运行编号>,<运行编号>   # 并排对比几次运行（含 95% 置信区间）
AGENT_PROMPT_RULES= npm run eval -- --repeat 3   # 换一组 system prompt 规则再跑（D3），空 = 基线
```

每次尝试会把 `eval/tasks/<id>/repo/` 复制到系统临时目录（不在本项目、也不在任何 git 仓库里，路径会打印出来），`git init` 成独立仓库，然后开一个自动批准的会话。评测会话存在 `.eval-runs/<运行编号>/sessions/`，和结果放在一起，不出现在网页的会话列表里。运行前会从环境变量里去掉 API key 等凭据，agent 的 bash 拿不到。agent 结束后，用隐藏的 `check/` 整体替换测试目录（agent 改过或新增的测试都不算数），再运行检查命令。

**PASS = 检查通过 + agent 自己结束 + 步数 ≤ 预算 + 成本 ≤ 预算。** 成本超了会立即停止这一轮。API 报错、评测程序异常记为 ERROR，单独统计，不计入通过率。结果写入 `.eval-runs/<运行编号>/results.json`；和上一次运行对比时，只比较内容没变过的任务（按任务目录的哈希判断），模型或单价不同会给出提示。

结果表里的 **bash file ops** 一栏是"通过 bash 读、搜、改工作区内文件的次数 / 全部文件操作次数（bash + 专用工具）"，用来看 `tools` 这类提示词规则有没有让模型改用专用工具；访问工作区外路径的 bash 调用不计入（专用工具到不了那里）。分类是按命令文本的启发式（`src/trace/bash-usage.ts`），只适合比较两次运行，不适合判断单次调用。评测时不启用 web_search，结果不受网络影响。

新增任务：在 `eval/tasks/` 下建目录，放 `task.json`、`repo/`、`check/`、`solution/`，然后跑 `--validate`。

## 会话数据

每个会话一个目录 `.sessions/<id>/`：

| 文件 | 内容 | 用途 |
|---|---|---|
| `meta.json` | 标题、工作区、模型、时间、轮数、审批模式 | 会话列表、会话权限 |
| `messages.json` | 完整对话历史（每轮结束时写入） | 继续会话时恢复上下文 |
| `events.jsonl` | 界面事件（用户输入、工具调用、审批、结果） | 重新打开会话时回放 |
| `trace.jsonl` | span 记录 + 模型原始返回 | 统计页面、调试 |

trace 的第一条是 `session` 事件，记录模型、工作区、启用的提示词规则、工具列表和完整的 system prompt（每次加载会话都会记一条：进程启动后才改的提示词不会生效，以这里为准）。

trace 里的 span 结构：`turn`（一次用户输入）→ `llm`（一次模型调用，含 token 用量、stop reason）和 `tool`（一次工具调用，含参数、是否失败、审批结果 `approval`：`not_required` / `auto` / `allowed` / `denied`，以及审批等待时长）。span 在结束时写入，所以进行中的 turn 只有子 span。

```bash
jq -c 'select(.type=="span" and .kind=="llm") | .attrs' .sessions/<id>/trace.jsonl
```

## 结构

```
src/
  index.ts              入口：参数解析，分发到终端或网页
  app.ts                组装 provider、会话存储、每个会话的 agent 依赖
  cli.ts                终端模式
  ui.ts                 终端输出
  types.ts              内部消息格式，与线上协议解耦
  config.ts             环境变量加载与校验
  pricing.ts            单价与成本估算
  workspace/store.ts    工作区列表（.workspaces.json）
  agent/
    loop.ts             ★ agent 主循环（span 埋点、停止、插话注入）
    system-prompt.ts    ★ system prompt
    truncate.ts         ★ 工具输出截断策略
    permissions.ts      ★ 审批策略
    trace.ts            span / 事件写入
  providers/openai.ts   内部格式 ↔ OpenAI Chat Completions
  tools/                read_file / write_file / edit_file / glob / grep / bash / web_search
  session/
    store.ts            会话目录读写
    runner.ts           单个会话：历史、事件回放、审批、运行中的 turn
    events.ts           界面事件类型
  trace/analyze.ts      从 trace.jsonl 计算统计（含成本）、按 turn 组织 span
  trace/bash-usage.ts   bash 命令分类：读/搜/改文件、工作区外、其他（eval 的 bash file ops 指标）
  eval/
    tasks.ts            加载任务、复制仓库、运行检查命令
    runner.ts           跑一次尝试：成本守卫、判定 PASS/FAIL
    report.ts           结果表、与上次运行对比
    index.ts            npm run eval 入口
  gui/
    server.ts           路由、token 与 Host 校验
    manager.ts          按需加载会话，统计接口
    http.ts / reveal.ts HTTP 工具、在文件管理器中显示
    pick-folder.ts      弹出系统文件夹选择框
    *.html / common.*   对话、统计、原文件三个页面
eval/tasks/             10 个练习任务（repo / check / solution / task.json）
test/                   loop、tools、协议转换、trace、会话、HTTP 接口、eval
```

★ 标记的文件是"决策点"，详见 [DECISIONS.md](DECISIONS.md)。
