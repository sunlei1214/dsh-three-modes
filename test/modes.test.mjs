import assert from 'node:assert/strict'
import test from 'node:test'

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
  isToggle,
  sessionEvents,
} from '../lib/modes.js'

/** Build one `command/run` event for `/mode`. */
function run(commandId, args, name = COMMAND) {
  return { type: 'command/run', data: { commandId, name, args, source: { kind: 'user' } } }
}

/** Build one `command/done` event. */
function done(commandId, kind = 'success') {
  return { type: 'command/done', data: { commandId, kind } }
}

test('vocabulary exposes the three modes in control-bar order', () => {
  assert.deepEqual(MODES, ['discussion', 'adversarial', 'task'])
  assert.equal(PLUGIN, 'three-modes')
  assert.equal(COMMAND, 'mode')
})

test('isMode accepts only the three names', () => {
  assert.equal(isMode('task'), true)
  assert.equal(isMode('discussion'), true)
  assert.equal(isMode('adversarial'), true)
  assert.equal(isMode('Task'), false)
  assert.equal(isMode(''), false)
  assert.equal(isMode(undefined), false)
})

test('commandMode reads a /mode invocation and normalizes case and padding', () => {
  assert.equal(commandMode(run('c1', ' task ')), 'task')
  assert.equal(commandMode(run('c1', 'ADVERSARIAL')), 'adversarial')
  assert.equal(commandMode(run('c1', 'bogus')), undefined)
  assert.equal(commandMode(run('c1', '')), undefined)
  assert.equal(commandMode(run('c1', 'task', 'autonomy')), undefined)
  assert.equal(commandMode({ type: 'command/done', data: { commandId: 'c1' } }), undefined)
  assert.equal(commandMode(undefined), undefined)
})

test('a fold with no history keeps the fallback mode', () => {
  assert.equal(foldThreeModesMode([]), 'task')
  assert.equal(foldThreeModesMode([], 'discussion'), 'discussion')
})

test('only a successful command/done commits the proposed mode', () => {
  assert.equal(foldThreeModesMode([run('c1', 'discussion'), done('c1')]), 'discussion')
  assert.equal(foldThreeModesMode([run('c1', 'discussion'), done('c1', 'error')]), 'task')
  assert.equal(foldThreeModesMode([run('c1', 'discussion')]), 'task')
})

test('an unmatched command/done never commits a mode', () => {
  assert.equal(foldThreeModesMode([done('ghost')]), 'task')
})

test('later switches win and interleaved commands do not cross-commit', () => {
  const events = [
    run('c1', 'discussion'),
    run('c2', 'adversarial'),
    done('c2'),
    done('c1', 'error'),
    run('c3', 'task'),
    done('c3'),
  ]
  assert.equal(foldThreeModesMode(events), 'task')
})

test('a replayed log folds to the same mode, which is what survives a reload', () => {
  const events = [run('c1', 'adversarial'), done('c1'), run('c2', 'discussion'), done('c2', 'error')]
  assert.equal(foldThreeModesMode(events), 'adversarial')
  assert.equal(foldThreeModesMode([...events]), 'adversarial')
})

test('sessionEvents prefers snapshotEvents and falls back to the events array', () => {
  assert.deepEqual(sessionEvents({ snapshotEvents: () => [1, 2] }), [1, 2])
  assert.deepEqual(sessionEvents({ events: [3] }), [3])
  assert.deepEqual(sessionEvents({}), [])
})

// ---- the on/off toggle ------------------------------------------------------

test('isToggle accepts only on and off', () => {
  assert.deepEqual(TOGGLES, ['on', 'off'])
  assert.equal(isToggle('on'), true)
  assert.equal(isToggle('off'), true)
  assert.equal(isToggle('task'), false)
  assert.equal(isToggle('ON'), false)
  assert.equal(isToggle(undefined), false)
})

test('commandEnabled reads /mode on and /mode off, and nothing else', () => {
  assert.equal(commandEnabled(run('c1', 'on')), true)
  assert.equal(commandEnabled(run('c1', 'on')), true)
  assert.equal(commandEnabled(run('c1', ' off ')), false)
  assert.equal(commandEnabled(run('c1', 'OFF')), false)
  assert.equal(commandEnabled(run('c1', 'task')), undefined)
  assert.equal(commandEnabled(run('c1', 'bogus')), undefined)
  assert.equal(commandEnabled(run('c1', 'on', 'autonomy')), undefined)
  assert.equal(commandEnabled({ type: 'command/done', data: { commandId: 'c1' } }), undefined)
  assert.equal(commandEnabled(undefined), undefined)
})

test('the two commands never read each other', () => {
  // `/mode on` must not be folded as a mode, and `/mode task` not as a toggle.
  assert.equal(commandMode(run('c1', 'on')), undefined)
  assert.equal(commandMode(run('c1', 'off')), undefined)
  assert.equal(commandEnabled(run('c1', 'discussion')), undefined)
  assert.equal(commandEnabled(run('c1', 'task')), undefined)
})

test('a fold with no history keeps the fallback enablement', () => {
  assert.equal(foldThreeModesEnabled([]), true)
  assert.equal(foldThreeModesEnabled([], false), false)
})

test('only a successful command/done commits the toggle', () => {
  assert.equal(foldThreeModesEnabled([run('c1', 'off'), done('c1')]), false)
  assert.equal(foldThreeModesEnabled([run('c1', 'off'), done('c1', 'error')]), true)
  assert.equal(foldThreeModesEnabled([run('c1', 'off')]), true)
  assert.equal(foldThreeModesEnabled([done('ghost')]), true)
})

test('a mode switch and a toggle fold independently over one log', () => {
  const events = [
    run('c1', 'discussion'),
    done('c1'),
    run('c2', 'off'),
    done('c2'),
    run('c3', 'adversarial'),
    done('c3'),
  ]
  // `/mode off` leaves the mode alone; `/mode adversarial` leaves the switch off.
  assert.equal(foldThreeModesMode(events), 'adversarial')
  assert.equal(foldThreeModesEnabled(events), false)

  const revived = [...events, run('c4', 'on'), done('c4')]
  assert.equal(foldThreeModesEnabled(revived), true)
  assert.equal(foldThreeModesMode(revived), 'adversarial', 'the mode survived the off/on cycle')
})

test('a rejected toggle leaves the previous state, so the switch cannot lie', () => {
  const events = [run('c1', 'off'), done('c1'), run('c2', 'on'), done('c2', 'error')]
  assert.equal(foldThreeModesEnabled(events), false)
})
