export const audioVoiceOptions = [
    { value: "alloy", label: "Alloy" },
    { value: "ash", label: "Ash" },
    { value: "ballad", label: "Ballad" },
    { value: "coral", label: "Coral" },
    { value: "echo", label: "Echo" },
    { value: "fable", label: "Fable" },
    { value: "nova", label: "Nova" },
    { value: "onyx", label: "Onyx" },
    { value: "sage", label: "Sage" },
    { value: "shimmer", label: "Shimmer" },
    { value: "verse", label: "Verse" },
    { value: "marin", label: "Marin" },
    { value: "cedar", label: "Cedar" },
    // 智谱 GLM-TTS 的系统音色。不列进来就选不到，而音色名必须原样发给服务商。
    // 标签保持短：动画圈系列官方名很长，放进三列胶囊里会换行出框，这里只留音色名与来源。
    { value: "tongtong", label: "彤彤（智谱）" },
    { value: "chuichui", label: "锤锤（智谱）" },
    { value: "xiaochen", label: "小陈（智谱）" },
    { value: "jam", label: "Jam（智谱）" },
    { value: "kazi", label: "Kazi（智谱）" },
    { value: "douji", label: "Douji（智谱）" },
    { value: "luodo", label: "Luodo（智谱）" },
];

export const audioFormatOptions = [
    { value: "mp3", label: "MP3" },
    { value: "wav", label: "WAV" },
    { value: "opus", label: "Opus" },
    { value: "aac", label: "AAC" },
    { value: "flac", label: "FLAC" },
    { value: "pcm", label: "PCM" },
];

/**
 * 音色名要原样发给服务商。
 *
 * 此前会把列表外的音色一律改写成 `alloy`，于是智谱的 `tongtong` 被换成 `alloy` 而报参数错误；
 * 现在只把空值回落到默认，其余一律透传，模型脚本与其它服务商的音色名都不会再被吃掉。
 */
export function normalizeAudioVoiceValue(value: string) {
    return (value || "").trim() || "alloy";
}

export function normalizeAudioFormatValue(value: string) {
    return audioFormatOptions.some((item) => item.value === value) ? value : "mp3";
}

/**
 * 空值与非法值一律回落到 1。
 *
 * 此前 `Number("")` 得 0，再被下限夹成 0.25，于是**没设过语速时默认发出去的就是 0.25x**：
 * 面板输入框显示的是 1，状态栏显示 0.25x，两边不一致；而智谱这类服务商的语速下限是 0.5，
 * 默认值直接落进非法区间，请求必被拒。
 */
export function normalizeAudioSpeedValue(value: string) {
    const speed = Number(value);
    if (!String(value ?? "").trim() || !Number.isFinite(speed) || speed <= 0) return "1";
    return String(Math.max(0.25, Math.min(4, Number(speed.toFixed(2)))));
}

export function audioVoiceLabel(value: string) {
    const voice = normalizeAudioVoiceValue(value);
    return audioVoiceOptions.find((item) => item.value === voice)?.label || voice;
}

export function audioFormatLabel(value: string) {
    const format = normalizeAudioFormatValue(value);
    return audioFormatOptions.find((item) => item.value === format)?.label || format;
}

export function audioSpeedLabel(value: string) {
    return `${normalizeAudioSpeedValue(value)}x`;
}

export function audioMimeType(format: string) {
    if (format === "wav") return "audio/wav";
    if (format === "opus") return "audio/opus";
    if (format === "aac") return "audio/aac";
    if (format === "flac") return "audio/flac";
    if (format === "pcm") return "audio/pcm";
    return "audio/mpeg";
}
