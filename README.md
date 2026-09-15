> **自带 API Key，接入任意兼容服务商**
>
> 启动 MGCanvas，打开右上角设置，在「渠道」中新增服务商：选择协议（OpenAI / Gemini / 火山方舟 / 异步任务），填写接口地址与 API Key，拉取或手动添加模型，即可在画布节点中使用图片、视频、音频等生成能力。
>
> **二次开发**：复用本项目 `web/src/services/api/` 中的接口封装扩展画布节点与生成工作流。接入步骤见[快速开始](docs/content/docs/overview/quick-start.zh-CN.mdx)。生成调用按所选服务商实际计费。

## 许可与商业化

本项目遵循 **GNU Affero General Public License v3.0（AGPL-3.0）**，完整条款见 [LICENSE](LICENSE)。

| 使用方式 | 说明 |
| --- | --- |
| **个人使用 / 学习 / 二次开发** | ✅ 自由使用，无需授权 |
| **销售软件副本** | ✅ 允许。需按 AGPL-3.0 §6 向使用者提供**源代码获取方式**（提供本仓库地址即可，无需随包分发源码） |
| **修改后分发** | ⚠️ 必须以 AGPL-3.0 开源你的修改 |
| **作为网络服务提供（SaaS）** | ⚠️ AGPL-3.0 §13 要求向网络用户提供对应源码 |
| **闭源再发布** | ❌ 不允许 |

**源代码**：<https://github.com/maoge19523-cpu/MGCanvas>

应用内「配置 → 关于」也会展示版本、许可与源代码入口。
<p align="center">
  <img src="web/public/logo.svg" width="96" alt="MGCanvas logo">
</p>

<h1 align="center">MGCanvas</h1>

<p align="center">MGCanvas 打造的 AI 无限画布</p>

MGCanvas 将画布编排、节点连接、AI 生成、素材管理和本地 Agent 协作集中在同一个工作空间。应用打开后直接进入无限画布，不再经过独立展示首页；图片与视频能力通过画布节点按需使用，不再提供单独的生图工作台或视频创作台。

## 产品展示

产品截图与演示素材待重新采集后补充（旧截图仍保留在 `docs/images/legacy/` 作为历史备份，其界面与当前版本不一致，请勿直接引用）。

## 桌面客户端源码启动

环境要求：Node.js 20+、Rust 1.85+。Windows 需要 Microsoft C++ Build Tools 与 WebView2；macOS 需要 Xcode Command Line Tools。

```bash
cd web
npm install --legacy-peer-deps
npm run desktop:dev
```

启动后会直接打开 MGCanvas 桌面窗口，不需要浏览器。`npm run dev` 仅保留给前端界面调试，不是正式用户入口。

## 打包 Windows / macOS

```bash
cd web
npm run desktop:package
```

脚本会询问打包 Windows、macOS 或全部版本。Windows 本机生成 NSIS `.exe`；Mac 本机生成 Intel + Apple Silicon 通用 `.app/.dmg`；“全部”会交给仓库的双平台 GitHub Actions 构建，因为正式 macOS 安装包不能在 Windows 本机生成。

首次使用时请在设置中新增渠道：选择协议、填写接口地址与 API Key、选择模型。仓库不包含用户密钥。

## 主要能力

- 无限画布：节点拖拽、缩放、连线、小地图、撤销重做和项目导入导出。
- 画布内 AI 工作流：在节点上下文中组织提示词、参考素材与生成结果。
- 素材管理：上传素材保存在客户端本地；生成的图片、视频、音频和文件会自动保存到系统应用数据目录并复用稳定本地地址。
- MGCanvas Agent：可选的本地 Agent 通道，用于让 Codex 或 Claude Code 读取和操作当前画布。
- 插件扩展：通过节点插件扩展画布能力；仅应安装来自可信来源的插件。

## ComfyUI 本地画布插件

**将本地 ComfyUI 工作流接入 MGCanvas，封装为可连线、可复用的画布插件节点。**

> 请自行准备可用的 ComfyUI 环境（含所需模型与自定义节点），本仓库不提供整合包下载。

1. 准备好 ComfyUI 环境，按工作流需要配置模型与自定义节点。
2. 在 MGCanvas 的「ComfyUI 本地」中选择该 ComfyUI 环境目录并启动环境。
3. 导入 ComfyUI **API Format JSON** 工作流，检查依赖，选择要暴露的输入与输出并保存。
4. 将工作流添加到画布，作为插件节点连接提示词、图片等输入，在画布中运行并查看结果。

更多说明见 [ComfyUI 本地模块](modules/comfyui-local/README.md)。

## 数据与配置

画布项目、上传素材、生成记录和连接配置默认保存在 MGCanvas 客户端本地。生成的图片、视频、音频会在任务完成后立即转存到系统应用数据目录：Windows 为 `%LOCALAPPDATA%/com.mgcanvas.app/media-cache`，macOS 为 `~/Library/Application Support/com.mgcanvas.app/media-cache`。API 密钥保存在当前客户端配置中，请只在受信任的设备上使用。

## 文档

- [快速开始](docs/content/docs/overview/quick-start.zh-CN.mdx)
- [画布节点操作手册](docs/content/docs/canvas/canvas-node-manual.zh-CN.mdx)
- [画布快捷键](docs/content/docs/canvas/canvas-shortcuts.zh-CN.mdx)
- [安全策略](SECURITY.md)
- [贡献者协议](CLA.md)

## 开源许可与来源

MGCanvas 基于 `basketikun/infinite-canvas` 开源项目进行二次开发。
