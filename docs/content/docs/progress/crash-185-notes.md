# React #185 渲染循环排查记录

合成面板时间线拖动时崩溃，界面显示「界面出错了」。仅**生产构建**（打包版）复现，
开发版（`tauri dev`）与浏览器版都不复现。此文档记录已确认的事实与已排除的方向，
供后续继续排查时直接接手。

## 现象

- 报错固定为 `Minified React error #185`，崩溃页「崩溃前的控制台输出」里能看到 React 原话。
- 绑定在合成面板拖动上：拖动片段换顺序、拖片段两端改入点/出点都会触发；普通操作不触发。
- 触发后由全局错误边界 `web/src/components/layout/app-error-boundary.tsx` 接管，画布与项目文件不受影响。

## 已确认的事实

1. **React 原话**（取证版错误边界从控制台捞出来的）：
   > Maximum update depth exceeded. This can happen when a component repeatedly calls setState
   > inside componentWillUpdate or componentDidUpdate. … The above error occurred in the `<Portal>` component.

   这是 React 的**生命周期变体**报错。若是 `useEffect` 引起的，React 会说
   `calls setState inside useEffect`，措辞不同。**因此应优先查类组件 / 布局投影这类生命周期写入。**

2. **组件栈从头到尾没有变过**（多次崩溃、换了多个修复包都一致）：
   ```
   Portal → DialogWrap → NoFormStyle → NoCompactStyle → ContextIsolator
         → Modal$1 → CanvasDirectorDialog → section → main → MGCanvasProjectPage
         → CanvasPage → RenderedRoute → Outlet → AppErrorBoundary → UserLayout → …
   ```
   即崩溃始终发生在 **antd Modal 的 Portal** 内，且**渲染链一直经过 `CanvasDirectorDialog`**
   （`web/src/components/canvas/canvas-director-dialog.tsx`）。注意：弹窗关闭时 React 仍会渲染
   `Modal` 组件并执行其中 hooks，这条链一直存在。

3. **整个包里只有两处 `componentDidUpdate`**（搜索 `componentDidUpdate` 得到，React 自身除外）：
   - `rc-tree` 的 `NodeList`：`componentDidUpdate → onUpdated → setState({ activeKey })`
   - `motion`（framer-motion）的 `MeasureLayout`：`projection.root.didUpdate()` +
     `microtask.postRender(() => safeToRemove())`

4. **包里 `Portal` 的全部实现只有两处 setState**，且都已验证在当前用法下是稳定的：
   - `useEffect(() => { if (autoDestroy || open) setShouldRender(open) }, [open, autoDestroy])`
   - 一个**没有依赖数组**的 effect：`setInnerContainer(() => getPortalContainer(getContainer) ?? null)`
     —— 只有 `getContainer()` 返回值变化才会真的写状态；已用固定返回 `document.body` 的容器验证过，仍然崩溃。

## 已排除的方向（都改过、都没解决）

| 方向 | 结论 |
|---|---|
| 合成面板拖动的状态写入本身 | 已加 no-op 守卫，非根因 |
| 换顺序时重置拖动基准导致来回震荡 | 已修（推进 ±24px），非根因 |
| FFmpeg 探测反复 setState | 已加同值守卫，已证实不是 |
| `ModelScriptEditor` 每次渲染重建 CodeMirror 扩展 | 已修，仍崩 |
| `useVersionCheck` 首次检查反复重跑 | 已修，仍崩 |
| 版本更新弹窗 / 顶栏快捷键弹窗常驻渲染 | 已改为只在 open 时渲染，崩溃只是转移到下一个弹窗 |
| `ConfigProvider` 的 `getPopupContainer` | 已固定为模块级稳定函数，仍崩 |
| `CanvasDirectorDialog` 的 `getContainer` | 已固定为 `() => document.body`，仍崩 |
| 侧栏 `layoutId` 共享布局动画 | 已移除；侧栏整体改用 `@/lib/motion-static` 静态替身，仍崩 |

## 下一步建议（按顺序）

1. **把拖动改成「松手才提交」**：拖动过程中只用本地预览状态，`pointerup` 时一次性写入画布状态。
   理由是崩溃需要每秒几十次的连续重渲染才会点燃，把写入从每帧一次降到全程一次，
   既保留功能又拆掉点火条件。这是业界剪辑软件的常规做法。
2. 若仍崩，**删除拖拽交互**（拖动排序 + 拖两端裁剪），改为输入框精确设置秒数，
   保留时间线显示、播放预览与导出。
3. 若还想继续深挖：读 `canvas-director-dialog.tsx` 完整的 JSX 上下文，
   确认该 `Modal` 所处的表达式层级（上一轮曾因未读全文而把 JSX 改坏），
   再考虑关闭时不渲染整个 `Modal`。

## 诊断能力（保留，别删）

- `web/src/components/layout/app-error-boundary.tsx`：全局错误边界，并且**拦截 console 的报错/警告**
  显示在崩溃页上。生产包没有 DevTools（F12 无效），这是唯一能看到 React 原话的入口。
- 排查期间在 `web/vite.config.ts` 里有三条诊断配置（未压缩、sourcemap、
  `process.env.NODE_ENV=development`），定案后应改回；未压缩会让包体积变大。
- 打包后可以用 `Select-String` 直接搜构建产物（`web/dist/assets/app-*.js`）
  定位栈里的行号，例如搜索 `componentDidUpdate`、`cm-scroller` 等特征字符串，
  能快速判断某个组件属于哪个库。
