import { theme } from "antd";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { editWaveformBuckets, waveformColumns, waveformHasSignal, waveformStripSeconds, waveformY } from "@/lib/edit/waveform";
import { formatEditTime } from "@/lib/edit/timeline";
import { ensureEditWaveform, type EditWaveform } from "@/services/edit-waveform";
import { useEditState } from "@/stores/use-edit-store";
import type { EditAudioTrack, EditMedia } from "@/types/edit";

// 写成 `?? []` 会每次渲染都产生新数组，zustand 的 Object.is 比较会因此判定「状态变了」（React #185 的成因之一）。
const EMPTY_TRACKS: EditAudioTrack[] = [];
const EMPTY_MEDIA: EditMedia[] = [];
const EMPTY_PEAKS = new Float32Array(0);

/** 一条音轨的波形状态：数据没到手前 pending，到手后按有没有信号分 ready / silent，出错是 failed。 */
type WaveformStatus = "pending" | "ready" | "silent" | "failed";

/**
 * 时间线下方新增的**音轨行**：剪辑台原来的时间线只画视频片段，音频只以「音轨」列表出现在右侧属性区，
 * 音量 / 淡入淡出都在那里调，但看不到波形也就无法做音画对齐（对白口型、音乐卡点）。
 * 这里给每条音轨一行，按时间线的时间轴铺开波形。
 *
 * 时间对齐的依据：条的位置与宽度都用**百分比**（秒数 / 成片总秒数），与标尺刻度、播放头同一套换算，
 * 所以波形上的某一秒和视频片段上的同一秒在 x 上一致（详见 waveformStripSeconds 与下面的 style.width）。
 *
 * 纪律：绘制只在「数据或尺寸变化」时发生，播放与拖动路径里一次都不写 store / setState——
 * 波形的数据进 ref，尺寸进 ref，canvas 的具体像素尺寸与重绘由 ResizeObserver 直接操作 DOM。
 */
export function EditAudioTrackRow({ projectId, totalSeconds }: { projectId: string; totalSeconds: number }) {
    const { t } = useTranslation();
    const { projects } = useEditState();
    const project = projects.find((item) => item.id === projectId);
    const tracks = project?.audioTracks ?? EMPTY_TRACKS;
    const media = project?.media ?? EMPTY_MEDIA;

    return (
        <div data-edit-audio-track className="thin-scrollbar mt-1.5 flex max-h-[80px] shrink-0 flex-col gap-1 overflow-y-auto">
            {tracks.length ? (
                tracks.map((track) => <AudioTrackStrip key={track.id} track={track} source={media.find((item) => item.id === track.mediaId)} totalSeconds={totalSeconds} />)
            ) : (
                // 没有音轨时也占住这一行：布局稳定，也说明波形会画在哪里。
                <div className="flex h-9 items-center justify-center rounded-[8px] border border-dashed border-black/[0.08] px-2 text-center text-[10px] text-stone-400 dark:border-white/[0.08] dark:text-zinc-600">{t("editor.emptyAudioTracks")}</div>
            )}
        </div>
    );
}

