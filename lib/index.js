/**
 * Host half of `dsh-three-modes`.
 *
 * Owns the durable per-session mode (discussion / adversarial / task), the
 * mode prompt section, the tool mask and guard that keep the two review modes
 * read-only, the temperature override, and the `/mode` command.
 *
 * Everything here is derived from the session log: the registered projection
 * folds `command/run` + `command/done` for `/mode <name>` and only commits a
 * success, so a reload, a new window, or a resumed session recovers the same
 * mode without starting a new conversation.
 *
 * @module dsh-three-modes
 */
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import {
  COMMAND,
  MODES,
  PLUGIN,
  TOGGLES,
  commandEnabled,
  commandMode,
  foldThreeModesEnabled,
  foldThreeModesMode,
  isMode,
  sessionEvents,
} from './modes.js'

/** Loader entry id; matches `cordis.patch.yml`. */
const name = PLUGIN

/** Host services this plugin needs. */
const inject = ['agents', 'tools', 'systemPrompt']

const DEFAULT_DISCUSSION_PROMPT =
  '你当前处于【讨论模式】。禁止修改任何文件或执行终端命令。请作为架构师，引导我梳理需求、完善技术方案。多向我提问，不要急于给出最终代码。'

const DEFAULT_ADVERSARIAL_PROMPT =
  '你当前处于【对抗模式】。请作为最严苛的红队审查员/杠精，对刚才确认的方案进行毁灭性审查。专找逻辑漏洞、极端边界条件、性能瓶颈和安全风险。不要给出赞美，只指出问题并提供修改建议。'

const DEFAULT_TASK_PROMPT =
  '你当前处于【任务模式】。方案已确认。请立即停止讨论，严格按照最终版方案执行任务。请直接调用工具修改文件或运行命令。'

/**
 * Tools whose execution writes state: filesystem writes, shells, terminals,
 * long-running jobs, deliverables, and control of other agents. Names the
 * running composition does not register are dropped before the mask is
 * installed, because `tools.restrict()` throws on an unknown global tool.
 */
const DEFAULT_MUTATING_TOOLS = [
  'write',
  'edit',
  'str_replace_editor',
  'pwsh',
  'bash',
  'terminal_open',
  'terminal_send',
  'terminal_signal',
  'terminal_close',
  'present',
  'todo_write',
  'goal',
  'create_goal',
  'update_goal',
  'job_kill',
  'schedule_create',
  'schedule_update',
  'schedule_delete',
  'ralph',
  'workflow',
  'send_message',
  'interrupt_agent',
  'working_directory',
]

const Config = Schema.object({
  defaultMode: Schema.union(MODES).default('task'),
  defaultEnabled: Schema.boolean().default(true),
  discussionPrompt: Schema.string().default(DEFAULT_DISCUSSION_PROMPT),
  adversarialPrompt: Schema.string().default(DEFAULT_ADVERSARIAL_PROMPT),
  taskPrompt: Schema.string().default(DEFAULT_TASK_PROMPT),
  mutatingTools: Schema.array(Schema.string()).default(DEFAULT_MUTATING_TOOLS),
  discussionTemperature: Schema.number().default(0.7),
  adversarialTemperature: Schema.number().default(0.2),
  overrideTemperature: Schema.boolean().default(true),
})

/** Projection view carried to the client: the mode, its enablement, and any in-flight switch. */
const projectionSchema = z.object({
  mode: z.enum(MODES),
  enabled: z.boolean().default(true),
  pending: z.enum(MODES).optional(),
  pendingEnabled: z.boolean().optional(),
})

/** One in-flight `/mode` admission, awaited on `command/done`. */
const attemptSchema = z.object({
  commandId: z.string(),
  mode: z.enum(MODES).optional(),
  enabled: z.boolean().optional(),
})

/** Projection state folded over the session log. */
const projectionStateSchema = z.object({
  mode: z.enum(MODES),
  // `.default` rather than a `stateVersion` bump: a row cached before the
  // toggle existed carries no `enabled`, and reusing it is both correct (the
  // log folds to `true` for such sessions) and much cheaper than invalidating
  // every historical session's cache and refolding its whole log.
  enabled: z.boolean().default(true),
  attempts: z.array(attemptSchema),
})

