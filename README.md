# raw-coding-agent

从零搭的 coding agent，用于学习。主循环、工具、会话和评测由项目自己实现；原生多厂商协议使用 `@earendil-works/pi-ai`，现有 Chat Completions 兼容端点保留 `openai` SDK 适配。

## 运行

```bash
npm install
npm run gui
```

需要 Node 24+（原生运行 `.ts`，无需编译）。没有 API Key 也能先打开界面：在「设置 / 厂商连接」中保存凭据，再选择新会话默认厂商、模型和思考强度。原生接入支持 OpenAI、Anthropic、Google、DeepSeek、OpenRouter；模型与可选强度来自锁定版本的 Pi 目录，目录不代表账号实际访问权限。

凭据保存在 `~/.raw-coding-agent/providers.json`，文件权限为 `0600`；页面和 API 只返回掩码，留空保留已有密钥，清除按钮显式删除。会话只保存厂商、模型和思考强度。凭据更新从已有会话的下一轮生效。旧 `.env` 的 `OPENAI_API_KEY` / `OPENAI_BASE_URL` 只属于「兼容端点（原 .env）」；旧会话继续使用它，不会把原来的 DeepSeek 或代理 key 当成 OpenAI 原生 key。

需要兼容端点时仍可 `cp .env.example .env`。模型回复默认流式显示；`OPENAI_STREAM=false` 可关闭逐字显示。兼容端点支持非流式 HTTP 回退，Pi 原生适配仍使用 SDK 的流式传输。

### Orca / OpenCode

Orca launches the OpenCode CLI inside this workspace. The checked-in `opencode.json` selects `deepseek/deepseek-chat` through DeepSeek's OpenAI-compatible endpoint; OpenCode reads `OPENAI_API_KEY` from this workspace's `.env` via Bun's automatic dotenv loading. No key is stored in the config. Open the workspace in Orca, launch the OpenCode agent, and confirm the model is `deepseek/deepseek-chat`.

