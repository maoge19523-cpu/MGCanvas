# AGENTS.md

本文档用于约束本项目中的 AI / 自动化开发行为。开发时优先遵循本文件，其次遵循用户当前消息。

## 基本原则

- 先读现有代码，再动手修改，优先沿用项目已有结构和写法。
- 写代码保持最少行数，能简单实现就不要引入复杂抽象。
- 标准格式、协议、解析、压缩、加密、日期等通用能力优先使用成熟稳定的库，不要手写底层实现，除非用户明确要求或项目已有实现必须沿用。
- 不要为了“兼容更多场景”写大量分支，只实现当前明确需要的功能。
- 项目尚未上线，不需要兼容旧数据；本地存储结构调整时直接按新设计修改，不写旧字段兼容或数据迁移兜底，除非用户明确要求。
- 每次写完代码，不需要检查语法，不需要执行构建，用户会自己做。
- 不要改无关文件，不要顺手重构。
- 如果工作区已有用户改动，不要回滚，不要覆盖；只在必要范围内追加修改。

## 反复提醒沉淀

- 如果开发过程中总是遇到某个问题，或者用户反复提醒同一个注意事项，需要把该注意事项补充到本文件。
- 补充时写成明确、可执行的规则，避免只写模糊描述。
- 新规则应放到最相关的章节；找不到合适章节时放到“项目注意事项”。

## 前端规范

- 前端使用 Vite、React、React Router、TypeScript、Ant Design、Tailwind、Zustand。
- 编写 Ant Design 相关代码时，参考 https://ant.design/llms-full.txt 理解组件 API、示例和设计规范，并优先结合项目当前 antd 版本与既有写法。
- 外部服务请求统一放在 `web/src/services/api/`；桌面生产环境通过 `web/src/services/platform/` 与 Tauri 原生能力访问，不依赖 Vite 开发服务器代理。
- 全局或跨页面状态优先放在 `web/src/stores/`。
- 已经放在全局 store 或全局 hook 中的状态/动作，组件需要时直接使用对应 store/hook，不要为了“纯组件”层层透传 props；避免一个组件传递过多参数。
- 全局组件、全局常量、全局配置等全局性质的内容不要作为 props 或参数层层传递；哪里需要就在哪里直接从对应全局入口获取。
- 多个页面重复出现的 UI 副作用动作，例如复制文本并提示、下载并提示、统一确认弹窗，优先抽成 `web/src/hooks/` 下的全局 hook；不要放进 store，除非它确实是需要共享/订阅的状态。
- 路由页面放在 `web/src/pages/`，页面布局放在 `web/src/layouts/`，路由配置放在 `web/src/router.tsx`。
- 画布页面放在 `web/src/pages/canvas/`，画布组件放在 `web/src/components/canvas/`，画布状态放在 `web/src/stores/canvas/`，画布工具函数放在 `web/src/lib/canvas/`。
- 页面按目录组织，例如 `web/src/pages/image/index.tsx`；页面里只有一个主业务组件时直接写在对应页面入口中，不要单独拆 `Manager` 组件再传一堆 props。
- 不要新增只做简单转发的组件，例如只 `return <X>{children}</X>` 或只换个名字透传 props；直接在使用处使用真实组件或把逻辑写进当前文件。
- 页面私有 hook 放在对应页面目录下，例如 `admin/assets/use-admin-assets.ts`；只有多个页面真实复用的 hook 才放到外层 `hooks/`。
- 管理后台页面私有组件放到各自页面目录的 `components/` 下，例如 `admin/assets/components/`、`admin/prompts/components/`；不要为了单页面使用放到 `admin/components/` 共享目录。
- 管理后台主题、背景、卡片阴影、表格配色等统一在 `web/src/lib/app-theme.ts`、`AppProviders` 或必要的全局 CSS 作用域中配置；页面私有组件不要自己写 `dark ? ...` 主题分支。
- Ant Design 的 Dropdown、Menu、Select、Cascader、TreeSelect 等弹层背景、悬停态和选中态颜色统一通过 `web/src/lib/app-theme.ts` 的全局 Alias Token 与组件 Token 配置；不要在业务组件内为单个弹层覆盖颜色。
- 组件优先使用函数组件和现有 hooks，不新增大型状态管理方案。
- UI 图标优先使用 `lucide-react` 或项目已经使用的 Ant Design 图标。
- 页面文案保持中文。
- 不要在组件里堆太多无关逻辑；复杂逻辑优先抽成同目录工具函数或小组件。
- 样式优先由组件自己管理；组件私有样式优先使用 Tailwind className 或少量内联 style，不要为单个组件新增大量全局 CSS。
- 全局 CSS 只放基础变量、全局重置、跨页面通用样式和少量第三方组件必要覆盖；不要在 `globals.css` 堆页面私有样式。
- 代码尽量短小直接，少拆不必要组件，少做多层 props 传递，避免为了抽象堆出更多代码。
- 前端业务数据需要 WebView 本地持久化时，默认使用 `localforage`；`localStorage` 只用于极小的简单配置，不要用来保存业务列表、生成记录、图片、base64 或大 JSON。大媒体优先交给 Tauri 原生层写入系统应用数据目录。

