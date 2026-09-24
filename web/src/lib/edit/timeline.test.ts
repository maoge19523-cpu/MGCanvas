import { describe, expect, it } from "vitest";

import { buildComposeRequest, buildComposeSegments, buildComposeTracks, buildEditClips, editOutputSeconds, editPlaybackSeconds, editTickLabel, editTickStep, editTransitionSeconds, formatEditTime, resolveEditPlayback, resolveEditSeek } from "./timeline";
import { EDIT_DEFAULT_OUTPUT, EDIT_TRANSITIONS, normalizeEditTransition, type EditClip, type EditMedia, type EditProject } from "@/types/edit";

function media(id: string, seconds: number | undefined, kind: "video" | "audio" = "video"): EditMedia {
    return { id, name: `素材${id.toUpperCase()}`, kind, source: "local", url: `blob:${id}`, durationMs: seconds === undefined ? undefined : Math.round(seconds * 1000), width: 1920, height: 1080, createdAt: "2024-01-01T00:00:00.000Z" };
}

function clip(id: string, mediaId: string, patch: Partial<EditClip> = {}): EditClip {
    return { id, mediaId, start: 0, end: 0, volume: 1, fadeIn: 0, fadeOut: 0, ...patch };
}

function project(patch: Partial<EditProject> = {}): EditProject {
    return {
        id: "edit-1",
        name: "测试剪辑",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        media: [media("a", 6), media("b", 5), media("c", 4)],
        clips: [clip("c1", "a", { start: 1, end: 5 }), clip("c2", "b"), clip("c3", "c", { start: 0.5, end: 3.5 })],
        audioTracks: [],
        output: { ...EDIT_DEFAULT_OUTPUT },
        ...patch,
    };
}

describe("剪辑台时间线：时长换算", () => {
    it("按素材真实时长与入出点算出每段净时长与起点，顺序即片段列表顺序", () => {
        const views = buildEditClips(project().media, project().clips);

        expect(views.map((view) => [view.id, view.offset, view.length])).toEqual([
            ["c1", 0, 4],
            ["c2", 4, 5],
            ["c3", 9, 3],
        ]);
        expect(views.map((view) => [view.start, view.end])).toEqual([
            [1, 5],
            [0, 5],
            [0.5, 3.5],
        ]);
        expect(editPlaybackSeconds(views)).toBe(12);
    });

    it("出点为 0 表示整段到素材末尾；超过素材全长时按素材全长截断", () => {
        const views = buildEditClips([media("a", 4)], [clip("c1", "a"), clip("c2", "a", { end: 99 })]);
        expect(views.map((view) => [view.start, view.end, view.length])).toEqual([
            [0, 4, 4],
            [0, 4, 4],
        ]);
    });

    it("素材缺少时长信息时该段长度为 0、并标记未探测到时长，不影响其它段起点", () => {
        const views = buildEditClips([media("a", undefined), media("b", 3)], [clip("c1", "a"), clip("c2", "b")]);
        expect(views.map((view) => view.length)).toEqual([0, 3]);
        expect(views.map((view) => view.offset)).toEqual([0, 0]);
        expect(views.map((view) => view.hasDuration)).toEqual([false, true]);
    });

    it("素材已被移除时片段仍占位，但显示名与播放地址回落为空", () => {
        const views = buildEditClips([], [clip("c1", "gone")]);
        expect(views[0]!.name).toBe("素材已移除");
        expect(views[0]!.src).toBe("");
        expect(views[0]!.hasDuration).toBe(false);
    });
});

describe("剪辑台时间线：转场与成片时长", () => {
    const views = buildEditClips(project().media, project().clips);

    it("没设转场的接缝不计时长（硬切）", () => {
        expect(editTransitionSeconds(views)).toEqual([0, 0, 0]);
        expect(editOutputSeconds(views)).toBe(12);
    });

    it("转场时长口径与 FFmpeg 侧一致：不超过相邻两段较短者的八成，并限制在 0.1–1.5 秒", () => {
        // 第二段 5s、第三段 3s：八成是 2.4s，超出上限 1.5s，实际取 1.5s。
        const long = buildEditClips(project().media, [clip("c1", "a", { transition: "fade", transitionDuration: 3 }), clip("c2", "b"), clip("c3", "c")]);
        expect(editTransitionSeconds(long)[0]).toBeCloseTo(1.5, 5);

        // 短段：第一段只剩 0.2s 时，八成是 0.16s，高于下限 0.1s，取 0.16s。
        const short = buildEditClips([media("a", 10), media("b", 10)], [clip("c1", "a", { start: 0, end: 0.2, transition: "fade", transitionDuration: 1 }), clip("c2", "b")]);
        expect(editTransitionSeconds(short)[0]).toBeCloseTo(0.16, 5);

        // 转场会让成片比各段之和短一个转场时长：三段全长 6+5+4=15s，只剩第一道接缝有转场。
        expect(editOutputSeconds(long)).toBeCloseTo(15 - 1.5, 5);
    });
});

