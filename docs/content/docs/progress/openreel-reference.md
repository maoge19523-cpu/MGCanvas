# OpenReel 参考结论：许可红线与轨道模型地基

这份文件只留两条**会直接改变决策**的结论，供以后动剪辑台、动 FFmpeg 分发方式、或规划多轨 / 插入编辑之前先看一眼。

完整的调研报告（含源码路径、功能清单、借鉴与不借鉴清单、实测数字与更正记录）放在**仓库外**的本地副本：`H:\智谱\_ref\openreel-video-调研报告.md`；被调研的源码副本在 `H:\智谱\_ref\openreel-video\`（来自 GitHub main tarball，commit `5f3c85e5…`，**不是 git 仓库**，本机参考用、不入库）。因此下面这两条结论必须在仓库内留一份。

## 结论 1：许可红线 —— 可以吸收它的代码，绝不能照搬它的 FFmpeg

- **OpenReel 本体是 MIT**（根 `LICENSE` 与 `package.json` 的 `license: "MIT"`）。与我们的 AGPL-3.0 **兼容**，可以吸收其源码，**唯一义务是保留版权与许可声明**。
- ⛔ **它捆绑的 FFmpeg 构建是 GPL**：`apps/desktop/LICENSES/FFMPEG.md` 写明所有捆绑构建都按 `--enable-gpl` 配置（含 `libx264` / `libx265`），其中 **macOS x64 / Linux / Windows 为 GPL-3.0-or-later，macOS arm64 为 GPL-2.0-or-later**；`apps/desktop/scripts/fetch-ffmpeg.mjs` 按平台下载预编译二进制到 `resources/bin/`。**它的 Blender sidecar 同样是 GPL**（`LICENSES/BLENDER.md`）。
- ⚠️ **绝不能把它的 ffmpeg 二进制（或同类的 GPL 构建）照搬进我们的分发物。** 一旦随安装包分发 GPL 构建的 FFmpeg，GPL 的分发义务（提供对应源码等）就会跟上来；这与我们自己的 AGPL-3.0 授权、以及将来可能的商业授权都需要单独评估。
- ✅ **MGCanvas 现有做法——不分发 FFmpeg、只探测用户本机已装的 FFmpeg（设置页填路径，安装包里不带）——正是避开这条分发义务的关键，务必保持。**
- ⚠️ **未核实**：它浏览器端兜底用的 `@ffmpeg/core@0.12.6` 与 `@ffmpeg/core-mt@0.12.6` 的许可（它的 `LICENSES/` 未覆盖这两个包，外部检索也没有权威结论）。要引用这两包时先自己确认许可。
- 另外：`@mediapipe/tasks-vision`、`onnxruntime-web`、`three`、`mediabunny`、`gsap` 等依赖各有自己的许可（**GSAP 带商业授权条款**）；它的品牌名与 UI 视觉不受 MIT 的商标 / 外观保护延伸，照搬命名与配色有风险。

## 结论 2：「真实空隙」是一切轨道功能的地基

- OpenReel 里 **`Clip.startTime` 是绝对时间线坐标**，**真实空隙是一等公民**：有 `TimelinePlacementPolicy = "gap" | "stack-above"`（`packages/core/src/timeline/timeline-placement.ts`）、轨道头上有 `hasGaps` 检测与 **"Remove Gaps" / "Close Gap to Previous"** 合拢操作（`apps/web/src/components/editor/timeline/TrackHeader.tsx`、`ClipContextMenu.tsx`），并且**同轨片段禁止重叠**。
- MGCanvas 的视频片段位置是**前面片段时长累加推导**出来的，**结构上不存在空隙**——轨道上也因此没有「落点」这个概念。
- ⚠️ **这条决定了改动的天花板**：**多视频轨、接缝转场（挂在轨上而不是段上）、音频片段化、插入 / 覆盖编辑，全都卡在这个地基上**；不是加一个字段就能做出来的。反过来，**不需要空隙语义的局部功能可以先做**（例如「音轨的起始时间」这类单轨拖动，本轮已落地）。
- 因此：**动多轨或插入编辑之前，先立项改时间线数据模型（让片段持有绝对起点、空隙成为合法状态），不要在外围继续加补丁。**

## 附带的两个对照（关于诚实度）

- OpenReel **自己也有「预览 ≠ 导出」**：字幕的卡拉OK / 逐词 / 逐词高亮动画只在预览生效，导出走的是另一个渲染器、**完全不读动画样式**，而且**没有告知用户**。⇒ MGCanvas 在合成面板写明「预览仅用于对时，成片效果以导出为准」**在诚实度上更优，不要为了「对齐参考实现」而改掉这句话**。
- 它的 `apps/desktop/test/parity.md` 自认「预览与导出逐帧一致」，但同一份文件把这件事明确列为**需要人眼验证**的项目。⇒ **「参考实现声称一致」不等于有自动化证明**；我们自己的「预览仅供对时」也应当保持如实标注。
