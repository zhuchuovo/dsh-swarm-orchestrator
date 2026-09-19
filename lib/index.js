/**
 * dsh-swarm-orchestrator — 并行子代理集群（host 半边）。
 *
 * 母代理用 `swarm_run` 给出整体目标 + 切片列表；本插件按配置的并发数同时派发多个独立子代理
 * （`ctx.subagents`，每个是独立会话，可分别指定 provider/model），全部完成后可选派发一名独立
 * 验收代理。子代理的实时活动从 `session/event` 流里取标量叶子字段（工具名、目标路径、步号、
 * 文本尾部），经 `/api/swarm/*` 提供给浏览器看板。
 *
 * 平面：host。集群状态以调用方 session id 为键、跨会话共享，且消费 host 平面的 `subagents`
 * 单例（provider 名全局只能注册一次），所以它是 profile 的一行而不是 preset 的一行。
 * 三个模型工具因此注册到全局 tools 层——任意对话、任意 preset 都能直接调用。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-swarm-orchestrator'
/** `subagents` 是子代理注册表；`tools` 是模型工具注册表。二者都是 host 平面单例。 */
export const inject = ['subagents', 'tools']

const ROUTE_PATH = '/api/swarm'
const MAX_TASKS = 8
const MAX_CONCURRENCY = 8
/** 常驻进程里最多保留多少个会话的「最近一次集群看板」（超出时淘汰已结束的旧记录）。 */
const MAX_RETAINED_RUNS = 50

/** 配置文件的绝对路径：`$DSH_HOME/swarm-orchestrator.json`（默认 `~/.dsh`）。 */
function configFile() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'swarm-orchestrator.json')
}

function normalizeRoute(raw) {
  if (!raw || typeof raw !== 'object') return null
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
  const model = typeof raw.model === 'string' ? raw.model.trim() : ''
  return provider && model ? { provider, model } : null
}

function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const rawConcurrency = Number(src.concurrency)
  const concurrency = Math.min(
    MAX_CONCURRENCY,
    Math.max(1, Number.isFinite(rawConcurrency) ? Math.round(rawConcurrency) : 2),
  )
  const slots = []
  const rawSlots = Array.isArray(src.slots) ? src.slots : []
  for (let i = 0; i < MAX_CONCURRENCY; i += 1) slots.push(normalizeRoute(rawSlots[i]))
  return {
    concurrency,
    verify: src.verify === undefined ? true : Boolean(src.verify),
    provider: typeof src.provider === 'string' ? src.provider.trim() : '',
    slots,
    verifier: normalizeRoute(src.verifier),
  }
}

/**
 * 安装插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 本行的 fiber 上下文。
 */
