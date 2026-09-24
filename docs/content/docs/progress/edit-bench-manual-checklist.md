# 剪辑台「照着点」验证清单

这份清单给**独立剪辑台**（本轮新增：主时钟、吸附与导引线、拆分 / 删除 / 涟漪删除、快捷键表、撤销重做）用。

为什么需要它：这批交互**至今没有任何人在真实界面里点过**——现存的自动化只有两类，覆盖不到交互本身：

- **单元测试**（纯函数 / store）：`web/src/lib/edit/timeline.test.ts`、`timeline-edit.test.ts`、`playback-clock.test.ts`、`shortcuts.test.ts`、`history.test.ts`、`web/src/stores/use-edit-store.test.ts`、`web/src/components/canvas/canvas-composite-panel.test.tsx`（连播切换部分）。
- **产物读回**（`renderToStaticMarkup` 静态渲染后读回 HTML 断言）：`web/src/pages/editor/editor.test.tsx`、`editor-timeline-ui.test.tsx`、`send-to-editor.test.tsx`、`canvas-composite-panel.test.tsx`（标尺 / 播放头渲染部分）。

真实指针拖动、真实按键、真实播放、真实文件选择器、真实 FFmpeg，这五条路径**完全没有自动化覆盖**。

---

## 0. 前置条件与准备

| 项 | 说明 |
|---|---|
| 客户端 | **已打包安装**的桌面版（Tauri 2）。确认安装包的 `LastWriteTime` 晚于最后一次改动的源文件，否则测的是旧包。 |
| 素材 | 3～6 个 15 秒左右的 mp4（画布生成或本机视频都行），外加 1 个 mp3。 |
| 长片项目（E5 用） | 新建剪辑 → 把同一个 15 秒素材连续点 6 次「加入时间线」→ 逐段在右侧「出点」填 `15`，得到约 90 秒时间线。要几分钟就再多加几段。**只有一段素材看不出漂移**。 |
| 界面分区 | 素材区 = 左 248px；预览区 = 上中；时间线 = 下（高 196px）；属性区 = 右 304px。 |
| 记录方式 | 文末有记录表，每项填 通过 / 不通过 / 未测。 |

词表：**松手才生效** = 拖动过程中不写项目数据（只改 DOM），`pointerup` 时一次性提交。

---

## E1 时间线拖动：裁剪入出点、换序、拖播放头

| 项 | 内容 |
|---|---|
| 前置 | 时间线上有 ≥ 3 段（每段 ≥ 5 秒），当前是暂停状态。 |
| 步骤 | ① 拖**第 2 段本体**（片段条中间，光标变抓手）向右越过第 3 段中点后松手。② 拖第 2 段**左端 1.5px 手柄**（光标变左右箭头）向右约 2 秒的距离再松手。③ 拖**右端手柄**向左约 1 秒。④ 在标尺上按住左键横向拖动，松手。⑤ 按 `Space` 起播，播放中再拖一次标尺。 |
| 预期 | 拖动中：片段条跟着移动 / 变宽，片段标签上的秒数实时变化，播放中画面继续播。松手前：右侧属性区的「入点 / 出点」读数与片段顺序**都不变**；松手后才一次性提交。全程不卡顿、不出现「界面出错了」。播放头：拖动中竖线与左上角读数跟随；**播放中**松手后画面从新位置继续。 |
| 已知行为（不算失败） | **暂停时**拖播放头（含点标尺、按 `←/→`），只有读数会动，画面不会跟着刷新；按 `Space` 起播后才从新位置取帧。如果你期望暂停时也刷新画面，记为「需要改进」。 |
| 怀疑 | 拖动过程掉帧 / 逐帧写状态 → `web/src/pages/editor/components/edit-stage.tsx` 的 `handleTimelineMove`（只允许改 DOM：`style.flexGrow`、`style.transform`、`textContent`、`paintGuide`），松手提交在 `endTimelineDrag` → `commitReorder` / `updateClip`；规则见 `AGENTS.md`「画布高频交互禁止逐帧写状态」。松手后顺序没变 → `endTimelineDrag` 里的 `draggedRef.current` 判定、`editReorderIndex`（`web/src/lib/edit/timeline-edit.ts`）。裁剪值越界或夹不住 → `clampTrimValue`（edit-stage.tsx）。拖动时崩溃 → 先看错误边界页 `web/src/components/layout/app-error-boundary.tsx`，历史排查结论见 `crash-185-notes.md`。 |

