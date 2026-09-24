import { describe, expect, it } from "vitest";

import { EditPlaybackClock, EDIT_DRIFT_COOLDOWN_MS, editDesiredMediaSeconds, editDriftAction, editDriftCooldownReady, editDriftSeconds, editFrameSeconds, editPointerVelocity, type EditClockSource } from "./playback-clock";
import { buildEditClips } from "./timeline";
import type { EditClip, EditMedia } from "@/types/edit";

function fakeSource() {
    let seconds = 0;
    const source: EditClockSource = { now: () => seconds };
    return { source, advance: (delta: number) => (seconds += delta), set: (value: number) => (seconds = value) };
}

function media(id: string, length: number): EditMedia {
    return { id, name: id, kind: "video", source: "local", url: `blob:${id}`, durationMs: length * 1000, createdAt: "2024-01-01T00:00:00.000Z" };
}

function clip(id: string, mediaId: string, patch: Partial<EditClip> = {}): EditClip {
    return { id, mediaId, start: 0, end: 0, volume: 1, fadeIn: 0, fadeOut: 0, ...patch };
}

describe("剪辑台主时钟：唯一真相的时间来源", () => {
    it("起播后按时间源推进，暂停后停住，恢复时从停住的位置继续", () => {
        const { source, advance } = fakeSource();
        const clock = new EditPlaybackClock(source);
        expect(clock.playing).toBe(false);
        expect(clock.currentTime).toBe(0);
        advance(5);
        expect(clock.currentTime).toBe(0);

        clock.play(2);
        expect(clock.currentTime).toBe(2);
        advance(1.5);
        expect(clock.currentTime).toBeCloseTo(3.5, 6);

        clock.pause();
        advance(10);
        expect(clock.currentTime).toBeCloseTo(3.5, 6);
        expect(clock.playing).toBe(false);

        // 恢复：不传参数就从暂停点继续。
        clock.play();
        expect(clock.currentTime).toBeCloseTo(3.5, 6);
        advance(0.25);
        expect(clock.currentTime).toBeCloseTo(3.75, 6);
    });

    it("拖动播放头后重新起播：seek 把主时钟的基准重新钉在这一秒", () => {
        const { source, advance } = fakeSource();
        const clock = new EditPlaybackClock(source);
        clock.play(0);
        advance(4);
        expect(clock.currentTime).toBeCloseTo(4, 6);

        clock.seek(10);
        expect(clock.currentTime).toBeCloseTo(10, 6);
        advance(1);
        expect(clock.currentTime).toBeCloseTo(11, 6);
    });

    it("暂停状态下 seek 只挪位置，不会自己走起来", () => {
        const { source, advance } = fakeSource();
        const clock = new EditPlaybackClock(source);
        clock.seek(7);
        advance(3);
        expect(clock.currentTime).toBeCloseTo(7, 6);
        expect(clock.playing).toBe(false);
    });

    it("时间不会为负", () => {
        const { source, set } = fakeSource();
        const clock = new EditPlaybackClock(source);
        set(10);
        clock.play(2);
        set(0);
        expect(clock.currentTime).toBe(0);
        clock.seek(-5);
        expect(clock.currentTime).toBe(0);
    });
});

describe("剪辑台漂移校正：阈值与动作", () => {
    const frame = editFrameSeconds(30);

    it("帧率换算：非法帧率按 30fps 兜底", () => {
        expect(frame).toBeCloseTo(1 / 30, 6);
        expect(editFrameSeconds(60)).toBeCloseTo(1 / 60, 6);
        expect(editFrameSeconds(0)).toBeCloseTo(1 / 30, 6);
        expect(editFrameSeconds(Number.NaN)).toBeCloseTo(1 / 30, 6);
    });

    it("偏差超过一帧：视频落后就丢帧追赶，超前就补帧等待，一帧以内不动", () => {
        expect(editDriftAction(2 * frame, frame)).toBe("skip");
        expect(editDriftAction(frame + 0.001, frame)).toBe("skip");
        expect(editDriftAction(-2 * frame, frame)).toBe("wait");
        expect(editDriftAction(-frame - 0.001, frame)).toBe("wait");
        expect(editDriftAction(frame / 2, frame)).toBe("ok");
        expect(editDriftAction(-frame / 2, frame)).toBe("ok");
        expect(editDriftAction(0, frame)).toBe("ok");
    });

    it("容差可以放宽到多帧，帧率非法时不做任何校正", () => {
        expect(editDriftAction(1.5 * frame, frame, 2)).toBe("ok");
        expect(editDriftAction(2.5 * frame, frame, 2)).toBe("skip");
        expect(editDriftAction(5, 0)).toBe("ok");
        expect(editDriftAction(Number.NaN, frame)).toBe("ok");
    });

    it("追赶用的硬 seek 有冷却，避免高帧率下反复 seek", () => {
        expect(editDriftCooldownReady(0, EDIT_DRIFT_COOLDOWN_MS - 1)).toBe(false);
        expect(editDriftCooldownReady(0, EDIT_DRIFT_COOLDOWN_MS)).toBe(true);
        expect(editDriftCooldownReady(0, 10, 5)).toBe(true);
    });

    it("期望媒体时间：全局秒数换算成段内媒体时间，并夹在本段入出点之间（片段切换点与段尾都对）", () => {
        const views = buildEditClips([media("a", 6), media("b", 5)], [clip("c1", "a", { start: 1, end: 5 }), clip("c2", "b")]);
        // c1 全局 0–4s，入点 1s。
        expect(editDesiredMediaSeconds(views[0]!, 0)).toBe(1);
        expect(editDesiredMediaSeconds(views[0]!, 2.5)).toBe(3.5);
        expect(editDesiredMediaSeconds(views[0]!, 4)).toBe(5);
        expect(editDesiredMediaSeconds(views[0]!, 99)).toBe(5);
        expect(editDesiredMediaSeconds(views[0]!, -3)).toBe(1);
        // c2 全局 4–9s，入点 0s。
        expect(editDesiredMediaSeconds(views[1]!, 4)).toBe(0);
        expect(editDesiredMediaSeconds(views[1]!, 6.5)).toBe(2.5);
    });

    it("偏差 = 期望媒体时间 − 视频当前时间，符号决定追赶方向", () => {
        expect(editDriftSeconds(3, 3)).toBe(0);
        expect(editDriftSeconds(3.2, 3)).toBeCloseTo(0.2, 6);
        expect(editDriftSeconds(3, 3.2)).toBeCloseTo(-0.2, 6);
    });

    it("指针速度用于「快拖不吸附」，时间差为 0 时返回 0 而不是 Infinity", () => {
        expect(editPointerVelocity(0, 0, 100, 100)).toBeCloseTo(1000, 6);
        expect(editPointerVelocity(0, 0, -100, 100)).toBeCloseTo(1000, 6);
        expect(editPointerVelocity(0, 50, 100, 50)).toBe(0);
    });
});
