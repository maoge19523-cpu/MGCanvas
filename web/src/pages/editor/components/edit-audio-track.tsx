import { Button, Popover, Tooltip, theme } from "antd";
import { HeadphoneOff, Headphones, Lock, LockOpen, Plus, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";

import { EDIT_GAIN_AREA_FILL_OPACITY, EDIT_VOLUME_MAX, EDIT_VOLUME_MIN, editAudioGainShape, editGainAreaText, editGainHeightPercent, editGainPointsText, editVolumeFromDrag, editVolumeLabel, editVolumeReadout, editVolumeSnap, editVolumeStep } from "@/lib/edit/audio-gain";
import { editTrackAudibility, type EditTrackAudibility } from "@/lib/edit/audio-mix";
import { editAudioTrimEdge, editAudioTrimFields, editAudioTrimWindow, type EditAudioTrimEdge, type EditAudioTrimTarget, type EditAudioTrimWindow } from "@/lib/edit/audio-trim";
import { EDIT_MIN_TRIM_SECONDS, editTrackDraggable, editTrackStartLimit, type EditSnapPoint, type EditSnapResult } from "@/lib/edit/timeline-edit";
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
    /**
     * 拖两端裁剪时求落点：`filmSeconds` 是这条边在**成片时间轴上的绝对秒数**
     * （素材内秒数 − 入点 + 起点），吸附候选点、吸附阈值、导引线都与片段拖动共用同一份。
     */
    placeTrim: (event: ReactPointerEvent<HTMLElement>, filmSeconds: number, target: EditAudioTrimTarget) => EditSnapResult;
    /** 显示 / 收起吸附导引线（与片段拖动共用同一条线）。 */
    guide: (point: EditSnapPoint | null) => void;
    /** 松手时才调用：提交一次起始时间（0 回缺省）。 */
    commit: (trackId: string, start: number) => void;
    /** 松手时才调用：提交一次裁剪（回到缺省的那一侧写回 undefined）。 */
    commitTrim: (trackId: string, patch: { sourceStart?: number; sourceEnd?: number }) => void;
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
    /**
     * **裁剪区间**（这条轨在素材内取哪一段，见 lib/edit/audio-trim）：
     * 缺省 = 整条素材（`start` 0、长度就是素材时长），与改动前逐字一致。
     * 这里的 `trim.seconds` 是**留下的那一段**有多长，下面所有「这条轨能占多久」都按它算：
     * 波形条宽、音量线、淡入淡出坡度、以及导出侧那对 atrim 读的都是同一个数。
     */
    const trim = editAudioTrimWindow(track, audioSeconds);
    const stripSecondsFor = (startSeconds: number, window: EditAudioTrimWindow) => waveformStripSeconds(window.seconds, totalSeconds, track.loop, startSeconds);
    const stripSeconds = stripSecondsFor(trackStart, trim);

    /**
     * 音量线与淡入淡出坡度的几何：与同一行的波形条**同一段秒数**（起点 + 裁剪后那段还能占的时长），
     * 全部由 lib/edit/audio-gain 的纯函数算出来（高度是分贝映射，横轴最后仍走 timeToPercent）。
     * `trimmed` 只影响一件事：导出侧淡出的锚点（裁过之后导出按裁剪后内容的末尾起淡出）。
     */
    const gain = editAudioGainShape(track, { start: trackStart, seconds: stripSeconds, total: totalSeconds, trimmed: trim.trimmed });
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
    /**
     * 拖两端裁剪的说明挂在**两端把手的提示**上（那是本次新加的元素）。
     * 不动行本身那个 title：它的整段文字被 editor-audio-gain-ui 的回归测试逐字冻着
     * （「原有元素一个字都没变、新元素只许追加在后面」那把锁），动它等于把旧锁拆掉。
     */
    const trimHint = [t("editor.trackTrimHint"), trim.trimmed ? t("editor.trackTrimmedNote", { start: formatEditTime(trim.start), length: formatEditTime(trim.seconds) }) : null].filter(Boolean).join(" · ");

    // 拖动音量线的过程量：只进 ref，一次都不写 store / setState（与左右拖动音轨同一套纪律）。
    const volumeDragRef = useRef<{ y: number; volume: number; rowHeight: number; pending: number } | null>(null);    const volumeRef = useRef<HTMLDivElement | null>(null);
    const gainLineRef = useRef<SVGPolylineElement | null>(null);
    const gainAreaRef = useRef<SVGPolygonElement | null>(null);
    const readoutRef = useRef<HTMLSpanElement | null>(null);

    /**
     * 音量线与折线的画面：**只有这一个地方写**（拖动过程走它；React 那侧的内联样式由同一个纯函数给出，
     * 所以拖完松手后 React 渲染出来的值与拖动期间直写的值严格一致）。
     * 左右拖动这条轨、或拖两端裁剪时也只写 DOM：秒数一变，音量线的 left / width 与整条折线都跟着重算。
     * `trim` 缺省取「拖动中的那一份，否则是已提交的那一份」，所以调用方不传也不会画错。
     */
    const paintGain = (startSeconds: number, volume: number, window: EditAudioTrimWindow = pendingTrimRef.current ?? trim) => {
        const start = Math.min(editTrackStartLimit(totalSeconds), Math.max(0, Number.isFinite(startSeconds) ? startSeconds : 0));
        const seconds = stripSecondsFor(start, window);
        const next = editAudioGainShape({ ...track, volume }, { start, seconds, total: totalSeconds, trimmed: window.trimmed });
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
    const paintStrip = (startSeconds: number, window: EditAudioTrimWindow = pendingTrimRef.current ?? trim) => {
        const element = stripRef.current;
        if (!element) return;
        const start = Math.min(editTrackStartLimit(totalSeconds), Math.max(0, Number.isFinite(startSeconds) ? startSeconds : 0));
        if (start > 0) element.style.left = `${timeToPercent(start, totalSeconds)}%`;
        else element.style.removeProperty("left");
        element.style.width = `${timeToPercent(stripSecondsFor(start, window), totalSeconds)}%`;
        // 条长变了，画布上的波形也要按新的秒数重画（条宽变化由 ResizeObserver 兜住）。
        // 这里只写 ref：拖动期间一次状态写入都没有。
        const previous = pendingTrimRef.current;
        pendingStartRef.current = start;
        // 裁掉的区间同样只进 ref：draw 读它来画「留下的那一段」的波形（一次状态写入都没有）。
        pendingTrimRef.current = window;
        // 取用区间变了就显式重画一次：条宽的变化会被 ResizeObserver 兜住，但**窗口变化不一定改条宽**
        // （例如裁掉的开头落在成片之外时，条宽仍被成片尽头夹住），不重画就会停在旧区间的波形上。
        if (previous === null || previous.start !== window.start || previous.end !== window.end) draw();
        // 音量线与折线横跨的就是这同一段秒数：起点一变，它们跟着一起改（同样只写 DOM）。
        paintGain(start, track.volume, window);
    };

    const draw = () => {
        const canvas = canvasRef.current;
        const { width, height } = sizeRef.current;
        if (!canvas || width <= 0 || height <= 0) return;
        const context = canvas.getContext("2d");
        if (!context) return;
        context.clearRect(0, 0, width, height);
        const waveform = waveformRef.current;
        // 拖动中（还没松手）用 ref 里的未提交起点 / 未提交裁剪区间重算，否则条被裁短的那一刻
        // 画布会先用旧秒数画一帧（拖两端裁剪时波形也要跟着换成留下的那一段）。
        const window = pendingTrimRef.current ?? trim;
        const seconds = stripSecondsFor(pendingStartRef.current ?? trackStart, window);
        // 一列画布像素 = 一列波形极值；数据为空（还没算出来 / 素材没有音频流）时全是 0，只剩中位线。
        // 取峰值的窗口就是裁剪后的那一段：波形只画留下的部分（loop 时按这一段回卷）。
        const columns = waveformColumns(waveform?.peaks ?? EMPTY_PEAKS, waveform?.troughs ?? EMPTY_PEAKS, width, seconds, audioSeconds, track.loop, { start: window.start, length: window.seconds });
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
    // 裁剪区间（入点 / 长度）也必须进签名：裁得前后一样长时波形显示的是**另一段**内容。
    useEffect(() => {
        draw();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [track.loop, status, buckets, stripSeconds, trim.start, trim.seconds, token.colorPrimary, token.colorFill]);

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
    // 拖动期间「还没提交的裁剪区间」（拖两端裁剪时写）：与 pendingStartRef 同一套纪律，
    // paintStrip 写、draw 与 paintGain 读，一次状态写入都没有。
    const pendingTrimRef = useRef<EditAudioTrimWindow | null>(null);

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
        paintStrip(state.pending, pendingTrimRef.current ?? trim);
        pendingStartRef.current = null;
        pendingTrimRef.current = null;
        drag.commit(track.id, state.pending);
    };

    /**
     * **拖两端裁剪**：拖左端改素材内的**入点**（开头被砍掉），拖右端改**出点**（结尾被砍掉）。
     * 与视频片段拖两端、字幕块拖两端同一套手感：命中带 6px（两端各一条）、光标 ew-resize、
     * 悬停有一片淡底、锁定轨一点就给出同一句反馈、键盘左右箭头每次一步。
     *
     * 三处语义（与片段裁剪逐字同形，别再各写一套）：
     * - **`start`（这条轨在成片里的起点）不动**：裁左端不是把整条轨往右挪，而是让内容改从素材的更后面开始，
     *   于是整条轨变短、右端在成片上提前结束——这条轨仍从原来那一刻混进成片；
     * - 两条边之间至少留 EDIT_MIN_TRIM_SECONDS（与片段裁剪同一个值），出点不越过素材全长；
     * - 拖动过程**只写 ref 与 DOM**（条宽 + 波形 + 音量线 + 折线），松手才提交一次（React #185 的纪律）。
     */
    const trimDragRef = useRef<{ edge: EditAudioTrimEdge; x: number; perPixel: number; trim: EditAudioTrimWindow; pending: EditAudioTrimWindow } | null>(null);

    const startTrimDrag = (event: ReactPointerEvent<HTMLSpanElement>, edge: EditAudioTrimEdge) => {
        // 这一下是在裁两端，不是在拖整行改起点、也不是在调音量：不让事件冒泡到行上。
        event.stopPropagation();
        // 锁定的轨连 trimDragRef 都不建：拖动过程一次都不会发生，并给出同一句可理解的反馈（不静默失效）。
        if (!editTrackDraggable(track)) {
            drag.refuse();
            return;
        }
        // 秒 / 像素用「成片总秒数 ÷ 行宽」：行宽就是标尺、片段条、波形条共用的那个可定位宽度，
        // 而且素材内的秒数与成片时间轴上的秒数是 1:1 平移（裁掉开头不改变这个比例），所以同一把尺子通用。
        const row = (event.currentTarget as HTMLElement).closest<HTMLElement>("[data-edit-track-row]");
        const width = row?.getBoundingClientRect().width ?? 0;
        trimDragRef.current = { edge, x: event.clientX, perPixel: width > 0 && totalSeconds > 0 ? totalSeconds / width : 0.05, trim, pending: trim };
        // 抓住指针：拖出这一行（甚至拖出窗口）都不会中途丢事件，松手一定提交。
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const moveTrimDrag = (event: ReactPointerEvent<HTMLSpanElement>) => {
        const state = trimDragRef.current;
        if (!state) return;
        event.stopPropagation();
        // 被拖的那条边现在的素材内秒数（出点缺省 0 = 素材末尾，拖动时按素材末尾起算）。
        const from = state.edge === "start" ? state.trim.start : state.trim.end > 0 ? state.trim.end : audioSeconds;
        const target = from + (event.clientX - state.x) * state.perPixel;
        // 吸附：落点是这条边在**成片时间轴上的绝对秒数**（起点 + (素材内秒数 − 入点)），交给时间线那一套
        // 候选点（0 秒 / 播放头 / 片段边界 / 网格）吸附，再换回素材内秒数并夹进合法区间（见 lib/edit/audio-trim）。
        const placed = drag.placeTrim(event, trackStart + (target - state.trim.start), { edge: state.edge, window: state.trim, startSeconds: trackStart, sourceSeconds: audioSeconds });
        const next = editAudioTrimWindow({ sourceStart: state.edge === "start" ? placed.seconds : state.trim.start, sourceEnd: state.edge === "end" ? placed.seconds : state.trim.end }, audioSeconds);
        state.pending = next;
        // 起点照旧（裁两端不动 start），只把「留下的那一段」重画一遍：条宽、波形、音量线、折线一起改。
        paintStrip(trackStart, next);
        drag.guide(placed.point ?? null);
    };

    const endTrimDrag = (event: ReactPointerEvent<HTMLSpanElement>) => {
        const state = trimDragRef.current;
        trimDragRef.current = null;
        if (!state) return;
        event.stopPropagation();
        drag.guide(null);
        // 先把 DOM 钉在要提交的那个值上，再提交一次；值没变就不写 store（不产生一条空的撤销记录）。
        paintStrip(trackStart, state.pending);
        pendingStartRef.current = null;
        pendingTrimRef.current = null;
        if (state.pending.start !== trim.start || state.pending.end !== trim.end) drag.commitTrim(track.id, editAudioTrimFields(state.pending));
    };

    /**
     * 键盘可达：两端把手各自是 role="slider" 的可聚焦元素，← → 每次移动一步（0.1 秒，与片段裁剪的最小长度同值）。
     * 左右箭头是时间线的快捷键（移动播放头），所以这里必须 preventDefault + stopPropagation：
     * 焦点在这个把手上时，按键改的是这条边的裁剪，而不是把播放头挪走。
     */
    const onTrimKeyDown = (event: ReactKeyboardEvent<HTMLSpanElement>, edge: EditAudioTrimEdge) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        event.stopPropagation();
        const from = edge === "start" ? trim.start : trim.end > 0 ? trim.end : audioSeconds;
        const moved = editAudioTrimEdge(trim, edge, from + (event.key === "ArrowRight" ? EDIT_MIN_TRIM_SECONDS : -EDIT_MIN_TRIM_SECONDS), audioSeconds);
        const next = editAudioTrimWindow({ sourceStart: edge === "start" ? moved.start : trim.start, sourceEnd: edge === "end" ? moved.end : trim.end }, audioSeconds);
        if (next.start !== trim.start || next.end !== trim.end) updateAudioTrack(projectId, track.id, editAudioTrimFields(next));
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
                        // 图标本身必须跟着状态换：只换颜色时，未静音的按钮仍画着一只「打了叉的喇叭」，
                        // 用户点完看到的还是同一只叉喇叭，于是判定「静音键打不开、一直在静音」——
                        // 现象是「按钮失效」，其实是这个开关从来没有「未静音」的样子。
                        // 与视频轨轨道头（edit-stage 的关闭原声）逐字同一写法：静音 VolumeX、正常 Volume2。
                        icon={track.muted ? <VolumeX className="size-3" style={{ color: token.colorError }} /> : <Volume2 className="size-3" style={{ color: token.colorTextTertiary }} />}
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
                        // 与同一排的静音（Volume2 ↔ VolumeX）、锁定（Lock ↔ LockOpen）逐字同一写法：
                        // 一个开关的两种状态必须是两个图标。独奏过去无论开还是关都画同一只 Headphones，
                        // 只换颜色与底色，用户点完看到的还是那只耳机，于是被读成「独奏键没反应」——
                        // 与静音键那次是同一类问题（外观不变 ⇒ 以为按钮失效）。
                        // 已独奏＝正在监听（Headphones，主题色）；未独奏＝被划掉的耳机（HeadphoneOff，弱色）。
                        icon={track.solo ? <Headphones className="size-3" style={{ color: token.colorPrimary }} /> : <HeadphoneOff className="size-3" style={{ color: token.colorTextTertiary }} />}
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
                    // 宽高都钉成**行盒**的 100%，缺一不可：SVG 是替换元素，只有 inset-0（top/right/bottom/left=0）
                    // 时浏览器不会把它拉伸成行盒，而是按 viewBox 的 1:1 比例给它一个「与行等宽的正方形」——
                    // 实测行高 36px、行宽 860px 时覆盖层是 860×860，折线落在行顶下方 227.9px、面积铺到 834.2px，
                    // 全都在行外、被这一行的 overflow-hidden 整块裁掉：画了等于没画（用户只看得见音量基准线）。
                    // 另外那 824px 的溢出只是「恰好」被 overflow-hidden 挡着：一旦有人去掉它或去掉 pointer-events-none，
                    // 这个层就会盖住它下面的行。把它约束在行盒里，从根上避免这两件事。
                    style={{ width: "100%", height: "100%" }}
                >
                    {/* 折线下方那块面积：把「被淡变压下去多少」也画出来，光一条线看不出削掉了多少。
                        填充**只能是与波形条同一个 token（colorPrimary）+ fillOpacity 的低透明度**：这块曾经用
                        colorPrimaryBg，而它在当前主题下是实心的中灰（浅色 #575757 / 深色 #595959），
                        整行波形被一块 70.5% 行高的灰板压死（用户报的「颜色太重、把波形遮盖完了」）。
                        同色叠加 = 波形色本身，所以低透明度的填充挡不住波形；详见 EDIT_GAIN_AREA_FILL_OPACITY。 */}
                    <polygon ref={gainAreaRef} data-edit-track-gain-area={track.id} points={gainArea} fillOpacity={EDIT_GAIN_AREA_FILL_OPACITY} style={{ fill: token.colorPrimary }} />
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

            {/*
              两端裁剪把手：**绝对定位的覆盖层**（与片段条两端的把手、接缝标记同一类），
              固定 6px 宽、不参与任何宽度分配，所以标尺 / 播放头 / 片段条 / 波形条的百分比一个都没动。
              位置由 timeToPercent 给出（与波形条的两条边严格同一套换算）：
              左端 = 起点，右端 = 起点 + 裁剪后那段能占的秒数（也就是波形条的右边缘）。
              命中带压在音量线（z-[3]）与波形之上：它贴在两端的 6px 里，中间整片仍然是整行拖动的地盘，
              所以「拖整行改起点」与「拖两端裁剪」不会互相抢那一下。
              把手本身不改 start：拖左端裁掉的是素材的开头（内容往后挪），这条轨仍从同一时刻混进成片。
            */}
            {gainVisible
                ? (
                      [
                          { edge: "start" as const, at: trackStart, hint: t("editor.trimStart"), cursor: "cursor-ew-resize" },
                          { edge: "end" as const, at: trackStart + stripSeconds, hint: t("editor.trimEnd"), cursor: "cursor-ew-resize" },
                      ] as const
                  ).map((handle) => (
                      <span
                          key={handle.edge}
                          data-edit-track-trim-start={handle.edge === "start" ? track.id : undefined}
                          data-edit-track-trim-end={handle.edge === "end" ? track.id : undefined}
                          // 键盘可达：可聚焦的水平滑块，← → 每次移动一步（0.1 秒）。锁定时不给滑块语义、不进 Tab 序列。
                          role={track.locked ? undefined : "slider"}
                          tabIndex={track.locked ? -1 : 0}
                          aria-orientation="horizontal"
                          aria-label={handle.hint}
                          aria-valuemin={0}
                          aria-valuemax={Math.round(audioSeconds * 10) / 10}
                          aria-valuenow={Math.round((handle.edge === "start" ? trim.start : trim.end > 0 ? trim.end : audioSeconds) * 10) / 10}
                          aria-valuetext={formatEditTime(handle.edge === "start" ? trim.start : trim.end > 0 ? trim.end : audioSeconds)}
                          aria-disabled={track.locked ? true : undefined}
                          // 与片段条两端逐字同一套外观：6px 命中带、悬停才显出一层淡底，光标先说清能左右拖。
                          // 提示里带上「这一拖会改什么」与裁剪现状（行本身的 title 一个字都没动，见上面的 trimHint）。
                          title={track.locked ? t("editor.trackLockHint") : `${handle.hint} · ${trimHint}`}
                          className={`absolute inset-y-0 z-[4] w-1.5 touch-none ${track.locked ? "cursor-not-allowed" : handle.cursor} hover:bg-black/10 dark:hover:bg-white/15`}
                          // 右端贴着波形条的右边缘往内收 6px（与片段条的右把手同一取舍），不越过那条边。
                          style={{ left: `calc(${timeToPercent(handle.at, totalSeconds)}% ${handle.edge === "start" ? "+ 2px" : "- 8px"})` }}
                          onPointerDown={(event) => startTrimDrag(event, handle.edge)}
                          onPointerMove={moveTrimDrag}
                          onPointerUp={endTrimDrag}
                          onPointerCancel={endTrimDrag}
                          onKeyDown={(event) => onTrimKeyDown(event, handle.edge)}
                      />
                  ))
                : null}
        </div>
    );
}