## E2 吸附与竖线导引

| 项 | 内容 |
|---|---|
| 前置 | 吸附开关默认开启（时间线右上角磁铁图标为主色高亮，`aria-pressed="true"`）。 |
| 步骤 | ① **慢慢**把一段拖到与相邻片段边缘对齐处附近。② 盯着时间线看是否出现一条贯穿的竖线（主题主色，`data-edit-snap-guide`），松手后确认竖线消失。③ **快速甩动**鼠标拖同一段（明显超过 900 像素/秒）。④ **按住 `Alt`** 拖同一段。⑤ 按 `N` 关闭吸附，再重复 ①，再按 `N` 打开。⑥ 把播放头停在某处，把一段拖到播放头附近，看是否吸附到播放头。 |
| 预期 | 慢拖：在约 40 像素范围内吸住相邻片段边缘 / 播放头 / 时间网格，同时出现竖线导引；快拖：完全不吸附；按 `Alt`：临时不吸附；`N`：全局开关（Tooltip 显示「吸附已关闭：拖动不再吸附（按 N 切换）」）；吸附阈值随缩放换算（把窗口拉窄，同样的像素距离对应更少的秒数）。 |
| 怀疑 | `edit-stage.tsx` 的 `snapActive`（`Alt` 与速度判定）、`paintGuide`（导引线的 `style.left` / `opacity`）；`web/src/lib/edit/playback-clock.ts` 的 `editPointerVelocity`；`web/src/lib/edit/timeline-edit.ts` 的 `EDIT_SNAP_THRESHOLD_PX`、`EDIT_SNAP_VELOCITY_LIMIT`、`editSnapThresholdSeconds`、`collectEditSnapPoints`、`resolveEditSnap`。导引线不出来还有一种可能：吸附点被 `clampTrimValue` 夹回合法区间时**故意不画线**（见 `handleTimelineMove` 的注释）。 |

## E3 快捷键（重点：输入框里打字不被吃掉）

| 项 | 内容 |
|---|---|
| 前置 | 剪辑项目已打开，时间线 ≥ 2 段。 |
| 步骤 | ① 依次按 `Space`（播放 / 暂停）、`S`（在播放头处拆分）、`Delete`（删除）、`Shift+Delete`（涟漪删除）、`Ctrl+Z`、`Ctrl+Shift+Z`、`Ctrl+Y`、`N`、`←`/`→`（逐帧）、`Shift+←`/`Shift+→`（±1 秒）。② **重点**：把光标分别点进属性区的「入点」数字框、「音量」框、字幕文本框、顶部项目名输入框、以及「长边 / 帧率」下拉，各输入一遍中文（用输入法打「测试」）与英文，顺手按 `Space`、`S`、`Delete`、`←`/`→`。 |
| 预期 | 非输入焦点时：11 类动作全部生效；`Backspace` 与 `Delete` 等效；拆分失败时提示「播放头不在任何片段内部，先把播放头移到要切开的位置」，删除找不到目标时提示「先选中一个片段，或把播放头移到要删除的片段上」。输入框内：**字能正常打进去**，`Space` 不播放、`S` 不拆分、`Delete` 只删字符、`←/→` 在框内移动光标；中文输入法打字过程中的按键也不触发快捷键。 |
| 观察项（不算失败） | 焦点停在 antd 按钮上时按 `Space`，会命中「播放 / 暂停」并阻止默认行为，那个按钮不会被点。若你期望 `Space` 触发聚焦按钮，记为「交互取舍」。 |
| 怀疑 | `web/src/lib/edit/shortcuts.ts` 的 `matchEditShortcut`、`normalizeEditShortcutKey`、`isEditShortcutTargetBlocked`；监听注册在 `edit-stage.tsx` 的 `useEffect`（`window.addEventListener("keydown")`）与 `runShortcut`。输入框里仍被吃掉时，先确认焦点元素 `tagName` 是不是 `INPUT`——`isEditShortcutTargetBlocked` 只放行 `INPUT` / `TEXTAREA` / `SELECT` 与 `contentEditable`，antd 的 `InputNumber`、`Select` 内层都是 `INPUT`。 |

## E4 撤销 / 重做

