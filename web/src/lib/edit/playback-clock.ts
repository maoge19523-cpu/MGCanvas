import type { EditClipView } from "./timeline";

/** 主时钟的时间源：只要能给出单调递增的秒数即可，便于注入假时钟做单元测试。 */
export type EditClockSource = { now: () => number };

/**
 * 优先用 `AudioContext.currentTime` 当主时钟（音频硬件时钟，单调、不受 rAF 节流影响）。
 * 只有它**真的在跑**（state === "running"）时才采用：被自动播放策略挂起的 AudioContext
 * 的 currentTime 是不走的，用它会把播放头冻住，所以挂起时一律退化成 performance.now()。
 * 时钟源只解析一次，绝不中途切换——中途换源会让时间跳变。
 */
let resolvedSource: EditClockSource | null = null;

export async function resolveEditClockSource(): Promise<EditClockSource> {
    if (resolvedSource) return resolvedSource;
    const Ctor = globalThis.AudioContext;
    if (typeof Ctor === "function") {
        try {
            const context = new Ctor();
            if (context.state === "suspended") await context.resume().catch(() => undefined);
            if (context.state === "running") {
                resolvedSource = { now: () => context.currentTime };
                return resolvedSource;
            }
        } catch {
            // 拿不到 AudioContext（无头环境、被策略拒绝）时用单调时钟兜底。
        }
    }
    resolvedSource = { now: () => performance.now() / 1000 };
    return resolvedSource;
}

/** 一帧的秒数；帧率非法时按 30fps 兜底。 */
export function editFrameSeconds(fps: number) {
    return 1 / (Number.isFinite(fps) && fps > 0 ? fps : 30);
}

/**
 * 主时钟主导的播放时钟：`currentTime` 是播放时间的唯一真相，
 * 各段 <video> 的 currentTime 只是被对齐的对象。
 */
export class EditPlaybackClock {
    private origin = 0;
    private base = 0;
    private held = 0;
    private running = false;

    constructor(private readonly source: EditClockSource) {}

    get playing() {
        return this.running;
    }

    get currentTime() {
        if (!this.running) return this.held;
        return Math.max(0, this.base + (this.source.now() - this.origin));
    }

    /** 从 from 起播；不传则从当前停住的位置继续（暂停 / 恢复靠这一句对齐）。 */
    play(from?: number) {
        const start = from ?? this.currentTime;
        this.base = Math.max(0, start);
        this.held = this.base;
        this.origin = this.source.now();
        this.running = true;
    }

    pause() {
        this.held = this.currentTime;
        this.running = false;
    }

    /** 拖动播放头后重新起播：把主时钟重新基准到这一秒，而不是让视频自己去追。 */
    seek(seconds: number) {
        this.held = Math.max(0, seconds);
        if (this.running) {
            this.base = this.held;
            this.origin = this.source.now();
        }
    }
}

/** 该段在全局秒数处对应的媒体时间（段内秒数），超出本段时夹到本段首尾。 */
export function editDesiredMediaSeconds(view: EditClipView, seconds: number) {
    return view.start + Math.max(0, Math.min(seconds - view.offset, view.length));
}

/** 偏差 = 期望的媒体时间 − 视频当前的媒体时间。正数表示视频落后，负数表示视频超前。 */
export function editDriftSeconds(desiredMediaSeconds: number, videoSeconds: number) {
    return desiredMediaSeconds - videoSeconds;
}

export type EditDriftAction = "ok" | "skip" | "wait";

/**
 * 偏差判定，阈值是一帧：
 * - 视频落后超过一帧 → `skip`：直接跳到正确的媒体时间（丢帧追赶）。
 * - 视频超前超过一帧 → `wait`：暂停播放、重复当前帧等主时钟追上来（补帧等待）。
 * - 一帧以内 → `ok`：不动，避免来回 seek 抖动。
 */
export function editDriftAction(driftSeconds: number, frameSeconds: number, tolerance = 1): EditDriftAction {
    if (!Number.isFinite(driftSeconds) || !(frameSeconds > 0)) return "ok";
    const limit = frameSeconds * Math.max(0, tolerance);
    if (!(limit > 0)) return "ok";
    if (driftSeconds > limit) return "skip";
    if (driftSeconds < -limit) return "wait";
    return "ok";
}

/** 追赶用的硬 seek 有代价，两次之间至少隔这么久，避免高帧率下反复 seek。 */
export const EDIT_DRIFT_COOLDOWN_MS = 300;

export function editDriftCooldownReady(lastCorrectionAt: number, now: number, cooldownMs = EDIT_DRIFT_COOLDOWN_MS) {
    return now - lastCorrectionAt >= cooldownMs;
}

/** 指针速度（像素/秒），用于「快拖不吸附」。 */
export function editPointerVelocity(previousX: number, previousAt: number, clientX: number, now: number) {
    const elapsed = (now - previousAt) / 1000;
    if (!(elapsed > 0)) return 0;
    return Math.abs(clientX - previousX) / elapsed;
}
