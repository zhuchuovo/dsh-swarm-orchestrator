# dsh-swarm-orchestrator

并行子代理集群（常驻插件）：母代理把整体目标拆成多个互不重叠的切片，按配置的并发数**同时**驱动
多个独立子代理写代码，全部完成后可选派发一名独立验收代理；会话输入框上方实时显示每个子代理
**此刻正在做什么**。

## 它提供什么

**模型工具（全局注册，任意对话可用）**

| 工具 | 作用 |
| --- | --- |
| `swarm_run` | 给出 `goal` + `tasks[]`，按并发数同时派发子代理；`wait:false` 转后台。**幂等**：同一个目标+同一批切片重复调用不会重新派发 |
| `swarm_status` | 罗列进行项：每个子代理的切片、状态、模型、此刻的工具与目标、耗时、触及文件、交付摘要 |
| `swarm_control` | `cancel_all` / `cancel_unit` / `cancel_queued` / `clear` |

**幂等护栏（防止项目被反复重跑）**：每轮集群会算一个「项目指纹」（`goal` + 切片清单）。
重复调用 `swarm_run` 时按指纹判定，**一律不再重新派发子代理**：

| 情况 | 行为 |
| --- | --- |
| 同一个项目正在跑 | 搭上那一轮，返回它的结果（绝不重启） |
| 同一个项目已成功结束 | 直接复用已有报告，不新建任何子代理 |
| 同一个项目上次失败/被取消 | 放行——重试是合理的 |
| 目标或切片清单变了 | 放行——那是另一个项目 |
| 显式传 `rerun: true` | 跳过护栏，强制重跑 |

没有这层护栏时，`swarm_run` 只要被重复调用一次（模型重试、同一批工具调用被并发派发、
上游续轮又问一遍），旧实现就会把整轮切片从零重新派发一遍——项目看起来「完成后又被
完整完成一次」，而且会反复。

**界面**

- `conversation.input.dock`（id `swarm-board`）：实时看板。每个子代理一行，含状态灯、切片名、
  模型、此刻的工具与目标文件、步数/工具次数、最近自述、耗时、进度条；点行直接打开该子代理的会话。
  当前会话没有集群任务时渲染为 null（不占位）。
- `settings.section`（id `swarm`）：配置页。并发数 1–8、验收代理开关、子代理后端（fork/spawn/自动）、
  逐切片模型分配（从已有运营商取供应商与模型列表）。

**配置持久化**：配置写入 `$DSH_HOME/swarm-orchestrator.json`（默认 `~/.dsh/`），重启后保留。

## 装在哪个平面

host 平面的一行（profile bundle）。集群状态以调用方 session id 为键、跨会话共享注册表，且消费
host 平面的 `subagents` 单例，所以不能进 preset。工具因此注册到全局 tools 层，**所有对话和所有
preset 都能用**；看板按会话各自独立。

## 安装

```jsonc
// dsh.profile.bundles 里追加
"dsh-swarm-orchestrator"
```

客户端半边由 package.json 的 `dsh.client` 声明装配，host 半边由 bundle patch 插入一行。
装完重启 profile（必要时刷新页面）生效。

## 已知边界

- 子代理后端取 `subagents.list()` 中可用的名字，优先 `fork`（继承父代理已完成轮次上下文），
  验收代理优先 `spawn`（全新会话，保持独立判断）。
- 单次最多 8 个切片、并发上限 8。
- 幂等护栏以「`goal` + 切片清单」为键：只改并发数或验收开关**不算**新项目，仍会复用；
  要重跑就传 `rerun: true`，或用 `swarm_control` 的 `clear` 清掉记录再调用。
- 取消整轮会 abort 该轮所有子代理；`wait:false` 的后台集群由插件自己持有 AbortController，
  不受工具调用返回影响。
- **递归由 `maxDepth: 1` 结构性拦住**：孙代理的 `childDepth` 会是 2 > 1，直接被子代理服务拒绝。
  传给子代理的 `toolFilter.deny` 只是额外一层——注意它按**调用方 agent 的 scope** 取工具表
  （`ctx.tools.schemas(parent)`），因为 `subagent_fork` / `cordis_*` / `ask_user_question` 都是
  preset 行注册的 agent-scope 工具，在 host 平面的全局视图里看不到。若后端拒绝该 filter，
  插件会去掉它重试一次，`maxDepth` 仍然生效。
- 工具注册在**全局层**，因此每个 agent 都能看到；但 preset 若用 `tools.restrict({ allow: [...] })`
  收窄全局工具，`swarm_*` 也会被一起挡掉——那是 preset 自己的选择。

## 重启后自检

装完必须重启 profile 才会生效（组合在启动时读取）。重启后按顺序确认：

1. `dsh --profile web --dump-config` 应含 `- id: swarm-orchestrator`。
2. 任意对话里 `swarm_run` / `swarm_status` / `swarm_control` 三个工具都在（切一个别的会话同样在）。
3. 设置里出现「并行子代理集群」页；改并发数保存后，`$DSH_HOME/swarm-orchestrator.json` 出现。
4. 派一个 2 切片任务：输入框上方出现看板，两行同时「运行中」；点行能跳进子代理会话。
5. 重启 DSH 再看第 3 步的文件是否被读回（`[swarm] config loaded from …` 会打在 host 日志里）。
