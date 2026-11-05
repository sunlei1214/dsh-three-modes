/**
 * Mode vocabulary and the log fold that makes a mode durable.
 *
 * This module has no imports on purpose: the host half composes it with the
 * registry, the prompt, and the tool mask, while tests and tooling can fold a
 * recorded session log with nothing but Node.
 *
 * @module dsh-three-modes/modes
 */

/** The three modes, in control-bar order. */
export const MODES = ['discussion', 'adversarial', 'task']

/** The two arguments that switch the whole plugin on or off. */
export const TOGGLES = ['on', 'off']

/** The slash command that selects a mode or toggles the plugin: `/mode`. */
export const COMMAND = 'mode'

/** Loader entry id, slot id, and projection key: one name for the whole plugin. */
export const PLUGIN = 'three-modes'

/**
 * Whether a raw string names a mode.
 * @param value - candidate text.
 * @returns whether it is one of {@link MODES}.
 */
export function isMode(value) {
  return MODES.includes(value)
}

/**
 * Whether a raw string is the `on` / `off` toggle.
 * @param value - candidate text.
 * @returns whether it is one of {@link TOGGLES}.
 */
export function isToggle(value) {
  return TOGGLES.includes(value)
}

/**
 * The single argument of a `/mode` invocation, normalized, or `undefined`.
 * @param event - one session log event.
 * @returns the lower-cased argument, or `undefined` for any other event.
 */
function commandArgument(event) {
  if (event?.type !== 'command/run') return undefined
  const data = event.data
  if (data?.name !== COMMAND) return undefined
  return (data.args ?? '').trim().toLowerCase()
}

/**
 * The mode one log event selects, or `undefined` when it selects nothing.
 *
 * Only a `/mode <name>` invocation counts. `/mode` alone, `/mode bogus`,
 * `/mode on`, and every other command are all admissions the executor logs but
 * that select no mode — the handler rejects the first two, the toggle is read
 * by {@link commandEnabled}, and the fold ignores them here.
 * @param event - one session log event.
 * @returns the selected mode, or `undefined`.
 */
export function commandMode(event) {
  const raw = commandArgument(event)
  return isMode(raw) ? raw : undefined
}

/**
 * The enablement one log event selects, or `undefined` when it selects none.
 * @param event - one session log event.
 * @returns `true` for `/mode on`, `false` for `/mode off`, else `undefined`.
 */
export function commandEnabled(event) {
  const raw = commandArgument(event)
  if (raw === 'on') return true
  if (raw === 'off') return false
  return undefined
}

/**
 * Fold a complete session log into the last value a successfully committed
 * command selected.
 *
 * A `command/run` only *proposes* a value; the paired `command/done` commits
 * it, and only when `kind === 'success'`. That pairing is what keeps a rejected
 * switch (bad name, thrown handler, aborted request) from silently changing the
 * value, and it is why the value survives a reload: the same events replay.
 *
 * @param events - the session's event snapshot, in log order.
 * @param fallback - value used before the first successful command.
 * @param read - extracts this fold's candidate value from one event.
 * @returns the folded value.
 */
function foldSelection(events, fallback, read) {
  let value = fallback
  const attempts = new Map()
  for (const event of events) {
    if (event?.type === 'command/run') {
      const candidate = read(event)
      if (candidate !== undefined) attempts.set(event.data.commandId, candidate)
      continue
    }
    if (event?.type !== 'command/done') continue
    const candidate = attempts.get(event.data.commandId)
    if (candidate === undefined) continue
    attempts.delete(event.data.commandId)
    if (event.data.kind === 'success') value = candidate
  }
  return value
}

/**
 * Fold a complete session log into its effective durable mode.
 * @param events - the session's event snapshot, in log order.
 * @param fallback - mode used before the first successful `/mode`.
 * @returns the folded mode.
 */
export function foldThreeModesMode(events, fallback = 'task') {
  return foldSelection(events, fallback, commandMode)
}

/**
 * Fold a complete session log into whether the plugin is switched on.
 * @param events - the session's event snapshot, in log order.
 * @param fallback - state used before the first successful `/mode on|off`.
 * @returns the folded enablement.
 */
export function foldThreeModesEnabled(events, fallback = true) {
  return foldSelection(events, fallback, commandEnabled)
}

/**
 * Read a complete event snapshot across the rc and released Session APIs.
 * @param session - the session whose log is read.
 * @returns the event array.
 */
export function sessionEvents(session) {
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
  return session.events ?? []
}