| 项 | 内容 |
|---|---|
| 前置 | 新建一个项目（历史为空）。 |
| 步骤 | ① 看撤销 / 重做两个按钮是否都是**禁用**（灰）。② 只做**一次**拖拽换序，松手后按一次 `Ctrl+Z`，看顺序是否一次就还原。③ 悬停撤销 / 重做按钮看 Tooltip。④ 在属性区把「音量」从 100 连续改成 120、130（两次间隔小于 0.6 秒），再按一次 `Ctrl+Z`。⑤ 一直撤销到按钮变灰，再连按 `Ctrl+Shift+Z` 恢复。⑥ 按 `F5` 刷新页面。 |
| 预期 | ① 两个按钮禁用。② 一次拖拽 = **一条**记录，一次 `Ctrl+Z` 即还原。③ Tooltip 显示「撤销：调整片段顺序」（属性改动是「撤销：调整片段属性」，拆分是「撤销：拆分片段」），栈空时只显示「撤销 / 重做」。④ 同字段在 0.6 秒内连敲合并成一条，一次撤销直接回到 100。⑤ 撤销到底后撤销按钮变灰、重做按钮可用，重做能逐步复原。⑥ 刷新后项目 / 素材 / 片段顺序都在，但撤销栈清空、按钮变灰 —— **设计如此**（历史只在内存里，不落盘）。 |
| 怀疑 | `web/src/stores/use-edit-store.ts` 的 `patchProject`（值没变不写历史）、`updateClips` / `updateClip`（mergeKey 与 600ms 窗口）、`applyHistory`、`historyFlags` / `historyLabels`、`persist` 的 `partialize`；`web/src/lib/edit/history.ts` 的 `pushEditHistory`、`editHistoryFlags`、`editHistoryLabels`、`EDIT_HISTORY_MERGE_MS`；按钮区块是 `edit-stage.tsx` 的 `data-edit-history`。 |

## E5 长片不漂（主时钟）——本轮最需要手工确认的一条

| 项 | 内容 |
|---|---|
| 前置 | 按第 0 节造一个**多段、合计几分钟**的项目（例如同一 15 秒素材排 6 段 = 90 秒；要更严就排 12 段 = 180 秒）。给每段素材或每段开头准备可识别的画面标记（能一眼看出"这是第几段"）。 |
| 步骤 | ① 从 0 起播，播到底，中途每隔几十秒记一次「播放头读数 + 画面现在是哪一段」。② 拖到 60 秒处，按 `Space` 起播，看画面是否立刻对齐。③ 播放中暂停 5 秒再恢复。④ 把「帧率」从 30 改成 24 或 60，再播一遍。 |
| 怎么判断「漂了」 | **不要用"播放头准不准"判断**：播放头位置就是每帧从主时钟算出来的，它按定义永远准。要看**画面内容与播放头读数的错位**——例如读数已经进入第 5 段、画面却还是第 4 段的结尾内容，并且这种错位**持续存在**（切段瞬间的一两帧黑帧 / 卡顿不算）。错位随时间越来越大 = 漂了。 |
| 预期 | 全程画面与读数对得上；② 起播后立刻对齐；③ 恢复后仍对齐；④ 改帧率只改变追赶的敏感度（容差是一帧），不改变对齐结果。 |
| 怀疑 | `web/src/lib/edit/playback-clock.ts` 的 `resolveEditClockSource`（`AudioContext` 真的在跑才用它，被挂起时退化为 `performance.now()/1000`，且时钟源只解析一次）、`EditPlaybackClock.play/pause/seek`、`editDriftAction`（容差一帧）、`EDIT_DRIFT_COOLDOWN_MS`（300ms 硬 seek 冷却）、`editDesiredMediaSeconds`、`editFrameSeconds`；`edit-stage.tsx` 的 `stepPreview`（每帧只读主时钟、写 DOM 与 `<video>` 属性，不写 React 状态）、`startClip`（换源后 `loadedmetadata` 再按主时钟重算起播点）、`seekPreview`、`togglePreview`。帧率取自项目「输出 → 帧率」（默认 30）。 |

## E6 浅色与深色主题