/** The localized name of one mode, for command replies and denial text. */
const MODE_LABELS = {
  discussion: '讨论模式',
  adversarial: '对抗模式',
  task: '任务模式',
}

/**
 * Plugin body.
 * @param ctx - plugin root context.
 * @param config - validated deployment configuration.
 */
function apply(ctx, config) {
  const settings = {
    defaultMode: config?.defaultMode ?? 'task',
    defaultEnabled: config?.defaultEnabled ?? true,
    discussionPrompt: config?.discussionPrompt ?? DEFAULT_DISCUSSION_PROMPT,
    adversarialPrompt: config?.adversarialPrompt ?? DEFAULT_ADVERSARIAL_PROMPT,
    taskPrompt: config?.taskPrompt ?? DEFAULT_TASK_PROMPT,
    mutatingTools: config?.mutatingTools ?? DEFAULT_MUTATING_TOOLS,
    discussionTemperature: config?.discussionTemperature ?? 0.7,
    adversarialTemperature: config?.adversarialTemperature ?? 0.2,
    overrideTemperature: config?.overrideTemperature ?? true,
  }

  const PROMPTS = {
    discussion: () => settings.discussionPrompt,
    adversarial: () => settings.adversarialPrompt,
    task: () => settings.taskPrompt,
  }

  /** Temperature per mode; `undefined` means "keep whatever the route uses". */
  const TEMPERATURES = {
    discussion: settings.discussionTemperature,
    adversarial: settings.adversarialTemperature,
    task: undefined,
  }

  /** Durable mode read back from the log. */
  const modeOf = (session) => foldThreeModesMode(sessionEvents(session), settings.defaultMode)

  /** Durable enablement read back from the log. */
  const enabledOf = (session) => foldThreeModesEnabled(sessionEvents(session), settings.defaultEnabled)

  /** Selections applied synchronously by `/mode`, before the log catches up. */
  const runtimeSelections = new WeakMap()
  /** Instrumented agents and the disposers this plugin owns for each. */
  const instrumented = new Map()

  /** Effective mode for one agent: live selection first, then the folded log. */
  const effectiveMode = (agent) => runtimeSelections.get(agent.session)?.mode ?? modeOf(agent.session)

  /**
   * Effective enablement for one agent: live selection first, then the fold.
   *
   * A pending selection carries `mode` and/or `enabled`; each falls back to the
   * log independently so a mode switch never disturbs the switch state.
   */
  const effectiveEnabled = (agent) => runtimeSelections.get(agent.session)?.enabled ?? enabledOf(agent.session)

  /** Human-readable denial for a tool the current mode forbids. */
  const denialMessage = (mode, tool) =>
    `当前处于【${MODE_LABELS[mode]}】，不允许调用工具「${tool}」。该模式只读：请先在底部控件或输入 /mode task 切换到任务模式再执行操作。`

  /**
   * Reconcile one agent's tool mask with its current mode.
   *
   * `restrict()` refuses unknown names, so the deny list is intersected with
   * the scope's restrictable names on every sync — the composition can grow or
   * shrink between syncs (an MCP server connecting, a plugin unloading).
   */
  const syncRestriction = (agent) => {
    const state = instrumented.get(agent)
    if (state === undefined) return
    // A switched-off plugin is silent: no mask, exactly as an uninstalled one.
    const readOnly = effectiveEnabled(agent) && effectiveMode(agent) !== 'task'
    const deny = readOnly
      ? settings.mutatingTools.filter((tool) => ctx.tools.view(agent).restrictableNames.has(tool))
      : []
    // The guard reads this set on every call, so it is always written before the
    // branches below — including the ones that return early. Leaving a stale set
    // behind would let the guard keep denying a tool after the mask was lifted.
    state.denied = new Set(deny)
    if (!readOnly || deny.length === 0) {
      if (state.restriction !== undefined) {
        state.restriction()
        state.restriction = undefined
      }
      return
    }
    if (state.restriction !== undefined) return
    try {
      state.restriction = agent.ctx.tools.restrict({ deny })
    } catch (error) {
      ctx.logger.warn('three-modes: failed to install the tool mask: %o', error)
    }
  }

  /** Instrument one agent exactly once. */
  const instrument = (agent) => {
    if (instrumented.has(agent)) return
    const state = {
      restriction: undefined,
      denied: new Set(),
      disposeRequest: undefined,
      disposeGuard: undefined,
    }
    instrumented.set(agent, state)
    try {
      // The waterfall rebuilds the call config from the deployment defaults on
      // every request, so task mode simply passes the inherited value through:
      // nothing this hook returned earlier survives into the next request.
      state.disposeRequest = agent.ctx.on('agent/request', async (_payload, next) => {
        const proposed = await next()
        // Checked before anything else: a switched-off plugin must not touch the
        // config at all, or `/mode off` on a review mode would keep forcing its
        // temperature through the inherited one.
        if (!effectiveEnabled(agent)) return proposed
        if (!settings.overrideTemperature) return proposed
        const temperature = TEMPERATURES[effectiveMode(agent)]
        if (temperature === undefined || proposed.temperature === temperature) return proposed
        return { ...proposed, temperature }
      })
      // The mask hides these tools from the model, but a stale schema or a
      // resumed turn can still name one; the guard is the runtime backstop and
      // it denies with the same explanation the model would have read.
      state.disposeGuard = agent.ctx.tools.guard((exec) => {
        if (!state.denied.has(exec.name)) return undefined
        return denialMessage(effectiveMode(agent), exec.name)
      })
      syncRestriction(agent)
    } catch (cause) {
      instrumented.delete(agent)
      state.disposeRequest?.()
      state.disposeGuard?.()
      throw cause
    }
  }

  /** Drop every registration this plugin installed for one agent. */
  const release = (agent) => {
    const state = instrumented.get(agent)
    if (state === undefined) return
    instrumented.delete(agent)
    runtimeSelections.delete(agent.session)
    state.restriction?.()
    state.disposeRequest?.()
    state.disposeGuard?.()
  }

  ctx.on('agent/created', ({ agent }) => {
    instrument(agent)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    release(agent)
  })

  // A `/mode` invoked while the turn is already running takes effect at the
  // next step boundary; re-read the log there so the mask and the prompt agree.
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    instrument(agent)
    syncRestriction(agent)
    return decision
  })

  // `command/done` is the commit point: the log now holds the new mode, so the
  // optimistic selection can be dropped and the mask rebuilt from the fold.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'command/done') return
    const selection = runtimeSelections.get(session)
    if (selection === undefined || selection.commandId !== event.data.commandId) return
    runtimeSelections.delete(session)
    for (const agent of instrumented.keys()) {
      if (agent.session !== session) continue
      syncRestriction(agent)
    }
  })

  ctx.effect(() => () => {
    for (const agent of [...instrumented.keys()]) release(agent)
  }, 'dsh-three-modes: release agents')

  ctx.systemPrompt.section({
    name: 'three-modes:mode',
    // Between PLAN_POLICY (500) and TEAM_POLICY (600): after the deployment
    // persona and the plan policy, before any tool's own guidance.
    order: 520,
    text: (context) => {
      const agent = context.agent
      // No agent on this assembly (a deployment-level prompt): stay silent.
      if (agent === undefined) return ''
      // An empty section is dropped from the assembled prompt outright, so a
      // switched-off plugin leaves no trace in the request at all.
      if (!effectiveEnabled(agent)) return ''
      return PROMPTS[effectiveMode(agent)]()
    },
  })

  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register({
      key: name,      stateVersion: 1,
      stateSchema: projectionStateSchema,
      init: () => ({ mode: settings.defaultMode, enabled: settings.defaultEnabled, attempts: [] }),
      apply: (state, event) => {
        if (event.type === 'command/run') {
          const mode = commandMode(event)
          const enabled = commandEnabled(event)
          if (mode === undefined && enabled === undefined) return state
          const attempt = { commandId: event.data.commandId }
          if (mode !== undefined) attempt.mode = mode
          if (enabled !== undefined) attempt.enabled = enabled
          return { ...state, attempts: [...state.attempts, attempt] }
        }
        if (event.type !== 'command/done') return state
        const attempt = state.attempts.find((candidate) => candidate.commandId === event.data.commandId)
        if (attempt === undefined) return state
        const attempts = state.attempts.filter((candidate) => candidate !== attempt)
        if (event.data.kind !== 'success') return { ...state, attempts }
        // The two commands commit independently: `/mode off` leaves the mode
        // alone, `/mode task` leaves the switch alone.
        return {
          mode: attempt.mode ?? state.mode,
          enabled: attempt.enabled ?? state.enabled,
          attempts,
        }
      },
      view: (state) => ({ mode: state.mode, enabled: state.enabled }),
      wire: {
        viewSchema: projectionSchema,
        // The first still-pending switch is echoed back so the control can
        // show the target the user clicked before the log commits it.
        view: (state) => {
          const view = { mode: state.mode, enabled: state.enabled }
          const selection = state.attempts.at(-1)
          if (selection === undefined) return view
          if (selection.mode !== undefined && selection.mode !== state.mode) view.pending = selection.mode
          if (selection.enabled !== undefined && selection.enabled !== state.enabled) {
            view.pendingEnabled = selection.enabled
          }
          return view
        },
      },
    })
  })

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: COMMAND,
      description: '切换本会话的三种模式：讨论 / 对抗 / 任务，或开关整个插件',
      input: { hint: '<discussion|adversarial|task|on|off>' },
      handler: ({ agent, commandId, rawInput }) => {
        const selection = rawInput.trim().toLowerCase()
        if (selection === 'on' || selection === 'off') {
          const enabled = selection === 'on'
          instrument(agent)
          const previous = runtimeSelections.get(agent.session)
          // Carry the live mode across the toggle. Dropping it would let the
          // optimistic mode fall back to the fold for the instant between the
          // click and the log commit, which reads as a flicker back to task.
          const carried = previous?.mode === undefined ? {} : { mode: previous.mode }
          runtimeSelections.set(agent.session, { ...carried, commandId, enabled })
          try {
            syncRestriction(agent)
          } catch (cause) {
            if (previous === undefined) runtimeSelections.delete(agent.session)
            else runtimeSelections.set(agent.session, previous)
            syncRestriction(agent)
            throw cause
          }
          return {
            kind: 'success',
            text: enabled
              ? '已启用三种模式。当前模式重新生效，工具权限按模式恢复。'
              : '已关闭三种模式。插件完全静默：不注入提示词，并解除全部工具限制。',
          }
        }
        if (!isMode(selection)) {
          return { kind: 'error', text: '用法：/mode <discussion|adversarial|task|on|off>' }
        }
        const mode = selection
        instrument(agent)
        const previous = runtimeSelections.get(agent.session)
        runtimeSelections.set(agent.session, { commandId, mode })
        try {
          syncRestriction(agent)
        } catch (cause) {
          if (previous === undefined) runtimeSelections.delete(agent.session)
          else runtimeSelections.set(agent.session, previous)
          syncRestriction(agent)
          throw cause
        }
        const detail =
          mode === 'task'
            ? '工具权限已全部恢复，可以直接修改文件与执行命令。'
            : '所有会产生副作用的工具已禁用，只保留读取、检索与提问能力。'
        return { kind: 'success', text: `已切换到${MODE_LABELS[mode]}。${detail}` }
      },
    })
  })

  for (const agent of ctx.agents.list()) instrument(agent)
}

Object.assign(apply, { inject })

export {
  Config,
  DEFAULT_ADVERSARIAL_PROMPT,
  DEFAULT_DISCUSSION_PROMPT,
  DEFAULT_MUTATING_TOOLS,
  DEFAULT_TASK_PROMPT,
  MODES,
  TOGGLES,
  apply,
  apply as default,
  commandEnabled,
  foldThreeModesEnabled,
  foldThreeModesMode,
  inject,
  name,
}
