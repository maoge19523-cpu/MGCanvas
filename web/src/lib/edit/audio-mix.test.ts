import { describe, expect, it } from "vitest";

import { editTrackAudibility, resolveAudibleTracks } from "./audio-mix";
import type { EditAudioTrack } from "@/types/edit";

function track(id: string, patch: Partial<EditAudioTrack> = {}): EditAudioTrack {
    return { id, mediaId: `m-${id}`, volume: 1, fadeIn: 0, fadeOut: 0, loop: false, ...patch };
}

/** 出声的轨 id，按输入顺序排好便于断言。 */
function audibleIds(tracks: EditAudioTrack[]) {
    const audible = resolveAudibleTracks(tracks);
    return tracks.filter((item) => audible.has(item.id)).map((item) => item.id);
}

describe("剪辑台混音判定：哪些音轨真的出声", () => {
    it("又没静音又没独奏：每条轨都出声", () => {
        const tracks = [track("t1"), track("t2"), track("t3")];
        expect(audibleIds(tracks)).toEqual(["t1", "t2", "t3"]);
        expect(editTrackAudibility(tracks)).toEqual({ t1: "audible", t2: "audible", t3: "audible" });
    });

    it("有静音：静音的轨不出声，其余照常", () => {
        const tracks = [track("t1"), track("t2", { muted: true }), track("t3")];
        expect(audibleIds(tracks)).toEqual(["t1", "t3"]);
        expect(editTrackAudibility(tracks).t2).toBe("muted");
    });

    it("有独奏：只有独奏的轨出声，其余全部被排除", () => {
        const tracks = [track("t1"), track("t2", { solo: true }), track("t3")];
        expect(audibleIds(tracks)).toEqual(["t2"]);
        expect(editTrackAudibility(tracks)).toEqual({ t1: "solo", t2: "audible", t3: "solo" });
    });

    it("独奏 + 静音叠加：以「被排除」为准（静音的轨即使独奏也不出声）", () => {
        const tracks = [track("t1", { solo: true, muted: true }), track("t2", { solo: true }), track("t3")];
        expect(audibleIds(tracks)).toEqual(["t2"]);
        // 静音优先登记成 muted，独奏与否都不改这个结论。
        expect(editTrackAudibility(tracks).t1).toBe("muted");
        expect(editTrackAudibility(tracks).t3).toBe("solo");
    });

    it("全部独奏：所有没静音的轨都出声", () => {
        const tracks = [track("t1", { solo: true }), track("t2", { solo: true }), track("t3", { solo: true, muted: true })];
        expect(audibleIds(tracks)).toEqual(["t1", "t2"]);
    });

    it("空数组：没有任何轨出声，也不报错", () => {
        expect(audibleIds([])).toEqual([]);
        expect(resolveAudibleTracks([]).size).toBe(0);
        expect(editTrackAudibility([])).toEqual({});
    });

    it("旧项目里三个字段全是 undefined 时语义等同「不静音 / 不独奏 / 不锁定」", () => {
        // 老数据里没有这三个键，读进来就是 undefined：判定必须与显式 false 完全一致。
        const legacy = [track("t1"), track("t2")];
        const explicit = [track("t1", { muted: false, solo: false, locked: false }), track("t2", { muted: false, solo: false, locked: false })];
        expect(audibleIds(legacy)).toEqual(audibleIds(explicit));
        expect(editTrackAudibility(legacy)).toEqual(editTrackAudibility(explicit));
    });
});