| 项 | 内容 |
|---|---|
| 前置 | 能切换主题（顶栏或设置里的明暗切换）。 |
| 步骤 | 在两个主题下各走一遍：剪辑台首页（项目列表 + 「新建剪辑」主按钮）、项目页四区、空状态页、错误提示（故意删掉素材文件后导出，或触发一次失败提示）、时间线上的导引线与播放头、片段选中态。 |
| 预期 | 「新建剪辑」主按钮浅色下是**深底浅字**、深色下是浅底深字，两主题都清晰可读；侧边栏「剪辑台」入口、素材区 / 属性区的小字不糊；导引线（主色竖线）、播放头与选中片段边框（`#756bff`）在浅色浅背景上仍然看得见；错误提示不出现白底白字。 |
| 怀疑 | `web/src/styles/globals.css` 的 `.td-workspace-action.is-primary` 与 `html:not(.dark) .td-workspace-action:not(.is-primary)` 玻璃化规则（浅色白底白字刚修过就是这两条互相压制）；`edit-stage.tsx` 里写死的 `#756bff`、`text-stone-*` / `dark:text-zinc-*`；画布节点错误面板在 `web/src/components/canvas/canvas-node-hover-toolbar.tsx` 的 `CanvasNodeInfoModal`。 |

## E7 空状态四类

| 场景 | 操作 | 预期 | 怀疑 |
|---|---|---|---|
| 没有剪辑项目 | 侧边栏点「剪辑台」 | 「还没有剪辑项目」+「新建剪辑」主按钮 + 引导文字（左侧导入素材、中间预览、下方时间线、右侧调参数并导出） | `web/src/pages/editor/index.tsx` |
| 项目没有素材 | 新建剪辑后进入项目页 | 素材区：「这个项目还没有素材：先在左侧导入本地文件，或从「我的资产」选择，或在画布上把节点发送过来。」+「导入本地文件」主按钮；预览区、时间线区、属性区也各有对应空提示而不是空白 | `web/src/pages/editor/components/edit-media-panel.tsx`、`edit-stage.tsx` 的 `empty` 分支、`edit-inspector.tsx` |
| 时间线为空（有素材） | 导入素材但先不加入时间线 | 时间线区：「时间线还是空的」+「在左侧素材上点「加入时间线」，片段就会按顺序排到这里。」+「把素材全部加入时间线」按钮；点它把所有**已探测到时长的视频**一次排上时间线并提示「已加入时间线」；若一个都没有，弹「还没有探测到时长的视频素材，先导入素材或重新探测。」而不是静默无反应 | `edit-stage.tsx` 的 `addAllToTimeline`（一次 `addClips` 写入） |
| 素材缺时长 | 导入一个时长探测失败的文件 | 该素材行下方显示「时长未探测到，暂不能进入时间线」（琥珀色），右侧按钮是「重新探测」而不是「加入时间线」；点它成功提示「已探测到真实时长」，失败提示「仍然探测不到时长，请换一个文件或先转码」 | `edit-media-panel.tsx` 的 `playable` / `reprobe`；`web/src/services/edit-media.ts` 的 `probeEditMediaDuration` |

## E8 素材来源一：本地文件导入

| 项 | 内容 |
|---|---|
| 前置 | 项目页已打开。 |
| 步骤 | 点素材区上方或空状态里的「导入本地文件」→ 看选择器是否弹出、能否多选 → 选 1 个 mp4 + 1 个 mp3 → 看素材行的「来源」与时长 → 再试一次选 1 个 png。 |
| 预期 | 选择器能弹出、能多选；导入成功提示「已导入 2 个素材」；素材行显示「本地文件 · 0:15.0」这样的时长；png 被跳过并提示「没有可导入的视频或音频文件」。 |
| 怀疑 | 这个按钮触发的是页面内的隐藏 `<input type="file">`（**不是 Tauri 原生对话框**），见 `edit-media-panel.tsx` 的 `fileInputRef` / `importFiles`；导入与时长探测在 `web/src/services/edit-media.ts` 的 `importLocalMediaFiles`、`probeEditMediaDuration`，底层是 `web/src/services/file-storage.ts` 的 `uploadMediaFile`（它同时写入 `durationMs`）。桌面版选择器打不开属于这一层的问题，不是剪辑台逻辑。 |

## E9 素材来源二：从「我的资产」选择