function AudioTrackStrip({ track, source, totalSeconds }: { track: EditAudioTrack; source: EditMedia | undefined; totalSeconds: number }) {
    const { t } = useTranslation();
    const { token } = theme.useToken();
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const stripRef = useRef<HTMLDivElement | null>(null);
    // 波形数据只进 ref：绘制不经过 React，数据到手也只需要重绘一次，不产生任何状态写入。
    const waveformRef = useRef<EditWaveform | null>(null);
    const sizeRef = useRef({ width: 0, height: 0 });
    const [buckets, setBuckets] = useState<number | null>(null);
    const [status, setStatus] = useState<WaveformStatus>("pending");

    const audioSeconds = (source?.durationMs || 0) / 1000;
    const stripSeconds = waveformStripSeconds(audioSeconds, totalSeconds, track.loop);

    const draw = () => {
        const canvas = canvasRef.current;
        const { width, height } = sizeRef.current;
        if (!canvas || width <= 0 || height <= 0) return;
        const context = canvas.getContext("2d");
        if (!context) return;
        context.clearRect(0, 0, width, height);
        const waveform = waveformRef.current;
        // 一列画布像素 = 一列波形极值；数据为空（还没算出来 / 素材没有音频流）时全是 0，只剩中位线。
        const columns = waveformColumns(waveform?.peaks ?? EMPTY_PEAKS, waveform?.troughs ?? EMPTY_PEAKS, width, stripSeconds, audioSeconds, track.loop);
        context.fillStyle = token.colorFill;
        context.fillRect(0, Math.round(height / 2), width, 1);
        context.fillStyle = token.colorPrimary;
        for (let column = 0; column < columns.length; column += 1) {
            const top = Math.round(waveformY(columns[column].peak, height));
            const bottom = Math.round(waveformY(columns[column].trough, height));
            context.fillRect(column, top, 1, Math.max(1, bottom - top));
        }
    };

    // 绘制函数每次渲染刷新（与剪辑台里 shortcutRef / frameFlushRef 同一写法），
    // 这样 ResizeObserver 回调里调用的一定是最新闭包，而回调本身不写任何状态。
    const drawRef = useRef(draw);
    useEffect(() => {
        drawRef.current = draw;
    });

    // 尺寸与档位：canvas 的像素尺寸直接由这里写，只有跨档才更新一次 state（拖动窗口不会每帧重解码）。
    useEffect(() => {
        const strip = stripRef.current;
        const canvas = canvasRef.current;
        if (!strip || !canvas || typeof ResizeObserver === "undefined") return;
        const measure = () => {
            const ratio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
            const width = Math.max(1, Math.round(strip.clientWidth * ratio));
            const height = Math.max(1, Math.round(strip.clientHeight * ratio));
            if (width === sizeRef.current.width && height === sizeRef.current.height) return;
            sizeRef.current = { width, height };
            canvas.width = width;
            canvas.height = height;
            setBuckets((current) => {
                const next = editWaveformBuckets(width);
                return current === next ? current : next;
            });
            drawRef.current();
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(strip);
        return () => observer.disconnect();
    }, []);

    // 取峰值：只在「素材变了 / 档位跨档了」时跑，命中内存缓存就直接返回。
    useEffect(() => {
        // 时长没探测到的素材与「暂不能进入时间线」同一口径：不取波形，只留中位线与提示。
        if (!source || !source.durationMs || buckets === null) return;
        let active = true;
        setStatus("pending");
        void ensureEditWaveform(source, buckets)
            .then((waveform) => {
                if (!active) return;
                waveformRef.current = waveform;
                setStatus(waveform ? (waveformHasSignal(waveform.peaks, waveform.troughs) ? "ready" : "silent") : "failed");
            })
            .catch(() => {
                if (!active) return;
                waveformRef.current = null;
                setStatus("failed");
            });
        return () => {
            active = false;
        };
    }, [source?.id, source?.storageKey, source?.url, source?.localPath, source?.durationMs, buckets]);

    // 数据或尺寸变化后重绘（状态与档位就是这两件事的签名，颜色变化也重绘一次以跟上主题）。
    useEffect(() => {
        draw();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [track.loop, status, buckets, stripSeconds, token.colorPrimary, token.colorFill]);

    const hint = !source ? t("editor.mediaRemoved") : !source.durationMs ? t("editor.noDurationInline") : status === "pending" ? t("editor.waveformPending") : status === "failed" ? t("editor.waveformFailed") : null;

    return (
        <div className="relative h-9 shrink-0 overflow-hidden rounded-[8px] bg-black/[0.03] dark:bg-white/[0.05]" title={source ? `${source.name} · ${formatEditTime(audioSeconds)}` : t("editor.mediaRemoved")}>
            <div
                ref={stripRef}
                data-edit-waveform-strip={track.id}
                className="absolute inset-y-0 left-0 overflow-hidden rounded-[8px] border border-black/[0.09] dark:border-white/[0.09]"
                // 条宽 = 该音轨在成片时间轴上占的秒数 / 成片总秒数：与标尺、播放头同一套百分比换算，x 严格对齐。
                style={{ width: `${totalSeconds > 0 ? (stripSeconds / totalSeconds) * 100 : 0}%` }}
            >
                <canvas ref={canvasRef} data-edit-waveform={track.id} className="block h-full w-full" />
            </div>
            {hint ? (
                <span data-edit-waveform-hint className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-[10px] text-stone-400 dark:text-zinc-600">
                    {hint}
                </span>
            ) : null}
        </div>
    );
}
