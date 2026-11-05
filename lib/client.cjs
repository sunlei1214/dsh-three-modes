window.__ModuleLoader__.load({
  id: 'dsh-three-modes',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'three-modes'

    /** Host services used by the control. */
    const inject = ['slots', 'remote', 'remote.commands', 'locale']

    const CSS_ID = 'dsh-three-modes/ThreeModesControl.css'
    const CSS = `
.tm-root{display:inline-flex;align-items:center;min-width:0;flex:none;gap:2px}
.tm-seg{display:inline-flex;align-items:center;gap:2px;box-sizing:border-box;height:28px;padding:2px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:transparent;flex:none}
.tm-btn{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 7px;border:0;border-radius:calc(var(--dsw-radius-sm) - 2px);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:500;line-height:20px;cursor:pointer;white-space:nowrap;transition:background-color .12s ease,color .12s ease}
.tm-btn:hover:not([aria-disabled="true"]){background:var(--dsw-alias-interactive-bg-hover)}
.tm-btn:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.tm-btn[aria-pressed="true"]{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}
.tm-btn[aria-disabled="true"]{color:var(--dsw-alias-label-dimmed);cursor:default}
.tm-btn[aria-disabled="true"]:hover{background:transparent}
.tm-btn[aria-disabled="true"][aria-pressed="true"]{background:transparent;color:var(--dsw-alias-label-dimmed)}
.tm-glyph{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;flex:none}
.tm-glyph svg{width:14px;height:14px;display:block}
.tm-sep{width:1px;height:16px;margin:0 1px;background:var(--dsw-alias-border-l2);flex:none}
.tm-switch{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;height:22px;padding:0 4px;border:0;border-radius:calc(var(--dsw-radius-sm) - 2px);background:transparent;cursor:pointer;flex:none}
.tm-switch:hover{background:var(--dsw-alias-interactive-bg-hover)}
.tm-switch:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.tm-track{position:relative;box-sizing:border-box;width:26px;height:16px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;transition:background-color .14s ease,border-color .14s ease}
.tm-switch[aria-checked="true"] .tm-track{background:var(--dsw-alias-interactive-bg-active);border-color:transparent}
.tm-thumb{position:absolute;top:50%;left:1px;width:12px;height:12px;margin-top:-6px;border-radius:50%;background:var(--dsw-alias-label-tertiary);transition:transform .14s ease,background-color .14s ease}
.tm-switch[aria-checked="true"] .tm-thumb{transform:translateX(10px);background:var(--dsw-alias-label-primary)}
.tm-error{margin-inline-start:6px;color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px;white-space:nowrap}
@media (max-width:860px){.tm-btn .tm-label{display:none}.tm-btn{padding:0 5px}}
`

    if (
      typeof document !== 'undefined' &&
      document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_ID) + ']') === null
    ) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-three-modes'
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /**
     * Inline glyphs, drawn to match the surrounding 14px outline icons: a
     * 1.5-unit stroke on a 16-unit grid, round caps, `currentColor` only.
     */
    const GLYPHS = {
      // Two bubbles: the speaker and the reply.
      discussion: [
        ['path', { d: 'M2.6 3.2h6.2a1.2 1.2 0 0 1 1.2 1.2v3.4a1.2 1.2 0 0 1-1.2 1.2H5.6L3.4 11V9H2.6a1.2 1.2 0 0 1-1.2-1.2V4.4a1.2 1.2 0 0 1 1.2-1.2Z' }],
        ['path', { d: 'M12.2 6h.6a1.2 1.2 0 0 1 1.2 1.2v2.6a1.2 1.2 0 0 1-1.2 1.2h-.5v1.7l-1.9-1.7h-2' }],
      ],
      // Two arrows meeting head-on.
      adversarial: [
        ['path', { d: 'M2 4.6h5.4M4.9 2.1l2.5 2.5-2.5 2.5' }],
        ['path', { d: 'M14 8.2H8.6M11.1 5.7l-2.5 2.5 2.5 2.5' }],
      ],
      // A play triangle: run it.
      task: [['path', { d: 'M4.4 2.9 13 7.6a.45.45 0 0 1 0 .8L4.4 13.1a.45.45 0 0 1-.67-.4V3.3a.45.45 0 0 1 .67-.4Z' }]],
    }

    /** Render one glyph as a 14x14 outline SVG. */
    function Glyph({ name }) {
      const shapes = GLYPHS[name] ?? []
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
        },
        shapes.map(([tag, attrs], index) => h(tag, { key: index, ...attrs })),
      )
    }

    /** Control-bar order per mode. */
    const MODES = [{ mode: 'discussion' }, { mode: 'adversarial' }, { mode: 'task' }]

    /** Read the failure text out of one remote command reply, or null on success. */
    function commandFailure(reply) {
      if (!reply?.ok) {
        return reply?.error === undefined
          ? 'command failed'
          : `${reply.error.message} (${reply.error.code})`
      }
      const value = reply.value
      if (value === undefined) return 'unknown command: /mode'
      if (value.result?.kind === 'error') return value.result.text
      return null
    }

    /**
     * Three-mode segmented control plus its on/off switch, over the host-folded
     * `three-modes` projection.
     * @param props - slot props: the projection reader, the `/mode` submitter, and localized copy.
     * @returns the control, or null while the projection is unavailable.
     */
    function ThreeModesControl({ useProjection, runMode, sessionId, t }) {
      const projection = useProjection('three-modes')
      const [submitting, setSubmitting] = React.useState(null)
      const [toggling, setToggling] = React.useState(null)
      const [error, setError] = React.useState(null)
      const alive = React.useRef(true)

      React.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      if (projection === undefined) return null

      // Local optimism first (the click is instant), then the host's own
      // pending echo once `command/run` is logged, then the committed value.
      const enabled = toggling ?? projection.pendingEnabled ?? projection.enabled ?? true
      const shown = submitting ?? projection.pending ?? projection.mode
      const busy = submitting !== null || toggling !== null

      // Both handlers return early on their own. `aria-disabled` is not a real
      // disabled state — the button keeps focus and still receives keyboard
      // activations — so the guard cannot live in the markup alone.
      const choose = (mode) => {
        if (!enabled || mode === shown || busy) return
        setSubmitting(mode)
        setError(null)
        runMode(mode).then(
          (failure) => {
            if (!alive.current) return
            setSubmitting(null)
            setError(failure ?? null)
          },
          (reason) => {
            if (!alive.current) return
            setSubmitting(null)
            setError(reason instanceof Error ? reason.message : String(reason))
          },
        )
      }

      const toggle = () => {
        if (busy) return
        const next = !enabled
        setToggling(next)
        setError(null)
        runMode(next ? 'on' : 'off').then(
          (failure) => {
            if (!alive.current) return
            setToggling(null)
            setError(failure ?? null)
          },
          (reason) => {
            if (!alive.current) return
            setToggling(null)
            setError(reason instanceof Error ? reason.message : String(reason))
          },
        )
      }

      const label = (mode) => (t === undefined ? mode : t(`mode.${mode}`))
      const title = (mode) => (t === undefined ? label(mode) : t(`mode.${mode}.title`))
      const switchLabel = t === undefined ? 'Enable three modes' : t('switch.label')
      const switchTitle = enabled
        ? t === undefined
          ? 'On'
          : t('switch.on.title')
        : t === undefined
          ? 'Off'
          : t('switch.off.title')

      return h(
        'div',
        { className: 'tm-root', 'data-three-modes': sessionId ?? '' },
        h(
          'div',
          {
            className: 'tm-seg',
            role: 'group',
            'aria-label': t === undefined ? 'Mode' : t('group'),
            'aria-busy': busy || undefined,
          },
          MODES.map(({ mode }) => {
            const active = shown === mode
            return h(
              'button',
              {
                key: mode,
                type: 'button',
                className: 'tm-btn',
                'aria-pressed': active,
                'aria-disabled': !enabled || undefined,
                tabIndex: enabled ? undefined : -1,
                title: title(mode),
                onClick: () => choose(mode),
              },
              h('span', { className: 'tm-glyph' }, h(Glyph, { name: mode })),
              h('span', { className: 'tm-label' }, label(mode)),
            )
          }),
        ),
        h('span', { className: 'tm-sep', 'aria-hidden': true }),
        h(
          'button',
          {
            type: 'button',
            className: 'tm-switch',
            role: 'switch',
            'aria-checked': enabled,
            'aria-label': switchLabel,
            title: switchTitle,
            onClick: toggle,
          },
          h('span', { className: 'tm-track' }, h('span', { className: 'tm-thumb' })),
        ),
        error === null
          ? null
          : h(
              'span',
              { className: 'tm-error', role: 'status', title: error },
              t === undefined ? 'switch failed' : t('error.switch'),
            ),
      )
    }

    const DICTIONARIES = {
      zh: {
        group: '模式',
        'mode.discussion': '讨论',
        'mode.adversarial': '对抗',
        'mode.task': '任务',
        'mode.discussion.title': '讨论模式：不改文件、不执行命令，作为架构师与你梳理需求和技术方案',
        'mode.adversarial.title': '对抗模式：不改文件、不执行命令，作为红队审查员找出逻辑漏洞、边界条件与安全风险',
        'mode.task.title': '任务模式：恢复全部工具权限，直接执行已确认的方案',
        'switch.label': '启用三种模式',
        'switch.on.title': '开关已打开：三种模式生效中。关闭后插件完全静默，不注入提示词并解除全部工具限制',
        'switch.off.title': '开关已关闭：插件完全静默。打开后恢复上次选中的模式',
        'error.switch': '切换失败',
      },
      en: {
        group: 'Mode',
        'mode.discussion': 'Discuss',
        'mode.adversarial': 'Review',
        'mode.task': 'Task',
        'mode.discussion.title': 'Discussion mode: no file edits or commands — shape the requirements and design with you',
        'mode.adversarial.title': 'Adversarial mode: no file edits or commands — red-team the plan for logic holes, edge cases, and security risk',
        'mode.task.title': 'Task mode: full tool access — execute the confirmed plan',
        'switch.label': 'Enable three modes',
        'switch.on.title': 'Switched on: the three modes are active. Switched off, the plugin is silent — no prompt section, no tool mask',
        'switch.off.title': 'Switched off: the plugin is silent. Switch it on to restore the last selected mode',
        'error.switch': 'switch failed',
      },
    }

    /** Register the segmented control in the composer tool row. */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'three-modes: dictionaries')

      ctx.slots.inject('conversation.input.left', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.left',
            id: 'three-modes',
            // The `left` list sits right after the permission and plan controls
            // inside the composer tool row, before the model picker.
            order: 10,
            locale: NS,
            inject: (sessionId) => ({
              // One entry point for both verbs: `/mode <mode>` and `/mode on|off`
              // are the same command, so the switch rides the same write path.
              runMode: async (selection) => {
                const reply = await ctx.remote.commands.execute(sessionId, `/mode ${selection}`, [])
                return commandFailure(reply)
              },
            }),
          },
          ThreeModesControl,
        ),
      )
    }

    return { apply, inject, Glyph, ThreeModesControl }
  },
})