## 画布 UI 规范

- 做 canvas 前端 UI 时必须遵循当前画布主题。
- 优先使用 `canvasThemes`、`useThemeStore` 或 Ant Design `ConfigProvider` token。
- 不要硬编码黑白、stone、slate 等颜色导致浅色/深色主题不一致。
- 新增画布按钮、弹窗、浮层时，尽量复用已有工具栏、节点面板、Modal 的视觉风格。
- 画布顶部工具栏和状态信息优先采用极简扁平风格：无边框、无阴影、无胶囊背景，融入整体背景，弱化按钮感，仅保留轻微 hover 反馈，保持简洁现代、低视觉重量。
- 左侧画布面板等列表里的节点/元素缩略图容器，非图片类型（文本、配置、视频、音频等）不要使用 `theme.node.fill`（`#e7e5df`/`#292524`）这类灰色背景，图标直接无背景展示，尽量不要给多余底色，保持干净。
- 画布内的操作按钮（如面板里的「添加」「导出」「选择」等）默认用扁平无底色样式：透明背景、仅 `hover:bg-black/5 dark:hover:bg-white/10` 轻微反馈，靠图标+文字表达，不要用 `theme.toolbar.activeBg`（`#e7e5df`/`#3a3631`）或 `theme.node.fill` 之类的灰色作为按钮填充底色。灰色 `activeBg` 只允许用于「选中态」等需要表达状态的高亮，不要当普通装饰底色。
- 图片节点尺寸逻辑要尊重原始比例，除非功能明确要求自由变形。
- 批量生成、多图展示、助手面板等画布交互要尽量简洁，不要占用过多画布空间。

## UI 调整规范（踩坑沉淀）

- 调整间距、留白、字号、圆角等视觉参数时**一次改到位**：小幅递增（如左右留白 24→36→48px）用户看不出差别，会被判定为「没改」。经验值：页面级左右留白一次给到 48–64px。
- 改视觉前**先确认目标元素**：用截图标注位置对不上时，先读组件树确认用户指的是哪一层（外层容器 / 内容面板 / 面板内标题），不要凭「框」的直觉直接改。曾把 `rounded-[28px]` 加到外层容器（连同标题一起切圆），而用户要的是内层内容面板。
- 面板内的**标题与选项要对齐**：若选项按钮有 `px-3`，同级标题也必须加同样的 `px-3`，否则小标题看起来「贴着边框」，会被误判为容器内边距不足。
- 半透明只用于装饰面（外壳、工具栏、卡片）；承载表单与文字的面板一律用不透明底色（`theme.node.panelSolid`），否则会透出下层节点文字造成重叠。

## 文档规范

- README 保持简洁，只放项目介绍、核心功能、快速开始和文档入口。
- `docs/index.md` 放给 AI 使用的文档索引，不要再放到 `docs/content/docs/` 内容目录里。
- 详细功能介绍写到 `docs/content/docs/overview/features.mdx`。
- 后续待办写到 `docs/content/docs/progress/todo.mdx`。
- 已实现但还需要用户测试确认的事项写到 `docs/content/docs/progress/pending-test.mdx`。
- `docs/content/docs/progress/pending-test.mdx` 用来记录这个版本实际做了哪些可测试变更；`CHANGELOG.md` 的 `Unreleased` 只保留对这些变更的版本级归纳，避免逐条照搬实现细节。
- 每次重大改动（新增/调整/删除功能、接口或工具，影响用户可感知行为）完成后，都要在 `CHANGELOG.md` 的 `Unreleased` 追加一条记录，按 `[新增]` / `[调整]` / `[修复]` / `[优化]` 前缀分类，用一句中文归纳；纯内部重构、格式化、无用户可感知影响的小改动可不记。
- 每次 todo 事项完成后，先从 `docs/content/docs/progress/todo.mdx` 移到 `docs/content/docs/progress/pending-test.mdx`，不要直接写进正式功能说明；用户确认测试通过后再更新 `docs/content/docs/overview/features.mdx`。
- 每次任务完成前，都要根据实际变更检查并更新 `docs/content/docs/progress/todo.mdx` 和 `docs/content/docs/progress/pending-test.mdx`；如果功能或待办没有变化，也要确认无需修改。
- 文档不要写过期日期；除非用户明确要求记录具体时间。

