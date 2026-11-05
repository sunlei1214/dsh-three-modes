/**
 * Host-half integration test.
 *
 * Drives `apply()` with a stub composition and asserts the three things the
 * on/off switch has to get right:
 *
 * 1. switching off lifts the tool mask *and* clears the guard's deny set, so
 *    nothing keeps refusing tools after the mask is gone;
 * 2. switching off empties the prompt section, which the assembler drops;
 * 3. switching off stops the temperature override instead of leaving the last
 *    review mode's value pinned.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, Config } from '../lib/index.js'

/** A composition whose only agent is the one the test drives. */
function createComposition(options = {}) {
  const restrictable = new Set(options.tools ?? ['write', 'edit', 'pwsh', 'read', 'grep'])
  const sections = []
  const commands = []
  const restrictions = []
  const requestHooks = []
  const guards = []

  const agent = {
    session: { snapshotEvents: () => events },
    ctx: {
      tools: {
        restrict(filter) {
          const record = { deny: [...(filter.deny ?? [])], disposed: false }
          restrictions.push(record)
          return () => {
            record.disposed = true
          }
        },
        guard(fn) {
          guards.push(fn)
          return () => {}
        },
      },
      on(event, handler) {
        if (event === 'agent/request') requestHooks.push(handler)
        return () => {}
      },
    },
  }

  /** The session log every fold reads; tests push onto it. */
  const events = []

  const ctx = {
    logger: { warn() {} },
    agents: { list: () => [agent] },
    tools: {
      view() {
        return { visible: new Set(restrictable), knownNames: restrictable, restrictableNames: restrictable }
      },
    },
    on() {
      return () => {}
    },
    effect() {
      return () => {}
    },
    systemPrompt: {
      section(definition) {
        sections.push(definition)
        return () => {}
      },
    },
    inject(deps, register) {
      if (deps.includes('commands')) {
        ctx.__commands = {
          register(definition) {
            commands.push(definition)
            return () => {}
          },
        }
        register({ commands: ctx.__commands })
        return
      }
      if (deps.includes('sessionProjections')) {
        ctx.__projections = {
          register(definition) {
            ctx.__projection = definition
            return () => {}
          },
        }
        register({ sessionProjections: ctx.__projections })
      }
    },
  }

  return { ctx, agent, events, sections, commands, restrictions, requestHooks, guards }
}

/** Append a committed `/mode <arg>` to a log. */
function commit(events, commandId, args, kind = 'success') {
  events.push({ type: 'command/run', data: { commandId, name: 'mode', args } })
  events.push({ type: 'command/done', data: { commandId, kind } })
}

test('the config keeps the switch on by default', () => {
  const parsed = Config({})
  assert.equal(parsed.defaultEnabled, true)
  assert.equal(parsed.defaultMode, 'task')
})

test('switching off lifts the mask and clears the deny set that the guard reads', () => {
  const { ctx, agent, events, commands, restrictions, guards } = createComposition()
  apply(ctx, {})
  const command = commands[0]

  // A review mode installs the mask.
  command.handler({ agent, commandId: 'c1', rawInput: 'discussion' })
  assert.equal(restrictions.length, 1)
  const first = restrictions[0]
  assert.equal(first.disposed, false)
  assert.ok(first.deny.includes('write'), 'the mask denies a mutating tool')

  // The guard denies while the mask is on...
  const guard = guards[0]
  assert.match(guard({ name: 'write' }), /讨论模式/)

  // ...and must stop denying the moment the plugin is switched off. `denied`
  // is captured by the guard closure, so a stale set would keep a write denied
  // even though the mask itself is gone.
  command.handler({ agent, commandId: 'c2', rawInput: 'off' })
  assert.equal(first.disposed, true, 'the restriction disposer ran')
  assert.equal(guard({ name: 'write' }), undefined, 'the guard no longer denies')
  assert.equal(guard({ name: 'pwsh' }), undefined, 'nor any other tool')

  // Switching back on re-installs it, because the mode was never forgotten.
  command.handler({ agent, commandId: 'c3', rawInput: 'on' })
  assert.equal(restrictions.length, 2)
  assert.equal(restrictions[1].disposed, false)
  assert.match(guard({ name: 'write' }), /讨论模式/, 'still the same mode')
})

test('the prompt section is empty while switched off, and names the mode while on', () => {
  const { ctx, agent, events, commands, sections } = createComposition()
  apply(ctx, {})
  const section = sections[0]
  assert.equal(section.order, 520)

  const read = () => section.text({ agent })

  // The default mode is task, so the section carries the task prompt.
  assert.match(read(), /任务模式/)
  commands[0].handler({ agent, commandId: 'c1', rawInput: 'discussion' })
  assert.match(read(), /讨论模式/)

  commands[0].handler({ agent, commandId: 'c2', rawInput: 'off' })
  assert.equal(read(), '', 'an empty section is dropped from the assembled prompt')

  // A deployment-level assembly carries no agent and stays silent regardless.
  commands[0].handler({ agent, commandId: 'c3', rawInput: 'on' })
  assert.match(read(), /讨论模式/)
  assert.equal(section.text({}), '')
})