| 项 | 内容 |
|---|---|
| 前置 | 「我的资产」里至少有一个视频（没有就先在画布上把视频节点「加入我的资产」）。 |
| 步骤 | 点「从我的资产选择」→ 看弹窗里有哪些条目 → 选一个点「导入」。 |
| 预期 | 弹窗**只列视频**（音频 / 图片不出现）；导入后提示「已导入 1 个素材」，素材行来源标注「我的资产」；资产里没有视频时显示「「我的资产」里还没有视频素材」。 |
| 怀疑 | `edit-media-panel.tsx` 的 `videoAssets` / `importAsset`；`web/src/services/edit-media.ts` 的 `importAssetToEditMedia`（资产没存时长，导入时现探一次，探不到就走 E7 第四行的表现）。 |

## E10 素材来源三：画布节点「送剪辑」

| 项 | 内容 |
|---|---|
| 前置 | 一个画布，上面有**已出片**的视频节点（`metadata.content` 非空）与音频节点。先截图记下节点数量与连线数量。 |
| 步骤 | ① 鼠标移到视频节点上，工具条里找「送剪辑」（四角板图标）。② 点它，看提示与提示里的「打开剪辑台」按钮，点进去看素材区。③ 回到画布，数节点与连线，对比截图。④ 再点一次「送剪辑」。 |
| 预期 | ① 视频与音频节点工具条上都有「送剪辑」，图片 / 文本节点上没有；空节点（没有产物）也没有。② 提示「已发送到剪辑台：{项目名}」，跳转后素材区出现该素材、来源标注「画布发送」。③ **画布节点位置、数量、连线、合成节点的 compositeSettings 全都逐字未变**。④ 第二次仍进同一个项目（取最近更新的那个），不会每次新建。 |
| 怀疑 | `web/src/components/canvas/canvas-node-hover-toolbar.tsx` 的 `sendEditor` 工具项与 `hasVideo` / `hasAudio` 判定；`web/src/services/edit-media.ts` 的 `canvasNodeToEditMedia`（只读复制，不改节点）；`web/src/pages/canvas/project.tsx` 的 `sendNodeToEditor`（`ensureProject` + `addMedia` + 提示里的跳转按钮）。若跳转后素材不在列表，先确认 `ensureProject` 选中的项目与提示里的项目名是否一致。 |

## E11 画布侧回归（本轮明确要求保留的东西）

| 项 | 内容 |
|---|---|
| 前置 | 任意画布。 |
| 步骤 | ① 新建一个「合成」节点，连 2 个视频 + 1 个音频，确认节点、端口、连线都在。② 点开合成节点的浮动面板，改一个参数（背景音乐的淡出秒数），关掉再打开看值是否还在。③ 点「开始合成」，等成片出来，确认新的视频节点落在**当前**画布上；合成期间切到另一个画布再切回来，成片不得落到别的画布。④ AI 导演「一键生成整片」跑完，确认成片下方自动出现一个已经连好的合成节点。 |
| 预期 | 四条都与加剪辑台之前一致：合成节点与 `compositeSettings` 原样、浮动面板照旧、成片回落当前画布、AI 导演自动接合成节点。剪辑台是并列的第二条剪辑路径，不应改动它们中的任何一条。 |
| 怀疑 | `web/src/pages/canvas/project.tsx` 的 `renderNodePanel`（Composite 分支）、`handleConfigNodeChange`、`handleRunComposite`（成片追加，含归属校验）、`attachCompositeNode`（AI 导演自动接合成节点）、`buildDirectorNodes`；`web/src/components/canvas/canvas-composite-panel.tsx`。成片落错画布是刚修过的缺陷（`f14e2ec`），若复现直接看 `handleRunComposite` 里的归属校验。 |

## E12 画布合成面板的连播预览