## 发版本流程

- 发版本时，先把 `CHANGELOG.md` 的 `Unreleased` 变更整理成新的版本记录，并保留空的 `Unreleased` 标题。
- 按当前版本号提升一个版本，更新根目录 `VERSION`。
- 将当前未提交的代码全部提交到 Git。
- 提交完成后，给当前提交打最新版本号对应的 tag，例如 `v0.0.5`。
- 发版本流程中不要执行编译、测试或构建，除非用户明确要求。

## 桌面客户端规范

- 正式用户入口是 Tauri 2 桌面客户端；Vite 仅用于界面开发和静态资源构建，不能把生产功能只实现为 Vite middleware。
- Tauri 原生工程放在 `web/src-tauri/`，平台适配入口放在 `web/src/services/platform/`。
- Windows/macOS 可写业务文件统一放入系统 AppLocalData/Application Support，不要写安装目录或源码仓库。
- Windows 安装包必须在 Windows 构建，macOS `.app/.dmg` 必须在 Mac 构建；双平台打包使用各自宿主或 CI。

## 交付前必须完成构建（重要）

改动源码后，**必须走完「提交 → 打包 → 安装」三步**，再让用户测试；只改源码不算完成。

- 每次改完先 `git status --short` 确认没有未提交改动；有就提交。
- 打包后对比时间戳，确认构建产物晚于所有改动过的源文件：
  `构建产物(src-tauri/target/release/bundle/nsis/*.exe).LastWriteTime` 必须大于每个改动源文件的 `LastWriteTime`。
- 曾出现过多次「源码已修好但没打包」，用户反复测试旧版本、同一问题重复上报。
- 多行提交信息一律先写到文件再 `git commit -F <文件>`。直接在命令行里传多行字符串会被 PowerShell 与 git 一起解析：带 `-` 开头的行、消息里的引号都会让 git 报 `' did not match any file(s) known to git` 而**提交静默失败**（打包照常成功，于是看起来像提交过了）。提交后必须用 `git log --oneline -1` 确认新提交真的产生了。

## 项目注意事项

- 在这台机器上用命令行验证接口时要记住三点（都已实际踩过）：① `curl` 必须加 `--ssl-no-revoke`，否则 Schannel 的吊销检查离线会直接返回 HTTP 000，看着像目标站点不通，其实与站点无关（方舟、智谱对象存储都中招过）；② 带中文或嵌套引号的 JSON 请求体一律先用工具写成文件再用 `-d @文件`，不要在命令行里内联，PowerShell 会把引号吃掉，服务端只会回一句 JSON 解析错误，看不出真正原因；③ 服务商返回的图片/视频是带签名与有效期的临时链接，需要下载验证时要紧接着做。

- 当前画布项目和“我的素材”主要保存在桌面 WebView 本地，生成媒体写入系统应用数据目录；不要在文档中误写成已支持云同步。
- 当前 AI API Key 存在桌面客户端本地配置中，Generic 请求通过受限的 Tauri HTTP 权限发送；涉及安全说明时要写清楚。
- Docker 静态资源路径目前仍是待办项，文档中不要过度承诺生产部署已经完全验证。
- Agent 对话消息必须同时按 `threadId`、`turnId` 和 `itemId` 归属；实时事件只用于补充未物化的 turn，历史快照成为权威后不得重复合并同一条消息。
- 本地启动或浏览器验收时不要关闭用户已经打开的浏览器窗口或标签页；需要自动化验证时使用独立测试页面，避免打断用户当前页面和对话状态。