`.env` 里填了 `TAVILY_API_KEY`（[Tavily](https://tavily.com)，每月 1000 次免费）就会多一个 `web_search` 工具，用来查文档、报错信息等工作区里没有的资料。它只读、不需要审批，但查询内容会发到 Tavily；provider 和搜索凭据都不会传给 agent 的 bash。

不配 key 也有 `web_fetch`：给一个 http(s) 地址，返回网页的正文（HTML 会去掉脚本和样式、压缩空白），用来读文档、issue 或 web_search 找到的页面。图片和其他二进制类型会被拒绝；云厂商的 metadata 地址也会被拒绝。网页内容是不可信数据，prompt 里明确要求模型不要执行页面里的指令。

工作区根目录有 `AGENTS.md` 时，它的内容会作为“Repository instructions”追加到 system prompt（最多 20000 字符）：仓库自己的测试命令、代码风格和禁区不用每次重复。每个会话只读一次，改了要新开会话才生效；trace 的 `session` 事件里记录了完整 prompt，可以确认模型看到的是哪一版。

GUI 输入 `/` 可选择命令或技能，方向键选择，Tab / 点击补全；Enter 在输入不完整时补全，完整命令可直接发送。终端支持同一组命令，Tab 补全：

| 命令 | 行为 |
| --- | --- |
| `/clear` | 切到同工作区、模型、思考强度、权限及额度设置的空会话。旧会话仍可查看；重置对话、计划和已加载技能，不改工作区文件。运行中需先停止。 |
| `/compact [重点]` | 压缩当前上下文，保留已加载技能。 |
| `/loop [--max N] [任务]` | 循环模式：每轮结束后如果计划还有未完成项，就用循环提示词自动继续，最多 N 轮（默认 10）。`/loop stop` 退出。 |
| `/plan [任务]` | 计划模式：只提供只读工具，agent 探索后给出计划；网页上可以改、删计划项并点“执行计划”。`/plan off` 退出。 |
| `/help` | 显示命令帮助，不调用模型。 |
| `/skills` | 显示可用技能、文件路径及已加载标记，不调用模型。 |
| `/skill 名称 [任务]` 或 `/技能名 [任务]` | 加载指定 `SKILL.md`，可同时开始任务。不带任务只加载，不调用模型。 |

`/plan` 进入计划模式后只暴露 `read_file`、`list_dir`、`glob`、`grep`、`web_search`、`web_fetch` 和 `plan`，没有 bash 和写文件的工具，所以探索阶段不会改工作区。计划项保存在 `meta.json` 的 `plan` 里，网页顶部可以编辑文字、点方框切换状态、删除单项或清空；点“执行计划”退出计划模式并让 agent 按清单开始，完整工具随之恢复。`/loop` 只在一轮以 `unverified` 结束（计划没做完或检查没过）时自动续跑，正常完成、出错、被停止或达到轮数上限就结束；自动继续的提示词和上限可以在网页顶部“设置”里改，“停止”会中断当前一轮并退出循环。两种模式都保存在会话里，重启后继续生效；`/clear` 和 fork 不继承模式，fork 只复制计划清单。

技能从工作区及祖先目录、用户目录下的 `.agents/skills`、`.codex/skills`、`.claude/skills` 发现。例如 `.agents/skills/review/SKILL.md` 可通过 `/review` 加载。支持常见 frontmatter `name` / `description`（含引号和多行描述）、符号链接和包内的 `skills/` 子目录。同名优先使用距离工作区最近的技能，同层按上述目录顺序；与内置命令重名时使用 `/skill 名称`。

已选技能的完整内容保存为会话快照，后续轮次、压缩、重启和 fork 均保留；修改文件后再次加载可更新快照。未选择的技能正文不会发给模型。技能只提供指令，不安装依赖、不自动执行脚本、不改变工具权限；工作区外的参考文件仍通过受现有审批控制的 bash 读取。单文件最多 128000 字节，累计加载最多 100000 字符，且须留在模型上下文预算内。扫描最多 8 层、2000 个目录；缺失、不可读或过大的文件不出现在列表。

`/clear` 创建新会话，所以会话花费重新计数；项目和工作区累计花费继续保留。终端原有 `/auto on|off` 和 `/exit` 不变。

### 网页界面

```bash
npm run gui                              # 终端会打印带 token 的地址，用它打开
npm run gui -- --cwd ../some-repo        # 可选：顺便把这个目录加入项目列表
```

- **项目**：在侧边栏点"+ 打开项目"，再点"选择…"弹出系统的文件夹选择框（macOS 用 `osascript`，Windows 用 PowerShell，Linux 需要 `zenity`），也可以在输入框里填路径（支持 `~`）后点"打开"。可以同时打开多个，列表保存在 `.projects.json`（旧的 `.workspaces.json` 会自动改名过来），下次启动不用再给 `--cwd`。项目通常是一个 git 仓库，也可以是仓库里的子目录或者普通文件夹。移除项目只是从列表拿掉，不删文件、worktree 和会话（会话会出现在"其他"分组）。
- **工作区**（git worktree，参考 [Orca](https://github.com/stablyai/orca)）：项目下面列出它的工作区，第一个是项目目录本身（"主目录"），其余是这个仓库的 git worktree，每个显示分支和未提交的文件数。会话属于某个工作区，在工作区上点"+ 会话"就在那个目录里工作；不同工作区的会话改文件互不干扰。
  - **新建**：项目上点"+ 工作区"。可以新建分支 `agent/<名字>`，名字里带 `/`（如 `feat/login`）时就用它作分支全名、目录名把 `/` 换成 `-`（默认从 `origin/HEAD`，没有就依次试 `origin/main`、`origin/master`、`main`、`master`），也可以检出一个已有分支。目录放在仓库旁边的 `<仓库>.worktrees/<名字>`，仓库根目录的 `.worktreeinclude`（每行一个路径或 glob，如 `.env`）里列出的未跟踪文件会被复制过去。建好后自动在里面新建一个会话。项目是仓库里的子目录时，worktree 建在仓库这一级，会话进入 worktree 里同一个子目录。
  - **删除**：工作区右键 → 删除。有未提交或未跟踪的文件时会先拒绝，确认后才强制删除；这里新建的分支用 `git branch -d` 一起删，有未合并的提交就保留并提示。检出已有分支的工作区，删除时不动分支。工作区里还有会话在运行时不能删。会话记录保留，归到"其他"。
  - **Fork 到新工作区**：会话右键或对话页顶部"Fork"。新会话复制历史，同时新建一个 worktree，分支从原工作区当前的提交开始；原工作区未提交的改动不会带过去（会提示有几个）。
  - 记录在 `.worktrees.json`（只记这里新建的；手动 `git worktree add` 的也会列出来，只是删除时不会删它的分支）。
- **页面结构**：顶部四个常驻标签：会话、统计、迭代记录、设置，都在同一个页面（`/`）里。地址里的 `#stats/<会话>`、`#iterations/<提交>`、`#settings` 表示当前标签，其他情况 `#<会话>` 是对话。统计和迭代记录各在一个 iframe 里，第一次打开后只是隐藏，所以切回来是瞬时的，滚动位置和展开状态都在。单独打开 `/stats`、`/iterations` 会转到对应标签。
- **外观与键盘**：终端风格（等宽字体，琥珀色只标出当前标签、运行中和等待批准），有浅色和深色两套，默认跟随系统，可以在"设置"里固定一种（存在浏览器本地）。没在输入框里打字时：`1`–`4` 切换标签，`/` 搜索会话，有待审批时 `y` 允许、`n` 拒绝、`a` 本会话不再询问，`Esc` 停止 agent；底部状态栏显示当前会话的状态和此刻可用的按键。
- **手机**：屏幕不超过 720px 宽时一次只显示一栏：没打开会话时是会话列表，打开后是对话，左上角"‹"回到列表；统计和迭代记录的表格可以横向滑动，提交详情盖住整页显示。触屏上长按代替右键菜单，鼠标悬停才出现的按钮一直显示（会话右边的归档图标也在，点击区域更大），输入框里 Enter 是换行、点"发送"才发出。配合 `--remote` / `--public` 用（见下面"从其他设备访问""从公网访问"）。
- **对话**：点任意历史会话即可继续之前的工作。文件改动和危险 bash 调用会在页面上请求批准。把鼠标移到会话上（或用 Tab 选到它），右侧出现归档图标，点一下就把这个会话收进"已归档"，不用右键；搜索结果里也一样。右键菜单里还有复制 session id、复制工作区路径、fork、设置这个会话的额度、归档或删除。
- **归档与删除**：归档的会话不在项目树里显示，在侧栏的"已归档"标签里（注明属于哪个项目和工作区），右侧的取消归档图标一直显示，点一下就能恢复（`meta.json` 的 `archived`）；仍然能搜到，搜索结果右侧也有恢复图标，右键也能恢复。删除会移除整个会话目录（消息、trace、图片），不能恢复；正在运行的会话要先停止，被别的进程打开的会话不能删。
- **搜索**：侧栏顶部的搜索框按标题、你发的消息和 agent 的回复搜索（不搜工具调用和输出），不区分大小写，包括已归档的会话；结果显示匹配的片段，Esc 清空。
- **图片**：在输入框里粘贴（或拖进来）图片，发送前显示在输入框上方，可以逐张移除；一条消息最多 8 张、每张 5 MB 以内（png / jpeg / gif / webp）。图片存在会话目录的 `attachments/` 里，`messages.json` 只记路径，每次请求时再读出来。模型支持图片时（`.env` 里设 `OPENAI_VISION=true`，或用 `MODEL_VISION_JSON` 按模型配置）以图片发给模型；不支持时只告诉模型图片保存在哪里。agent 运行中插话也可以带图片，和文字一起在下一步之前送达。
- **Fork**：对话页顶部的"Fork"或右键菜单。新会话复制原会话的对话历史（到最后一轮结束为止，正在运行的那一轮不算）、图片附件和审批模式，之后两边各自继续，互不影响。trace 从空开始，所以统计只算 fork 之后的花费；`meta.json` 的 `forkedFrom` 记录来源。原会话正在运行时不能 fork。"同一工作区"的 fork 两边改的是同一个目录；要互不干扰就选"Fork 到新工作区"。
- **额度**：对话页顶部"额度"设置本会话的每轮最多步数、每轮最多花费（默认跟 `.env` 的 `AGENT_MAX_STEPS` / `AGENT_MAX_TURN_COST_USD`；步数默认不限，设成正整数才有上限；可以改成不限或自定义，比如步数不限、但每轮不超过 $1）和本会话累计最多花费；保存在 `meta.json` 的 `limits` / `budgetUsd`，从下一轮开始生效。项目和工作区在侧栏右键"设置额度…"，按这个范围内所有会话的累计花费算，设了之后侧栏显示"已花 / 上限"。一轮跑到一半碰到任何一层的累计上限，会像其他上限一样停下来让模型总结（`finishReason: "budget"`）；已经用完时新消息会被拒绝，提示是哪一层。
- **停止与插话**：agent 运行时输入框仍可用，发出的内容是"插话"，在它下一步调用模型之前送达，并带有明确的 `User interjection` 标记；如果这一轮先结束了，插话会作为下一轮自动发送。"停止"按钮（或 Esc）会中断模型请求、kill 正在运行的命令（连同子进程）、拒绝正在等待的审批、丢弃未送达的插话；已完成的步骤保留在历史里，可以接着聊。
- **原地打转检测**：读文件、跑检查等 2–6 个调用及结果连续重复三轮时，先提醒 agent 换排查方向；提醒后仍重复一轮旧观察，才以 `stagnant` 结束并总结。新证据、成功修改、已观察到的 Bash 文件变化和用户插话会清除旧记录。完整工具批次中的后续修改不会被提前跳过。检测使用截断前结果，仅规范常见测试计时信息；动态输出或语义相近但参数不同的命令，仍可能绕过这条检测。
- **计划与循环**：`/plan` 进入只读计划模式，对话页顶部显示“计划模式”，计划面板列出清单：点方框切换 `pending`/`in_progress`/`completed`，点“编辑”原地改文字，“删除”去掉单项，“清空”删整张清单，“执行计划”退出计划模式并让 agent 按清单开始。`/loop` 的循环次数显示在标题旁（如“循环 2/10”），可以“停止”（中断当前一轮并退出）、“设置”（改自动继续的提示词和最多轮数）、“退出”；循环在一轮以 `unverified` 结束时自动续跑。两种模式都保存在 `meta.json`，重启后继续；`/clear` 与 fork 不继承模式。
- **会话权限**：每个会话有自己的审批模式，`每次询问` 或 `自动批准`，保存在 `meta.json`。新会话用"设置"标签里的"新会话自动批准"（默认开启，存在 `.settings.json`），之后可以随时用对话页顶部的开关切换，也可以在审批卡片上点"允许，本会话不再询问"。切换立即生效；切成自动批准时，正在等待批准的调用也会放行。**只读命令免审**：`每次询问` 下，`ls`/`cat`/`grep`/`rg`/`find`/`pwd`/`git status`/`git diff`/`git log` 等只读命令直接执行；写文件、编辑文件、删除、装包、跑任意代码、重定向、命令替换和网络访问仍然询问。这是减少无意义弹窗的便利规则，不是安全边界；bash 本身仍然能访问工作区外，真要隔离得靠容器/沙箱。
- **模型与思考强度**：「设置」中原子保存新会话默认厂商、模型、思考强度；已有会话不跟随默认值变化。对话页顶部可单独切换这三项，运行期间禁用切换。Fork 和重启保留会话选择。只提供模型支持的强度，服务端也会拒绝不支持的组合；这里的 `thinkEffort` 不包含客户端多 agent 的 Ultra 模式。兼容端点仍通过 `/models` 获取 ID，原生厂商使用 Pi 模型目录。原生费用按 Pi 目录逐次估算（含缓存写入），兼容端点沿用 `PRICE_*` / `MODEL_PRICING_JSON`。
- **上下文压缩**：每次模型调用前检查完整请求，包括 system prompt、工具定义、reasoning 和图片预留量。原生厂商窗口来自 Pi 目录；兼容端点由 `MODEL_CONTEXT_WINDOWS_JSON` 指定，未知模型保守按 64k，并预留输出空间。超过设置阈值或输入预算时自动压缩，`/compact` 可手动执行。摘要保留任务、最近完整消息组和改过的文件；压缩失败时，只有原请求仍在输入预算内才继续，否则保留历史并报错。服务端仍报超窗时最多强制压缩重试一次。
- **完成检查**：改过文件后，模型需要调用 `verify_changes`，并完成计划中的所有项目。检查命令在会话首次执行前固定并持久化：优先读取工作区 `.agent-checks.json`（例如 `{"commands":["python3 -m pytest"]}`），否则使用 `package.json` 中已有的 `npm test`、`npm run typecheck`。修改检查配置后需新开会话；npm 检查还会锁定 scripts 定义，防止把原检查改成空操作后通过。验证走正常审批、超时和环境过滤，审批展示实际命令；任一命令失败、留下后台进程或验证期间文件变化，都不算通过。之后再次修改会使结果失效，状态会跨重启保留。缺少检查或验证未通过时，以 `unverified` 结束，不显示为正常完成。检查覆盖范围由配置决定；命令通过不等于所有需求都正确。
- **改动**：对话页顶部的"改动"按钮显示工作区里未提交的 `git diff`（新增/删除/上下文分组着色），未跟踪文件单独列出；不是 git 仓库时会说明。改了什么不用切到终端自己跑 `git diff`。
- **统计**：所有会话的 token、模型调用、工具调用汇总；进入单个会话可以看到工具统计、缓存命中比例和每轮的 span 瀑布图，点击任意 span 能看到它的原始记录。
- **迭代记录**：每次迭代解决了什么问题、改了什么，可以按时间线或按模块看，按模块筛选；点提交号在右侧看完整改动（`git show`），或跳到 GitHub。数据在 `docs/iterations.json`（模块列表 + 每条的 `module` / `title` / `problem` / `change` / `commits`），提交的时间和标题从 git 读。没被任何记录引用的提交会列在"未归档的提交"里；只改了这个文件的提交（补提交号）不算。`npm test` 会检查每条记录的模块和提交号都存在。
- **原文件**（`/raw`）：每个统计数据旁都有"查看内容"（带行号、可逐行格式化 JSON、可跳到指定行）和"在 Finder 中显示"。

服务只监听 `127.0.0.1`，所有接口都要求启动时随机生成的 token，并校验 Host 头。因为页面能触发 bash，不要把这个地址分享出去。

#### 从其他设备访问（Tailscale）

```bash
npm run gui -- --remote                  # 地址是 https://<本机>.<tailnet>.ts.net/
npm run gui -- --remote --remote-port 8443
```

手机、另一台电脑在局域网或外网都能打开这个界面，前提是两边都装了 [Tailscale](https://tailscale.com) 并登录同一个账号，tailnet 开了 MagicDNS 和 HTTPS 证书（管理后台 DNS 页）。同一局域网里 Tailscale 会走直连，不绕外网。

- **怎么连**：启动时读 `tailscale status --json` 拿到本机的 MagicDNS 名和所属账号，在 `127.0.0.1` 上另开一个端口（系统分配）专门给远程用，然后 `tailscale serve --bg --https=<端口> http://127.0.0.1:<这个端口>`：Tailscale 在 tailnet 名上终结 HTTPS（证书自动签发），转发过来。两个端口都只监听 `127.0.0.1`。退出（Ctrl-C、kill、关终端窗口）时 `tailscale serve --https=<端口> off`。进程号和转发目标记在 `.remote-serve-<端口>.json`，进程被强杀留下的配置下次启动能认出来（记录的进程已经不在），直接覆盖；这个端口上有别的 serve 配置、另一个实例正在用、或者开了 Funnel（公网）时拒绝启动，不会覆盖。用 `nohup` 启动时关终端不会退出，也就不会关掉 serve。没用前台模式的 `tailscale serve`：macOS 版（1.104）前台进程被 kill 后配置不会清掉，端口一直被占着。
- **谁能进**：请求从哪个端口进来决定它算本机还是远程，不看 Host 头（serve 原样转发 Host，tailnet 里的人可以自称 `127.0.0.1`）。本机端口：Host 只能是 `127.0.0.1` / `localhost`，要启动 token。远程端口四层检查，缺一不可：Host 必须是本机的 tailnet 名（防 DNS rebinding）；`Tailscale-User-Login` 必须是本机所属账号（serve 会替换客户端自带的这个头；tagged 设备和别人共享过来的设备要么没有、要么不是你，都拒绝）；非 GET 请求的 `Origin` 必须是 tailnet 地址；最后还要有配对得到的设备凭证。启动 token 在远程不算数。
- **配对**：在主机的"设置 → 远程访问"点"配对新设备"，显示二维码和链接（`https://…/pair#<配对码>`，码放在 `#` 后面，不进请求行和日志），5 分钟内有效，只能用一次。配对码只能在主机上生成（这就是"人在主机旁"的证明）。手机扫码打开，换到一个设备凭证，存成 `__Host-` 前缀、`HttpOnly; Secure; SameSite=Strict` 的 cookie，有效一年。一分钟内 10 次错误的配对码会锁到这一分钟结束。在主机本机上打开 tailnet 地址也算远程设备，同样要配对。
- **设备**：记在 `.devices.json`（只存凭证的 sha256，文件权限 600；多个实例共用时会读到彼此的改动，但在 A 实例撤销的设备，连在 B 实例上的会话推送要等它下一个请求才断；文件读不了时改名成 `.devices.json.bad`，设备要重新配对）。"设置 → 远程访问"列出所有设备和最近访问时间，可以撤销：撤销后这台设备正在看的会话推送立即断开，跳回配对页。已配对的设备也能撤销别的设备（都是同一个账号），手机丢了就在主机上把它撤销。
- **同一个 tailnet 名上的其他服务**：cookie 不区分端口，同一个 `*.ts.net` 名下 serve 的其他端口也会收到设备凭证，不要和不信任的服务共用这台机器的 tailnet 名。
- **远程不能用的**：系统文件夹选择框和"在 Finder 中显示"会出现在主机的屏幕上，远程时不提供（接口返回 403），打开项目要输入主机上的路径。
- **没做的**：不支持 Funnel（没有身份头，公网用下面的 Cloudflare 方案）、Headscale（不支持 serve）、tagged 的主机。

#### 从公网访问（Cloudflare Tunnel + Access）

手机不装 Tailscale 也能打开。选型过程见 [docs/public-access-evaluation.md](docs/public-access-evaluation.md)。代价是 **Cloudflare 能看到明文**（对话、代码、命令输出），因为 HTTPS 在它的边缘终结。

```bash
npm run gui -- --public                       # cloudflared 转发到 http://127.0.0.1:4318
npm run gui -- --public --public-port 4400
npm run gui -- --remote --public              # 两个入口一起开
```

一次性准备（应用不管 cloudflared，它作为系统服务常驻）：

1. 域名的 DNS 托管在 Cloudflare。
2. Zero Trust 后台建一个 **Access 应用**（Self-hosted），域名填 `agent.example.com`，策略只放行你自己的邮箱（邮箱验证码或 GitHub 登录）。记下应用的 **AUD tag** 和团队名（`<team>.cloudflareaccess.com`）。
3. 装 `cloudflared`，`cloudflared tunnel login`、`cloudflared tunnel create rca`、`cloudflared tunnel route dns rca agent.example.com`，`~/.cloudflared/config.yml`：

   ```yaml
   tunnel: rca
   credentials-file: /Users/<你>/.cloudflared/<tunnel-id>.json
   ingress:
     - hostname: agent.example.com
       service: http://127.0.0.1:4318
       originRequest:
         httpHostHeader: agent.example.com   # 应用要求 Host 是公网域名
         access:                             # cloudflared 自己也校验 Access 令牌，没有就不转发
           required: true
           teamName: <team>
           audTag: [<AUD tag>]
     - service: http_status:404
   ```

   装成 launchd 服务，断线自动重连：`cloudflared service install`（当前用户的 LaunchAgent，登录后启动，用 `~/.cloudflared/` 下的配置）；要开机不登录也启动，用 `sudo cloudflared service install`，它以 root 运行、读 `/etc/cloudflared/config.yml`，需要把配置和凭证文件复制过去并改好 `credentials-file` 路径。
4. `.env` 里填 `PUBLIC_ORIGIN`、`CF_ACCESS_TEAM_DOMAIN`、`CF_ACCESS_AUD`、`PUBLIC_ALLOWED_EMAILS`（见 `.env.example`）。

- **谁能进**：三层，缺一不可。Cloudflare 边缘：没通过 Access 登录的请求到不了 Mac。应用：校验每个请求的 `Cf-Access-Jwt-Assertion`（RS256，用团队公开的密钥验签，检查签发方、AUD、有效期，邮箱必须在 `PUBLIC_ALLOWED_EMAILS` 里），这样 Access 策略配错了也不会放行；外加和 Tailscale 一样的 Host / Origin 检查。最后还要配对过的设备凭证。公网入口单独一个 `127.0.0.1` 端口，只给 cloudflared 用。启动时先去取一次密钥，团队名填错会直接报错退出；之后遇到不认识的密钥 ID（Cloudflare 轮换密钥）最多每分钟重取一次，取不到返回 503，不会放行。
- **配对**：同 Tailscale。两个入口都开时，配对对话框里选"Tailscale"或"公网"，生成对应地址的链接。配对码只能从生成它的那个入口兑换，设备凭证也只在配对时的入口有效，同一台手机走两个入口要各配对一次。设备列表里标出是从哪个入口配对的。
- **新建的会话默认每次询问**：从公网新建或 fork 的会话，不管设置里"新会话自动批准改动"、被 fork 的会话怎么选，都从"每次询问"开始，需要时在对话页顶部手动切成自动。这只是更稳妥的默认值，不是权限边界：配对过的设备仍然可以切成自动，也可以给已经是自动的会话发消息。
- **审计日志**：两个远程入口上所有改动类的请求（POST）和所有被拒绝的请求，按行记在 `.audit.jsonl`（文件权限 600）：时间、入口、账号（tailnet 登录名或 Access 邮箱）、设备、方法、路径（不含查询参数）、状态码；客户端中途断开（比如上传到一半）的记 `"aborted": true`。只读请求不记。
- **登录过期**：Access 登录默认 24 小时过期，之后浏览器的后台请求会被重定向到 Cloudflare 登录页，页面里只看到网络错误。页面发现请求失败时用不跟随重定向的请求探一次，确认是登录过期就整页刷新，走一遍 Access 登录再回来；输入框里没发出去的文字（和放得下的图片）刷新后还在。一分钟内不会再自动刷新第二次，避免配置有误时反复刷新。
- **iOS 切回前台**：iOS Safari 把页面放到后台会掐断推送连接，常常没有任何错误事件。远程打开的页面在离开超过 10 秒后回到前台、从往返缓存恢复、或网络恢复时，重新连接当前会话的推送（服务端会重放整个会话，不会漏消息；输入框里没发出去的文字和图片保留）。
- **没做的**：Mac 睡眠时远程打不开，需要插电并防止睡眠（`caffeinate -s`）。

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
npm run eval                           # 全部任务各跑 1 次，使用全局默认厂商/模型/思考强度
npm run eval -- --repeat 3             # 每个任务跑 3 次，减少随机性
npm run eval -- --only py-paginate,py-lru-cache
npm run eval -- --report <运行编号>,<运行编号>   # 并排对比几次运行（含 95% 置信区间）
AGENT_PROMPT_RULES= npm run eval -- --repeat 3   # 换一组 system prompt 规则再跑（D3），空 = 基线
```

每次尝试会把 `eval/tasks/<id>/repo/` 复制到系统临时目录（不在本项目、也不在任何 git 仓库里，路径会打印出来），`git init` 成独立仓库，然后开一个自动批准的会话。评测会话存在 `.eval-runs/<运行编号>/sessions/`，和结果放在一起，不出现在网页的会话列表里。运行前会从环境变量里去掉 API key 等凭据，agent 的 bash 拿不到。agent 结束后，用隐藏的 `check/` 整体替换测试目录（agent 改过或新增的测试都不算数），再运行检查命令。

普通评测和 SWE-bench 都在启动时固定全局厂商、模型、思考强度，运行途中修改界面默认值不会改变本次实验。报告记录这三项及计价来源，跨配置比较时给出提示。原有任务预算按历史 DeepSeek 运行设置；切换更贵的模型时需检查预算，避免第一轮请求就触发费用限制。

**PASS = 检查通过 + agent 自己结束 + 步数 ≤ 预算 + 成本 ≤ 预算。** 成本超了会立即停止这一轮。API 报错、评测程序异常记为 ERROR，单独统计，不计入通过率。结果写入 `.eval-runs/<运行编号>/results.json`；和上一次运行对比时，只比较内容没变过的任务（按任务目录的哈希判断），模型或单价不同会给出提示。

结果表里的 **bash file ops** 一栏是"通过 bash 读、搜、改工作区内文件的次数 / 全部文件操作次数（bash + 专用工具）"，用来看 `tools` 这类提示词规则有没有让模型改用专用工具；访问工作区外路径的 bash 调用不计入（专用工具到不了那里）。分类是按命令文本的启发式（`src/trace/bash-usage.ts`），只适合比较两次运行，不适合判断单次调用。评测时不启用 web_search，结果不受网络影响。

新增任务：在 `eval/tasks/` 下建目录，放 `task.json`、`repo/`、`check/`、`solution/`，然后跑 `--validate`。

### SWE-bench Verified

自建任务太简单时，用公开基准 [SWE-bench Verified](https://www.swebench.com)（500 个真实 GitHub issue）测更难的题，也能和别人公布的结果对照。需要 Docker 和 [uv](https://docs.astral.sh/uv/)；第一次运行会自动建 `.swebench-venv/`（装官方 `swebench` 包，用来生成评测脚本和解析测试日志），并把数据集下载到 `.swebench-cache/`。

```bash
npm run eval:swe -- --repo django/django --difficulty easy --sample 5 --list   # 先看会选中哪些
npm run eval:swe -- --only django__django-11099 --validate                    # 不调用模型：参考答案必须判为 resolved
npm run eval:swe -- --repo django/django --sample 5 --seed pilot --remove-images
npm run eval:swe -- --report <运行编号>,<运行编号>
```

- **怎么跑**：每个实例有官方镜像（`swebench/sweb.eval.x86_64.*`，x86，在 Apple Silicon 上走模拟）。把镜像里的 `/testbed` 复制到系统临时目录，再以**相同的绝对路径**挂回一个容器，`/testbed` 链接到它。agent 的文件工具在宿主机上改这份代码，`bash` 换成在容器里执行的版本（激活项目的 conda 环境，120 秒超时在容器内生效），两边看到的路径一致。宿主机的环境变量不会进入容器。
- **怎么判**：agent 结束后，在它的容器里用 `git add -A && git diff --cached --binary <起始提交>` 取出改动（在容器里取：`.git/config` 归 agent 控制，宿主机的 git 会执行它放进去的 hook、filter 或 fsmonitor；起始提交是 agent 开始前记下的，它自己 commit 过也算），在一个**全新的**容器里按官方顺序 `git apply`，然后运行实例自带的评测脚本（它会先把测试文件重置并打上隐藏测试），最后用 `swebench` 的解析器判定 FAIL_TO_PASS 和 PASS_TO_PASS 是否全部通过。这和官方 harness 的流程一样（打补丁的命令顺序也照抄），只是 Docker 由这里直接调度：agent 运行时本来就要自己起容器，评分用同一套代码，不必再走 harness 的 Python Docker SDK。
- **两个数字**：`resolved` 只看测试，和公开榜单的口径一致；`passed` 还要求 agent 自己结束、没超步数和成本预算（默认 100 步 / $0.5，`--max-steps`、`--max-cost` 可调），和自建任务的 PASS 一样。
- **产物**：`.eval-runs/swe/<运行编号>/`：`results.json`、`sessions/`，以及每次尝试的 `attempts/<实例>-<次>/`（`patch.diff`、`eval.sh`、`test.log`、`report.json`）。临时目录里的代码默认评完就删（`--keep-workspaces` 保留）。
- **磁盘**：每个镜像解压后 1–4 GB，同一仓库同一版本的实例共用大部分层。`--remove-images` 在实例跑完后删掉它的镜像。
- **版本**：数据集固定在一个 revision（`setup.ts` 的 `DATASET_REVISION`），结果里按它标记；官方镜像只有 `:latest`，没法同样固定。
- **中断**：Ctrl-C 会删掉这次运行起的容器（名字里都带运行编号）。
- **已知局限**：题目公开多年，模型可能训练时见过；Verified 的 500 题里 Django 占 231 个；镜像里的 git 历史停在 base commit（抽查过没有不可达的后续提交），但没像 DeepSWE 那样做浅克隆。

## 会话数据

每个会话一个目录 `.sessions/<id>/`：

| 文件 | 内容 | 用途 |
|---|---|---|
| `meta.json` | 标题、工作区、模型、时间、轮数、审批模式 | 会话列表、会话权限 |
| `messages.json` | 完整对话历史（每个工具执行前后和每轮结束时原子写入） | 恢复已完成结果；中断中的工具标为结果不确定，尚未开始的工具标为未执行，不自动重放副作用 |
| `events.jsonl` | 界面事件（用户输入、工具调用、审批、结果） | 重新打开会话时回放 |
| `trace.jsonl` | span 记录 + 模型原始返回 | 统计页面、调试 |

trace 的第一条是 `session` 事件，记录模型、工作区、启用的提示词规则、工具列表和完整的 system prompt（每次加载会话都会记一条：进程启动后才改的提示词不会生效，以这里为准）。

trace 里的 span 结构：`turn`（一次用户输入）→ `llm`（一次模型调用，含 token 用量、stop reason）和 `tool`（一次工具调用，含参数、是否失败、审批结果 `approval`：`not_required` / `auto` / `allowed` / `denied`，以及审批等待时长；只读 bash 自动放行时是 `auto`）。span 在结束时写入，所以进行中的 turn 只有子 span。

主 agent、子 agent、上下文摘要统一记录模型用量并计入预算；子 agent 的调用也可在 trace 中检查。额度耗尽后不再付费生成停止摘要。单次请求的费用只能在返回用量后确定，因此最后一次调用仍可能超过余额；失败或中断、未返回用量的请求标记为 `usageUncertain`，不会伪造费用数字。评测使用独立隐藏测试作为验收，不启用交互式 `verify_changes`，保留原来的评分口径。

trace 在写入前会按常见密钥格式脱敏（`sk-`、`tvly-`、GitHub token、`Bearer`、JWT、`*_KEY=`/`*_TOKEN=`、`password:`、PEM 私钥等）。这是尽力而为的模式匹配，不是数据防泄漏系统：不要故意把真实凭据喂给工具。

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
  workspace/
    store.ts            项目列表（.projects.json）、这里新建的 worktree（.worktrees.json）
    git.ts              git 命令封装：worktree list、status、分支、工作区 diff
    worktrees.ts        项目的工作区（worktree）：列出、新建、删除
  agent/
    loop.ts             ★ agent 主循环（span 埋点、停止、插话注入、流式 delta、按步 checkpoint）
    system-prompt.ts    ★ system prompt 与 AGENTS.md 注入
    truncate.ts         ★ 工具输出截断策略
    permissions.ts      ★ 审批策略：模式、只读 bash 命令放行
    trace.ts            span / 事件写入（写入前脱敏常见凭据）
  providers/openai.ts   内部格式 ↔ OpenAI Chat Completions（流式 tool_calls 拼接、非流式回退）
  tools/                read_file / write_file / edit_file / list_dir / glob / grep / plan / delegate_task / bash / web_search / web_fetch
  session/
    store.ts            会话目录读写
    runner.ts           单个会话：历史、事件回放、审批、计划、只读子 agent、运行中的 turn、压缩、每步保存
    events.ts           界面事件类型
  trace/analyze.ts      从 trace.jsonl 计算统计（含成本）、按 turn 组织 span
  trace/bash-usage.ts   bash 命令分类：读/搜/改文件、工作区外、其他（eval 的 bash file ops 指标）
  eval/
    tasks.ts            加载任务、复制仓库、运行检查命令
    runner.ts           跑一次尝试：成本守卫、判定 PASS/FAIL
    report.ts           结果表、与上次运行对比
    index.ts            npm run eval 入口
    common.ts           两个入口共用：并发池、运行编号、去掉凭据
    swebench/           npm run eval:swe：数据集、Docker 容器里的 bash、官方脚本评分（helper.py 调 swebench 包）
  gui/
    server.ts           路由、token 与 Host 校验
    iterations.ts       迭代记录：docs/iterations.json + git log
    manager.ts          按需加载会话，统计、搜索、归档与删除
    settings.ts         网页的设置（.settings.json）
    http.ts / reveal.ts HTTP 工具、在文件管理器中显示
    pick-folder.ts      弹出系统文件夹选择框
    remote/             --remote / --public：tailscale 状态与 serve（tailscale.ts）、Cloudflare Access 令牌校验（cf-access.ts）、来访者校验（access.ts）、设备与配对码（devices.ts）、审计日志（audit.ts）、接口（routes.ts）
    *.html / common.*   主页面（会话 / 设置，统计和迭代记录以 iframe 嵌入）、统计、迭代记录、原文件、配对页
eval/tasks/             10 个练习任务（repo / check / solution / task.json）
test/                   loop、tools、权限、协议转换（含流式）、trace/脱敏、会话、HTTP 接口、eval
```

★ 标记的文件是"决策点"，详见 [DECISIONS.md](DECISIONS.md)。
