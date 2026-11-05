# dsh-three-modes

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的三模式切换插件：在**同一个会话**里，一键切换「讨论 / 对抗 / 任务」三种工作状态。

不用新建会话、不丢上下文。切换的瞬间，系统提示词、工具权限、采样温度三样东西一起换掉。

```
[ 讨论 | 对抗 | 任务 ]  |  ( ●)
```

最右边那个小开关是总闸：关掉之后插件完全静默，不注入任何提示词，并解除全部工具限制，和没装一样。

控件就长在输入框下方那一排控制条里，夹在【权限审查】和【模型选择】之间。

---

## 它解决什么问题

和一个通用 agent 对话，最别扭的地方是：**它不知道你现在想干什么**。

- 你想先聊清楚方案，它已经开始改文件了；
- 你让它挑毛病，它反过来夸你方案写得好；
- 方案终于定了，它还在追问"要不要再确认一下"。

本质上这是同一个模型在三种角色之间反复横跳。`dsh-three-modes` 的做法很直接：把"现在该扮演谁"变成一个显式的、可切换的状态，而不是靠你在提示词里反复叮嘱。

| 模式 | 模型被要求做的事 | 工具 | 温度 |
| --- | --- | --- | --- |
| 讨论 | 当架构师，梳理需求、完善方案，多提问，不急着出代码 | 全部禁用 | `0.7` |
| 对抗 | 当最严苛的红队审查员，专找逻辑漏洞、边界条件、性能瓶颈、安全风险 | 全部禁用 | `0.2` |
| 任务 | 停止讨论，按最终方案直接调工具干活 | 全部放开 | 继承当前值 |

前两种模式**物理上**改不了文件、跑不了命令——不是"请你不要"，是工具真的不在那儿。

---

## 安装

先克隆仓库：

```bash
git clone https://github.com/sunlei1214/dsh-three-modes.git
```

插件以 profile bundle 的方式挂载。以 `desktop` profile 为例：

```bash
dsh plugin --profile desktop add "file:D:/path/to/dsh-three-modes"
```

然后在 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 里追加包名：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-three-modes"
      ]
    }
  }
}
```

重启 DSH，输入框下方就会多出那三个按钮。

> **注意**：插件目录必须是 profile 的 `node_modules` 下的**真实目录拷贝**，不能是符号链接/junction。DSH 解析客户端 bundle 时会校验模块 URL 最近的 `package.json` 名字，junction 会让它解析到别处而静默跳过插件。

---

## 使用

### 点按钮

三个按钮就是三种模式，当前模式会高亮。点击即刻切换，无需确认。

### 总开关

控件最右边的小开关控制整个插件：

- **打开**：三种模式正常生效，恢复到上次选中的模式。
- **关闭**：插件完全静默——系统提示词里不再注入任何模式文字，工具限制全部解除，温度覆盖也停用。效果等同于没装这个插件。

关闭时三个模式按钮会一起变灰、不可点击，但仍然显示在那里，随时可以重新打开。

开关状态同样是持久的，和模式一起存在会话里。**开关只管"插件是否出声"，不清除你选的模式**——关掉再打开，回到的还是原来那个模式。

### 斜杠命令

```
/mode            查看当前模式
/mode discussion 切到讨论模式
/mode adversarial 切到对抗模式
/mode task       切到任务模式
/mode off        关闭插件（等同点那个开关）
/mode on         重新打开
```

命令和按钮读写同一份状态，混着用没问题。

> `/mode off` 是公开命令，不是隐藏入口——UI 上没有额外按钮，但命令本身能用，也便于脚本化。

### 状态是持久的

模式和开关状态都存在会话事件流里（`/mode` 命令的 `command/run` + `command/done`），折叠出当前值。也就是说：

- 刷新页面、重开客户端，模式和开关状态都还在；
- 会话被恢复、分叉，状态跟着走；
- 历史记录里能查到你什么时候切的模式、什么时候关的插件。

---

## 三种模式的提示词

提示词可以整套替换。默认值如下（`config` 里改，见下节）：

**讨论模式**

> 你当前处于【讨论模式】。禁止修改任何文件或执行终端命令。请作为架构师，引导我梳理需求、完善技术方案。多向我提问，不要急于给出最终代码。

**对抗模式**

> 你当前处于【对抗模式】。请作为最严苛的红队审查员/杠精，对刚才确认的方案进行毁灭性审查。专找逻辑漏洞、极端边界条件、性能瓶颈和安全风险。不要给出赞美，只指出问题并提供修改建议。

**任务模式**

> 你当前处于【任务模式】。方案已确认。请立即停止讨论，严格按照最终版方案执行任务。请直接调用工具修改文件或运行命令。

提示词以 `systemPrompt.section` 注入，`order: 520`——排在计划策略（500）之后、工具说明（1000+）之前。文本为空字符串时整个 section 隐藏，不会留一个空段落污染缓存。

---

## 配置

```ts
interface Config {
  /** 新会话的初始模式，默认 'task' */
  defaultMode: 'discussion' | 'adversarial' | 'task'
  /** 新会话的开关初始状态，默认 true */
  defaultEnabled: boolean
  /** 讨论模式提示词 */
  discussionPrompt: string
  /** 对抗模式提示词 */
  adversarialPrompt: string
  /** 任务模式提示词 */
  taskPrompt: string
  /** 讨论/对抗模式下额外禁用的工具名 */
  mutatingTools: string[]
  /** 讨论模式温度 */
  discussionTemperature: number
  /** 对抗模式温度 */
  adversarialTemperature: number
  /** 是否覆盖温度。关掉就完全不动模型参数 */
  overrideTemperature: boolean
}
```

写进 profile 的 `cordis.yml`：

```yaml
plugins:
  three-modes:
    defaultMode: discussion
    discussionTemperature: 0.7
    adversarialTemperature: 0.2