test('switching off releases the temperature override', async () => {
  const { ctx, agent, commands, requestHooks } = createComposition()
  apply(ctx, {})
  assert.equal(requestHooks.length, 1)
  const request = requestHooks[0]

  // Discussion forces 0.7 through.
  commands[0].handler({ agent, commandId: 'c1', rawInput: 'discussion' })
  assert.equal((await request({}, async () => ({ temperature: 1 }))).temperature, 0.7)

  // Off means completely transparent: the inherited value survives.
  commands[0].handler({ agent, commandId: 'c2', rawInput: 'off' })
  assert.equal((await request({}, async () => ({ temperature: 1 }))).temperature, 1)

  // Adversarial, then on again, restores its own value.
  commands[0].handler({ agent, commandId: 'c3', rawInput: 'adversarial' })
  assert.equal((await request({}, async () => ({ temperature: 1 }))).temperature, 0.2)
})

test('a failing restrict() is contained, and the guard still denies', () => {
  const { ctx, agent, commands, sections, restrictions, guards } = createComposition()
  apply(ctx, {})
  const command = commands[0]
  const guard = guards[0]

  // `restrict()` failing must never take the plugin down: `syncRestriction`
  // logs and moves on, and the guard — which is the runtime backstop — keeps
  // denying the tools the mode forbids.
  const original = agent.ctx.tools.restrict
  const warnings = []
  ctx.logger.warn = (...args) => warnings.push(args)
  agent.ctx.tools.restrict = () => {
    throw new Error('boom')
  }

  // The command still succeeds: the mode is set, only the mask is unavailable.
  const result = command.handler({ agent, commandId: 'c1', rawInput: 'discussion' })
  assert.equal(result.kind, 'success')
  assert.equal(warnings.length, 1, 'the failure was reported, not swallowed silently')
  assert.equal(sections[0].text({ agent }).includes('讨论模式'), true, 'the prompt still applies')
  assert.match(guard({ name: 'write' }), /讨论模式/, 'and the guard still refuses the tool')

  // A switch that cannot re-install the mask still changes the state.
  agent.ctx.tools.restrict = original
  command.handler({ agent, commandId: 'c2', rawInput: 'task' })
  assert.equal(guard({ name: 'write' }), undefined, 'task mode lifts the guard')
  assert.equal(restrictions.length, 0, 'the mask never installed, so there was none to lift')
})

test('the projection folds the toggle independently of the mode', () => {
  const { ctx, events } = createComposition()
  apply(ctx, {})
  const projection = ctx.__projection
  assert.equal(projection.key, 'three-modes')
  assert.equal(projection.stateVersion, 1, 'no bump: a cached row stays reusable')

  let state = projection.init({}, 0)
  assert.deepEqual({ mode: state.mode, enabled: state.enabled }, { mode: 'task', enabled: true })

  const feed = (event) => {
    state = projection.apply(state, event)
    return projection.wire.view(state)
  }

  assert.deepEqual(feed({ type: 'command/run', data: { commandId: 'c1', name: 'mode', args: 'discussion' } }), {
    mode: 'task',
    enabled: true,
    pending: 'discussion',
  })
  assert.deepEqual(feed({ type: 'command/done', data: { commandId: 'c1', kind: 'success' } }), {
    mode: 'discussion',
    enabled: true,
  })

  // Off is echoed as a pending toggle before the log commits it.
  assert.deepEqual(feed({ type: 'command/run', data: { commandId: 'c2', name: 'mode', args: 'off' } }), {
    mode: 'discussion',
    enabled: true,
    pendingEnabled: false,
  })
  assert.deepEqual(feed({ type: 'command/done', data: { commandId: 'c2', kind: 'success' } }), {
    mode: 'discussion',
    enabled: false,
  })

  // The mode still changes while the plugin is off — it is remembered, not lost.
  feed({ type: 'command/run', data: { commandId: 'c3', name: 'mode', args: 'task' } })
  assert.deepEqual(feed({ type: 'command/done', data: { commandId: 'c3', kind: 'success' } }), {
    mode: 'task',
    enabled: false,
  })

  // A rejected toggle changes nothing.
  feed({ type: 'command/run', data: { commandId: 'c4', name: 'mode', args: 'on' } })
  assert.deepEqual(feed({ type: 'command/done', data: { commandId: 'c4', kind: 'error' } }), {
    mode: 'task',
    enabled: false,
  })

  // A cached row written before the switch existed has no `enabled` key.
  assert.equal(projection.stateSchema.parse({ mode: 'task', attempts: [] }).enabled, true)
})

test('an unrelated command is not folded at all', () => {
  const { ctx } = createComposition()
  apply(ctx, {})
  const projection = ctx.__projection
  const state = projection.init({}, 0)
  const same = projection.apply(state, {
    type: 'command/run',
    data: { commandId: 'c1', name: 'autonomy', args: 'off' },
  })
  assert.equal(same, state, 'another plugin’s /off is untouched')
})
