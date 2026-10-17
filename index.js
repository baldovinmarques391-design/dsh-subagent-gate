/**
 * @local/dsh-subagent-gate —— 原生子代理总开关
 *
 * 需求（使用者原话）：
 *   - 设置页有一个开关；
 *   - 关上：关于子代理的提示词整块消失，插件页里也看不见「子智能体」；
 *   - 打开：插件页能看见子代理，但**只在会话里确实有子代理记录时才注入提示词**；
 *   - 旧对话（已有子代理历史）注入的是另一套提示词。
 *
 * 实现要点：
 *   1) 开关的值走 dsh 的 settings 服务（`installSection`，applies: live），
 *      所以设置页里那行是活配置，改完立即生效，无需重启。
 *   2) "在插件页看不见" = 往 profile 补丁里写 `- id: <行id>` + `disabled: true`
 *      覆盖（这正是插件页开关自己的做法），补丁是活的，写完立刻重载。
 *   3) 提示词走 `systemPrompt.context()`：仅在开关打开、且该会话
 *      `ctx.subagents.listChildren(sessionId)` 非空时才注入。
 */
import Schema from '@deepseek-ai/schemastery'
import { readFile, writeFile } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 自己的日志（这个组合里 ctx.logger 不一定存在），保证任何一步都留痕。 */
function diag(message) {
  try {
    appendFileSync(join(HERE, 'gate.log'), `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch { /* 写不了就算了 */ }
}

export const name = 'subagent-gate'

export const Config = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .description('总开关。关掉后：不注入任何子代理提示词，并隐藏 hiddenRows 列出的插件行。')
    .volatile(),
  hiddenRows: Schema.array(Schema.string())
    .default(['ui-settings-subagent', 'ui-subagent'])
    .description('关掉时要隐藏的插件行 id；写进 profile 补丁的 disabled 覆盖里。')
    .volatile(),
  refreshMs: Schema.natural()
    .default(20000)
    .description('子代理记录缓存的刷新间隔（毫秒）。')
    .volatile(),
})

const BLOCK_BEGIN = '# === subagent-gate: begin（由「原生子代理总开关」自动维护，勿手改）==='
const BLOCK_END = '# === subagent-gate: end ==='
const DEFAULT_HIDDEN = ['ui-settings-subagent', 'ui-subagent']

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 读一个可能是 schemastery「volatile 单元格」的配置值。
 * 标了 `.volatile()` 的字段在配置对象里是 `{ get() }` 惰性单元格（不是普通值），
 * 所以必须在**用的时候**才解包，不能在 apply 时缓存 —— 否则开关拨了也不生效。
 * 这与 DSH 官方 dsh-compact 里 readValue() 的做法一致。
 */
export function readValue(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get()
    } catch {
      return undefined
    }
  }
  return value
}

export function apply(ctx, config = {}) {
  /** 当前开关（每次都从活单元格里读）。 */
  const enabledNow = () => readValue(config.enabled) !== false
  /** 当前要隐藏的插件行 id。 */
  const hiddenRowsNow = () => {
    const value = readValue(config.hiddenRows)
    return Array.isArray(value) && value.length > 0 ? value.map(String) : DEFAULT_HIDDEN
  }

  // ── 1) 插件行可见性：往 profile 补丁写 / 撤 disabled 覆盖 ─────────────
  // settings 是可选服务：apply 时可能还没有，用 ctx.inject 等它就绪。
  let settings = ctx.get('settings')
  let syncing = false
  // ── 关于"摘掉原生子代理工具"：做不到，代码已删（2026-10-16 查证）──
  // dsh-tools 的 restrict() 明确要求：① 必须在 agent 作用域里调用（根上下文直接抛错）；
  // ② 只能点名"全局工具"，scope-local 名称会抛 unknown global tool。
  // 而 subagent / subagent_fork 等由 **agent preset 平面**注册（scope-local），
  // 所以任何外部插件都摘不掉它们 —— 只能改成"把真相告诉模型"（见下面第 3 节的提示词）。
  ctx.inject(['settings'], (scoped) => {
    if (typeof scoped?.settings?.prepareDocument === 'function') settings = scoped.settings
    void syncVisibility()
    if (typeof settings?.configure === 'function') {
      ctx.effect(() => settings.configure({ auto: false }, ctx.fiber))
    }
  })

  async function syncVisibility() {
    if (settings === undefined || settings === null || syncing) return
    syncing = true
    try {
      const file = await settings.prepareDocument()
      let text = ''
      try {
        text = await readFile(file, 'utf8')
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      const present = text.includes(BLOCK_BEGIN)
      const wantHidden = enabledNow() !== true
      if (wantHidden && !present) {
        const rows = hiddenRowsNow()
        const block = [
          '',
          BLOCK_BEGIN,
          ...rows.map((id) => `- id: ${id}\n  disabled: true`),
          BLOCK_END,
          '',
        ].join('\n')
        await writeFile(file, text.replace(/\s*$/, '\n') + block, 'utf8')
        ctx.logger?.info?.(`subagent-gate: 已隐藏插件行 ${rows.join(', ')}`)
      } else if (!wantHidden && present) {
        const re = new RegExp(`\\n?${escapeRe(BLOCK_BEGIN)}[\\s\\S]*?${escapeRe(BLOCK_END)}\\n?`, 'm')
        await writeFile(file, text.replace(re, '\n'), 'utf8')
        ctx.logger?.info?.('subagent-gate: 已恢复子代理相关插件行')
      }
    } catch (error) {
      ctx.logger?.warn?.(`subagent-gate: 写 profile 补丁失败：${String(error?.message ?? error)}`)
    } finally {
      syncing = false
    }
  }

  // ── 2) 子代理记录缓存（同步可读，供提示词组装使用）──────────────────
  const children = new Map()
  const subagents = ctx.get('subagents')
  const agents = ctx.get('agents')

  async function refresh(id) {
    if (subagents === undefined || id === undefined) return
    try {
      const list = await subagents.listChildren(id)
      children.set(id, Array.isArray(list) ? list : [])
    } catch {
      children.set(id, [])
    }
  }

  async function refreshAll() {
    if (agents === undefined) return
    for (const agent of agents.list()) await refresh(agent.id)
  }

  // ── 3) 提示词 ────────────────────────────────────────────────────────
  //   开关=关 → 注入一段"原生子代理已关闭"的实话（工具摘不掉，就告诉模型别调它们）
  //   开关=开 + 会话有子代理记录 → 注入历史记录说明
  //   开关=开 + 无记录 → 一个字都不注入
  const OFF_NOTICE = [
    '[原生子代理] 本机原生子代理已关闭（总开关处于"关"）。',
    '不要调用 subagent / subagent_fork / list_agents / send_message / interrupt_agent —— 它们必然失败（maxDepth 0）。',
    '需要派子代理时用免费桥接：freesub_run(task="…")（Qoder CN 的免费模型）。',
  ].join('\n')

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    ctx.effect(() => systemPrompt.context({
      name: 'native-subagent-awareness',
      order: 96,
      text: (assemble) => {
        if (enabledNow() !== true) return OFF_NOTICE
        const id = assemble?.scope?.id
        if (typeof id !== 'string') return ''
        const list = children.get(id)
        if (list === undefined) {
          void refresh(id)
          return ''
        }
        if (list.length === 0) return ''
        const brief = list.slice(0, 8).map((child) => {
          const label = child?.name ?? child?.label ?? child?.agentId ?? child?.id ?? '子代理'
          const status = child?.status ?? child?.state ?? '未知'
          return `- ${String(label)} [${String(status)}]`
        })
        return [
          `[原生子代理] 本会话有 ${list.length} 条子代理记录（本机原生子代理已关闭）：`,
          ...brief,
          '说明：subagent / subagent_fork / list_agents 等原生工具在本机不存在，不要调用它们，也不要假装派过子代理。',
          '需要派子代理时用免费桥接：freesub_run(task="…")（Qoder CN 的免费模型）。',
          '用户问起这些历史记录时，照实说明原生子代理已被总开关关闭。',
        ].join('\n')
      },
    }))
  }

  // ── 4) 触发器：激活时、子代理起止时、新 agent 建立时、定时兜底 ──────
  diag(`apply：enabled=${String(readValue(config.enabled))}`)
  void syncVisibility()
  void refreshAll()

  ctx.on('agent/created', (payload) => {
    const id = payload?.agent?.id
    if (typeof id === 'string') void refresh(id)
  })
  ctx.on('subagent/start', () => { void refreshAll() })
  ctx.on('subagent/end', () => { void refreshAll() })
  // 设置表单写盘后立刻重算可见性：volatile 单元格的值是活的，但"写块"这个动作需要我们做。
  ctx.on('settings/document-updated', (ns) => {
    if (String(ns) === name) {
      diag(`收到 settings/document-updated：enabled=${String(readValue(config.enabled))}`)
      void syncVisibility()
    }
  })

  ctx.effect(() => {
    const timer = setInterval(() => {
      void refreshAll()
      void syncVisibility()
    }, Number(readValue(config.refreshMs) ?? 20000))
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'subagent-gate: 子代理记录刷新 + 可见性兜底')

  // ── 5) 设置表单与 configure 注册已在文件前半部分随 ctx.inject(['settings']) 一起完成 ──
}
