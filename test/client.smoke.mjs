/**
 * Local smoke test for the client half.
 *
 * It loads `lib/client.cjs` the way the browser module loader does — a
 * `window.__ModuleLoader__.load({ id, factory })` registration — with a stub
 * React, a stub DOM, and a stub plugin context, then drives the segmented
 * control and its on/off switch: render, click, failure path, the disabled
 * presentation, and the registration the slot system receives.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../lib/client.cjs', import.meta.url), 'utf8')

/** Minimal hook runtime: one render at a time, effects flushed immediately. */
function createReactStub() {
  const states = []
  let cursor = 0
  const refs = []
  const cleanups = []
  const effectQueue = []

  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children },
    }),
    useState(initial) {
      const index = cursor++
      if (!(index in states)) states[index] = initial
      return [
        states[index],
        (next) => {
          states[index] = typeof next === 'function' ? next(states[index]) : next
        },
      ]
    },
    useRef(initial) {
      const index = cursor++
      refs[index] ??= { current: initial }
      return refs[index]
    },
    useEffect(fn) {
      effectQueue.push(fn)
    },
    /** Reset the hook cursor for one render pass and flush queued effects. */
    __render(reset = {}) {
      cursor = 0
      if (reset.states) states.length = 0
      if (reset.refs) refs.length = 0
      for (const fn of effectQueue.splice(0)) cleanups.push(fn())
    },
    /** Rewind the hook cursor so the next Component call is a fresh render. */
    __begin() {
      cursor = 0
    },
    /** Drop every retained hook slot; use before the first render of a scenario. */
    __reset() {
      states.length = 0
      refs.length = 0
      effectQueue.length = 0
      for (const cleanup of cleanups.splice(0)) cleanup?.()
    },
    __flushCleanups() {
      for (const cleanup of cleanups.splice(0)) cleanup?.()
    },
  }
  return React
}

/** A tiny DOM good enough for the stylesheet registration. */
function createDom() {
  const head = { children: [] }
  const document = {
    head: {
      appendChild(tag) {
        head.children.push(tag)
        return tag
      },
    },
    createElement: (tag) => ({ tag, dataset: {}, textContent: '' }),
    querySelector(selector) {
      const match = /data-plugin-css="(.*)"/.exec(selector)
      if (match === null) return null
      return head.children.find((tag) => tag.dataset.pluginCss === match[1]) ?? null
    },
  }
  return { document, head }
}

