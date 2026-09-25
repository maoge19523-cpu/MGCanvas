import { describe, expect, it } from "vitest";

import { editAudioGainShape } from "@/lib/edit/audio-gain";
import { editTrackAudibility, resolveAudibleTracks } from "@/lib/edit/audio-mix";
import { EDIT_AUDIO_DRIFT_TOLERANCE, editAudioDriftSeconds, editAudioPreviewElementVolume, editAudioPreviewGain, editAudioPreviewPlan, editAudioPreviewState, type EditAudioPreviewTrack } from "@/lib/edit/audio-preview";
import { editDriftAction } from "@/lib/edit/playback-clock";
import type { EditAudioTrack, EditMedia } from "@/types/edit";

/**
 * 预览混音的纯计算：给一个播放时刻，算出每条音轨此刻以多大增益出声、处于素材内的哪个位置。
 * 期望值全部按导出侧 ffmpeg_compose.rs 的 track_chain 手算：
 * `volume → atrim=end=total → afade in(st=0,d=fadeIn) → afade out(st=span−fadeOut,d=fadeOut) → adelay=start`。
 */

const TOTAL = 10;

function audioMedia(overrides: Partial<EditMedia> & { id: string }): EditMedia {
    return { name: overrides.id, kind: "audio", source: "local", url: `blob:${overrides.id}`, durationMs: 30000, createdAt: "2024-01-01T00:00:00.000Z", ...overrides };
}

function videoMedia(id: string): EditMedia {
    return { id, name: id, kind: "video", source: "local", url: `blob:${id}`, durationMs: 5000, createdAt: "2024-01-01T00:00:00.000Z" };
}

function track(overrides: Partial<EditAudioTrack> & { id: string }): EditAudioTrack {
    return { mediaId: "m1", volume: 1, fadeIn: 0, fadeOut: 0, loop: false, ...overrides };
}

/** 计划里那条轨（顺便断言它真的进了计划）。 */
function planned(tracks: EditAudioTrack[], media: EditMedia[], id: string, total = TOTAL, urls: Record<string, string> = {}): EditAudioPreviewTrack {
    const found = editAudioPreviewPlan(tracks, media, urls, total).tracks.find((item) => item.id === id);
    expect(found, `音轨 ${id} 应该在预览计划里`).toBeTruthy();
    return found!;
}

