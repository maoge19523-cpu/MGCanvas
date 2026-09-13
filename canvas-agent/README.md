# MGCanvas Agent

MGCanvas Agent 用来连接 MGCanvas 网页、本机 Codex 与 Claude Code。当前仓库只提供本地源码运行方式，不依赖远程 npm 包或线上站点。

## 本地构建与启动

```bash
cd canvas-agent
npm install
npm run build
node dist/index.js
```

需要调试日志时运行：

```bash
node dist/index.js --debug
```

Agent 默认监听 `127.0.0.1:17371`，启动后会输出 `Local URL` 和 `Connect token`。在 MGCanvas 的 Agent 面板中填写这两项即可连接。

配置保存在 `~/.mgcanvas/mgcanvas-agent.json`，调试日志保存在 `~/.mgcanvas/logs/mgcanvas-YYYY-MM-DD.log`。首次连接会记录网页 Origin；如需切换站点，请清理配置中的 `origins`。

## 注册本地命令

需要让 Codex 插件直接启动 Agent 时，可以在完成构建后链接本地包：

```bash
cd canvas-agent
npm link
mgcanvas-agent --debug
```

`npm link` 只注册当前源码构建出的本地命令，不会下载或调用远程 MGCanvas 包。

## Codex MCP

使用已链接的本地命令：

```bash
codex mcp add mgcanvas -- mgcanvas-agent mcp
```

或直接使用当前仓库的绝对路径：

```bash
codex mcp add mgcanvas -- node /absolute/path/to/MGCanvas/canvas-agent/dist/index.js mcp
```

移除手动注册的 MCP：

```bash
codex mcp remove mgcanvas
```

当前 MCP 提供画布读取、节点创建、连线和生成流程等工具；任何实际画布写入仍由网页侧边栏二次确认。

## Codex 本地插件

仓库内的插件位于 `plugins/mgcanvas`。先完成上面的 `npm run build && npm link`，再从仓库根目录注册本地 marketplace：

```bash
codex plugin marketplace add "$(pwd)"
codex plugin add mgcanvas@mgcanvas-local
```

Windows PowerShell 可使用 `$PWD` 代替 `$(pwd)`。

## Claude Code MCP

```bash
claude mcp add --scope user --transport stdio mgcanvas -- mgcanvas-agent mcp
```

MGCanvas Agent 调用 Claude Code 时只允许 `mcp__mgcanvas__*` 工具；画布写操作仍由网页侧边栏确认。