/** Instantiate the plugin exactly as the loader would. */
function loadPlugin() {
  const React = createReactStub()
  const { document, head } = createDom()
  let registration
  const window = {
    __ModuleLoader__: {
      load(input) {
        registration = input
      },
    },
  }
  const sandbox = { window, document, console }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.cjs' })

  assert.equal(registration.id, 'dsh-three-modes')
  const module = registration.factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require: ${id}`)
  })
  return { module, React, head }
}

/** Walk the rendered tree and collect every element, resolving function components. */
function walk(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out)
    return out
  }
  // The stub renderer does not descend into function components, so do it here:
  // the glyphs are components and their SVG has to be observable.
  if (typeof node.type === 'function') {
    walk(node.type(node.props), out)
    return out
  }
  out.push(node)
  walk(node.props.children, out)
  return out
}

/** Collect the rendered text of a node. */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  return textOf(node.props.children)
}

/** The mode buttons only — the switch is a button too, so filter it out. */
function modeButtons(nodes) {
  return nodes.filter((node) => node.type === 'button' && node.props.role !== 'switch')
}

// ---- registration -----------------------------------------------------------

const { module, React, head } = loadPlugin()
assert.equal(typeof module.apply, 'function')
assert.deepEqual(Array.from(module.inject), ['slots', 'remote', 'remote.commands', 'locale'])

// The stylesheet is installed once, keyed so a second load is a no-op.
assert.equal(head.children.length, 1)
assert.equal(head.children[0].dataset.plugin, 'dsh-three-modes')
const css = head.children[0].textContent
assert.match(css, /\.tm-seg/)
assert.match(css, /aria-pressed/)
// The control adopts the native chip geometry instead of a pill.
assert.match(css, /border-radius:var\(--dsw-radius-sm\)/)
assert.doesNotMatch(css, /border-radius:999px/)
// The switch keeps the primitive's contract.
assert.match(css, /\.tm-track/)
assert.match(css, /aria-checked="true"/)

// ---- apply: dictionary and slot registration --------------------------------

const dictionaries = []
const slots = []
const calls = []
const replies = []
const ctx = {
  effect(fn) {
    fn()
    return () => {}
  },
  locale: {
    register(ns, dicts) {
      dictionaries.push({ ns, dicts })
      return () => {}
    },
  },
  slots: {
    inject(key, register) {
      assert.equal(key, 'conversation.input.left')
      register()
    },
    register(definition, Component) {
      slots.push({ definition, Component })
      return () => {}
    },
  },
  remote: {
    commands: {
      async execute(sessionId, line, attachments) {
        calls.push({ sessionId, line, attachments })
        const next = replies.shift()
        if (next instanceof Error) throw next
        return next
      },
    },
  },
}
module.apply(ctx)

assert.equal(dictionaries.length, 1)
assert.equal(dictionaries[0].ns, 'three-modes')
assert.deepEqual(Object.keys(dictionaries[0].dicts).sort(), ['en', 'zh'])
// Both languages must define the same keys, or one locale renders raw keys.
assert.deepEqual(Object.keys(dictionaries[0].dicts.zh).sort(), Object.keys(dictionaries[0].dicts.en).sort())

assert.equal(slots.length, 1)
const slot = slots[0]
assert.equal(slot.definition.name, 'conversation.input.left')
assert.equal(slot.definition.id, 'three-modes')
assert.equal(slot.definition.order, 10)
assert.equal(slot.definition.locale, 'three-modes')

const injected = slot.definition.inject('session-1')
assert.equal(typeof injected.runMode, 'function')

// ---- runMode maps a remote reply to a failure string ------------------------

replies.push({ ok: true, value: { commandId: 'c1', result: { kind: 'success', text: 'ok' } } })
assert.equal(await injected.runMode('task'), null)
assert.equal(calls.at(-1).sessionId, 'session-1')
assert.equal(calls.at(-1).line, '/mode task')
assert.equal(calls.at(-1).attachments.length, 0)

// The switch rides the same command; only the argument differs.
replies.push({ ok: true, value: { commandId: 'c2', result: { kind: 'success', text: 'ok' } } })
assert.equal(await injected.runMode('off'), null)
assert.equal(calls.at(-1).line, '/mode off')

replies.push({ ok: false, error: { message: 'boom', code: 'E_NOPE' } })
assert.equal(await injected.runMode('task'), 'boom (E_NOPE)')

replies.push({ ok: true, value: undefined })
assert.equal(await injected.runMode('task'), 'unknown command: /mode')

replies.push({ ok: true, value: { commandId: 'c3', result: { kind: 'error', text: '用法：/mode' } } })
assert.equal(await injected.runMode('task'), '用法：/mode')

// ---- render ----------------------------------------------------------------

/** Render one pass with a fresh hook cursor; `reset` also clears retained state. */
function render(props, reset = false) {
  if (reset) React.__reset()
  React.__begin()
  return slot.Component(props)
}

const t = (key) => dictionaries[0].dicts.zh[key] ?? key
const projection = { mode: 'task', enabled: true }
const props = { useProjection: () => projection, runMode: injected.runMode, sessionId: 'session-1', t }
const nodes = walk(render(props, true))

const buttons = modeButtons(nodes)
assert.equal(buttons.length, 3, 'three modes')
assert.deepEqual(
  buttons.map((button) => button.props['aria-pressed']),
  [false, false, true],
  'the host-folded mode is the pressed one',
)
assert.deepEqual(
  buttons.map((button) => textOf(button)),
  ['讨论', '对抗', '任务'],
  'glyphs are decorative: the label alone is the accessible text',
)
assert.equal(buttons[2].props.title.startsWith('任务模式'), true)
assert.equal(buttons[0].props['aria-disabled'], undefined)

// Every glyph is an inline 14px outline SVG — not an emoji — and each mode
// draws a distinct shape so the three stay distinguishable without colour.
const glyphs = nodes.filter((node) => node.type === 'svg')
assert.equal(glyphs.length, 3, 'one svg glyph per mode')
for (const glyph of glyphs) {
  assert.equal(glyph.props.viewBox, '0 0 16 16')
  assert.equal(glyph.props.stroke, 'currentColor')
  assert.equal(glyph.props.strokeWidth, 1.5)
  assert.equal(glyph.props['aria-hidden'], true)
}
assert.doesNotMatch(textOf(render(props)), /[\u{1F300}-\u{1FAFF}\u2694]/u, 'no emoji survives')

// ---- the switch ------------------------------------------------------------

const switchNode = walk(render(props, true)).find((node) => node.props.role === 'switch')
assert.ok(switchNode, 'the control carries a switch')
assert.equal(switchNode.props['aria-checked'], true, 'on by default')
assert.equal(switchNode.props.className, 'tm-switch')
assert.equal(switchNode.props.title.startsWith('开关已打开'), true)

// A stopped plugin still shows the three modes, greyed and non-interactive.
const offRender = walk(render({ ...props, useProjection: () => ({ mode: 'task', enabled: false }) }, true))
const offSwitch = offRender.find((node) => node.props.role === 'switch')
assert.equal(offSwitch.props['aria-checked'], false)
assert.equal(offSwitch.props.title.startsWith('开关已关闭'), true)
const offButtons = modeButtons(offRender)
assert.equal(offButtons.length, 3, 'the modes stay visible when switched off')
assert.deepEqual(
  offButtons.map((button) => button.props['aria-disabled']),
  [true, true, true],
  'all three are greyed out',
)
assert.deepEqual(
  offButtons.map((button) => button.props.tabIndex),
  [-1, -1, -1],
  'and taken out of the tab order',
)
// The pressed mode must not keep its selected styling while disabled.
assert.equal(offButtons[2].props['aria-pressed'], true)

// A cached projection from before the switch existed has no `enabled` field.
const legacy = modeButtons(walk(render({ ...props, useProjection: () => ({ mode: 'discussion' }) }, true)))
assert.equal(legacy[0].props['aria-disabled'], undefined, 'a legacy row defaults to enabled')

// A pending switch is shown immediately, before the log commits.
const pendingButtons = modeButtons(
  walk(render({ ...props, useProjection: () => ({ mode: 'task', enabled: true, pending: 'discussion' }) }, true)),
)
assert.deepEqual(
  pendingButtons.map((button) => button.props['aria-pressed']),
  [true, false, false],
)

// ... and so is a pending toggle.
const pendingToggle = walk(
  render({ ...props, useProjection: () => ({ mode: 'task', enabled: true, pendingEnabled: false }) }, true),
).find((node) => node.props.role === 'switch')
assert.equal(pendingToggle.props['aria-checked'], false, 'the optimistic value wins')

// Without a projection the control renders nothing rather than guessing.
assert.equal(render({ ...props, useProjection: () => undefined }), null)

// An untranslated context still renders (the guard is for early mounts).
const bare = modeButtons(
  walk(render({ useProjection: () => projection, runMode: injected.runMode, sessionId: 's' }, true)),
)
assert.equal(bare.length, 3)
assert.equal(textOf(bare[0]), 'discussion')
assert.equal(
  walk(render({ useProjection: () => projection, runMode: injected.runMode, sessionId: 's' }, true)).find(
    (node) => node.props.role === 'switch',
  ).props['aria-label'],
  'Enable three modes',
)

// ---- clicking --------------------------------------------------------------

// A disabled mode ignores the click: `aria-disabled` is presentational, so the
// handler itself has to refuse, or Enter on a focused button would still fire.
let quiet = walk(render({ ...props, useProjection: () => ({ mode: 'task', enabled: false }) }, true))
const before = calls.length
modeButtons(quiet)[0].props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(calls.length, before, 'a switched-off control sends no command')

replies.push({ ok: false, error: { message: 'nope', code: 'E_NO' } })
const clickable = modeButtons(walk(render(props, true)))
clickable[0].props.onClick()
// The optimistic selection renders before the reply lands.
const optimistic = modeButtons(walk(render(props)))
assert.deepEqual(
  optimistic.map((button) => button.props['aria-pressed']),
  [true, false, false],
)
assert.equal(calls.at(-1).line, '/mode discussion')

// The switch is locked out too while a mode switch is in flight.
const lockedSwitch = walk(render(props)).find((node) => node.props.role === 'switch')
const whileBusy = calls.length
lockedSwitch.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(calls.length, whileBusy, 'no second command while one is in flight')

// Let the promise settle, then re-render to observe the recorded failure.
await new Promise((resolve) => setTimeout(resolve, 0))
const afterFailure = walk(render(props))
const status = afterFailure.find((node) => node.props.role === 'status')
assert.ok(status, 'a failed switch reports status')
assert.equal(status.props.title, 'nope (E_NO)')
assert.equal(textOf(status), '切换失败')

// ---- the switch actually toggles -------------------------------------------

replies.push({ ok: true, value: { commandId: 'c9', result: { kind: 'success', text: 'ok' } } })
const toggleTarget = walk(render(props, true)).find((node) => node.props.role === 'switch')
toggleTarget.props.onClick()
assert.equal(calls.at(-1).line, '/mode off', 'an on-switch sends off')
// Optimistically checked-off before the host answers.
const toggling = walk(render(props)).find((node) => node.props.role === 'switch')
assert.equal(toggling.props['aria-checked'], false)
await new Promise((resolve) => setTimeout(resolve, 0))

console.log('smoke: all client-half assertions passed')