| 项 | 内容 |
|---|---|
| 前置 | 合成节点已连上 ≥ 2 个视频片段（素材有时长）。 |
| 步骤 | ① 打开合成面板，找播放按钮（无障碍名称「顺序连播预览」）。② 点它，看是否依次播各段。③ 点标尺、再拖播放头到第 2 段中间。④ 播放中点一次标尺。⑤ 再点按钮暂停。 |
| 预期 | 面板里能看到时间标尺、总时长、播放头竖线；点播放后按片段顺序连播各段原始素材，播放头与读数（`分:秒.十分位`）跟随，读数右侧显示当前段名；点标尺 / 拖播放头可定位，**播放中**定位后从新位置继续；末段播完停在末尾；面板写明「预览仅用于对时，成片效果以导出为准」。预览只播各段原声，**不含转场、字幕烧字与多轨混音**，这是设计如此。 |
| 怀疑 | `web/src/components/canvas/canvas-composite-panel.tsx` 的 `togglePreview` / `tickPreview` / `stepPreview`、`startSeek` / `moveSeek` / `endSeek`、`paintPlayhead`、`resolveCompositePlayback` / `resolveCompositeSeek` / `buildCompositePreviewClips`。播放器是一个 1px、`opacity:0` 的 `<video>`（故意不用 `display:none`，避免部分 WebView 因不可见而暂停媒体）——没声音时先确认它没被裁掉，而不是先怀疑音频。 |

## E13 导出成片（此前已验证过一次，改完代码要重测）

| 项 | 内容 |
|---|---|
| 前置 | 桌面客户端；时间线上 ≥ 3 段；本机 FFmpeg 可用（设置 → 本地 FFmpeg 能看到路径）。 |
| 步骤 | 给第 1 段设转场「交叉溶解」、第 2 段填一句字幕、点左侧音频素材行右侧的 ➕（Tooltip「音频作为附加音轨混进成片，不参与画面拼接」）、整体淡入淡出保持默认 0.5 秒 → 点「导出成片」→ 选目录 → 用播放器看。 |
| 预期 | 弹出选择目录对话框（用户取消则不发请求）；按钮进入 loading；成功提示「成片已导出：{文件名}」，属性区显示成片路径与「打开所在文件夹」；成片里转场、字幕、音轨混音、整体淡入淡出都能看到 / 听到；实际时长与「成片时长约」一致。 |
| 怀疑 | `web/src/pages/editor/export.ts` 的 `exportEditProject` / `pickOutputDirectory` / `openOutputDirectory`；`web/src/lib/edit/timeline.ts` 的 `buildComposeRequest`；`web/src/services/platform/desktop-ffmpeg.ts` 的 `composeVideo` / `resolveEditMediaLocalPath` / `readFfmpegPath`；Rust 侧 `web/src-tauri/src/ffmpeg_compose.rs` 的 `compose_blocking`、`global_fade_chain`（尾逗号就是在这里被结构性杜绝的）、`describe_exit_code`（把 FFmpeg 的大负数退出码翻成中文）。报「未检测到 FFmpeg」时去设置里指定路径。 |

---

## 记录表

| 编号 | 项目 | 结果（通过 / 不通过 / 未测） | 现象与截图 | 备注 |
|---|---|---|---|---|
| E1 | 时间线拖动：裁剪、换序、拖播放头、松手才生效 | | | |
| E2 | 吸附与竖线导引（含快拖不吸附、Alt、N） | | | |
| E3 | 快捷键全套 + 输入框内不被吃掉 | | | |
| E4 | 撤销 / 重做（一条记录、禁用态、Tooltip 操作名） | | | |
| E5 | 长片不漂（主时钟、暂停恢复、拖后重播） | | | |
| E6 | 浅色与深色主题 | | | |
| E7 | 空状态四类 | | | |
| E8 | 素材来源一：本地文件导入 | | | |
| E9 | 素材来源二：我的资产 | | | |
| E10 | 素材来源三：画布节点「送剪辑」（含画布未被改动） | | | |
| E11 | 画布侧回归（合成节点 / 浮动面板 / 成片回落 / AI 导演） | | | |
| E12 | 画布合成面板连播预览 | | | |
| E13 | 导出成片复测 | | | |

## 本轮完全没有自动化覆盖、必须靠这份清单的部分

1. 真实指针拖动（松手才生效、吸附、导引线、卡顿与崩溃）—— E1、E2。
2. 真实键盘输入与焦点判定（尤其输入框 / 输入法）—— E3。
3. 真实播放（主时钟对齐、长片漂移、暂停恢复）—— E5、E12。
4. 真实文件选择器与素材时长探测 —— E8、E9。
5. 画布节点工具条 → 剪辑台的真实点击链路 —— E10。
6. 画布侧回归（合成节点、浮动面板、成片归属、AI 导演自动接线）—— E11。
7. 真实 FFmpeg 出片（含转场 / 字幕 / 混音）—— E13。