describe("预览音轨：哪条轨进混音（与导出同一份判定）", () => {
    const media = [audioMedia({ id: "m1" }), audioMedia({ id: "m2" }), videoMedia("v1")];

    it("静音轨整条不进预览，被独奏排除的轨也不进——判定就是 resolveAudibleTracks", () => {
        const tracks = [track({ id: "t1" }), track({ id: "t2", muted: true }), track({ id: "t3" })];
        const plan = editAudioPreviewPlan(tracks, media, {}, TOTAL);

        // 计划里的 id 与导出请求构造读的**同一份**结果逐字一致。
        expect(plan.tracks.map((item) => item.id)).toEqual([...resolveAudibleTracks(tracks)]);
        expect(plan.tracks.map((item) => item.id)).toEqual(["t1", "t3"]);
        // 静音轨没有元素、也没有提示：它不是「坏了」，是用户自己关的。
        expect(plan.unavailable).toEqual([]);
    });

    it("有任一轨独奏时，未独奏的轨一律不进预览（与 editTrackAudibility 的结果一致）", () => {
        const tracks = [track({ id: "t1" }), track({ id: "t2", solo: true }), track({ id: "t3", solo: true, muted: true })];
        const plan = editAudioPreviewPlan(tracks, media, {}, TOTAL);

        expect(plan.tracks.map((item) => item.id)).toEqual(["t2"]);
        // 静音的轨即使独奏也不出声（editTrackAudibility 的规则）。
        expect(editTrackAudibility(tracks)).toEqual({ t1: "solo", t2: "audible", t3: "muted" });
    });

    it("没有音轨时不产出任何元素；音轨全部静音同样一条都不产出", () => {
        expect(editAudioPreviewPlan([], media, {}, TOTAL).tracks).toEqual([]);
        expect(editAudioPreviewPlan([track({ id: "t1", muted: true })], media, {}, TOTAL).tracks).toEqual([]);
    });

    it("素材被移除 / 素材不是音频：不进混音，并且记进 unavailable 让界面能解释", () => {
        const tracks = [track({ id: "t1", mediaId: "nope" }), track({ id: "t2", mediaId: "v1" }), track({ id: "t3" })];
        const plan = editAudioPreviewPlan(tracks, media, {}, TOTAL);

        expect(plan.tracks.map((item) => item.id)).toEqual(["t3"]);
        expect(plan.unavailable).toEqual(["nope", "v1"]);
    });

    it("可播放地址还没有解析出来（只有 storageKey）时静默跳过，不误报「素材已移除」", () => {
        const pending = audioMedia({ id: "m9", url: "", storageKey: "edit-audio:1" });
        const plan = editAudioPreviewPlan([track({ id: "t1", mediaId: "m9" })], [pending], {}, TOTAL);

        expect(plan.tracks).toEqual([]);
        expect(plan.unavailable).toEqual([]);
    });

    it("地址与片段预览同一来源：use-edit-media-urls 解析出来的地址优先，其次才是素材上记的地址", () => {
        const plan = editAudioPreviewPlan([track({ id: "t1" })], media, { m1: "asset://localhost/a.mp3" }, TOTAL);
        expect(plan.tracks[0]!.src).toBe("asset://localhost/a.mp3");
        expect(editAudioPreviewPlan([track({ id: "t1" })], media, {}, TOTAL).tracks[0]!.src).toBe("blob:m1");
    });
});

describe("预览音轨：夹取范围与导出 track_chain 逐字一致", () => {
    const media = [audioMedia({ id: "m1" })];

    it("音量夹进 [0,4]、淡入 [0,5]、淡出 [0,10]、起点 [0, 成片总长]", () => {
        const plannedTrack = planned([track({ id: "t1", volume: 9, fadeIn: 9, fadeOut: 99, start: 99 })], media, "t1");
        expect(plannedTrack.volume).toBe(4);
        expect(plannedTrack.fadeIn).toBe(5);
        expect(plannedTrack.fadeOut).toBe(10);
        expect(plannedTrack.start).toBe(TOTAL);
        expect(plannedTrack.span).toBe(0);

        const negative = planned([track({ id: "t1", volume: -2, fadeIn: -1, fadeOut: -1, start: -5 })], media, "t1");
        expect([negative.volume, negative.fadeIn, negative.fadeOut, negative.start]).toEqual([0, 0, 0, 0]);
        expect(negative.span).toBe(TOTAL);
    });

    it("起点缺省 / 0 都表示从 0 秒混入（旧项目语义不变）", () => {
        const plannedTrack = planned([track({ id: "t1" })], media, "t1");
        expect(plannedTrack.start).toBe(0);
        expect(plannedTrack.span).toBe(TOTAL);
    });
});

