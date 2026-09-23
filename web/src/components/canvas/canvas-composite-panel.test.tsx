import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

import { CanvasCompositePanel, buildCompositePreviewClips, formatTimelineTime, resolveCompositePlayback, resolveCompositeSeek, type CompositeSegmentSource } from "./canvas-composite-panel";

const noop = () => undefined;

function videoNode(id: string, seconds?: number): CanvasNodeData {
    return {
        id,
        type: CanvasNodeType.Video,
        title: `素材${id.toUpperCase()}`,
        position: { x: 0, y: 0 },
        width: 320,
        height: 180,
        metadata: { content: `blob:${id}`, durationMs: seconds === undefined ? undefined : Math.round(seconds * 1000), status: "success" },
    };
}

function segment(id: string, seconds?: number): CompositeSegmentSource {
    return { connectionId: `conn-${id}`, node: videoNode(id, seconds) };
}

describe("合成面板时间轴：时长与刻度", () => {
    it("按入出点算出每段净时长与在总时间轴上的起点，顺序即数组顺序", () => {
        const clips = buildCompositePreviewClips([segment("a", 6), segment("b", 5), segment("c", 4)], {
            segments: { a: { start: 1, end: 5 }, b: { volume: 2, fadeIn: 0.5 }, c: { start: 0.5, end: 3.5 } },
        });

        expect(clips.map((clip) => [clip.id, clip.offset, clip.length])).toEqual([
            ["a", 0, 4],
            ["b", 4, 5],
            ["c", 9, 3],
        ]);
        // 每段的音量/淡入淡出与面板参数一致，未设的取默认值。
        expect(clips.map((clip) => [clip.volume, clip.fadeIn, clip.fadeOut])).toEqual([
            [1, 0, 0],
            [2, 0.5, 0],
            [1, 0, 0],
        ]);
        expect(clips.reduce((sum, clip) => sum + clip.length, 0)).toBe(12);
    });

    it("源视频没有时长时该段长度记 0，不影响其它段起点", () => {
        const clips = buildCompositePreviewClips([segment("a"), segment("b", 3)], {});
        expect(clips.map((clip) => clip.length)).toEqual([0, 3]);
        expect(clips.map((clip) => clip.offset)).toEqual([0, 0]);
    });

    it("播放头读数固定为 分:秒.十分位", () => {
        expect(formatTimelineTime(0)).toBe("0:00.0");
        expect(formatTimelineTime(3.5)).toBe("0:03.5");
        expect(formatTimelineTime(12)).toBe("0:12.0");
        expect(formatTimelineTime(65.44)).toBe("1:05.4");
        expect(formatTimelineTime(-4)).toBe("0:00.0");
    });
});