describe("剪辑台时间线：播放头与顺序连播", () => {
    const views = buildEditClips(project().media, project().clips);
    // c1: 0-4s，c2: 4-9s，c3: 9-12s。

    it("给段内媒体时间就能算出播放头的全局秒数", () => {
        expect(resolveEditPlayback(views, 0, 0)?.seconds).toBe(0);
        // 第一段入点是 1s：媒体时间 1s 对应时间轴 0s，媒体时间 2.5s 对应 1.5s。
        expect(resolveEditPlayback(views, 0, 2.5)?.seconds).toBe(1.5);
        expect(resolveEditPlayback(views, 0, 1)?.seconds).toBe(0);
        expect(resolveEditPlayback(views, 1, 2.5)?.seconds).toBe(6.5);
        expect(resolveEditPlayback(views, 7, 0)).toBeNull();
    });

    it("段尾只认入出点算出的净长度，而不是源素材全长", () => {
        expect(resolveEditPlayback(views, 0, 4.9)?.finished).toBe(false);
        expect(resolveEditPlayback(views, 0, 5)?.finished).toBe(true);
    });

    it("每段音量带淡入淡出，且封顶在浏览器音量上限 1", () => {
        const faded = buildEditClips([media("a", 4)], [clip("c1", "a", { fadeIn: 2, fadeOut: 2 })]);
        expect(resolveEditPlayback(faded, 0, 0)?.volume).toBe(0);
        expect(resolveEditPlayback(faded, 0, 1)?.volume).toBe(0.5);
        expect(resolveEditPlayback(faded, 0, 2)?.volume).toBe(1);
        const loud = buildEditClips([media("a", 4)], [clip("c1", "a", { volume: 2 })]);
        expect(resolveEditPlayback(loud, 0, 2)?.volume).toBe(1);
    });

    it("播放中定位：全局秒数能反查成第几段与段内媒体时间", () => {
        expect(resolveEditSeek(views, 0)).toEqual({ index: 0, currentTime: 1 });
        expect(resolveEditSeek(views, 4)).toEqual({ index: 1, currentTime: 0 });
        expect(resolveEditSeek(views, 6.5)).toEqual({ index: 1, currentTime: 2.5 });
        expect(resolveEditSeek(views, 99)).toEqual({ index: 2, currentTime: 3.5 });
    });

    it("按 30fps 假时钟走完整条时间轴：播放头单调、切换点正确、末段停表", () => {
        const step = 1 / 30;
        const switches: number[] = [];
        const seen: number[] = [];
        let index = 0;
        let currentTime = views[0]!.start;

        for (let frame = 0; frame < 2000; frame += 1) {
            const state = resolveEditPlayback(views, index, currentTime);
            if (!state) break;
            seen.push(state.seconds);
            if (state.finished) {
                const next = views.findIndex((view, i) => i > state.index && view.length > 0);
                if (next < 0) break;
                switches.push(next);
                index = next;
                currentTime = views[next]!.start;
                continue;
            }
            currentTime += step;
        }

        expect(switches).toEqual([1, 2]);
        expect(seen.every((seconds, i) => i === 0 || seconds >= seen[i - 1]!)).toBe(true);
        expect(seen[seen.length - 1]).toBeGreaterThan(12 - 0.1);
    });
});

