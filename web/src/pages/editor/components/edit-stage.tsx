import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { App, Button, Popover, Tooltip, theme } from "antd";
import { Clapperboard, Info, Magnet, Music2, Pause, Play, Redo2, Undo2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
    EDIT_SNAP_THRESHOLD_PX,
    collectEditSnapPoints,
    editClipIndexAt,
    editGridStep,
    editReorderIndex,
    editSecondsInsideClip,
    editSnapThresholdSeconds,
    isEditSnapSuppressed,
    resolveEditSnap,
    type EditSnapPoint,
} from "@/lib/edit/timeline-edit";
import {
    EditPlaybackClock,
    editDesiredMediaSeconds,
    editDriftAction,
    editDriftCooldownReady,
    editDriftSeconds,
    editFrameSeconds,
    editPointerVelocity,
    resolveEditClockSource,
} from "@/lib/edit/playback-clock";
import { EDIT_SHORTCUTS, editShortcutDisplay, editShortcutHints, isEditShortcutTargetBlocked, matchEditShortcut, type EditShortcutAction } from "@/lib/edit/shortcuts";
import { buildEditClips, editPlaybackSeconds, editTickLabel, editTickStep, formatEditTime, resolveEditPlayback, resolveEditSeek, type EditClipView } from "@/lib/edit/timeline";
import { createEditClip, useEditState } from "@/stores/use-edit-store";
import type { EditClip, EditMedia } from "@/types/edit";
import { useEditMediaUrls } from "../use-edit-media-urls";
import { EditAudioTrackRow } from "./edit-audio-track";

type EditStageProps = {
    projectId: string;
    clipId: string | null;
    hasMedia: boolean;
    onSelectClip: (clipId: string | null) => void;
};

// 项目还没水合完成时用固定引用兜底：写成 `?? []` 会每次渲染都产生新数组，
// zustand 的 Object.is 比较会因此判定「状态变了」而反复重渲染（React #185 的成因之一）。
const EMPTY_MEDIA: EditMedia[] = [];
const EMPTY_CLIPS: EditClip[] = [];

/**
 * 预览区 + 时间线。两块共用一套播放与播放头状态，所以放在同一个组件里：
 * 预览与时间轴的坐标必须完全一致，拆开就要跨组件同步播放头，反而更容易写入抖动。
 *
 * 高频交互（拖动片段换序、拖两端裁剪、拖播放头、播放）**一次都不写 store / setState**：
 * 过程量只存在 ref 里，视觉反馈直接改 DOM（flexGrow / transform / textContent / style.left），
 * 松手时（pointerup / pointercancel / pointerleave）才一次性提交到剪辑台 store。
 *
 * 播放由**主时钟**主导（EditPlaybackClock）：只有它是播放时间的真相，
 * 各段 <video>.currentTime 只是被定期对齐的对象，偏差超过一帧就丢帧追赶 / 补帧等待。
 *
 * 暂停态另有一条**取帧**路径（requestPausedFrame / paintPausedFrame）：播放路径只在起播与播放心跳里
 * 设过 src 与 currentTime，暂停后没人再管这个 <video>，所以暂停态必须自己把播放头那一帧取回来，
 * 否则预览区只能是黑屏。取帧同样遵循上面的纪律：只写 ref 与 <video> 属性，一次都不写 store / setState。
 */
