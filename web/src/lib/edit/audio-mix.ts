import type { EditAudioTrack } from "@/types/edit";

/** 一条音轨在混音里的处境：正常出声 / 自己静音 / 被别的轨独奏排除。 */
export type EditTrackAudibility = "audible" | "muted" | "solo";

/**
 * 「这条轨到底出不出声」的**唯一判定**：导出请求构造（buildComposeTracks）与轨道头状态显示都只读它，
 * 两处共用同一份结果，避免各写一套规则后悄悄漂移。
 *
 * 规则：muted 一律排除；只要有任一轨 solo === true，未 solo 的轨一并排除；
 * solo 与 muted 叠加时以「被排除」为准（静音的轨即使 solo 也不出声）。
 */
export function editTrackAudibility(tracks: EditAudioTrack[]): Record<string, EditTrackAudibility> {
    const soloed = tracks.some((track) => track.solo === true);
    const states: Record<string, EditTrackAudibility> = {};
    for (const track of tracks) {
        if (track.muted === true) states[track.id] = "muted";
        else if (soloed && track.solo !== true) states[track.id] = "solo";
        else states[track.id] = "audible";
    }
    return states;
}

/** 实际出声的音轨 id：导出只把这些轨交给 FFmpeg，其余整条跳过（等于既不出声也不参与混音补偿）。 */
export function resolveAudibleTracks(tracks: EditAudioTrack[]): Set<string> {
    const states = editTrackAudibility(tracks);
    return new Set(tracks.filter((track) => states[track.id] === "audible").map((track) => track.id));
}