describe("预览音轨：某一时刻的增益", () => {
    // 起点 2s、音量 50%、淡入 1s、淡出 2s，成片 10s → span 8s，淡出锚点 = 成片末尾 − 2 = 8s。
    const media = [audioMedia({ id: "m1" }), audioMedia({ id: "m2", durationMs: 3000 })];
    const half = planned([track({ id: "t1", volume: 0.5, fadeIn: 1, fadeOut: 2, start: 2 })], media, "t1");

    it("起点之前一秒都不出声", () => {
        expect(editAudioPreviewGain(half, 0)).toBe(0);
        expect(editAudioPreviewGain(half, 1.999)).toBe(0);
        expect(editAudioPreviewState(half, 1.5)).toBeNull();
    });

    it("淡入自音轨起点起算：起点为 0 增益，一个淡入时长之后到满音量", () => {
        expect(editAudioPreviewGain(half, 2)).toBe(0);
        expect(editAudioPreviewGain(half, 2.5)).toBeCloseTo(0.25, 6);
        expect(editAudioPreviewGain(half, 3)).toBeCloseTo(0.5, 6);
        // 淡入结束之后到淡出开始之前是一条平线（音量本身）。
        expect(editAudioPreviewGain(half, 5)).toBeCloseTo(0.5, 6);
    });

    it("淡出收在成片末尾：锚点是 成片总长 − fadeOut（不是音频内容末尾），到末尾归零", () => {
        expect(editAudioPreviewGain(half, 7.999)).toBeCloseTo(0.5, 6);
        expect(editAudioPreviewGain(half, 8)).toBeCloseTo(0.5, 6);
        expect(editAudioPreviewGain(half, 9)).toBeCloseTo(0.25, 6);
        expect(editAudioPreviewGain(half, 9.999)).toBeGreaterThan(0);
        // 成片末尾那一瞬间已经不在成片里（amix duration=first），增益归零。
        expect(editAudioPreviewGain(half, TOTAL)).toBe(0);
    });

    it("淡入 + 淡出 超过能占的时长时两条坡度相乘（导出就是两条 afade 串在同一条链上）", () => {
        // 淡入上限就是 5s（导出 clamp(_,0,5)），所以这里取 5s 淡入 + 6s 淡出，两者在本地 4~5s 重叠。
        const overlap = planned([track({ id: "t1", volume: 1, fadeIn: 5, fadeOut: 6, start: 0 })], media, "t1");
        expect([overlap.fadeIn, overlap.fadeOut]).toEqual([5, 6]);

        // t=4.5：淡入 (4.5/5)=0.9、淡出 (1 − 0.5/6)=0.9167，相乘 = 0.825。
        expect(editAudioPreviewGain(overlap, 4.5)).toBeCloseTo(0.825, 6);
        expect(editAudioPreviewGain(overlap, 5)).toBeCloseTo(5 / 6, 6);
        // 重叠区里这条轨永远到不了满音量（与可视化里的 overlap 标记同一件事）。
        expect(editAudioPreviewGain(overlap, 4.5)).toBeLessThan(1);
        expect(editAudioPreviewGain(overlap, 0)).toBe(0);
        // 只有一条坡度生效的地方照旧是单条线性坡。
        expect(editAudioPreviewGain(overlap, 2.5)).toBeCloseTo(0.5, 6);
    });

    it("音量就是导出那个 volume：100% 时增益为 1、400% 时为 4（元素上限另算，见 elementVolume）", () => {
        const full = planned([track({ id: "t1", volume: 1 }), track({ id: "t2", volume: 4 })], media, "t1");
        const loud = planned([track({ id: "t1", volume: 1 }), track({ id: "t2", volume: 4 })], media, "t2");

        expect(editAudioPreviewGain(full, 3)).toBe(1);
        expect(editAudioPreviewGain(loud, 3)).toBe(4);
        // 浏览器元素音量上限是 1：预览与导出**已知的一处差异**，界面文案里如实写明。
        expect(editAudioPreviewElementVolume(editAudioPreviewGain(loud, 3))).toBe(1);
        expect(editAudioPreviewElementVolume(0.35)).toBe(0.35);
    });

    it("音量拉到 0 的轨整条不出声（导出里 volume=0 就是静音）", () => {
        const silent = planned([track({ id: "t1", volume: 0 })], media, "t1");
        expect(editAudioPreviewGain(silent, 3)).toBe(0);
        expect(editAudioPreviewState(silent, 3)).toEqual({ offsetSeconds: 3, gain: 0 });
    });

    it("音轨超过成片总长的部分按成片总长截断（导出 atrim=end=total）", () => {
        // 素材 30s、起点 0、成片 10s：第 10 秒起（成片之外）不再出声。
        const longer = planned([track({ id: "t1" })], media, "t1");
        expect(longer.sourceSeconds).toBe(30);
        expect(editAudioPreviewState(longer, 9.999)?.offsetSeconds).toBeCloseTo(9.999, 6);
        expect(editAudioPreviewState(longer, TOTAL)).toBeNull();
        expect(editAudioPreviewState(longer, 12)).toBeNull();
        expect(editAudioPreviewGain(longer, 12)).toBe(0);
    });

    it("起点落在成片之外（含正好落在末尾）：一秒都不出声，也不会在末尾突然响一声", () => {
        const outside = planned([track({ id: "t1", start: 12 })], media, "t1");
        expect(outside.span).toBe(0);
        expect(outside.start).toBe(TOTAL);
        expect(editAudioPreviewState(outside, TOTAL)).toBeNull();
        expect(editAudioPreviewGain(outside, TOTAL)).toBe(0);
    });

    it("音轨比成片短时，淡出仍然锚在成片末尾（不是音频内容末尾）——导出就是这么做的", () => {
        // 素材 m2 只有 3 秒、起点 4s、成片 10s → span 6s；淡出 2s。
        // 导出的 afade out 锚点是「成片末尾 − fadeOut」= 本地 4s（绝对 8s）；而音频内容在成片里的
        // 本地 3s 就结束了，所以这一段淡出在成片里其实听不到（可视化把它标成 fadeOutAnchor="shifted"）。
        // 预览必须按同一个锚点算：按「音频内容末尾起淡出」（本地 1s）算出来的曲线与成片不一致。
        const short = planned([track({ id: "t1", volume: 1, fadeOut: 2, start: 4, mediaId: "m2" })], media, "t1");
        expect([short.span, short.sourceSeconds]).toEqual([6, 3]);

        // 本地 2s（绝对 6s）：内容还在，而淡出还没开始 → 满音量。
        // 按音频末尾起淡出的算法在这里只有 0.5。
        expect(editAudioPreviewGain(short, 6)).toBe(1);
        // 内容放完之后不出声，一直等到成片结束。
        expect(editAudioPreviewState(short, 7)).toBeNull();
    });
});

