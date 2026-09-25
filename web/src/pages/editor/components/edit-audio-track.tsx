import { Button, Popover, Tooltip, theme } from "antd";
import { Headphones, Lock, LockOpen, Plus, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";

import { EDIT_VOLUME_MAX, EDIT_VOLUME_MIN, editAudioGainShape, editGainAreaText, editGainHeightPercent, editGainPointsText, editVolumeFromDrag, editVolumeLabel, editVolumeReadout, editVolumeSnap, editVolumeStep } from "@/lib/edit/audio-gain";
import { editTrackAudibility, type EditTrackAudibility } from "@/lib/edit/audio-mix";
import { editTrackDraggable, editTrackStartLimit, type EditSnapPoint, type EditSnapResult } from "@/lib/edit/timeline-edit";
import { editWaveformBuckets, waveformColumns, waveformHasSignal, waveformStripSeconds, waveformY } from "@/lib/edit/waveform";
import { formatEditTime } from "@/lib/edit/timeline";
import { timeToPercent } from "@/lib/timeline-scale";
import { ensureEditWaveform, type EditWaveform } from "@/services/edit-waveform";
import { useEditState } from "@/stores/use-edit-store";
import type { EditAudioTrack, EditMedia } from "@/types/edit";

// 写成 `?? []` 会每次渲染都产生新数组，zustand 的 Object.is 比较会因此判定「状态变了」（React #185 的成因之一）。
const EMPTY_TRACKS: EditAudioTrack[] = [];
const EMPTY_MEDIA: EditMedia[] = [];
const EMPTY_PEAKS = new Float32Array(0);

/**
 * 轨道头开关的两套类名：激活态给一层双主题都看得清的底色，未激活态保持透明。
 * 底色只用既有 Tailwind 双主题类（不写死颜色），状态色另外走 antd token（见下面的图标 style）。
 * 视频轨的轨道头（edit-stage）也用同一套，避免两处各写一份后悄悄漂移。
 */
export const TRACK_TOGGLE_ON = "bg-black/[0.09] dark:bg-white/[0.14]";
export const TRACK_TOGGLE_OFF = "bg-transparent";

/** 一条音轨的波形状态：数据没到手前 pending，到手后按有没有信号分 ready / silent，出错是 failed。 */
type WaveformStatus = "pending" | "ready" | "silent" | "failed";

/**
 * 音轨拖动的共用上下文：**由时间线容器（edit-stage）提供**，因为吸附候选点、吸附阈值、
 * 吸附导引线在整条时间线上只有那一份（与片段拖动共用同一套），音轨行不另造第二套吸附。
 */
export type EditTrackDrag = {
    /** 按下时播种指针速度：「快拖不吸附」判据用的就是它，拖动过程中不再写任何状态。 */
    begin: (event: ReactPointerEvent<HTMLElement>) => void;
    /** 求落点：复用时间线的吸附（0 秒 / 播放头 / 片段边界 / 网格）并夹进 [0, 成片总长]。 */
    place: (event: ReactPointerEvent<HTMLElement>, rawSeconds: number) => EditSnapResult;
    /** 显示 / 收起吸附导引线（与片段拖动共用同一条线）。 */
    guide: (point: EditSnapPoint | null) => void;
    /** 松手时才调用：提交一次起始时间（0 回缺省）。 */
    commit: (trackId: string, start: number) => void;
    /** 锁定轨被拖动时的反馈。 */
    refuse: () => void;
};


/**
 * 时间线下方新增的**音轨行**：剪辑台原来的时间线只画视频片段，音频只以「音轨」列表出现在右侧属性区，
 * 音量 / 淡入淡出都在那里调，但看不到波形也就无法做音画对齐（对白口型、音乐卡点）。
 * 这里给每条音轨一行，按时间线的时间轴铺开波形。
 *
 * 时间对齐的依据：条的位置与宽度都用**百分比**（秒数 / 成片总秒数），与标尺刻度、播放头同一套换算，
 * 所以波形上的某一秒和视频片段上的同一秒在 x 上一致（详见 waveformStripSeconds 与下面的 style.width）。
 * 起始时间（track.start）同样只由 timeToPercent 换算成 left，不自己写第二套百分比。
 *
 * 同一行上还画着**音量基准线**与**淡入淡出坡度**（本文件下半部分），两类元素的定位方式按纪律分开：
 * - 折线是**覆盖层**（整行铺满的 SVG，绝对定位、不参与宽度分配）；
 * - 音量基准线是**按时间定位的内容**（与波形条 / 字幕块同类），left / width 都由 timeToPercent 给出，
 *   与同一行波形条的左右边缘严格重合。
 * 两者都绝对定位、都不从轨道宽度里取像素，所以标尺 / 播放头 / 片段条 / 字幕块的百分比一个都没动。
 * 音量基准线还能上下拖动改音量：拖动期间只写 ref 与 DOM，松手才提交一次。
 *
 * 纪律：绘制只在「数据或尺寸变化」时发生，播放与拖动路径里一次都不写 store / setState——
 * 波形的数据进 ref，尺寸进 ref，canvas 的具体像素尺寸与重绘由 ResizeObserver 直接操作 DOM；
 * 左右拖动这条轨、上下拖动音量线时同样只写 ref 与 DOM，松手（pointerup / pointercancel）才提交一次。
 */
export function EditAudioTrackRow({ projectId, totalSeconds, drag }: { projectId: string; totalSeconds: number; drag: EditTrackDrag }) {
    const { t } = useTranslation();
    const { projects } = useEditState();
    const project = projects.find((item) => item.id === projectId);
    const tracks = project?.audioTracks ?? EMPTY_TRACKS;
    const media = project?.media ?? EMPTY_MEDIA;
    // 谁真的出声只有这一个判定（与导出请求构造共用 resolveAudibleTracks / editTrackAudibility）。
    const audibility = editTrackAudibility(tracks);

    return (
        // 音轨行**不再自己滚动**：滚动条（3 条以上就会出现）会从它自己的宽度里吃掉 6~15px，
        // 波形条随之比标尺、播放头、片段条窄，音画对齐的尺子就废了。
        // 音轨多时整条时间轴统一在外层那一个容器里滚动，滚动条扣掉的是四类元素共用的同一个宽度（见 edit-stage）。
        <div data-edit-audio-track className="mt-1.5 flex flex-col gap-1">
            {tracks.length ? (
                tracks.map((track) => (
                    <AudioTrackStrip key={track.id} projectId={projectId} track={track} source={media.find((item) => item.id === track.mediaId)} totalSeconds={totalSeconds} audibility={audibility[track.id] ?? "audible"} drag={drag} />
                ))
            ) : (
                // 没有音轨时也占住这一行：布局稳定，也说明波形会画在哪里。
                <div className="flex h-9 items-center justify-center rounded-[8px] border border-dashed border-black/[0.08] px-2 text-center text-[10px] text-stone-400 dark:border-white/[0.08] dark:text-zinc-600">{t("editor.emptyAudioTracks")}</div>
            )}
            <AddAudioTrackRow projectId={projectId} />
        </div>
    );
}

/**
 * 时间线底部的「添加音轨」入口：**复用既有的 addAudioTrack**（与左侧音频素材上的「加入音轨」同一个动作），
 * 只是把「从哪条音频素材建轨」这一步摆到时间线这里选，不再造第二套建轨流程。
 */
function AddAudioTrackRow({ projectId }: { projectId: string }) {
    const { t } = useTranslation();
    const { token } = theme.useToken();
    const { projects, addAudioTrack } = useEditState();
    const [open, setOpen] = useState(false);
    const audio = (projects.find((item) => item.id === projectId)?.media ?? EMPTY_MEDIA).filter((item) => item.kind === "audio");

    return (
        <Popover
            open={open}
            onOpenChange={setOpen}
            trigger="click"
            placement="topLeft"
            title={t("editor.addTrack")}
            content={
                audio.length ? (
                    <div className="thin-scrollbar flex max-h-[200px] flex-col overflow-y-auto">
                        {audio.map((item) => (
                            <Button
                                key={item.id}
                                type="text"
                                size="small"
                                className="!justify-start !text-[11px]"
                                icon={<Plus className="size-3.5" />}
                                onClick={() => {
                                    addAudioTrack(projectId, item.id);
                                    setOpen(false);
                                }}
                            >
                                {item.name}
                            </Button>
                        ))}
                    </div>
                ) : (
                    <span className="text-[10px] leading-4 text-stone-400 dark:text-zinc-600">{t("editor.addTrackEmpty")}</span>
                )
            }
        >
            {/* Popover 的外层包一个 span：它只负责接点击，里面的 Tooltip + Button 仍是既有写法。 */}
            <span className="inline-flex self-start">
                <Tooltip title={t("editor.addTrackHint")}>
                    <Button data-edit-track-add type="text" size="small" className="!h-6 !px-1.5 !text-[10px]" title={t("editor.addTrackHint")} aria-label={t("editor.addTrack")} icon={<Plus className="size-3.5" />} style={{ color: token.colorTextSecondary }}>
                        {t("editor.addTrack")}
                    </Button>
                </Tooltip>
            </span>
        </Popover>
    );
}

function AudioTrackStrip({ projectId, track, source, totalSeconds, audibility, drag }: { projectId: string; track: EditAudioTrack; source: EditMedia | undefined; totalSeconds: number; audibility: EditTrackAudibility; drag: EditTrackDrag }) {
    const { t } = useTranslation();
    const { token } = theme.useToken();
    const { updateAudioTrack } = useEditState();
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const stripRef = useRef<HTMLDivElement | null>(null);
    // 波形数据只进 ref：绘制不经过 React，数据到手也只需要重绘一次，不产生任何状态写入。
    const waveformRef = useRef<EditWaveform | null>(null);
    const sizeRef = useRef({ width: 0, height: 0 });
    const [buckets, setBuckets] = useState<number | null>(null);
    const [status, setStatus] = useState<WaveformStatus>("pending");
    const audible = audibility === "audible";


    // 时间线上的起点（秒）：缺省 / 0 都表示从 0 秒起混入，与改动前逐字一致。
    const trackStart = track.start !== undefined && track.start > 0 ? track.start : 0;
    const audioSeconds = (source?.durationMs || 0) / 1000;
    const stripSeconds = waveformStripSeconds(audioSeconds, totalSeconds, track.loop, trackStart);

    /**
     * 音量线与淡入淡出坡度的几何：与同一行的波形条**同一段秒数**（起点 + 这条轨还能占的时长），
     * 全部由 lib/edit/audio-gain 的纯函数算出来（高度是分贝映射，横轴最后仍走 timeToPercent）。
     */
    const gain = editAudioGainShape(track, { start: trackStart, seconds: stripSeconds, total: totalSeconds });
    // 首屏（React 渲染那一份）的折线与面积坐标：与拖动期间 paintGain 直写 DOM 的值来自同一个纯函数。
    const gainPoints = editGainPointsText(gain, totalSeconds);
    const gainArea = editGainAreaText(gain, totalSeconds);
    const volumeLabel = editVolumeLabel(gain.volume);
    const volumeReadout = editVolumeReadout(gain.volume);
    // 成片里一秒都占不到（起点落在成片末尾之后 / 没有时长）时整块可视化不渲染：没有能进成片的音频。
    const gainVisible = stripSeconds > 0;
    /**
     * 淡入淡出与「超出」有关的说明都挂在整行提示里（行上悬停就能看到），不在行里再堆标记：
     * 这些是「导出会怎么做」的说明，不是每一帧都要看的数字。
     */
    const gainNotes = [
        gain.fadeInClamped || gain.fadeOutClamped ? t("editor.trackFadeClampedNote") : null,
        gain.overlap ? t("editor.trackFadeOverlapNote") : null,
        gain.fadeOutAnchor === "unheard" ? t("editor.trackFadeOutUnheardNote", { at: formatEditTime(gain.exportFadeOutStart), end: formatEditTime(gain.end) }) : null,
        gain.fadeOutAnchor === "shifted" ? t("editor.trackFadeOutShiftedNote", { at: formatEditTime(gain.exportFadeOutStart), start: formatEditTime(gain.end - gain.fadeOut) }) : null,
    ].filter(Boolean);

    // 拖动音量线的过程量：只进 ref，一次都不写 store / setState（与左右拖动音轨同一套纪律）。
    const volumeDragRef = useRef<{ y: number; volume: number; rowHeight: number; pending: number } | null>(null);
    const volumeRef = useRef<HTMLDivElement | null>(null);
    const gainLineRef = useRef<SVGPolylineElement | null>(null);
    const gainAreaRef = useRef<SVGPolygonElement | null>(null);
    const readoutRef = useRef<HTMLSpanElement | null>(null);

    /**
     * 音量线与折线的画面：**只有这一个地方写**（拖动过程走它；React 那侧的内联样式由同一个纯函数给出，
     * 所以拖完松手后 React 渲染出来的值与拖动期间直写的值严格一致）。
     * 左右拖动这条轨时也只写 DOM：起点一变，音量线的 left / width 与整条折线都跟着重算。
     */
    const paintGain = (startSeconds: number, volume: number) => {
        const start = Math.min(editTrackStartLimit(totalSeconds), Math.max(0, Number.isFinite(startSeconds) ? startSeconds : 0));
        const seconds = waveformStripSeconds(audioSeconds, totalSeconds, track.loop, start);
        const next = editAudioGainShape({ ...track, volume }, { start, seconds, total: totalSeconds });
        const line = volumeRef.current;
        if (line) {
            line.style.left = `${timeToPercent(start, totalSeconds)}%`;
            line.style.width = `${timeToPercent(seconds, totalSeconds)}%`;
            line.style.top = `${editGainHeightPercent(next.ratio)}%`;
        }
        gainLineRef.current?.setAttribute("points", editGainPointsText(next, totalSeconds));
        gainAreaRef.current?.setAttribute("points", editGainAreaText(next, totalSeconds));
        if (readoutRef.current) readoutRef.current.textContent = editVolumeReadout(next.volume);
    };

    /**
     * 波形条的定位：left / width **只有这一个地方写**（拖动过程中与松手之后都走它），
     * 所以 DOM 永远等于「已经提交 / 正要提交的那个起始时间」，不会出现视图与数据不一致。
     * 换算仍走 lib/timeline-scale 的 timeToPercent（与标尺、播放头、片段条同一套），
     * 起点为 0 时**不写 left**（回落到 left-0 类名），旧项目的产物与改动前逐字一致。
     */
    const paintStrip = (startSeconds: number) => {
        const element = stripRef.current;
        if (!element) return;
        const start = Math.min(editTrackStartLimit(totalSeconds), Math.max(0, Number.isFinite(startSeconds) ? startSeconds : 0));
        if (start > 0) element.style.left = `${timeToPercent(start, totalSeconds)}%`;
        else element.style.removeProperty("left");
        element.style.width = `${timeToPercent(waveformStripSeconds(audioSeconds, totalSeconds, track.loop, start), totalSeconds)}%`;
        // 条长变了，画布上的波形也要按新的秒数重画（ResizeObserver 回调里用的仍是同一个 drawRef）。
        // 这里只写 ref：拖动期间一次状态写入都没有。
        pendingStartRef.current = start;
        // 音量线与折线横跨的就是这同一段秒数：起点一变，它们跟着一起改（同样只写 DOM）。
        paintGain(start, track.volume);
    };

    const draw = () => {
        const canvas = canvasRef.current;
        const { width, height } = sizeRef.current;
        if (!canvas || width <= 0 || height <= 0) return;
        const context = canvas.getContext("2d");
        if (!context) return;
        context.clearRect(0, 0, width, height);
        const waveform = waveformRef.current;
        // 拖动中（还没松手）用 ref 里的未提交起点重算条长，否则条被裁短的那一刻画布会先用旧秒数画一帧。
        const seconds = pendingStartRef.current === null ? stripSeconds : waveformStripSeconds(audioSeconds, totalSeconds, track.loop, pendingStartRef.current);
        // 一列画布像素 = 一列波形极值；数据为空（还没算出来 / 素材没有音频流）时全是 0，只剩中位线。
        const columns = waveformColumns(waveform?.peaks ?? EMPTY_PEAKS, waveform?.troughs ?? EMPTY_PEAKS, width, seconds, audioSeconds, track.loop);
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
    // 每个开关都是「点一下切状态」的低频交互，直接提交一次 store —— 拖动路径里一次都不写（见文件顶部说明）。
    const toggle = (patch: Partial<EditAudioTrack>) => updateAudioTrack(projectId, track.id, patch);

    /**
     * 左右拖动改这条轨的起始时间。拖动期间**只写 ref 与 DOM**（波形条的 left / width 直接改 style），
     * 一次都不写 store / setState —— 松手（pointerup / pointercancel）才提交一次。这是 React #185 的直接对策。
     * 秒 / 像素用「成片总秒数 ÷ 行宽」：行宽就是标尺、片段条、波形条共用的那个可定位宽度
     * （整条时间轴的滚动 / 内边距只加在共用容器上，所以这里与标尺严格同源，见 edit-stage）。
     */
    const dragRef = useRef<{ x: number; start: number; perPixel: number; pending: number } | null>(null);
    // 拖动期间「还没提交的起点」：只由 paintStrip 写、由 draw 读（都是 ref，不产生状态写入）。
    // 松手提交后置回 null，之后画布与条宽都只认 props 里那个已经提交的值。
    const pendingStartRef = useRef<number | null>(null);

    const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
        // 轨道头（静音 / 独奏 / 锁定）压在行上：点它是在按开关，不是在拖轨。
        if ((event.target as HTMLElement).closest("[data-edit-track-head]")) return;
        // 锁定的轨连 dragRef 都不建：拖动过程一次都不会发生，并给出同一句可理解的反馈（不静默失效）。
        if (!editTrackDraggable(track)) {
            drag.refuse();
            return;
        }
        const width = event.currentTarget.getBoundingClientRect().width;
        drag.begin(event);
        dragRef.current = { x: event.clientX, start: trackStart, perPixel: width > 0 && totalSeconds > 0 ? totalSeconds / width : 0.05, pending: trackStart };
        // 抓住指针：横向拖出这一行（甚至拖出窗口）都不会中途丢事件，松手一定提交。
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
        const state = dragRef.current;
        if (!state) return;
        // place 里复用时线那一套吸附（0 秒 / 播放头 / 片段边界 / 网格）：只算落点，不写任何状态。
        const placed = drag.place(event, state.start + (event.clientX - state.x) * state.perPixel);
        state.pending = placed.seconds;
        paintStrip(placed.seconds);
        drag.guide(placed.point ?? null);
    };

    const endDrag = () => {
        const state = dragRef.current;
        dragRef.current = null;
        drag.guide(null);
        if (!state) return;
        // 先把 DOM 钉在要提交的那个值上（拖动期间是自己写的像素，React 的 style 差分未必覆盖），再提交一次；
        // 提交后清掉「未提交起点」，之后条宽与画布都只认 props 里那个已经提交的值。
        paintStrip(state.pending);
        pendingStartRef.current = null;
        drag.commit(track.id, state.pending);
    };

    /**
     * 上下拖动**音量基准线**改音量。与左右拖动这条轨同一套纪律：过程只写 ref 与 DOM
     * （线的高度、折线的 points、读数文字），一次都不写 store / setState，松手才提交一次。
     *
     * 为什么 muted 的轨**也允许**调音量：静音是「暂时不听它」的监听状态，音量是混音参数，
     * 两者互不取代；禁掉只会逼用户「取消静音 → 调 → 再静音」。它是不是出声仍然一眼可见：
     * 波形条变淡、折线与基准线画成虚线，轨道头与行尾都写着静音。
     * 锁定的轨则一律拒绝（连 dragRef 都不建），并给出与其它编辑入口同一句反馈。
     */
    const startVolumeDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
        // 这一下是在调音量，不是在拖整行改起点：不让事件冒泡到行上的左右拖动。
        event.stopPropagation();
        if (!editTrackDraggable(track)) {
            drag.refuse();
            return;
        }
        const row = (event.currentTarget as HTMLElement).closest<HTMLElement>("[data-edit-track-row]");
        const volume = editVolumeSnap(track.volume);
        volumeDragRef.current = { y: event.clientY, volume, rowHeight: row?.getBoundingClientRect().height ?? 0, pending: volume };
        // 抓住指针：纵向拖出这一行（甚至拖出窗口）都不会中途丢事件，松手一定提交。
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const moveVolumeDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
        const state = volumeDragRef.current;
        if (!state) return;
        event.stopPropagation();
        // 向上拖为正：位移按「1 像素 = 1/行高」换算，与画出来的高度是同一把尺子。
        state.pending = editVolumeFromDrag(state.volume, state.y - event.clientY, state.rowHeight);
        // 起点用「已经提交 / 正要提交」的那个值：左右拖动与音量拖动即使同时发生也不会画错。
        paintGain(pendingStartRef.current ?? trackStart, state.pending);
    };

    const endVolumeDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
        const state = volumeDragRef.current;
        volumeDragRef.current = null;
        if (!state) return;
        event.stopPropagation();
        // 先把 DOM 钉在要提交的值上，再提交一次；值没变就不写 store（不产生一条空的撤销记录）。
        paintGain(pendingStartRef.current ?? trackStart, state.pending);
        if (state.pending !== state.volume) updateAudioTrack(projectId, track.id, { volume: state.pending });
    };

    /**
     * 键盘可达：音量线本身是 role="slider" 的可聚焦元素，↑ ↓ 每次调一步（5%，与属性区 step 一致）。
     * 上下箭头不是时间线的快捷键（时间线只占了左右箭头），所以这里不会与全局快捷键打架；
     * 仍然 stopPropagation，避免日后新增快捷键时被这条线上的按键误触发。
     */
    const onVolumeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        event.stopPropagation();
        const next = editVolumeStep(track.volume, event.key === "ArrowUp" ? 1 : -1);
        if (next !== editVolumeSnap(track.volume)) updateAudioTrack(projectId, track.id, { volume: next });
    };

    const rowTitle = [source ? `${source.name} · ${formatEditTime(audioSeconds)}` : t("editor.mediaRemoved"), trackStart > 0 ? t("editor.trackStartAt", { time: formatEditTime(trackStart) }) : null, track.locked ? t("editor.trackLockHint") : t("editor.trackDragHint"), ...gainNotes].filter(Boolean).join(" · ");

    return (
        <div
            // className 必须仍是这个标签的**第一个**属性：editor-timeline-alignment-ui.test.tsx 用它逐字定位音轨行
            // （`<div class="relative h-9...`），也用它核对行容器没有会吃掉宽度的内边距 / 滚动条。
            // 类名前半段同样被逐字核对，追加类名时不要插到它中间去。
            className={`relative h-9 shrink-0 overflow-hidden rounded-[8px] bg-black/[0.03] dark:bg-white/[0.05] touch-none select-none ${track.locked ? "cursor-not-allowed" : "cursor-grab active:cursor-grabbing"}`}
            data-edit-track-row={track.id}
            title={rowTitle}
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
        >
            <div
                ref={stripRef}
                data-edit-waveform-strip={track.id}
                data-edit-track-audible={audible ? "true" : "false"}
                // 静音 / 被独奏排除的轨在时间线上明确变淡：状态在波形上就看得出来，不用去数右侧参数。
                className={`absolute inset-y-0 left-0 overflow-hidden rounded-[8px] border border-black/[0.09] dark:border-white/[0.09] ${audible ? "" : "opacity-40"}`}
                // 条宽 = 这条音轨在成片时间轴上**还能占**的秒数 / 成片总秒数，left = 起始时间 / 成片总秒数：
                // 都与标尺刻度、播放头、片段条共用 lib/timeline-scale 的同一套百分比换算，x 严格对齐。
                // 起始时间为 0 时不下发 left（回落到 left-0 类名），产物与改动前逐字一致。
                style={{ width: `${timeToPercent(stripSeconds, totalSeconds)}%`, ...(trackStart > 0 ? { left: `${timeToPercent(trackStart, totalSeconds)}%` } : {}) }}
            >
                <canvas ref={canvasRef} data-edit-waveform={track.id} className="block h-full w-full" />
            </div>

            {/* 轨道头：绝对定位压在行的左端，**不占任何宽度**，所以标尺 / 播放头 / 波形条共用的定位宽度一个像素都没变。 */}
            <span data-edit-track-head={track.id} className="absolute left-1 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5 rounded-[7px] p-0.5" style={{ background: token.colorBgElevated, border: `1px solid ${token.colorBorderSecondary}` }}>
                <Tooltip title={t("editor.trackMuteHint")}>
                    <Button
                        data-edit-track-mute={track.id}
                        type="text"
                        size="small"
                        className={`!h-5 !w-5 !min-w-5 !p-0 ${track.muted ? TRACK_TOGGLE_ON : TRACK_TOGGLE_OFF}`}
                        title={t("editor.trackMuteHint")}
                        aria-label={track.muted ? t("editor.trackUnmute") : t("editor.trackMute")}
                        aria-pressed={track.muted === true}
                        icon={<VolumeX className="size-3" style={{ color: track.muted ? token.colorError : token.colorTextTertiary }} />}
                        onClick={() => toggle({ muted: !track.muted })}
                    />
                </Tooltip>
                <Tooltip title={t("editor.trackSoloHint")}>
                    <Button
                        data-edit-track-solo={track.id}
                        type="text"
                        size="small"
                        className={`!h-5 !w-5 !min-w-5 !p-0 ${track.solo ? TRACK_TOGGLE_ON : TRACK_TOGGLE_OFF}`}
                        title={t("editor.trackSoloHint")}
                        aria-label={track.solo ? t("editor.trackUnsolo") : t("editor.trackSolo")}
                        aria-pressed={track.solo === true}
                        icon={<Headphones className="size-3" style={{ color: track.solo ? token.colorPrimary : token.colorTextTertiary }} />}
                        onClick={() => toggle({ solo: !track.solo })}
                    />
                </Tooltip>
                <Tooltip title={t("editor.trackLockHint")}>
                    <Button
                        data-edit-track-lock={track.id}
                        type="text"
                        size="small"
                        className={`!h-5 !w-5 !min-w-5 !p-0 ${track.locked ? TRACK_TOGGLE_ON : TRACK_TOGGLE_OFF}`}
                        title={t("editor.trackLockHint")}
                        aria-label={track.locked ? t("editor.trackUnlock") : t("editor.trackLock")}
                        aria-pressed={track.locked === true}
                        icon={track.locked ? <Lock className="size-3" style={{ color: token.colorWarning }} /> : <LockOpen className="size-3" style={{ color: token.colorTextTertiary }} />}
                        onClick={() => toggle({ locked: !track.locked })}
                    />
                </Tooltip>
            </span>

            {hint ? (
                // left-[78px]：让开左边的轨道头（三个开关约 70px 宽）。提示与轨道头都在行的最左端，
                // 不挪开就会叠在一起；这是纯粹的水平占位，与波形条的百分比定位互不影响。
                <span data-edit-waveform-hint className="pointer-events-none absolute inset-y-0 left-[78px] flex items-center text-[10px] text-stone-400 dark:text-zinc-600">
                    {hint}
                </span>
            ) : null}
            {!audible ? (
                <span data-edit-track-excluded={track.id} className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[10px] text-stone-400 dark:text-zinc-500">
                    {audibility === "muted" ? t("editor.trackMute") : t("editor.trackSoloExcluded")}
                </span>
            ) : null}

            {/* ── 音量与淡入淡出：画在同一行、同一条时间轴上（两类元素的定位方式不同，别混） ──────────
                · 折线是**覆盖层**：整行铺满（inset-0）、绝对定位、不参与任何宽度分配，只有它内部的坐标带时间。
                  纵轴是分贝映射（0 dB = 75% 行高，见 lib/edit/audio-gain），横轴**逐点**走 timeline-scale 的
                  timeToPercent——与同一行的波形条、标尺刻度、播放头同一把尺子。
                · 音量基准线是**按时间定位的内容**（与波形条、字幕块同类，不是接缝标记那种零宽覆盖层）：
                  它横跨的是「这条轨还能占的那段秒数」，两条边都得算，所以 left / width 都由同一个
                  timeToPercent 给出，与波形条的左右边缘严格重合。
                两者都绝对定位，不从轨道宽度里取像素：波形条 / 标尺 / 播放头 / 片段条 / 字幕块的百分比一个都没动。
                没有能进成片的秒数（起点在成片末尾之后 / 没有时长）时整块不渲染——没有可画的区间。 */}
            {gainVisible ? (
                <svg
                    data-edit-track-gain={track.id}
                    data-edit-track-gain-audible={audible ? "true" : "false"}
                    data-edit-track-gain-fade-in={gain.fadeIn}
                    data-edit-track-gain-fade-out={gain.fadeOut}
                    data-edit-track-gain-overlap={gain.overlap ? "true" : undefined}
                    data-edit-track-fade-out-anchor={gain.fadeOutAnchor === "none" ? undefined : gain.fadeOutAnchor}
                    aria-hidden="true"
                    // viewBox 0 0 100 100 + preserveAspectRatio="none"：x 的 1 个单位就是轨道的 1%，
                    // y 的 1 个单位就是行高的 1%，与 DOM 那侧的 top / left 百分比完全同一个坐标系。
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                    className={`pointer-events-none absolute inset-0 z-[2] ${audible ? "" : "opacity-50"}`}
                >
                    {/* 折线下方那块面积：把「被淡变压下去多少」也画出来，光一条线看不出削掉了多少。 */}
                    <polygon ref={gainAreaRef} data-edit-track-gain-area={track.id} points={gainArea} style={{ fill: token.colorPrimaryBg }} />
                    {/* 折线 = 音量 × 淡入系数 × 淡出系数：淡入 / 淡出为 0 时它就是一条与音量线等高的平线，
                        不会画出零宽的坡度；两条坡度重叠时这里是相乘后的曲线（导出就是两条 afade 串起来）。
                        被排除的音轨画成虚线并与波形条一起变淡：静音的轨不该看起来和正常一样。 */}
                    <polyline
                        ref={gainLineRef}
                        data-edit-track-gain-line={track.id}
                        points={gainPoints}
                        style={{ fill: "none", stroke: token.colorPrimary }}
                        strokeWidth={2}
                        vectorEffect="non-scaling-stroke"
                        strokeDasharray={audible ? undefined : "4 3"}
                    />
                </svg>
            ) : null}

            {gainVisible ? (
                <div
                    ref={volumeRef}
                    data-edit-track-volume={track.id}
                    data-edit-track-volume-audible={audible ? "true" : "false"}
                    data-edit-track-volume-locked={track.locked ? "true" : undefined}
                    // 键盘可达：可聚焦的竖直滑块，↑ ↓ 每次一步（5%）。锁定时不给滑块语义、不进 Tab 序列。
                    role={track.locked ? undefined : "slider"}
                    tabIndex={track.locked ? -1 : 0}
                    aria-orientation="vertical"
                    aria-label={t("editor.trackVolumeLine", { value: volumeLabel })}
                    aria-valuemin={EDIT_VOLUME_MIN * 100}
                    aria-valuemax={EDIT_VOLUME_MAX * 100}
                    aria-valuenow={Math.round(gain.volume * 100)}
                    aria-valuetext={volumeReadout}
                    aria-disabled={track.locked ? true : undefined}
                    title={[t("editor.trackVolumeHint", { value: volumeReadout }), track.locked ? t("editor.trackLockHint") : null, gainVisible && !audible ? t("editor.trackVolumeMutedNote") : null].filter(Boolean).join(" · ")}
                    // ns-resize：上下拖才有效，光标先把这件事说出来；锁定的轨给 not-allowed。
                    className={`absolute z-[3] h-3 -translate-y-1/2 touch-none ${track.locked ? "cursor-not-allowed" : "cursor-ns-resize"}`}
                    // left / width 与波形条的两条边**同一套换算**（同一个 timeToPercent），top 是分贝高度映射。
                    style={{ left: `${timeToPercent(trackStart, totalSeconds)}%`, width: `${timeToPercent(stripSeconds, totalSeconds)}%`, top: `${editGainHeightPercent(gain.ratio)}%` }}
                    onPointerDown={startVolumeDrag}
                    onPointerMove={moveVolumeDrag}
                    onPointerUp={endVolumeDrag}
                    onPointerCancel={endVolumeDrag}
                    onKeyDown={onVolumeKeyDown}
                >
                    <span
                        aria-hidden="true"
                        className="absolute inset-x-0 top-1/2 h-[2px] -translate-y-1/2 rounded-full"
                        style={{ background: audible ? token.colorPrimary : "transparent", backgroundImage: audible ? undefined : `repeating-linear-gradient(90deg, ${token.colorPrimary} 0 5px, transparent 5px 10px)` }}
                    />
                </div>
            ) : null}

            {/* 音量读数：恒在行的右上角（轨道头与行尾的静音标记都在别的竖直位置，互不遮挡），
                拖动期间由 paintGain 直接改它的文字，不经过 React（一次状态写入都没有）。 */}
            {gainVisible ? (
                <span
                    data-edit-track-volume-badge={track.id}
                    className="pointer-events-none absolute right-2 top-0 z-[3] flex items-center gap-1 rounded-[4px] px-1 text-[9px] leading-[10px] tabular-nums"
                    style={{ background: token.colorBgElevated, color: audible ? token.colorTextSecondary : token.colorTextQuaternary }}
                >
                    <Volume2 className="size-2.5" />
                    <span ref={readoutRef} data-edit-track-volume-readout={track.id}>
                        {volumeReadout}
                    </span>
                </span>
            ) : null}
        </div>
    );
}