describe("合成面板时间轴：播放头跟随与连播切换", () => {
    const clips = buildCompositePreviewClips([segment("a", 4), segment("b", 3), segment("c", 5)], { segments: { b: { start: 1, end: 3 }, c: { volume: 0.5 } } });
    // a: 0-4s，b: 4-6s（入点 1 出点 3），c: 6-11s。
    const total = clips.reduce((sum, clip) => sum + clip.length, 0);

    it("给段内媒体时间就能算出播放头的全局秒数", () => {
        expect(resolveCompositePlayback(clips, 0, 0)?.seconds).toBe(0);
        expect(resolveCompositePlayback(clips, 0, 2.5)?.seconds).toBe(2.5);
        // 第二段入点是 1s：媒体时间 1s 对应时间轴 4s。
        expect(resolveCompositePlayback(clips, 1, 1)?.seconds).toBe(4);
        expect(resolveCompositePlayback(clips, 1, 2.5)?.seconds).toBe(5.5);
        expect(resolveCompositePlayback(clips, 2, 3)?.seconds).toBe(9);
        expect(resolveCompositePlayback(clips, 3, 0)).toBeNull();
    });

    it("段尾只认入出点算出的净长度，而不是源视频全长", () => {
        // b 段源视频 3s，但出点设在 3s、入点 1s，播到媒体时间 3s 就该切段。
        expect(resolveCompositePlayback(clips, 1, 2.9)?.finished).toBe(false);
        expect(resolveCompositePlayback(clips, 1, 3)?.finished).toBe(true);
    });

    it("每段音量带淡入淡出，且封顶在浏览器音量上限 1", () => {
        const faded = buildCompositePreviewClips([segment("a", 4)], { segments: { a: { fadeIn: 2, fadeOut: 2 } } });
        expect(resolveCompositePlayback(faded, 0, 0)?.volume).toBe(0);
        expect(resolveCompositePlayback(faded, 0, 1)?.volume).toBe(0.5);
        expect(resolveCompositePlayback(faded, 0, 2)?.volume).toBe(1);
        expect(resolveCompositePlayback(faded, 0, 3.8)?.volume).toBeCloseTo(0.1, 5);
        // 面板允许 400% 音量，浏览器音量上限是 1，预览只能封顶（多出来的增益只在 FFmpeg 侧生效）。
        const loud = buildCompositePreviewClips([segment("a", 4)], { segments: { a: { volume: 2 } } });
        expect(resolveCompositePlayback(loud, 0, 2)?.volume).toBe(1);
    });

    it("播放中定位：全局秒数能反查成第几段与段内媒体时间", () => {
        expect(resolveCompositeSeek(clips, 0)).toEqual({ index: 0, currentTime: 0 });
        expect(resolveCompositeSeek(clips, 3.5)).toEqual({ index: 0, currentTime: 3.5 });
        // 4s 正好是第二段的起点，段内媒体时间落在入点 1s 上。
        expect(resolveCompositeSeek(clips, 4)).toEqual({ index: 1, currentTime: 1 });
        expect(resolveCompositeSeek(clips, 5.5)).toEqual({ index: 1, currentTime: 2.5 });
        expect(resolveCompositeSeek(clips, 6)).toEqual({ index: 2, currentTime: 0 });
        // 超出总时长时钳在最后一段末尾。
        expect(resolveCompositeSeek(clips, 99)).toEqual({ index: 2, currentTime: 5 });
    });

    it("按 30fps 假时钟走完整条时间轴：播放头单调、切换点正确、末段停表", () => {
        const step = 1 / 30;
        const switches: number[] = [];
        const seen: number[] = [];
        let index = 0;
        let currentTime = clips[0]!.start;

        // 与组件里 requestAnimationFrame 循环体同一套纯函数：读 currentTime → 算播放头 → 段尾切下一段。
        for (let frame = 0; frame < 2000; frame += 1) {
            const state = resolveCompositePlayback(clips, index, currentTime);
            if (!state) break;
            seen.push(state.seconds);
            if (state.finished) {
                const next = clips.findIndex((clip, i) => i > state.index && clip.length > 0);
                if (next < 0) break;
                switches.push(next);
                index = next;
                currentTime = clips[next]!.start;
                continue;
            }
            currentTime += step;
        }

        expect(switches).toEqual([1, 2]);
        expect(seen.every((seconds, i) => i === 0 || seconds >= seen[i - 1]!)).toBe(true);
        // 末段播完时播放头停在总时长上，且不越界。
        expect(seen[seen.length - 1]).toBeGreaterThan(total - 0.1);
        expect(Math.max(...seen)).toBeLessThanOrEqual(total);
    });
});

describe("合成面板时间轴：标尺、播放头与预览按钮", () => {
    const node: CanvasNodeData = {
        id: "composite-1",
        type: CanvasNodeType.Composite,
        title: "合成",
        position: { x: 0, y: 0 },
        width: 520,
        height: 600,
        metadata: { compositeSettings: { fps: 30, longEdge: 1080 } },
    };
    const segments = [segment("a", 4), segment("b", 3), segment("c", 5)];
    const render = () =>
        renderToStaticMarkup(
            <CanvasCompositePanel node={node} segments={segments} music={null} voice={null} isRunning={false} onChange={noop} onRun={noop} onReorderConnections={noop} onRemoveConnection={noop} onFocusReference={noop} />,
        );

    it("渲染时间标尺、总时长、播放头与 1 个预览播放器", () => {
        const markup = render();

        // 总时长 12s 走 2s 一档刻度，标尺上出现 0/2/4/6/8/10 与单位「秒」。
        expect(markup).toContain(">秒<");
        for (const tick of ["0", "2", "4", "6", "8", "10"]) expect(markup).toContain(`>${tick}</span>`);
        expect(markup).toContain("0:12.0");
        expect(markup).toContain("data-composite-playhead");
        expect(markup).toContain('aria-label="顺序连播预览"');
        expect(markup).toContain("预览仅用于对时");
        // 3 个片段缩略图 + 1 个顺序预览用的隐藏播放器。
        expect(markup.match(/<video/g)?.length).toBe(segments.length + 1);
    });
});