describe("预览音轨：跳转之后的重对齐（素材内位置）", () => {
    const media = [audioMedia({ id: "m1", durationMs: 4000 }), audioMedia({ id: "m2", durationMs: 3000 })];

    it("非循环：素材内的位置就是「播放时刻 − 起点」，播放头往前拖之后重新落到同一位置", () => {
        // m1 只有 4 秒，起点 2s → 出声区间是成片里的 [2, 6)。
        const plain = planned([track({ id: "t1", start: 2, mediaId: "m1" })], media, "t1");

        expect(editAudioPreviewState(plain, 2)!.offsetSeconds).toBe(0);
        expect(editAudioPreviewState(plain, 5.5)!.offsetSeconds).toBeCloseTo(3.5, 6);
        // 跳到任意时刻都是「重算」而不是「累加」：来回跳不会积累偏差。
        expect(editAudioPreviewState(plain, 3)!.offsetSeconds).toBeCloseTo(1, 6);
        expect(editAudioPreviewState(plain, 5.5)!.offsetSeconds).toBeCloseTo(3.5, 6);
        expect(editAudioPreviewState(plain, 2.25)!.offsetSeconds).toBeCloseTo(0.25, 6);
    });

    it("非循环且素材已经放完：不再出声（导出那边是静音，一直等到成片结束）", () => {
        const short = planned([track({ id: "t1", start: 4, mediaId: "m2" })], media, "t1");

        expect(editAudioPreviewState(short, 6.9)!.offsetSeconds).toBeCloseTo(2.9, 6);
        expect(editAudioPreviewState(short, 7)).toBeNull();
        expect(editAudioPreviewState(short, 7.5)).toBeNull();
    });

    it("循环：素材内位置按素材真实时长取模（对应导出的 -stream_loop -1）", () => {
        const looped = planned([track({ id: "t1", start: 0, loop: true, mediaId: "m1" })], media, "t1");

        expect(editAudioPreviewState(looped, 0)!.offsetSeconds).toBe(0);
        expect(editAudioPreviewState(looped, 3.5)!.offsetSeconds).toBeCloseTo(3.5, 6);
        expect(editAudioPreviewState(looped, 4)!.offsetSeconds).toBe(0);
        expect(editAudioPreviewState(looped, 9.5)!.offsetSeconds).toBeCloseTo(1.5, 6);
        // 起点偏移同样参与取模：电影时间 11s → 本地 9s → 素材内 1s。
        const shifted = planned([track({ id: "t1", start: 2, loop: true, mediaId: "m1" })], media, "t1");
        expect(editAudioPreviewState(shifted, 9)!.offsetSeconds).toBeCloseTo(3, 6);
    });

    it("循环 + 成片比音轨长：一直有声音，从不落到 null", () => {
        const looped = planned([track({ id: "t1", start: 0, loop: true, mediaId: "m1" })], media, "t1");
        for (const seconds of [0.5, 4, 7.25, 9.99]) expect(editAudioPreviewState(looped, seconds)).not.toBeNull();
    });

    it("回卷处的等价位置：主时钟刚回到 0.03s、元素还在 19.98s 时不算作 −19.95 秒的偏差", () => {
        // 不取等价点时差值大得离谱，会白 seek 一次、在循环接缝处断一下。
        expect(editAudioDriftSeconds(0.03, 19.98, 20, false)).toBeCloseTo(-19.95, 6);
        expect(editAudioDriftSeconds(0.03, 19.98, 20, true)).toBeCloseTo(0.05, 6);
        expect(editAudioDriftSeconds(3.9, 0.05, 4, true)).toBeCloseTo(-0.15, 6);
        // 没有时长（没探测到）时不做回卷，退化成普通差值。
        expect(editAudioDriftSeconds(5, 4.9, 0, true)).toBeCloseTo(0.1, 6);
        expect(editAudioDriftSeconds(5, 4.9, 20, false)).toBeCloseTo(0.1, 6);
    });

    it("漂移判定用的还是视频那一套 editDriftAction，只是容差按音频放宽到 3 帧", () => {
        const frame = 1 / 30;

        // 音频的容差是 3 帧（0.1s）：一帧的偏差不纠正（音频几十毫秒听不出来，纠正一次要重新解码）。
        expect(editDriftAction(0.05, frame, EDIT_AUDIO_DRIFT_TOLERANCE)).toBe("ok");
        expect(editDriftAction(0.2, frame, EDIT_AUDIO_DRIFT_TOLERANCE)).toBe("skip");
        expect(editDriftAction(-0.2, frame, EDIT_AUDIO_DRIFT_TOLERANCE)).toBe("wait");
        // 同一组偏差在视频那一档（1 帧）里是要纠正的：容差不同、判定函数是同一个。
        expect(editDriftAction(0.05, frame, 1)).toBe("skip");
    });
});

describe("预览音轨：与音轨可视化（lib/edit/audio-gain）画出的坡度同源", () => {
    it("淡出的锚点：可视化画出的「与导出一致」那一档，正是预览增益真正开始下降的时刻", () => {
        const media = [audioMedia({ id: "m1" })];
        const fade = planned([track({ id: "t1", volume: 0.8, fadeIn: 1, fadeOut: 2, start: 1, loop: true })], media, "t1");
        // 画出来的几何：起点 1s、能占 9s（loop 铺满成片剩余部分）、淡入 1s、淡出 2s。
        const shape = editAudioGainShape({ volume: 0.8, fadeIn: 1, fadeOut: 2 }, { start: 1, seconds: 9, total: TOTAL });

        expect(shape.fadeOutAnchor).toBe("none");
        expect(shape.exportFadeOutStart).toBeCloseTo(TOTAL - 2, 6);
        expect(editAudioPreviewGain(fade, 2)).toBeCloseTo(0.8, 6);
        expect(editAudioPreviewGain(fade, 8)).toBeCloseTo(0.8, 6);
        expect(editAudioPreviewGain(fade, 9)).toBeCloseTo(0.4, 6);
        expect(editAudioPreviewGain(fade, 10)).toBe(0);
    });
});