```

### 关于 `mutatingTools`

前两种模式要"只读"，就需要一份禁用清单。清单会先和 `ctx.tools.view(agent).restrictableNames` 取交集——`tools.restrict()` 遇到不认识的工具名会直接抛错，而不同版本、不同 profile 装载的工具集并不一样。

默认清单覆盖了这些会改东西的工具：

```
write  edit  str_replace_editor  pwsh  bash
terminal_open  terminal_send  terminal_signal  terminal_close
present  todo_write  goal  create_goal  update_goal
job_kill  schedule_create  schedule_update  schedule_delete
ralph  workflow  send_message  interrupt_agent  working_directory
```

`skill`、`read`、`grep`、`glob`、`web_search`、`web_fetch` 等只读工具不受影响——讨论和对抗模式下依然可以翻代码、查文档，只是不能落地。

---

## 实现要点

如果你想改它，这几个地方值得先知道。

### 宿主侧（`lib/index.js`）

**工具限制用 `restrict`，不是 `guard`。**

```js
const view = ctx.tools.view(agent)
const deny = config.mutatingTools.filter((name) => view.restrictableNames.includes(name))
const dispose = agent.ctx.tools.restrict({ deny })
```

`restrict` 需要 scoped ctx（`agent.ctx`），返回一个 disposer。切到任务模式时调用它，权限原样回来。这个限制是**单调**的——叠加在 scope 已有层级之上，松不掉别人设的限制，这点很重要。

`tools.guard` 作为运行时兜底：同步返回字符串即拒绝，拒绝会以 `Error: <reason>` 的形式呈现给模型。真正的门是 `restrict`，`guard` 负责在边界上给一句中文解释。

**温度覆盖走 `agent/request` 中间件。**

```js
agent.ctx.on('agent/request', async (_payload, next) => {
  const cfg = await next()
  return mode === 'task' ? cfg : { ...cfg, temperature: target }
})
```

关键细节：**只在模式真的不同时才改**。每次改 `temperature` 都会触发 `request/header reason: "change"`，进而打断 prompt cache。任务模式下把继承来的值原样透传，一个字节不动。

**状态存在事件流里。**

投影 `three-modes` 在 `apply` 里折叠 `command/run` 和 `command/done` 两种事件，只认 `kind === 'success'` 的完成态。模式（`/mode task`）和开关（`/mode on|off`）是同一个命令的两个参数，各自独立折叠、互不干扰，所以关掉再打开还能回到原来那个模式。

`stateVersion` 保持在 `1`，`enabled` 字段用 `z.boolean().default(true)` 兜底：开关是后加的，老会话缓存行里没有这个字段，给它默认值就能直接复用——升版本反而会让所有历史会话重折一遍日志，代价大而收益为零。

### 客户端侧（`lib/client.cjs`）

**插槽是 `conversation.input.left`。**

不是 `conversation.input.permission`（那边是单例，已被权限审查占着），也不是 `conversation.input.right`（在模型选择器后面）。`input.left` 是 list 型插槽、`replaceRisk: 'none'`，正好落在权限审查和模型选择之间。

```js
ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
  name: 'conversation.input.left',
  id: 'three-modes',
  order: 10,
}, ThreeModesControl))
```

**乐观选中。**

点击的一瞬间要立刻高亮，但状态得等事件流回写。所以显示的选中态是：

```js
const enabled = toggling ?? projection.pendingEnabled ?? projection.enabled ?? true
const shown = submitting ?? projection.pending ?? projection.mode
```

三级回退：本地刚点的 → 投影里待确认的 → 投影确认的。点下去不闪。

**关闭态用 `aria-disabled`，不是 `disabled`。**

关闭时三个模式按钮变灰，但标记是 `aria-disabled="true"` + `tabIndex={-1}`，不是原生 `disabled`。原因有两条：原生 `disabled` 的元素不可聚焦、会被读屏器整块跳过；而且它只拦鼠标，键盘激活仍然会触发 `onClick`。所以拦截写在 `choose()` 里自己判断，标记只负责呈现。

**图标是内联 SVG，不是 emoji。**

💬⚔️🚀 这类 emoji 在不同系统上字形、颜色、描边都不一致，和 DSH 全线性图标体系冲突。现在三个图标是 16×16 网格上的 `stroke-width:1.5` 线性描边 SVG，`currentColor` 取色，`aria-hidden` 隐藏——可读文本只有"讨论/对抗/任务"这三个词本身。

**开关是仿制的，不是 import 的。**

官方 `Switch` 在 `dsh-client-ui-primitives` 里，但插件规范明确禁止 `require` 它，要求把 markup/CSS/行为复制进插件、类名加自己前缀、只保留 `--dsw-alias-*` token。所以这里是一个 `role="switch"` + `aria-checked` 的按钮，里面 26×16 轨道 + 12px 滑块，`transform` 过渡 140ms。

**样式。** 用 DSH 的 CSS 变量（`--dsw-alias-label-primary`、`--dsw-alias-interactive-bg-active`、`--dsw-alias-border-l2`、`--dsw-radius-sm` 等），尺寸对齐官方 chip：高 28px、圆角 `--dsw-radius-sm`、字号 13px、字重 500。注入方式和官方插件一致，靠 `<style data-plugin-css="...">` 去重。

---

## 开发

```bash
node --check lib/index.js     # 宿主侧语法
node --check lib/client.cjs   # 客户端语法
node --test test/*.test.mjs   # 状态折叠单测 + 宿主侧集成
node test/client.smoke.mjs    # 客户端渲染冒烟（vm + stub React/DOM）
```

宿主侧测试需要 `@deepseek-ai/schemastery` 和 `zod` 可解析。本地开发时把 profile 的 `node_modules` 链进来即可：

```bash
cmd /c mklink /J node_modules "%USERPROFILE%\.dsh\profiles\desktop\node_modules"
```

仓库结构：

```
lib/
  index.js     宿主侧：工具限制、提示词注入、温度覆盖、投影、/mode 命令
  client.cjs   客户端：分段控件
  modes.js     共享常量与状态折叠（零依赖，宿主和测试都用）
locale/
  zh.json      中文文案
  en.json      英文文案
cordis.patch.yml   bundle 挂载声明
icon.svg      插件图标
test/
  modes.test.mjs    折叠逻辑单测
  host.test.mjs     宿主侧集成：三处静默、deny 集合、投影折叠
  client.smoke.mjs  渲染冒烟
```

`lib/modes.js` 没有任何 import，是宿主、客户端、测试三方共享的单一事实来源。改模式定义从这里改。

---

## 已知边界

- **只影响当前会话。** 不同会话可以处在不同模式、不同开关状态，互不干扰。
- **权限回滚依赖 disposer。** 如果 agent 在讨论模式下被销毁，`restrict` 的清理由 scope 生命期保证，不靠插件手动收尾。
- **`defaultMode` / `defaultEnabled` 只对新会话生效。** 已有会话以事件流为准。
- **温度覆盖关闭后不写任何请求头。** `overrideTemperature: false` 时插件对模型参数完全透明。
- **`/mode on|off` 是公开命令。** API 里没有"隐藏命令"的概念，所以它能被手敲出来，也能被脚本调用。它只是不在 UI 上多占一个入口。

---

## License

MIT