export function apply(ctx) {
  const subagents = ctx.get('subagents')
  const llm = ctx.get('llm')
  const agentDefaultModel = ctx.get('agentDefaultModel')

  const now = () => Date.now()
  const oneLine = value => String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim()
  const clip = (value, limit) => {
    const text = String(value === undefined || value === null ? '' : value)
    return text.length > limit ? `${text.slice(0, limit)}…` : text
  }
  /** 插件自己的日志出口：不碰 ctx.logger（未声明的服务属性访问在 Cordis 里会抛）。 */
  const log = (...args) => {
    try { console.log('[swarm]', ...args) } catch { /* ignore */ }
  }

  // ── 配置（持久化到 $DSH_HOME） ──────────────────────────────────────────────
  const file = configFile()
  let config = normalizeConfig(null)
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    config = normalizeConfig(parsed)
    log(`config loaded from ${file}`)
  } catch {
    // 首次运行或文件损坏：用默认配置，不阻塞激活。
  }

  function persistConfig() {
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf-8')
      renameSync(tmp, file)
    } catch (error) {
      log(`config persist failed: ${String(error && error.message ? error.message : error)}`)
    }
  }

  // ── 模型目录（设置页用） ───────────────────────────────────────────────────
  let optionsCache = { at: 0, providers: [], subagentProviders: [], defaultRoute: null }

  async function loadOptions(force) {
    if (!force && optionsCache.at > 0 && now() - optionsCache.at < 60_000) return optionsCache
    const providers = []
    if (llm !== undefined) {
      let listed = []
      try { listed = await llm.listProviders() } catch { listed = [] }
      for (const entry of Array.isArray(listed) ? listed : []) {
        if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) continue
        let models = []
        try {
          const found = await llm.listModels(entry.id)
          for (const info of Array.isArray(found) ? found : []) {
            const id = typeof info?.id === 'string' ? info.id : ''
            if (id) models.push({ id, name: typeof info?.name === 'string' ? info.name : id })
          }
        } catch { models = [] }
        providers.push({ id: entry.id, name: typeof entry.name === 'string' ? entry.name : entry.id, models })
      }
    }
    let subagentProviders = []
    try { subagentProviders = (subagents.list() || []).slice() } catch { subagentProviders = [] }
    let defaultRoute = null
    if (agentDefaultModel !== undefined) {
      try {
        const selection = agentDefaultModel.currentSelection()
        if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string') {
          defaultRoute = { provider: selection.provider, model: selection.model }
        }
      } catch { defaultRoute = null }
    }
    optionsCache = { at: now(), providers, subagentProviders, defaultRoute }
    return optionsCache
  }

  function resolveProviderName() {
    if (config.provider) {
      try { if (subagents.getProvider(config.provider) !== undefined) return config.provider } catch { /* fall through */ }
    }
    let names = []
    try { names = subagents.list() || [] } catch { names = [] }
    if (names.includes('fork')) return 'fork'
    if (names.includes('spawn')) return 'spawn'
    return names.length > 0 ? names[0] : ''
  }

  /** 验收代理优先全新会话（spawn），保持独立判断；否则退回工人后端。 */
  function resolveVerifierProviderName() {
    let names = []
    try { names = subagents.list() || [] } catch { names = [] }
    return names.includes('spawn') ? 'spawn' : resolveProviderName()
  }

  /** 子代理不该拿到的工具名（下面按调用方 scope 求交集后再用）。 */
  const DENY_CANDIDATES = [
    'subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code', 'send_message',
    'workflow', 'ralph', 'ask_user_question', 'exit_plan_mode',
    'cordis_define', 'cordis_run', 'cordis_stop', 'cordis_undefine',
    'cordis_inspect_list', 'cordis_inspect_query', 'cordis_inspect_self',
    'swarm_run', 'swarm_status', 'swarm_control',
  ]

  /**
   * 子代理不该拿到的工具：递归委派、向用户提问、自我修改运行时。
   *
   * 关键：必须按**调用方 agent 的 scope** 取工具表，不能取全局表。本插件是 host 平面的一行，
   * 而 `subagent` / `subagent_fork` / `cordis_*` / `ask_user_question` 这些是 preset 行注册的、
   * 属于 agent scope 的工具——在 host 平面的全局视图里根本看不到它们，按全局表算出来的 deny
   * 列表会是空的，等于没有过滤。
   */
  function childToolFilter(parent) {
    let available = []
    try {
      available = (ctx.tools.schemas(parent) || []).map(row => (typeof row?.name === 'string' ? row.name : '')).filter(Boolean)
    } catch { available = [] }
    if (available.length === 0) return null
    const deny = DENY_CANDIDATES.filter(candidate => available.includes(candidate))
    return deny.length > 0 ? { deny } : null
  }

  // ── 活动解析（只读事件的标量叶子字段） ─────────────────────────────────────
  function toolKindOf(toolName) {
    if (toolName === 'read' || toolName === 'glob' || toolName === 'grep') return 'read'
    if (toolName === 'write' || toolName === 'edit') return 'write'
    if (toolName === 'pwsh' || toolName === 'bash') return 'run'
    if (toolName === 'web_search' || toolName === 'web_fetch') return 'web'
    return 'tool'
  }

  const DESCRIBE_KEYS = ['file_path', 'path', 'notebook_path', 'pattern', 'command', 'query', 'url', 'description']

  function describeTool(args) {
    if (!args) return ''
    for (const key of DESCRIBE_KEYS) {
      const value = args[key]
      if (typeof value === 'string' && value.length > 0) return clip(oneLine(value), 100)
    }
    return ''
  }

  function pathOf(args) {
    if (!args) return ''
    const value = args.file_path ?? args.path ?? args.notebook_path
    return typeof value === 'string' ? value : ''
  }

  function assistantText(message) {
    if (!message || !Array.isArray(message.content)) return ''
    const parts = []
    for (const block of message.content) {
      if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    const text = oneLine(parts.join(' '))
    return text.length > 170 ? `…${text.slice(-170)}` : text
  }

  function setActivity(unit, kind, label, detail) {
    unit.activity = { kind, label, detail: clip(oneLine(detail), 110), at: now() }
  }

  function feedEvent(unit, event) {
    if (!event || typeof event !== 'object') return
    const data = event.data && typeof event.data === 'object' ? event.data : {}
    if (event.type === 'step/start') {
      unit.steps += 1
      setActivity(unit, 'thinking', '思考中', `第 ${String(data.step ?? 1)} 步`)
      return
    }
    if (event.type === 'turn/start') {
      setActivity(unit, 'thinking', '开始工作', `第 ${String(data.turn ?? 1)} 轮`)
      return
    }
    if (event.type === 'tool/call') {
      unit.toolCalls += 1
      const toolName = typeof data.name === 'string' ? data.name : ''
      let args = null
      if (typeof data.arguments === 'string' && data.arguments.length > 0) {
        try {
          const parsed = JSON.parse(data.arguments)
          if (parsed && typeof parsed === 'object') args = parsed
        } catch { args = null }
      }
      setActivity(unit, toolKindOf(toolName), toolName, describeTool(args))
      const path = pathOf(args)
      if (path && !unit.files.includes(path) && unit.files.length < 8) unit.files.push(clip(path, 90))
      return
    }
    if (event.type === 'assistant/message') {
      const text = assistantText(data.message)
      if (text) unit.lastText = text
      return
    }
    if (event.type === 'turn/end') setActivity(unit, 'idle', '收尾中', '')
  }

  // ── 集群状态 ───────────────────────────────────────────────────────────────
  const unitsByChild = new Map()
  /** 子代理会话事件 → 对应单元。整个插件生命周期只需要这一个监听器。 */
  ctx.on('session/event', (session, event) => {
    const entry = unitsByChild.get(session?.id)
    if (entry === undefined) return
    feedEvent(entry, event)
  })

  let runSeq = 0
  /** parentSessionId → run */
  const runsByParent = new Map()
  const liveRuns = new Set()

  function makeUnit(role, key, unitName, taskId, title) {
    return {
      key,
      role,
      name: unitName,
      taskId,
      title,
      status: 'queued',
      provider: '',
      model: '',
      childSessionId: '',
      startedAt: 0,
      endedAt: 0,
      activity: { kind: 'queued', label: '排队中', detail: '', at: now() },
      toolCalls: 0,
      steps: 0,
      files: [],
      lastText: '',
      summary: '',
      error: '',
      stopReason: '',
      handle: null,
    }
  }

  function buildWorkerPrompt(run, task, unit) {
    const lines = [
      `你是「并行编码集群」中的一名独立子代理，代号 ${unit.name}。你与其他子代理同时工作。`,
      '',
      '【全局目标】',
      run.goal,
      '',
      `【你负责的切片 ${task.id}：${task.title}】`,
      task.brief,
    ]
    if (task.files.length > 0) lines.push(`负责的文件/目录：${task.files.join('、')}`)
    lines.push(
      '',
      '【协作约束】',
      '1. 只修改你负责的切片范围内的文件。其他切片正由并行的其他子代理同时修改，越界会造成冲突。',
      '2. 不要调用任何委派/子代理类工具，也不要向用户提问；无法自行决定的问题写进总结的「需要母代理决策」。',
      '3. 直接把代码写完（含必要的自测），不要只给方案或伪代码。',
      '4. 小步验证：能编译、能运行、能测的部分自己实际跑一遍。',
    )
    if (run.verifyEnabled) lines.push('5. 全部完成后会有一名独立验收代理复查工作区，请保证改动自洽、可运行。')
    lines.push(
      '',
      '【交付格式】完成后用中文输出，最多 8 行：',
      '- 状态：完成 / 部分完成 / 阻塞',
      '- 改动文件：相对路径列表',
      '- 关键实现：2-3 条',
      '- 自测：实际执行过的验证',
      '- 需要母代理决策 / 风险：遗留问题',
    )
    return lines.join('\n')
  }

  function buildVerifierPrompt(run) {
    const lines = ['你是本次「并行编码集群」的独立验收代理。你不参与实现，只做检测与验收。', '', '【全局目标】', run.goal]
    if (run.verifyFocus) lines.push('', '【本次验收重点】', run.verifyFocus)
    lines.push('', '【各子代理的交付摘要（自我声明，不可直接采信）】')
    for (const unit of run.units) {
      if (unit.role !== 'worker') continue
      const route = unit.provider ? `${unit.provider}/${unit.model}` : '继承父会话'
      lines.push(`◆ ${unit.name} ${unit.title}（模型 ${route}，状态 ${unit.status}）`)
      if (unit.files.length > 0) lines.push(`  触及文件：${unit.files.join('、')}`)
      lines.push(`  自述：${unit.summary ? clip(oneLine(unit.summary), 400) : '（无摘要）'}`)
    }
    lines.push(
      '',
      '【验收要求】',
      '1. 不要相信自述，直接读工作区代码核实；能运行构建/测试/lint 就实际运行。',
      '2. 逐切片判定：通过 / 有问题 / 不通过，并给出证据（文件:行，或命令与输出摘要）。',
      '3. 检查切片之间的接口是否对齐：同名函数、导出、类型、注册入口、命名冲突。',
      '4. 不要修改任何代码，只报告。',
      '5. 输出中文报告：逐项结论 → 缺陷清单（按严重度排序） → 总体结论（可交付 / 需返工）。',
    )
    return lines.join('\n')
  }

  function unitView(unit) {
    const end = unit.endedAt > 0 ? unit.endedAt : now()
    return {
      key: unit.key,
      role: unit.role,
      name: unit.name,
      taskId: unit.taskId,
      title: unit.title,
      status: unit.status,
      provider: unit.provider,
      model: unit.model,
      childSessionId: unit.childSessionId,
      elapsedMs: unit.startedAt > 0 ? Math.max(0, end - unit.startedAt) : 0,
      activity: { ...unit.activity },
      toolCalls: unit.toolCalls,
      steps: unit.steps,
      files: unit.files.slice(),
      lastText: clip(unit.lastText, 200),
      summary: clip(unit.summary, 700),
      error: clip(unit.error, 300),
      stopReason: unit.stopReason,
    }
  }

  function boardOf(run) {
    const end = run.endedAt > 0 ? run.endedAt : now()
    const counts = { running: 0, done: 0, failed: 0, queued: 0 }
    for (const unit of run.units) {
      if (unit.status === 'running' || unit.status === 'verifying') counts.running += 1
      else if (unit.status === 'done') counts.done += 1
      else if (unit.status === 'failed') counts.failed += 1
      else if (unit.status === 'queued') counts.queued += 1
    }
    return {
      runId: run.id,
      parentSessionId: run.parentSessionId,
      status: run.status,
      goal: clip(run.goal, 300),
      concurrency: run.concurrency,
      verify: run.verifyEnabled,
      provider: run.providerName,
      elapsedMs: Math.max(0, end - run.startedAt),
      total: run.tasks.length,
      counts,
      units: run.units.map(unitView),
    }
  }

  function reportText(run) {
    const lines = []
    const head = run.status === 'done' ? '结束' : run.status === 'cancelled' ? '已取消' : '异常结束'
    lines.push(
      `集群 ${run.id} ${head} · 并发 ${run.concurrency} · 用时 ${Math.round((run.endedAt - run.startedAt) / 1000)}s`
      + ` · 后端 ${run.providerName || '无'}`,
      `目标：${clip(oneLine(run.goal), 160)}`,
      '',
    )
    for (const unit of run.units) {
      const route = unit.provider ? `${unit.provider}/${unit.model}` : '继承父会话'
      const mark = unit.status === 'done' ? '[OK]' : unit.status === 'failed' ? '[FAIL]' : `[${unit.status}]`
      const elapsed = Math.round(((unit.endedAt > 0 ? unit.endedAt : now()) - unit.startedAt) / 1000)
      lines.push(`${mark} ${unit.name} ${unit.title} — ${route} · 用时 ${elapsed}s · 工具 ${unit.toolCalls}次`)
      if (unit.files.length > 0) lines.push(`    触及文件：${unit.files.join('、')}`)
      if (unit.error) lines.push(`    错误：${clip(unit.error, 300)}`)
      if (unit.summary) lines.push(`    交付：${clip(oneLine(unit.summary), 900)}`)
    }
    return lines.join('\n')
  }

  function resultText(outcome) {
    if (!outcome || !Array.isArray(outcome.output)) return ''
    const parts = []
    for (const block of outcome.output) {
      if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join('\n').trim()
  }

  function settleRun(run) {
    if (run.settled) return
    run.settled = true
    run.endedAt = now()
    if (run.status !== 'cancelled' && run.status !== 'failed') {
      run.status = run.units.some(unit => unit.status === 'failed') ? 'failed' : 'done'
    }
    run.report = reportText(run)
    if (typeof run.detachOuter === 'function') {
      run.detachOuter()
      run.detachOuter = null
    }
    releaseRun(run)
    if (typeof run.settle === 'function') {
      const notify = run.settle
      run.settle = null
      notify()
    }
  }

  /**
   * 释放一个已结束集群的运行时资源。
   *
   * 这是常驻插件：进程要连续跑几天甚至几周，所以不能让已结束的集群一直挂着。
   *   - `liveRuns` 只在卸载时用来 abort 在飞的子代理，结束的集群必须移出（否则永久泄漏）
   *   - `unitsByChild` 是 session/event 的路由索引，结束的子代理不会再产生有效活动，按 id 精确摘除
   *   - `runsByParent` 保留最近一次看板（swarm_status / UI 还要读），但整体加上限
   */
  function releaseRun(run) {
    liveRuns.delete(run)
    for (const childId of run.childIds) unitsByChild.delete(childId)
    run.childIds.length = 0
    run.handles.length = 0
    if (runsByParent.size <= MAX_RETAINED_RUNS) return
    for (const [sessionId, candidate] of runsByParent) {
      if (runsByParent.size <= MAX_RETAINED_RUNS) break
      if (candidate !== run && candidate.settled) runsByParent.delete(sessionId)
    }
  }

  function pump(run, parent, signal) {
    if (run.settled) return
    while (run.active < run.concurrency) {
      const task = run.tasks.find(candidate => candidate.status === 'queued')
      if (task === undefined) break
      task.status = 'running'
      run.active += 1
      void startWorker(run, task, parent, signal)
    }
    if (run.active > 0) {
      run.status = 'running'
      return
    }
    if (run.tasks.some(task => task.status === 'queued' || task.status === 'running')) return
    if (run.verifier !== null && run.verifier.status === 'running') {
      run.status = 'verifying'
      return
    }
    if (run.verifyEnabled && run.verifier === null && !run.stopRequested) {
      run.status = 'verifying'
      run.active += 1
      void startVerifier(run, parent, signal)
      return
    }
    settleRun(run)
  }

  async function startChild(run, base, providerOverride) {
    const providerName = providerOverride || run.providerName
    if (!providerName) throw new Error('没有可用的子代理后端（subagents.list() 为空）')
    let capabilities = null
    try {
      const provider = subagents.getProvider(providerName)
      capabilities = provider ? provider.capabilities : null
    } catch { capabilities = null }

    const build = (rich) => {
      const request = { label: base.label, prompt: base.prompt, parent: base.parent, signal: base.signal }
      if (base.agentOptions && (!capabilities || capabilities.agentOptions !== false)) request.agentOptions = base.agentOptions
      if (rich && (!capabilities || capabilities.depthLimit !== false)) request.maxDepth = 1
      if (rich && (!capabilities || capabilities.toolFilter !== false)) {
        const filter = childToolFilter(base.parent)
        if (filter !== null) request.toolFilter = filter
      }
      return request
    }
    try {
      return await subagents.start(providerName, build(true))
    } catch {
      // 后端不支持某些可选能力时，退化为最小请求再试一次。
      return await subagents.start(providerName, build(false))
    }
  }

  async function startWorker(run, task, parent, signal) {
    const unit = makeUnit('worker', `W${task.index + 1}`, `#${task.index + 1}`, task.id, task.title)
    run.units.push(unit)
    const route = task.route || config.slots[task.index % MAX_CONCURRENCY] || null
    unit.status = 'running'
    unit.startedAt = now()
    if (route) { unit.provider = route.provider; unit.model = route.model }
    setActivity(unit, 'thinking', '已派发', '等待子代理接单')
    const base = {
      label: `${unit.name} ${task.id} ${task.title}`,
      prompt: [{ type: 'text', text: buildWorkerPrompt(run, task, unit) }],
      parent,
      signal,
    }
    if (route) base.agentOptions = { provider: route.provider, model: route.model }
    try {
      const handle = await startChild(run, base)
      unit.childSessionId = String(handle.id)
      unit.handle = handle
      run.handles.push(handle)
      unitsByChild.set(unit.childSessionId, unit)
      run.childIds.push(unit.childSessionId)
      if (signal.aborted || unit.status === 'cancelled') await handle.dispose().catch(() => {})
      const outcome = await handle.result
      const stopReason = typeof outcome?.stopReason === 'string' ? outcome.stopReason : 'error'
      unit.stopReason = stopReason
      unit.summary = resultText(outcome) || '（子代理未返回文本摘要）'
      if (unit.status !== 'cancelled') {
        unit.status = stopReason === 'completed' ? 'done' : 'failed'
        if (stopReason !== 'completed') unit.error = `子代理停止原因：${stopReason}`
        setActivity(unit, unit.status === 'done' ? 'idle' : 'error', unit.status === 'done' ? '已完成' : '失败', stopReason)
      }
    } catch (error) {
      if (unit.status !== 'cancelled') {
        unit.status = 'failed'
        unit.error = oneLine(error && error.message ? error.message : error)
        setActivity(unit, 'error', '启动/执行失败', unit.error)
      }
    } finally {
      task.status = unit.status === 'done' ? 'done' : 'failed'
      unit.endedAt = now()
      run.active -= 1
      pump(run, parent, signal)
    }
  }

  async function startVerifier(run, parent, signal) {
    const unit = makeUnit('verifier', 'V', '验收', 'V', '独立验收与检测')
    run.units.push(unit)
    run.verifier = unit
    const route = config.verifier
    unit.status = 'running'
    unit.startedAt = now()
    if (route) { unit.provider = route.provider; unit.model = route.model }
    setActivity(unit, 'thinking', '已派发', '等待验收代理接单')
    const base = {
      label: `验收代理 ${run.id}`,
      prompt: [{ type: 'text', text: buildVerifierPrompt(run) }],
      parent,
      signal,
    }
    if (route) base.agentOptions = { provider: route.provider, model: route.model }
    try {
      const handle = await startChild(run, base, resolveVerifierProviderName())
      unit.childSessionId = String(handle.id)
      unit.handle = handle
      run.handles.push(handle)
      unitsByChild.set(unit.childSessionId, unit)
      run.childIds.push(unit.childSessionId)
      if (signal.aborted || unit.status === 'cancelled') await handle.dispose().catch(() => {})
      const outcome = await handle.result
      const stopReason = typeof outcome?.stopReason === 'string' ? outcome.stopReason : 'error'
      unit.stopReason = stopReason
      unit.summary = resultText(outcome) || '（验收代理未返回文本报告）'
      if (unit.status !== 'cancelled') {
        unit.status = stopReason === 'completed' ? 'done' : 'failed'
        if (stopReason !== 'completed') unit.error = `子代理停止原因：${stopReason}`
        setActivity(unit, unit.status === 'done' ? 'idle' : 'error', unit.status === 'done' ? '验收完成' : '验收失败', stopReason)
      }
    } catch (error) {
      if (unit.status !== 'cancelled') {
        unit.status = 'failed'
        unit.error = oneLine(error && error.message ? error.message : error)
        setActivity(unit, 'error', '验收启动失败', unit.error)
      }
    } finally {
      unit.endedAt = now()
      run.active -= 1
      pump(run, parent, signal)
    }
  }

  function createRun(parentSessionId, args, options) {
    const source = Array.isArray(args.tasks) ? args.tasks : []
    const tasks = []
    for (let i = 0; i < source.length && i < MAX_TASKS; i += 1) {
      const raw = source[i] && typeof source[i] === 'object' ? source[i] : {}
      const files = []
      if (Array.isArray(raw.files)) {
        for (const entry of raw.files.slice(0, 12)) {
          if (typeof entry === 'string' && entry.length > 0) files.push(oneLine(entry))
        }
      }
      tasks.push({
        index: i,
        id: `T${i + 1}`,
        title: oneLine(typeof raw.title === 'string' ? raw.title : '') || `切片 ${i + 1}`,
        brief: typeof raw.brief === 'string' && raw.brief.length > 0
          ? raw.brief
          : '（未提供说明，请按全局目标自行完成本切片的合理实现）',
        files,
        route: normalizeRoute({ provider: raw.provider, model: raw.model }),
        status: 'queued',
      })
    }
    const rawConcurrency = Number(args.concurrency)
    const chosen = Number.isFinite(rawConcurrency) && rawConcurrency > 0
      ? Math.round(rawConcurrency)
      : options.concurrency
    runSeq += 1
    return {
      id: `swarm-${runSeq}`,
      parentSessionId,
      goal: oneLine(args.goal) || '（未提供全局目标）',
      verifyEnabled: args.verify === undefined ? options.verify : Boolean(args.verify),
      verifyFocus: oneLine(args.verifyFocus),
      concurrency: Math.max(1, Math.min(Math.min(chosen, MAX_CONCURRENCY), Math.max(1, tasks.length))),
      providerName: options.providerName,
      startedAt: now(),
      endedAt: 0,
      status: 'running',
      settled: false,
      stopRequested: false,
      active: 0,
      tasks,
      units: [],
      verifier: null,
      handles: [],
      childIds: [],
      report: '',
      settle: null,
      detachOuter: null,
    }
  }

  /** 中止：`unitKey` 为空表示整轮（含排队切片），否则只中止那一个子代理。 */
  function cancelRun(run, unitKey) {
    if (!unitKey) {
      run.stopRequested = true
      for (const task of run.tasks) {
        if (task.status === 'queued') task.status = 'cancelled'
      }
    }
    for (const unit of run.units) {
      if (unitKey && unit.key !== unitKey) continue
      if (unit.status === 'running' || unit.status === 'verifying') {
        unit.status = 'cancelled'
        setActivity(unit, 'error', '已中止', '')
      }
      if (unit.handle) {
        const handle = unit.handle
        unit.handle = null
        void handle.dispose().catch(() => {})
      }
    }
    if (!unitKey) {
      if (run.controller !== undefined && run.controller !== null) run.controller.abort()
      if (run.verifier === null || run.verifier.status !== 'running') {
        run.status = 'cancelled'
        settleRun(run)
      }
    }
  }

  // 插件卸载：abort 所有在跑的集群并释放句柄。
  ctx.effect(() => () => {
    for (const run of liveRuns) {
      try { run.controller?.abort() } catch { /* ignore */ }
      for (const handle of run.handles) {
        try { void handle.dispose().catch(() => {}) } catch { /* ignore */ }
      }
      run.handles.length = 0
    }
    liveRuns.clear()
    runsByParent.clear()
    unitsByChild.clear()
  }, 'swarm: dispose child subagent runs')

  // ── HTTP 路由（浏览器看板 / 设置页的数据面） ───────────────────────────────
  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  async function readJsonBody(req) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (chunks.length === 0) return null
    try { return JSON.parse(Buffer.concat(chunks).toString('utf-8')) } catch { return null }
  }

  // webServer 是可选服务，且挂载顺序不受本行控制：用 ctx.inject 等它就位。
  ctx.inject(['webServer'], (sctx) => {
    const webServer = sctx.get('webServer')
    if (webServer === undefined) return
    const route = {
      kind: 'prefix',
      path: ROUTE_PATH,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url || '/', 'http://localhost')
          const action = url.pathname.slice(ROUTE_PATH.length) || '/'
          if (req.method === 'GET' && action === '/snapshot') {
            const sessionId = url.searchParams.get('sessionId') || ''
            const current = sessionId ? runsByParent.get(sessionId) : undefined
            sendJson(res, 200, { board: current === undefined ? null : boardOf(current) })
            return
          }
          if (req.method === 'GET' && action === '/options') {
            const loaded = await loadOptions(false)
            sendJson(res, 200, {
              providers: loaded.providers,
              subagentProviders: loaded.subagentProviders,
              defaultRoute: loaded.defaultRoute,
              config,
              active: resolveProviderName(),
              verifierActive: resolveVerifierProviderName(),
            })
            return
          }
          if (req.method === 'POST' && action === '/config') {
            const body = await readJsonBody(req)
            config = normalizeConfig(body && body.config)
            persistConfig()
            sendJson(res, 200, { ok: true, config })
            return
          }
          if (req.method === 'POST' && action === '/cancel') {
            const body = await readJsonBody(req)
            const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
            const run = sessionId ? runsByParent.get(sessionId) : undefined
            if (run === undefined) {
              sendJson(res, 200, { ok: false, board: null })
              return
            }
            cancelRun(run, typeof body?.unitKey === 'string' ? body.unitKey : '')
            sendJson(res, 200, { ok: true, board: boardOf(run) })
            return
          }
          sendJson(res, 404, { error: `unknown swarm endpoint ${req.method} ${action}` })
        } catch (error) {
          sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
        }
      },
    }
    sctx.effect(() => webServer.register(route))
  })

  // ── 模型工具（全局注册：任意对话、任意 preset 可用） ────────────────────────
  ctx.tools.register(defineTool({
    name: 'swarm_run',
    description: '启动「并行子代理集群」：把整体目标拆成多个互不重叠的切片任务，按配置的并发数同时派发给多个独立子代理执行（各自独立会话，可分别指定模型），可选在全部完成后派发一名独立验收代理。返回每个切片的交付摘要与验收报告。用户界面会实时显示每个子代理正在做什么。',
    parameters: {
      goal: { type: 'string', required: true, description: '整体目标，所有子代理共享（写清技术栈、目录、验收标准）' },
      tasks: {
        type: 'array',
        required: true,
        description: '切片任务列表，建议 2-6 个；每个切片必须负责不同的文件/模块，避免写冲突',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', required: true, description: '切片标题，例如「地形与生物群系生成」' },
            brief: { type: 'string', required: true, description: '该切片的具体要求、接口约定、交付物' },
            files: { type: 'array', items: { type: 'string' }, description: '该切片负责的文件/目录（避免与其他切片重叠）' },
            provider: { type: 'string', description: '该切片使用的模型供应商（可选，留空用插件设置）' },
            model: { type: 'string', description: '该切片使用的模型（可选）' },
          },
        },
      },
      concurrency: { type: 'integer', description: '本次并发子代理数（1-8）；留空使用插件设置里的值' },
      verify: { type: 'boolean', description: '全部切片完成后是否派发独立验收代理（默认跟随插件设置）' },
      verifyFocus: { type: 'string', description: '验收重点（可选）' },
      wait: { type: 'boolean', description: '是否等待全部子代理与验收代理结束再返回，默认 true；false 表示后台运行，之后用 swarm_status 查询' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{
        type: 'text',
        text: value && typeof value.report === 'string' && value.report.length > 0 ? value.report : '集群已启动',
      }],
    },
    async execute(args, exec) {
      const parent = exec?.agent
      if (!parent || typeof parent.id !== 'string') {
        return { ok: false, report: 'swarm_run 必须在真实会话中被调用（缺少调用方 agent）。' }
      }
      const source = Array.isArray(args.tasks) ? args.tasks : []
      if (source.length === 0) return { ok: false, report: '至少需要一个切片任务（tasks）。' }
      const providerName = resolveProviderName()
      if (!providerName) return { ok: false, report: '没有可用的子代理后端（subagents.list() 为空）。' }

      const run = createRun(parent.id, args, {
        concurrency: config.concurrency,
        verify: config.verify,
        providerName,
      })
      const previous = runsByParent.get(parent.id)
      if (previous && !previous.settled) cancelRun(previous, '')
      runsByParent.set(parent.id, run)
      liveRuns.add(run)

      // 自有 AbortController：后台集群不依赖工具调用的生命周期；
      // 同时把调用方的取消信号接进来，整轮被取消时子代理一起停。
      const controller = new AbortController()
      run.controller = controller
      const outer = exec.signal
      if (outer) {
        const onOuterAbort = () => controller.abort(outer.reason)
        if (outer.aborted) controller.abort(outer.reason)
        else {
          outer.addEventListener('abort', onOuterAbort, { once: true })
          run.detachOuter = () => outer.removeEventListener('abort', onOuterAbort)
        }
      }

      const waiter = new Promise(resolve => { run.settle = resolve })
      pump(run, parent, controller.signal)

      if (args.wait === false) {
        return {
          ok: true,
          report: `集群 ${run.id} 已在后台启动：${run.tasks.length} 个切片，并发 ${run.concurrency}`
            + `，后端 ${providerName}${run.verifyEnabled ? '，含独立验收代理' : ''}。用 swarm_status 查询进度。`,
          board: boardOf(run),
        }
      }
      await waiter
      return { ok: true, report: reportText(run), board: boardOf(run) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'swarm_status',
    description: '罗列当前会话「并行子代理集群」的全部进行项：每个子代理的切片、状态、模型、当前正在执行的工具与目标、耗时、已触及文件与交付摘要。',
    parameters: {
      verbose: { type: 'boolean', description: '是否附上每个子代理的交付摘要（默认 true）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{
        type: 'text',
        text: value && typeof value.report === 'string' ? value.report : '当前没有集群任务。',
      }],
    },
    async execute(args, exec) {
      const sessionId = exec?.agent && typeof exec.agent.id === 'string' ? exec.agent.id : ''
      const run = sessionId ? runsByParent.get(sessionId) : undefined
      if (!run) return { ok: false, report: '当前会话没有集群任务。', board: null }
      const verbose = args.verbose === undefined ? true : Boolean(args.verbose)
      const board = boardOf(run)
      const lines = [
        `集群 ${run.id} · 状态 ${run.status} · 并发 ${run.concurrency}`
          + ` · 用时 ${Math.round(((run.endedAt > 0 ? run.endedAt : now()) - run.startedAt) / 1000)}s`,
        `目标：${clip(run.goal, 200)}`,
        `进行项：运行 ${board.counts.running} / 完成 ${board.counts.done}`
          + ` / 失败 ${board.counts.failed} / 排队 ${board.counts.queued}（共 ${board.total} 个切片）`,
        '',
      ]
      for (const unit of run.units) {
        const route = unit.provider ? `${unit.provider}/${unit.model}` : '继承父会话'
        const elapsed = Math.round(((unit.endedAt > 0 ? unit.endedAt : now()) - unit.startedAt) / 1000)
        lines.push(`· ${unit.name} [${unit.status}] ${unit.title} — ${route} · ${elapsed}s`)
        lines.push(`    现在：${unit.activity.label}${unit.activity.detail ? ` — ${unit.activity.detail}` : ''}`
          + `（步 ${unit.steps} / 工具 ${unit.toolCalls}）`)
        if (unit.files.length > 0) lines.push(`    触及文件：${unit.files.join('、')}`)
        if (unit.error) lines.push(`    错误：${clip(unit.error, 240)}`)
        if (verbose && unit.summary) lines.push(`    交付：${clip(oneLine(unit.summary), 800)}`)
      }
      for (const task of run.tasks) {
        if (task.status === 'queued') lines.push(`· 排队中 ${task.id} ${task.title}`)
      }
      return { ok: true, report: lines.join('\n'), board }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'swarm_control',
    description: '控制当前会话的「并行子代理集群」：中止全部或某个子代理，或清除已结束的集群记录。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['cancel_all', 'cancel_unit', 'cancel_queued', 'clear'],
        description: 'cancel_all 中止全部；cancel_unit 中止单个（需 unitKey）；cancel_queued 只清空尚未派发的切片；clear 清除记录',
      },
      unitKey: { type: 'string', description: 'cancel_unit 时的子代理代号，例如 W1 或 V' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{
        type: 'text',
        text: value && typeof value.report === 'string' ? value.report : '已处理。',
      }],
    },
    async execute(args, exec) {
      const sessionId = exec?.agent && typeof exec.agent.id === 'string' ? exec.agent.id : ''
      const run = sessionId ? runsByParent.get(sessionId) : undefined
      if (!run) return { ok: false, report: '当前会话没有集群任务。' }
      const action = typeof args.action === 'string' ? args.action : ''
      if (action === 'clear') {
        if (!run.settled) cancelRun(run, '')
        runsByParent.delete(sessionId)
        liveRuns.delete(run)
        return { ok: true, report: `已清除集群记录 ${run.id}。` }
      }
      if (action === 'cancel_all') {
        cancelRun(run, '')
        return { ok: true, report: `已中止集群 ${run.id} 的全部子代理。`, board: boardOf(run) }
      }
      if (action === 'cancel_queued') {
        let count = 0
        for (const task of run.tasks) {
          if (task.status === 'queued') { task.status = 'cancelled'; count += 1 }
        }
        return { ok: true, report: `已取消 ${count} 个排队切片。`, board: boardOf(run) }
      }
      if (action === 'cancel_unit') {
        const unitKey = typeof args.unitKey === 'string' ? args.unitKey : ''
        if (!unitKey) return { ok: false, report: 'cancel_unit 需要 unitKey，例如 W1。' }
        cancelRun(run, unitKey)
        return { ok: true, report: `已请求中止 ${unitKey}。`, board: boardOf(run) }
      }
      return { ok: false, report: `未知 action：${action}` }
    },
  }))

  log(`orchestrator ready · provider=${resolveProviderName()} · concurrency=${config.concurrency}`)
}