describe("剪辑台时间线：标尺与读数", () => {
    it("刻度步长随总时长自适应，刻度数不超过 8 个", () => {
        expect(editTickStep(3)).toBe(0.5);
        expect(editTickStep(12)).toBe(2);
        expect(editTickStep(60)).toBe(10);
        expect(editTickStep(900)).toBe(120);
    });

    it("超过一分钟的刻度写成 分:秒，秒级刻度保留十分位", () => {
        expect(editTickLabel(0, 2)).toBe("0");
        expect(editTickLabel(12, 2)).toBe("12");
        expect(editTickLabel(0.5, 0.5)).toBe("0.5");
        expect(editTickLabel(90, 30)).toBe("1:30");
    });

    it("播放头读数固定为 分:秒.十分位", () => {
        expect(formatEditTime(0)).toBe("0:00.0");
        expect(formatEditTime(3.5)).toBe("0:03.5");
        expect(formatEditTime(65.44)).toBe("1:05.4");
        expect(formatEditTime(-4)).toBe("0:00.0");
    });
});

describe("剪辑台导出：项目数据 → compose_video 入参", () => {
    const paths = { a: "C:\\tmp\\a.mp4", b: "C:\\tmp\\b.mp4", c: "C:\\tmp\\c.mp4", m: "C:\\tmp\\m.mp3" };

    it("视频片段按片段列表顺序映射成 segments，入出点与音量淡入淡出原样带过去", () => {
        const segments = buildComposeSegments({ project: project(), paths });

        expect(segments.map((segment) => segment.path)).toEqual(["C:\\tmp\\a.mp4", "C:\\tmp\\b.mp4", "C:\\tmp\\c.mp4"]);
        expect(segments[0]).toMatchObject({ start: 1, end: 5, volume: 1, fadeIn: 0, fadeOut: 0, subtitle: undefined });
    });

    it("删掉中间一段后顺序就是列表新顺序，与任何连线无关", () => {
        const reordered = project({ clips: [clip("c3", "c"), clip("c1", "a")] });
        expect(buildComposeSegments({ project: reordered, paths }).map((segment) => segment.path)).toEqual(["C:\\tmp\\c.mp4", "C:\\tmp\\a.mp4"]);
    });

    it("拿不到本地路径的片段不进合成，避免把不存在的文件交给 FFmpeg", () => {
        expect(buildComposeSegments({ project: project(), paths: { a: "C:\\tmp\\a.mp4" } }).length).toBe(1);
    });

    it("音频素材只进 tracks，不混进画面拼接", () => {
        const withAudio = project({ media: [...project().media, media("m", 30, "audio")], audioTracks: [{ id: "t1", mediaId: "m", volume: 0.4, fadeIn: 1, fadeOut: 2, loop: true }] });
        expect(buildComposeTracks({ project: withAudio, paths })).toEqual([{ path: "C:\\tmp\\m.mp3", volume: 0.4, fadeIn: 1, fadeOut: 2, loop: true }]);
        expect(buildComposeSegments({ project: withAudio, paths }).length).toBe(3);
    });

    it("整份导出请求带上输出参数与项目名，不涉及画布节点或 compositeSettings", () => {
        const request = buildComposeRequest({ project: project({ output: { ...EDIT_DEFAULT_OUTPUT, longEdge: 720, fps: 24, fadeIn: 0.2, fadeOut: 1, subtitleStyle: "center", subtitleSize: "large" } }), paths });

        expect(request).toMatchObject({ longEdge: 720, fps: 24, fadeIn: 0.2, fadeOut: 1, title: "测试剪辑", subtitleStyle: "center", subtitleSize: "large" });
        expect(request.segments.length).toBe(3);
        expect(request.tracks).toEqual([]);
        expect(Object.keys(request).sort()).toEqual(["fadeIn", "fadeOut", "fps", "longEdge", "segments", "subtitleSize", "subtitleStyle", "title", "tracks"]);
    });

    it("片段上设了转场时，转场与字幕一起进入该段参数", () => {
        const withTransition = project({ clips: [clip("c1", "a", { transition: "wipeleft", transitionDuration: 0.8, subtitle: "第一句" }), clip("c2", "b")] });
        const segments = buildComposeSegments({ project: withTransition, paths });
        expect(segments[0]).toMatchObject({ transition: "wipeleft", transitionDuration: 0.8, subtitle: "第一句" });
    });

    /**
     * 空滤镜名事故的回归护栏：转场字段一旦是空串/未知值，FFmpeg 会把 `xfade=transition=:...`
     * 里的滤镜名解析成空串并报 `No such filter: ""`（退出码 -1279870712），所以进参前必须归一成硬切。
     */
    const assertNoEmptyTransition = (request: ReturnType<typeof buildComposeRequest>) => {
        expect(JSON.stringify(request)).not.toContain('"transition":""');
        request.segments.forEach((segment) => {
            expect(segment.transition === undefined || EDIT_TRANSITIONS.includes(segment.transition as (typeof EDIT_TRANSITIONS)[number])).toBe(true);
        });
    };

    it("转场是空串时按硬切处理：不带 transition，也不带 transitionDuration", () => {
        const empty = project({ clips: [clip("c1", "a", { transition: "", transitionDuration: 0.8 }), clip("c2", "b")] });
        const request = buildComposeRequest({ project: empty, paths });

        expect(request.segments[0]).toMatchObject({ transition: undefined, transitionDuration: undefined });
        expect("transition" in request.segments[0]!).toBe(true);
        expect(request.segments[0]!.transition).toBeUndefined();
        assertNoEmptyTransition(request);
    });

    it("转场是未知字符串时按硬切处理，不会传给 compose_video", () => {
        const unknown = project({ clips: [clip("c1", "a", { transition: "zoom", transitionDuration: 0.8 }), clip("c2", "b", { transition: "  fade  " })] });
        const request = buildComposeRequest({ project: unknown, paths });

        expect(request.segments.map((segment) => segment.transition)).toEqual([undefined, undefined]);
        expect(request.segments.map((segment) => segment.transitionDuration)).toEqual([undefined, undefined]);
        assertNoEmptyTransition(request);
    });

    it("转场是 undefined 时按硬切处理", () => {
        const request = buildComposeRequest({ project: project(), paths });

        expect(request.segments.map((segment) => segment.transition)).toEqual([undefined, undefined, undefined]);
        assertNoEmptyTransition(request);
    });

    it("两个片段是同一个素材时两段都进合成，各自带自己的入出点", () => {
        const same = project({ media: [media("a", 10)], clips: [clip("c1", "a", { start: 1, end: 5 }), clip("c2", "a", { start: 6, end: 9 })] });
        const request = buildComposeRequest({ project: same, paths });

        expect(request.segments.map((segment) => segment.path)).toEqual(["C:\\tmp\\a.mp4", "C:\\tmp\\a.mp4"]);
        expect(request.segments.map((segment) => [segment.start, segment.end])).toEqual([
            [1, 5],
            [6, 9],
        ]);
        assertNoEmptyTransition(request);
    });

    it("片段短到放不下转场时，成片时长与转场秒数按较短者的八成收敛，请求本身仍然合法", () => {
        const tiny = project({ media: [media("a", 0.2), media("b", 0.2)], clips: [clip("c1", "a", { start: 0, end: 0.2, transition: "fade", transitionDuration: 1 }), clip("c2", "b", { start: 0, end: 0.2 })] });
        const views = buildEditClips(tiny.media, tiny.clips);

        expect(editTransitionSeconds(views)[0]).toBeCloseTo(0.16, 5);
        expect(editOutputSeconds(views)).toBeCloseTo(0.4 - 0.16, 5);
        const request = buildComposeRequest({ project: tiny, paths });
        expect(request.segments[0]).toMatchObject({ transition: "fade", transitionDuration: 1 });
        assertNoEmptyTransition(request);
    });
});

describe("剪辑台转场白名单：归一化", () => {
    it("白名单里的转场原样保留，其他值一律变成硬切", () => {
        expect(normalizeEditTransition("fade")).toBe("fade");
        expect(normalizeEditTransition("circleopen")).toBe("circleopen");
        expect(normalizeEditTransition("")).toBeUndefined();
        expect(normalizeEditTransition(undefined)).toBeUndefined();
        expect(normalizeEditTransition("dissolve2")).toBeUndefined();
        expect(normalizeEditTransition("FADE")).toBeUndefined();
    });

    it("同一份白名单用于时间线视图与属性区下拉框", () => {
        expect([...EDIT_TRANSITIONS]).toEqual(["fade", "dissolve", "wipeleft", "wiperight", "slideleft", "slideup", "circleopen"]);
        const views = buildEditClips(project().media, [clip("c1", "a", { transition: "加个转场" })]);
        expect(views[0]!.transition).toBeUndefined();
    });
});