export function EditStage({ projectId, clipId, hasMedia, onSelectClip }: EditStageProps) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const { token } = theme.useToken();
    const { projects, updateClips, updateClip, addClips, removeClip, rippleRemoveClip, splitClip, undoEdit, redoEdit, historyFlags, historyLabels } = useEditState();
    const project = projects.find((item) => item.id === projectId);
    const media = project?.media ?? EMPTY_MEDIA;
    const clips = project?.clips ?? EMPTY_CLIPS;
    const urls = useEditMediaUrls(media);
    const views = useMemo(() => buildEditClips(media, clips, urls), [media, clips, urls]);
    const totalSeconds = editPlaybackSeconds(views);

    // ── 播放头与预览：全部过程量放 ref，播放/暂停这一个低频开关才用 state ──────────────
    const [playing, setPlaying] = useState(false);
    // 吸附开关是低频交互，用 state；拖动过程中只读 ref，不做逐帧读状态。
    const [snapEnabled, setSnapEnabled] = useState(true);
    const snapEnabledRef = useRef(true);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const playheadRef = useRef<HTMLDivElement | null>(null);
    const guideRef = useRef<HTMLDivElement | null>(null);
    const readoutRef = useRef<HTMLSpanElement | null>(null);
    const activeLabelRef = useRef<HTMLSpanElement | null>(null);
    const timelineRef = useRef<HTMLDivElement | null>(null);
    const secondsRef = useRef(0);
    const totalRef = useRef(0);
    const playingRef = useRef(false);
    const indexRef = useRef(0);
    const viewsRef = useRef<EditClipView[]>([]);
    const frameSecondsRef = useRef(1 / 30);
    const frameRef = useRef(0);
    const awaitingRef = useRef(false);
    const srcRef = useRef("");
    const handlersRef = useRef<{ loaded: () => void; failed: () => void } | null>(null);
    const seekingRef = useRef(false);
    const clockRef = useRef<EditPlaybackClock | null>(null);
    const preparingRef = useRef(false);
    const waitingRef = useRef(false);
    const lastCorrectionRef = useRef(0);
    const velocityRef = useRef({ x: 0, at: 0 });
    // 暂停态取帧（scrub 预览）的过程量：与播放循环的 frameRef 分开，互不干扰。
    const scrubFrameRef = useRef(0);
    const scrubTargetRef = useRef<number | null>(null);
    const frameWaitingRef = useRef<number | null>(null);
    const frameAppliedRef = useRef(-1);
    const frameFlushRef = useRef<() => void>(() => undefined);
    const brokenSrcRef = useRef("");

    const flags = historyFlags(projectId);
    const labels = historyLabels(projectId);

    // 播放头与读数一律直接改 DOM：这两个节点的 style/textContent 不参与 React 渲染，
    // 因此其它原因引起的重渲染也不会把播放中的位置冲掉。
    const paintPlayhead = (seconds: number, total = totalRef.current) => {
        if (playheadRef.current) playheadRef.current.style.left = `${total > 0 ? Math.min(100, Math.max(0, (seconds / total) * 100)) : 0}%`;
        if (readoutRef.current) readoutRef.current.textContent = formatEditTime(seconds);
        const index = viewsRef.current.findIndex((view) => seconds < view.offset + view.length);
        const active = playingRef.current && index >= 0 ? viewsRef.current[index] : null;
        if (activeLabelRef.current) activeLabelRef.current.textContent = active ? t("editor.nowPlaying", { index: index + 1, name: active.name }) : "";
    };

    // 吸附导引线：只在拖动中显示，位置同样直写 DOM（不弹时间气泡，与 OpenReel 一致）。
    const paintGuide = (point: EditSnapPoint | null) => {
        const guide = guideRef.current;
        if (!guide) return;
        const total = totalRef.current;
        if (!point || total <= 0) {
            guide.style.opacity = "0";
            return;
        }
        guide.style.left = `${Math.min(100, Math.max(0, (point.seconds / total) * 100))}%`;
        guide.style.opacity = "1";
    };

    const detachHandlers = (video: HTMLVideoElement) => {
        const handlers = handlersRef.current;
        if (!handlers) return;
        video.removeEventListener("loadedmetadata", handlers.loaded);
        video.removeEventListener("error", handlers.failed);
        handlersRef.current = null;
    };

    // ── 暂停态取帧（scrub 预览）：暂停时也要显示播放头所在的那一帧 ──────────────────────
    // 换算只用现成的 resolveEditSeek：播放头是时间线全局秒数，落点要用该段自己的入点
    // （view.start + 播放头 - view.offset），换段、段边界、片尾都由它统一处理。
    // 这一组函数只写 ref 与 <video>（src / currentTime），不写 store、不 setState。

    /**
     * 发一次暂停态 seek。只有「手上还有目标 + 上一次 seek 已经落地」时才赋值：
     * 上一次还没走完就只把最新目标留在手上，等 seeked 再发，因此不会把 seek 堆积成一串。
     */
    const flushPausedFrameSeek = () => {
        const video = videoRef.current;
        const target = frameWaitingRef.current;
        if (!video || target === null) return;
        // 还在 seek，或元数据还没到（这时赋 currentTime 会被忽略）：留着等 seeked / loadedmetadata。
        if (video.seeking || video.readyState < 1) return;
        frameWaitingRef.current = null;
        frameAppliedRef.current = target;
        video.currentTime = target;
    };

    /** 暂停态取一帧：由 requestPausedFrame 合并到一帧一次执行，永远只用最新目标。 */
    const paintPausedFrame = () => {
        scrubFrameRef.current = 0;
        if (playingRef.current) return; // 播放中由主时钟主导，这里一律不插手
        const video = videoRef.current;
        const seconds = scrubTargetRef.current;
        scrubTargetRef.current = null;
        if (!video || seconds === null || totalRef.current <= 0) return;
        const target = resolveEditSeek(viewsRef.current, seconds);
        const view = target ? viewsRef.current[target.index] : null;
        // 素材缺失 / 素材没探测到时长：维持空状态——把已经挂上的源放掉，
        // 免得上一段的画面停在这里冒充「这一段」的画面。
        if (!target || !view || !view.src || view.length <= 0) {
            if (video.hasAttribute("src")) releaseVideo(video);
            return;
        }
        indexRef.current = target.index;
        if (srcRef.current === view.src) {
            // 画面已经落在目标位置附近就不再 seek：指针停住时的重复请求到此为止。
            const settled = Math.abs(target.currentTime - frameAppliedRef.current) < frameSecondsRef.current / 2 && Math.abs(target.currentTime - video.currentTime) < frameSecondsRef.current / 2;
            if (settled) return;
            frameWaitingRef.current = target.currentTime;
            flushPausedFrameSeek();
            return;
        }
        if (brokenSrcRef.current === view.src) return; // 这个地址刚加载失败过，拖动时不再反复重试
        // 换段 / 首次挂源：先设 src，等元数据到位再定位——没有元数据时赋 currentTime 会被忽略，
        // 新源在 loadeddata 之前绘制出来就是黑的，等帧这一步就落在这里。
        detachHandlers(video);
        frameAppliedRef.current = target.currentTime;
        frameWaitingRef.current = target.currentTime;
        srcRef.current = view.src;
        const loaded = () => {
            detachHandlers(video);
            brokenSrcRef.current = "";
            // 加载期间播放头可能已经动了：取手上最新的目标，赋完就清掉，避免 seeked 再补发一次。
            frameAppliedRef.current = frameWaitingRef.current ?? target.currentTime;
            frameWaitingRef.current = null;
            video.currentTime = frameAppliedRef.current;
        };
        const failed = () => {
            // 暂停态加载失败不弹提示（可播放地址可能只是还没解析好），留在空状态即可。
            detachHandlers(video);
            brokenSrcRef.current = view.src;
            srcRef.current = "";
            frameWaitingRef.current = null;
        };
        handlersRef.current = { loaded, failed };
        video.addEventListener("loadedmetadata", loaded);
        video.addEventListener("error", failed);
        video.src = view.src;
        video.load();
    };

    /**
     * 暂停态取帧的调度：拖播放头 / 点标尺 / 逐帧快捷键都会高频调用它，
     * 但同一帧内只排一次 rAF，并且永远只取最新目标——过程量只进 ref，不写 store。
     */
    const requestPausedFrame = (seconds: number) => {
        scrubTargetRef.current = seconds;
        if (scrubFrameRef.current) return;
        scrubFrameRef.current = requestAnimationFrame(paintPausedFrame);
    };

    // 清干净一个 <video>：pause + 移除 src + load()，否则元素被卸载后仍会在后台继续出声。
    // 只在元素被卸载 / 切项目时调用：暂停**不**释放源，否则暂停后画面立刻变黑。
    const releaseVideo = (video: HTMLVideoElement) => {
        detachHandlers(video);
        video.pause();
        video.removeAttribute("src");
        video.load();
        video.volume = 1;
        srcRef.current = "";
        brokenSrcRef.current = "";
    };

    const stopPreview = () => {
        if (frameRef.current) cancelAnimationFrame(frameRef.current);
        frameRef.current = 0;
        playingRef.current = false;
        awaitingRef.current = false;
        waitingRef.current = false;
        clockRef.current?.pause();
        if (videoRef.current) videoRef.current.pause();
        setPlaying(false);
        // 主时钟与 <video> 之间允许有一帧以内的偏差，停表后按播放头精确对齐一次再取帧。
        frameAppliedRef.current = -1;
        requestPausedFrame(secondsRef.current);
    };

    // 用稳定的 callback ref 接管 <video>：元素被移除（切项目、关闭页面）时 React 会先回调 null 再摘 DOM，
    // 正好在这里停播；普通 useEffect 清理拿到的 ref 那时已经是 null，拦不住后台播放。
    const onFrameSeeked = useCallback(() => frameFlushRef.current(), []);

    const attachVideo = useCallback(
        (element: HTMLVideoElement | null) => {
            const previous = videoRef.current;
            if (previous && previous !== element) {
                previous.removeEventListener("seeked", onFrameSeeked);
                releaseVideo(previous);
            }
            videoRef.current = element;
            // seeked 表示这一帧已经解码到位：这时才补发下一个目标，拖动再快也不会叠出多个在途 seek。
            element?.addEventListener("seeked", onFrameSeeked);
        },
        [onFrameSeeked],
    );

    // 逐段播放：切 src → 等元数据 → 按主时钟对齐到入点 → play()。
    // 段序与段尾都由主时钟判定，视频落后/超前只做校正，不参与决定时间。
    const startClip = (index: number, seekTo?: number) => {
        const video = videoRef.current;
        const view = viewsRef.current[index];
        if (!video || !view) {
            stopPreview();
            return;
        }
        const landing = seekTo ?? view.start;
        if (!view.src) {
            // 素材被移除 / 没有可播地址：不阻塞主时钟，等它自然被跳过。
            detachHandlers(video);
            indexRef.current = index;
            awaitingRef.current = false;
            srcRef.current = "";
            return;
        }
        if (srcRef.current === view.src) {
            // 同一份素材（段内定位，或相邻两段引用同一个素材）：直接定位，不重载 src。
            detachHandlers(video);
            indexRef.current = index;
            awaitingRef.current = false;
            waitingRef.current = false;
            video.currentTime = landing;
            frameAppliedRef.current = -1;
            if (playingRef.current && video.paused) void video.play().catch(() => undefined);
            return;
        }
        detachHandlers(video);
        indexRef.current = index;
        awaitingRef.current = true;
        waitingRef.current = false;
        paintPlayhead(view.offset + Math.max(0, landing - view.start));
        const loaded = () => {
            detachHandlers(video);
            awaitingRef.current = false;
            // 加载期间用户按了暂停：不要把播放重新拉起来（暂停后还在后台出声是最难察觉的一类问题），
            // 交给暂停态取帧把画面停在播放头位置。
            if (!playingRef.current) {
                frameAppliedRef.current = -1;
                requestPausedFrame(secondsRef.current);
                return;
            }
            // 元数据就绪后再按主时钟对齐一次：加载期间主时钟一直在走，起播点必须重算。
            const clock = clockRef.current;
            const target = clock ? editDesiredMediaSeconds(view, clock.currentTime) : landing;
            if (target > 0) video.currentTime = target;
            void video.play().catch(() => {
                message.warning(t("editor.previewBlocked"));
                stopPreview();
            });
        };
        const failed = () => {
            detachHandlers(video);
            message.warning(t("editor.previewFailed", { name: view.name }));
            stopPreview();
        };
        handlersRef.current = { loaded, failed };
        video.addEventListener("loadedmetadata", loaded);
        video.addEventListener("error", failed);
        video.src = view.src;
        video.load();
        srcRef.current = view.src;
    };

    /**
     * 播放心跳（每帧只读主时钟 + 写 DOM / <video> 属性，**不写任何 React 状态**）：
     * 1. 播放头位置 = 主时钟时间；
     * 2. 当前段由主时钟推导，段切换点在这里换源；
     * 3. 视频与主时钟偏差超过一帧就丢帧追赶（向前 seek）/ 补帧等待（暂停重复当前帧）。
     */
    const stepPreview = () => {
        if (!playingRef.current) return false;
        const video = videoRef.current;
        const clock = clockRef.current;
        const list = viewsRef.current;
        const total = totalRef.current;
        if (!video || !clock || total <= 0) {
            stopPreview();
            return false;
        }

        const seconds = Math.min(total, clock.currentTime);
        secondsRef.current = seconds;
        paintPlayhead(seconds, total);

        // 末段播完：以主时钟到点为准停表，而不是等某个 <video> 播完。
        if (seconds >= total - 1e-4) {
            stopPreview();
            paintPlayhead(total, total);
            return false;
        }

        // 片段切换点：段序完全由主时钟推导（视频各自播各自的会越播越偏）。
        const index = list.findIndex((view) => view.length > 0 && seconds < view.offset + view.length);
        if (index < 0) {
            stopPreview();
            return false;
        }
        if (index !== indexRef.current) {
            startClip(index, editDesiredMediaSeconds(list[index]!, seconds));
            return true;
        }
        if (awaitingRef.current) return true;

        const view = list[indexRef.current];
        if (!view) {
            stopPreview();
            return false;
        }
        const desired = editDesiredMediaSeconds(view, seconds);
        const state = resolveEditPlayback(list, indexRef.current, desired);
        if (state) video.volume = state.volume;

        const action = editDriftAction(editDriftSeconds(desired, video.currentTime), frameSecondsRef.current);
        if (action === "skip") {
            const now = performance.now();
            if (editDriftCooldownReady(lastCorrectionRef.current, now)) {
                lastCorrectionRef.current = now;
                waitingRef.current = false;
                video.currentTime = desired;
            }
        } else if (action === "wait") {
            // 视频超前：暂停一会儿，重复当前帧等主时钟追上来。
            if (!video.paused) video.pause();
            waitingRef.current = true;
        } else if (waitingRef.current || video.paused) {
            waitingRef.current = false;
            void video.play().catch(() => undefined);
        }
        return true;
    };

    const tick = () => {
        frameRef.current = 0;
        if (!stepPreview()) return;
        frameRef.current = requestAnimationFrame(tick);
    };

    /** 播放中定位：主时钟重新起基准，视频跟着重建，避免两边各自为政。 */
    const seekPreview = (seconds: number) => {
        if (!playingRef.current) return;
        clockRef.current?.seek(seconds);
        const target = resolveEditSeek(viewsRef.current, seconds);
        if (target) startClip(target.index, target.currentTime);
    };

    /** 播放头定位提交（点标尺 / 松手 / 快捷键）：播放中重新基准主时钟并重建视频，暂停态只把画面取到播放头位置。 */
    const commitPlayhead = (seconds: number) => {
        if (playingRef.current) seekPreview(seconds);
        else requestPausedFrame(seconds);
    };

    /** 播放头定位（暂停时只画 DOM 与取帧；播放中连主时钟与视频一起重新对齐）。 */
    const seekTo = (seconds: number) => {
        const total = totalRef.current;
        const clamped = Math.min(total, Math.max(0, seconds));
        secondsRef.current = clamped;
        paintPlayhead(clamped, total);
        commitPlayhead(clamped);
    };

    const togglePreview = async () => {
        if (playingRef.current) {
            stopPreview();
            return;
        }
        // 时钟源初始化只需要一瞬；这期间再点一次直接忽略，避免起两条播放循环。
        if (preparingRef.current) return;
        const list = views;
        const total = list.reduce((sum, view) => sum + view.length, 0);
        const first = list.findIndex((view) => view.length > 0 && view.src);
        if (first < 0 || total <= 0) {
            message.warning(t("editor.previewEmpty"));
            return;
        }
        // 时钟源只解析一次，之后一直复用（中途换源会让时间跳变）。
        preparingRef.current = true;
        const source = await resolveEditClockSource();
        preparingRef.current = false;
        clockRef.current ??= new EditPlaybackClock(source);
        const clock = clockRef.current;

        viewsRef.current = list;
        totalRef.current = total;
        const from = secondsRef.current >= total - 0.05 ? 0 : Math.max(0, secondsRef.current);
        const resolved = resolveEditSeek(list, from);
        const target = resolved && list[resolved.index]!.length > 0 && list[resolved.index]!.src ? resolved : { index: first, currentTime: list[first]!.start };
        playingRef.current = true;
        waitingRef.current = false;
        lastCorrectionRef.current = 0;
        setPlaying(true);
        clock.play(from);
        startClip(target.index, target.currentTime);
        if (!frameRef.current) frameRef.current = requestAnimationFrame(tick);
    };

    // 切项目：停播、放掉上一个项目的源、播放头归零。必须排在下面的时间线同步 effect 之前，
    // 这样紧接着的同步逻辑就是拿「新项目 + 播放头 0」去取第一帧。
    useEffect(() => {
        stopPreview();
        secondsRef.current = 0;
        paintGuide(null);
        const video = videoRef.current;
        if (video) releaseVideo(video);
    }, [projectId]);

    // 时间线数据变化（改入出点、增删片段、撤销重做、可播放地址解析完成）后同步过程量并重新对齐读数——只写 DOM。
    useEffect(() => {
        viewsRef.current = views;
        totalRef.current = totalSeconds;
        frameSecondsRef.current = editFrameSeconds(project?.output.fps ?? 30);
        const clamped = Math.min(secondsRef.current, totalSeconds);
        secondsRef.current = clamped;
        paintPlayhead(clamped, totalSeconds);
        // 暂停态补一帧：刚进页面、地址刚解析出来、刚改完片段时，预览区都该是播放头这一帧的画面。
        if (!playingRef.current) requestPausedFrame(clamped);
    }, [views, totalSeconds, project?.output.fps]);

    useEffect(
        () => () => {
            stopPreview();
            if (frameRef.current) cancelAnimationFrame(frameRef.current);
            if (scrubFrameRef.current) cancelAnimationFrame(scrubFrameRef.current);
            // 两个句柄都要归零：开发模式的 StrictMode 会先跑一遍清理再重挂，
            // 句柄不归零的话下一次取帧会以为「已经排上了 rAF」，从此再也不更新画面。
            frameRef.current = 0;
            scrubFrameRef.current = 0;
        },
        [],
    );

    // seeked 监听只绑一次（见 attachVideo），实现体每次渲染用 ref 刷新：与快捷键表同一写法。
    useEffect(() => {
        frameFlushRef.current = flushPausedFrameSeek;
    });

    useEffect(() => {
        snapEnabledRef.current = snapEnabled;
    }, [snapEnabled]);

    // ── 时间线上的直接操作：拖片段本体换序，拖两端裁剪入点/出点，过程中开启吸附 ───────────
    // 拖动过程只写 DOM（flexGrow / transform / textContent / 导引线位置），一条 store 写入都不发生；
    // 松手时按 ref 里记下的目标值提交一次。这是 React #185 的直接对策。
    const dragRef = useRef<{ index: number; x: number; shift: number; target: number; perPixel: number; element: HTMLElement } | null>(null);
    const trimRef = useRef<{ index: number; edge: "start" | "end"; x: number; perPixel: number; pending: number | null; element: HTMLElement; label: HTMLElement | null } | null>(null);
    const draggedRef = useRef(false);

    const clipLabel = (view: EditClipView, index: number, seconds: number) => `${t("editor.clipNumber", { index: index + 1 })} · ${seconds.toFixed(1)}s · ${view.name}`;

    /** 当前缩放下的吸附阈值（秒）：阈值按 40px 给，随缩放换算。 */
    const snapThreshold = () => {
        const box = timelineRef.current?.getBoundingClientRect();
        return editSnapThresholdSeconds(box?.width ?? 0, totalSeconds);
    };

    /** 拖这一下要不要吸附：开关关掉、按住 Alt、或拖得太快，都不吸附。 */
    const snapActive = (event: ReactPointerEvent<HTMLElement>) => {
        if (!snapEnabledRef.current || event.altKey) return false;
        const now = performance.now();
        const velocity = editPointerVelocity(velocityRef.current.x, velocityRef.current.at, event.clientX, now);
        velocityRef.current = { x: event.clientX, at: now };
        return !isEditSnapSuppressed(velocity);
    };

    const snapPointsFor = (excludeClipId: string) => collectEditSnapPoints(views, { playhead: secondsRef.current, grid: editGridStep(totalSeconds), excludeClipIds: [excludeClipId] });

    const startReorder = (event: ReactPointerEvent<HTMLDivElement>, index: number) => {
        event.stopPropagation();
        draggedRef.current = false;
        const box = timelineRef.current?.getBoundingClientRect();
        velocityRef.current = { x: event.clientX, at: performance.now() };
        dragRef.current = {
            index,
            x: event.clientX,
            shift: 0,
            target: index,
            perPixel: box && box.width > 0 && totalSeconds > 0 ? totalSeconds / box.width : 0.05,
            element: event.currentTarget,
        };
    };

    const startTrim = (event: ReactPointerEvent<HTMLSpanElement>, index: number, edge: "start" | "end") => {
        event.stopPropagation();
        const view = views[index];
        const bar = event.currentTarget.parentElement;
        if (!view || !bar) return;
        const width = bar.getBoundingClientRect().width;
        draggedRef.current = true;
        velocityRef.current = { x: event.clientX, at: performance.now() };
        trimRef.current = {
            index,
            edge,
            x: event.clientX,
            perPixel: width > 0 ? Math.max(0.1, view.length) / width : 0.05,
            pending: null,
            element: bar,
            label: bar.querySelector("[data-clip-label]"),
        };
    };

    /** 裁剪值的合法区间：入点不低于 0、不越过出点前 0.1 秒；出点不早于入点后 0.1 秒、不超过素材全长。 */
    const clampTrimValue = (view: EditClipView, edge: "start" | "end", value: number) => {
        if (edge === "start") {
            const until = (view.end || view.sourceSeconds) - 0.1;
            return Number(Math.min(Math.max(0, value), Math.max(0, until)).toFixed(2));
        }
        const next = Math.max(view.start + 0.1, value);
        return Number((view.sourceSeconds ? Math.min(next, view.sourceSeconds) : next).toFixed(2));
    };

    const handleTimelineMove = (event: ReactPointerEvent<HTMLDivElement>) => {
        const trim = trimRef.current;
        if (trim) {
            event.stopPropagation();
            const view = views[trim.index];
            if (!view) return;
            const delta = (event.clientX - trim.x) * trim.perPixel;
            const raw = clampTrimValue(view, trim.edge, (trim.edge === "start" ? view.start : view.end || view.sourceSeconds) + delta);
            // 吸附作用在「这条边在时间线上的全局秒数」上，再换回素材内的入点 / 出点。
            let pending = raw;
            let guide: EditSnapPoint | null = null;
            if (snapActive(event)) {
                const globalSeconds = view.offset + (raw - view.start);
                const snapped = resolveEditSnap(globalSeconds, 0, snapPointsFor(view.id), snapThreshold());
                if (snapped.snapped) {
                    const atSnap = Number((view.start + (snapped.seconds - view.offset)).toFixed(2));
                    const candidate = clampTrimValue(view, trim.edge, atSnap);
                    // 吸附点被夹回合法区间时就不再画导引线，免得线指着一个到不了的位置。
                    if (candidate === atSnap) {
                        pending = candidate;
                        guide = snapped.point ?? null;
                    }
                }
            }
            trim.pending = pending;
            // 只改这一条片段自己的宽度与标签：flex 布局会让后面的片段自动跟着挪，无需 React 参与。
            const length = trim.edge === "start" ? (view.end || view.sourceSeconds) - pending : pending - view.start;
            trim.element.style.flexGrow = String(Math.max(0.2, length));
            if (trim.label) trim.label.textContent = clipLabel(view, trim.index, Math.max(0, length));
            paintGuide(guide);
            return;
        }
        const drag = dragRef.current;
        if (!drag) return;
        event.stopPropagation();
        const view = views[drag.index];
        if (!view) return;
        const delta = event.clientX - drag.x;
        if (Math.abs(delta) > 4) draggedRef.current = true;
        const deltaSeconds = delta * drag.perPixel;
        const rawStart = view.offset + deltaSeconds;
        let startSeconds = rawStart;
        let guide: EditSnapPoint | null = null;
        if (snapActive(event)) {
            const snapped = resolveEditSnap(rawStart, view.length, snapPointsFor(view.id), snapThreshold());
            if (snapped.snapped) {
                startSeconds = snapped.seconds;
                guide = snapped.point ?? null;
            }
        }
        drag.target = editReorderIndex(views, drag.index, startSeconds);
        drag.shift = drag.target - drag.index;
        // 过程视觉同样用吸附后的落点，松手提交的位置和看到的一致。
        drag.element.style.transform = `translateX(${(startSeconds - view.offset) / drag.perPixel}px)`;
        paintGuide(guide);
    };

    const commitReorder = (from: number, to: number) => {
        if (to === from || to < 0 || to >= clips.length) return;
        const next = clips.slice();
        const [moved] = next.splice(from, 1);
        if (!moved) return;
        next.splice(to, 0, moved);
        updateClips(projectId, next);
    };

    const endTimelineDrag = () => {
        const drag = dragRef.current;
        const trim = trimRef.current;
        dragRef.current = null;
        trimRef.current = null;
        paintGuide(null);
        if (drag) {
            drag.element.style.transform = "";
            commitReorder(drag.index, draggedRef.current ? drag.target : drag.index);
        }
        if (trim && trim.pending !== null) {
            const view = views[trim.index];
            const current = trim.edge === "start" ? view?.start : view?.end;
            if (view && trim.pending !== current) updateClip(projectId, view.id, trim.edge === "start" ? { start: trim.pending } : { end: trim.pending });
        }
    };

    const movePlayheadFromClientX = (clientX: number, commit: boolean) => {
        const box = timelineRef.current?.getBoundingClientRect();
        if (!box || box.width <= 0 || totalSeconds <= 0) return;
        const seconds = Math.min(totalSeconds, Math.max(0, ((clientX - box.left) / box.width) * totalSeconds));
        secondsRef.current = seconds;
        paintPlayhead(seconds, totalSeconds);
        // 播放中沿用「松手才重新对齐主时钟」；暂停态边拖边取帧，节流交给 requestPausedFrame
        //（同一帧只跑一次 + 最新目标胜出 + 在途最多一个 seek），拖动过程一次都不写 store。
        if (playingRef.current) {
            if (commit) seekPreview(seconds);
            return;
        }
        requestPausedFrame(seconds);
    };

    // ── 拆分 / 删除 / 撤销重做：都由快捷键与按钮触发，一次操作一次 store 写入 ─────────────
    const playheadClipId = () => {
        const index = editClipIndexAt(views, secondsRef.current);
        return index >= 0 ? views[index]!.id : null;
    };

    /** 拆分优先用选中的片段，但必须包含播放头；否则用播放头所在的那一段。 */
    const splitAtPlayhead = () => {
        const here = playheadClipId();
        const selectedInside = Boolean(clipId) && views.some((view) => view.id === clipId && editSecondsInsideClip(view, secondsRef.current));
        const target = selectedInside ? clipId : here;
        if (!target || !splitClip(projectId, target, secondsRef.current)) {
            message.warning(t("editor.splitNowhere"));
            return false;
        }
        return true;
    };

    const deleteAt = (ripple: boolean) => {
        const target = (clipId && views.some((view) => view.id === clipId) ? clipId : null) ?? playheadClipId();
        if (!target) {
            message.warning(t("editor.deleteNowhere"));
            return false;
        }
        const removed = views.find((view) => view.id === target);
        onSelectClip(null);
        if (ripple) {
            rippleRemoveClip(projectId, target);
            // 涟漪：播放头跟着前移被删时长，接缝清干净不留残余。
            seekTo(Math.max(0, secondsRef.current - (removed?.length ?? 0)));
        } else {
            removeClip(projectId, target);
        }
        return true;
    };

    const runShortcut = (action: EditShortcutAction): boolean => {
        switch (action) {
            case "playPause":
                void togglePreview();
                return true;
            case "split":
                return splitAtPlayhead();
            case "delete":
                return deleteAt(false);
            case "rippleDelete":
                return deleteAt(true);
            case "undo":
                if (!flags.canUndo) return false;
                undoEdit(projectId);
                return true;
            case "redo":
                if (!flags.canRedo) return false;
                redoEdit(projectId);
                return true;
            case "toggleSnap":
                setSnapEnabled((value) => !value);
                return true;
            case "stepBack":
                seekTo(secondsRef.current - frameSecondsRef.current);
                return true;
            case "stepForward":
                seekTo(secondsRef.current + frameSecondsRef.current);
                return true;
            case "stepSecondBack":
                seekTo(secondsRef.current - 1);
                return true;
            case "stepSecondForward":
                seekTo(secondsRef.current + 1);
                return true;
        }
    };

    // 监听只注册一次，执行体每次渲染刷新，避免因依赖变化反复解绑重绑。
    const shortcutRef = useRef(runShortcut);
    useEffect(() => {
        shortcutRef.current = runShortcut;
    });
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.isComposing) return;
            // 焦点在输入框 / 文本域 / 可编辑元素上时一律放行，否则用户打不出字。
            if (isEditShortcutTargetBlocked(event.target as HTMLElement | null)) return;
            const binding = matchEditShortcut(event);
            if (!binding) return;
            if (shortcutRef.current(binding.action)) {
                event.preventDefault();
                event.stopPropagation();
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, []);

    const tickStep = editTickStep(totalSeconds);
    const ticks: number[] = [];
    for (let tickValue = 0; totalSeconds > 0 && tickValue < totalSeconds; tickValue += tickStep) ticks.push(Number(tickValue.toFixed(3)));
    const empty = views.length === 0;

    // 时间线空状态的一键引导：把已探测到时长的视频素材按素材顺序一次排上时间线（一次写入）。
    const addAllToTimeline = () => {
        const usable = media.filter((item) => item.kind === "video" && item.durationMs);
        if (!usable.length) {
            message.warning(t("editor.emptyClipsActionNone"));
            return;
        }
        addClips(projectId, usable.map((item) => createEditClip(item.id)));
        message.success(t("editor.addedToTimeline"));
    };

    const shortcutHelp = (
        <div className="flex flex-col gap-2">
            <ul className="flex flex-col gap-1.5">
                {EDIT_SHORTCUTS.map((binding) => (
                    <li key={binding.id} className="flex items-center justify-between gap-6 text-[11px]">
                        <span style={{ color: token.colorTextSecondary }}>{t(binding.labelKey)}</span>
                        <kbd className="shrink-0 rounded-[5px] px-1.5 py-0.5 text-[10px] tabular-nums" style={{ background: token.colorFillTertiary, color: token.colorText }}>
                            {editShortcutDisplay(binding)}
                        </kbd>
                    </li>
                ))}
            </ul>
            <p className="max-w-[240px] text-[10px] leading-4" style={{ color: token.colorTextTertiary }}>
                {t("editor.snapThresholdHint", { px: EDIT_SNAP_THRESHOLD_PX })}
            </p>
        </div>
    );

    return (
        <section className="flex min-h-0 flex-1 flex-col">
            <div data-edit-area="preview" aria-label={t("editor.preview")} className="flex min-h-0 flex-1 flex-col border-b border-black/[0.07] dark:border-white/[0.07]">
                <header className="flex h-11 shrink-0 items-center gap-2 px-4">
                    <Button
                        type="text"
                        size="small"
                        className="!h-7 !w-7 !min-w-7 !p-0"
                        disabled={totalSeconds <= 0}
                        icon={playing ? <Pause className="size-3.5 fill-current" /> : <Play className="size-3.5 fill-current" />}
                        aria-label={playing ? t("editor.pause") : t("editor.play")}
                        onClick={() => void togglePreview()}
                    />
                    <span className="shrink-0 text-[12px] tabular-nums text-stone-600 dark:text-zinc-400">
                        <span ref={readoutRef}>0:00.0</span>
                        <span className="text-stone-400 dark:text-zinc-600"> / {formatEditTime(totalSeconds)}</span>
                    </span>
                    <span ref={activeLabelRef} className="min-w-0 flex-1 truncate text-[11px] text-stone-400 dark:text-zinc-600" />
                    <Tooltip title={t("editor.previewHintDetail")}>
                        <span className="inline-flex shrink-0 cursor-help items-center gap-1 text-[10px] text-stone-400 dark:text-zinc-600">
                            <Info className="size-3" />
                            {t("editor.previewHint")}
                        </span>
                    </Tooltip>
                </header>
                <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black/85">
                    {empty ? (
                        <div className="flex flex-col items-center gap-2 px-6 text-center">
                            <Clapperboard className="size-6 text-white/30" />
                            <span className="text-[12px] text-white/60">{hasMedia ? t("editor.emptyClips") : t("editor.emptyMedia")}</span>
                        </div>
                    ) : (
                        <video ref={attachVideo} data-edit-preview-video onTimeUpdate={stepPreview} playsInline preload="auto" className="max-h-full max-w-full" />
                    )}
                </div>
            </div>

            <div data-edit-area="timeline" aria-label={t("editor.timeline")} className="flex h-[236px] shrink-0 flex-col px-4 pt-2.5">
                <div className="flex h-6 shrink-0 items-center gap-2">
                    <span className="text-[11px] font-medium text-stone-700 dark:text-zinc-300">{t("editor.timeline")}</span>
                    <span className="text-[10px] tabular-nums text-stone-400 dark:text-zinc-600">{t("editor.clipCount", { count: views.length })}</span>
                    <span data-edit-history className="flex items-center gap-0.5">
                        <Tooltip title={labels.undo ? t("editor.undoWith", { label: labels.undo }) : t("editor.undo")}>
                            <Button type="text" size="small" className="!h-6 !w-6 !min-w-6 !p-0" disabled={!flags.canUndo} aria-label={t("editor.undo")} icon={<Undo2 className="size-3.5" />} onClick={() => undoEdit(projectId)} />
                        </Tooltip>
                        <Tooltip title={labels.redo ? t("editor.redoWith", { label: labels.redo }) : t("editor.redo")}>
                            <Button type="text" size="small" className="!h-6 !w-6 !min-w-6 !p-0" disabled={!flags.canRedo} aria-label={t("editor.redo")} icon={<Redo2 className="size-3.5" />} onClick={() => redoEdit(projectId)} />
                        </Tooltip>
                        <Tooltip title={snapEnabled ? t("editor.snapOnHint") : t("editor.snapOffHint")}>
                            <Button
                                type="text"
                                size="small"
                                className="!h-6 !w-6 !min-w-6 !p-0"
                                aria-label={t("editor.snapToggle")}
                                aria-pressed={snapEnabled}
                                icon={<Magnet className="size-3.5" style={{ color: snapEnabled ? token.colorPrimary : token.colorTextQuaternary }} />}
                                onClick={() => setSnapEnabled((value) => !value)}
                            />
                        </Tooltip>
                        <Popover content={shortcutHelp} title={t("editor.shortcutsTitle")} trigger="click" placement="topLeft">
                            <Button type="text" size="small" className="!h-6 !min-w-6 !px-1.5 text-[10px]" aria-label={t("editor.shortcutsTitle")} icon={<Info className="size-3.5" />}>
                                {t("editor.shortcuts")}
                            </Button>
                        </Popover>
                    </span>
                    <span className="ml-auto text-[10px] text-stone-400 dark:text-zinc-600">{t("editor.timelineHint")}</span>
                </div>

                {empty ? (
                    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
                        <span className="text-[12px] text-stone-500 dark:text-zinc-500">{hasMedia ? t("editor.emptyClips") : t("editor.emptyMedia")}</span>
                        <span className="text-[10px] text-stone-400 dark:text-zinc-600">{t("editor.emptyClipsHint")}</span>
                        {hasMedia ? (
                            <Button size="small" onClick={addAllToTimeline}>
                                {t("editor.emptyClipsAction")}
                            </Button>
                        ) : null}
                    </div>
                ) : (
                    <div className="relative mt-2" ref={timelineRef}>
                        <div className="relative h-6 cursor-pointer touch-none select-none" title={t("editor.seekHint")} onPointerDown={(event) => { seekingRef.current = true; movePlayheadFromClientX(event.clientX, false); }} onPointerMove={(event) => { if (seekingRef.current) movePlayheadFromClientX(event.clientX, false); }} onPointerUp={() => { seekingRef.current = false; commitPlayhead(secondsRef.current); }} onPointerCancel={() => { seekingRef.current = false; }} onPointerLeave={() => { seekingRef.current = false; }}>
                            {ticks.map((tickValue) => (
                                <span key={tickValue} className="absolute top-0 flex flex-col items-center" style={{ left: `${(tickValue / totalSeconds) * 100}%`, transform: tickValue === 0 ? "none" : "translateX(-50%)" }}>
                                    <span className="h-1.5 w-px bg-stone-300 dark:bg-zinc-700" />
                                    <span className="text-[9px] leading-none tabular-nums text-stone-400 dark:text-zinc-600">{editTickLabel(tickValue, tickStep)}</span>
                                </span>
                            ))}
                            <span className="absolute bottom-0 right-0 text-[9px] leading-none text-stone-400 dark:text-zinc-600">{t("editor.seconds")}</span>
                        </div>

                        <div className="flex items-stretch gap-1" onPointerMove={handleTimelineMove} onPointerUp={endTimelineDrag} onPointerCancel={endTimelineDrag} onPointerLeave={endTimelineDrag}>
                            {views.map((view, index) => (
                                <div
                                    key={view.id}
                                    data-edit-clip={view.id}
                                    className={`relative h-12 min-w-[14px] cursor-grab touch-none select-none overflow-hidden rounded-[8px] border transition-colors active:cursor-grabbing ${view.id === clipId ? "border-[#756bff]" : "border-black/[0.09] hover:bg-black/[0.03] dark:border-white/[0.09] dark:hover:bg-white/[0.04]"}`}
                                    // 片段条宽度按真实时长铺开：flexGrow 就是该段秒数，拖动裁剪时直接改这个值即可让后面自动让位。
                                    style={{ flex: `${Math.max(0.2, view.length)} 1 0%` }}
                                    title={t("editor.clipHint", { index: index + 1, seconds: view.length.toFixed(1) })}
                                    onPointerDown={(event) => { startReorder(event, index); onSelectClip(view.id); }}
                                >
                                    <span data-clip-label className="pointer-events-none absolute inset-0 flex items-center gap-1 truncate px-2 text-[10px] text-stone-500 dark:text-zinc-400">
                                        {view.hasDuration ? clipLabel(view, index, view.length) : t("editor.clipNoDuration", { index: index + 1 })}
                                    </span>
                                    <span className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize rounded-l-[8px] hover:bg-black/10 dark:hover:bg-white/15" title={t("editor.trimStart")} onPointerDown={(event) => startTrim(event, index, "start")} />
                                    <span className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize rounded-r-[8px] hover:bg-black/10 dark:hover:bg-white/15" title={t("editor.trimEnd")} onPointerDown={(event) => startTrim(event, index, "end")} />
                                </div>
                            ))}
                        </div>

                        {/* 音轨行：音频只出现在右侧属性区的「音轨」列表里，看不到波形就没法做音画对齐，
                            所以在这里按同一条时间轴给每条音轨铺一行波形（位置与宽度都用百分比，与标尺、播放头同一套换算）。 */}
                        <EditAudioTrackRow projectId={projectId} totalSeconds={totalSeconds} />

                        {/* 吸附导引线：吸附到哪就画到哪，位置只由 paintGuide 直写 style.left（不弹时间气泡）。 */}
                        <div ref={guideRef} data-edit-snap-guide className="pointer-events-none absolute inset-y-0 z-10 w-px" style={{ left: "0%", opacity: 0, background: token.colorPrimary }} />
                        {/* 播放头：位置只由 paintPlayhead 直接写 style.left，不参与 React 渲染。 */}
                        <div ref={playheadRef} data-edit-playhead className="pointer-events-none absolute inset-y-0 w-px bg-[#756bff]" style={{ left: "0%" }} />
                    </div>
                )}

                <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pb-2 text-[10px] text-stone-400 dark:text-zinc-600">
                    <span className="flex items-center gap-1.5">
                        <Music2 className="size-3" />
                        {t("editor.audioTrackHint")}
                    </span>
                    {/* 快捷键常驻提示：完整键位表在右上角的帮助弹层里。 */}
                    <span data-edit-shortcut-hint className="ml-auto flex items-center gap-1.5">
                        {editShortcutHints().map((binding) => (
                            <kbd key={binding.id} title={t(binding.labelKey)} className="rounded-[5px] px-1.5 py-0.5 text-[10px] tabular-nums" style={{ background: token.colorFillTertiary, color: token.colorTextSecondary }}>
                                {editShortcutDisplay(binding)}
                            </kbd>
                        ))}
                    </span>
                </div>
            </div>
        </section>
    );
}
