import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { message } from "antd";
import { useTranslation } from "react-i18next";

import { formatTimelineTime, resolveCompositePlayback, resolveCompositeSeek, type CompositePreviewClip } from "@/lib/canvas/composite-editing";

/**
 * 剪辑台的顺序连播预览引擎（与合成节点浮层时代同一套逻辑，只换了宿主页面）。
 *
 * 纪律：播放头秒数是纯 UI 状态——只存在 ref 里，不进画布 store、不进节点 metadata，
 * 也**不进 React 状态**。播放期间每帧只写 ref 并直接改 DOM（播放头 left、读数 textContent），
 * 组件一次都不重渲染，从根上避免「逐帧写状态 → 渲染风暴 → React #185」。
 * 只有播放/暂停这一个低频开关用 state。
 */
export function useCompositePreview(clips: CompositePreviewClip[], totalSeconds: number) {
    const { t } = useTranslation();
    const [playing, setPlaying] = useState(false);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const playheadRef = useRef<HTMLDivElement | null>(null);
    const timelineRef = useRef<HTMLDivElement | null>(null);
    const timeRef = useRef<HTMLSpanElement | null>(null);
    const clipRef = useRef<HTMLSpanElement | null>(null);
    const secondsRef = useRef(0);
    const totalRef = useRef(0);
    const playingRef = useRef(false);
    const indexRef = useRef(0);
    const clipsRef = useRef<CompositePreviewClip[]>([]);
    const frameRef = useRef(0);
    const awaitingRef = useRef(false);
    const handlersRef = useRef<{ loaded: () => void; failed: () => void } | null>(null);
    const seekDraggingRef = useRef(false);

    // 播放头与读数一律直接改 DOM：这两个节点不参与 React 渲染，
    // 因此其它原因引起的重渲染也不会把播放中的位置冲掉。
    const paintPlayhead = useCallback((seconds: number, total = totalRef.current) => {
        if (playheadRef.current) playheadRef.current.style.left = `${total > 0 ? Math.min(100, Math.max(0, (seconds / total) * 100)) : 0}%`;
        if (timeRef.current) timeRef.current.textContent = formatTimelineTime(seconds);
        const index = clipsRef.current.findIndex((clip) => seconds < clip.offset + clip.length);
        const active = playingRef.current && index >= 0 ? clipsRef.current[index] : null;
        if (clipRef.current) clipRef.current.textContent = active ? `· ${t("editor.clipIndex", { index: index + 1 })} ${active.title}` : "";
    }, [t]);

    const detachHandlers = useCallback((video: HTMLVideoElement) => {
        const handlers = handlersRef.current;
        if (!handlers) return;
        video.removeEventListener("loadedmetadata", handlers.loaded);
        video.removeEventListener("error", handlers.failed);
        handlersRef.current = null;
    }, []);

    // 清干净一个 <video>：pause + 移除 src + load()，否则元素被卸载后仍会在后台继续出声。
    const releaseVideo = useCallback(
        (video: HTMLVideoElement) => {
            detachHandlers(video);
            video.pause();
            video.removeAttribute("src");
            video.load();
            video.volume = 1;
        },
        [detachHandlers],
    );

    const stop = useCallback(() => {
        if (frameRef.current) cancelAnimationFrame(frameRef.current);
        frameRef.current = 0;
        playingRef.current = false;
        awaitingRef.current = false;
        if (videoRef.current) releaseVideo(videoRef.current);
        setPlaying(false);
    }, [releaseVideo]);

    // 用稳定的 callback ref 接管 <video>：元素被移除（清空片段、切节点、离开页面）时 React 会先回调 null
    // 再摘 DOM，正好在这里停播；普通 useEffect 清理拿到的 ref 那时已经是 null，拦不住后台播放。
    const attachVideo = useCallback(
        (element: HTMLVideoElement | null) => {
            const previous = videoRef.current;
            if (previous && previous !== element) releaseVideo(previous);
            videoRef.current = element;
        },
        [releaseVideo],
    );

    // 逐段播放：切 src → 等元数据 → 定位到入点 → play()，段尾由 rAF 循环判定后切下一段。
    const startClip = useCallback(
        (index: number, seekTo?: number) => {
            const video = videoRef.current;
            const clip = clipsRef.current[index];
            if (!video || !clip) {
                stop();
                return;
            }
            detachHandlers(video);
            indexRef.current = index;
            awaitingRef.current = true;
            // 换段瞬间先把播放头放到该段落点：等元数据的空档里读数不会停在上一段末尾。
            const landing = seekTo ?? clip.start;
            paintPlayhead(clip.offset + Math.max(0, landing - clip.start));
            const loaded = () => {
                detachHandlers(video);
                awaitingRef.current = false;
                if (landing > 0) video.currentTime = landing;
                void video.play().catch(() => {
                    message.warning(t("editor.playBlocked"));
                    stop();
                });
            };
            const failed = () => {
                detachHandlers(video);
                message.warning(t("editor.clipUnplayable", { title: clip.title }));
                stop();
            };
            handlersRef.current = { loaded, failed };
            video.addEventListener("loadedmetadata", loaded);
            video.addEventListener("error", failed);
            video.src = clip.src;
            video.load();
        },
        [detachHandlers, paintPlayhead, stop, t],
    );

    // 播放心跳：读 <video>.currentTime → 算播放头秒数与音量 → 段尾切下一段，末段播完停表。
    // 抽成一步是为了让两条驱动共用：rAF 负责播放头平滑跟随，timeupdate 兜住「窗口不可见时浏览器停掉 rAF」
    // 的情况（否则当前段会越过出点一直放下去）。两处同时触发也安全——awaitingRef 会挡住重复切段。
    const step = useCallback(() => {
        if (!playingRef.current) return false;
        const video = videoRef.current;
        if (!video) {
            stop();
            return false;
        }
        if (awaitingRef.current) return true;
        const current = clipsRef.current;
        const state = resolveCompositePlayback(current, indexRef.current, video.currentTime);
        if (!state) {
            stop();
            return false;
        }
        video.volume = state.volume;
        secondsRef.current = state.seconds;
        paintPlayhead(state.seconds);
        if (state.finished) {
            // 跳过零时长的片段（源视频没有探测到时长），找不到下一段就停表。
            const next = current.findIndex((clip, index) => index > state.index && clip.length > 0);
            if (next < 0) {
                stop();
                paintPlayhead(totalRef.current);
                return false;
            }
            startClip(next);
        }
        return true;
    }, [paintPlayhead, startClip, stop]);

    const tick = useCallback(() => {
        frameRef.current = 0;
        if (!step()) return;
        frameRef.current = requestAnimationFrame(tick);
    }, [step]);

    // 播放中定位：把播放头秒数换成「第几段 + 段内时间」，同段只 seek，跨段才重新起播。
    const seek = useCallback(
        (seconds: number) => {
            if (!playingRef.current) return;
            const target = resolveCompositeSeek(clipsRef.current, seconds);
            if (!target) return;
            if (target.index === indexRef.current && !awaitingRef.current) {
                if (videoRef.current) videoRef.current.currentTime = target.currentTime;
                return;
            }
            startClip(target.index, target.currentTime);
        },
        [startClip],
    );

    const toggle = useCallback(() => {
        if (playingRef.current) {
            stop();
            return;
        }
        const current = clipsRef.current;
        const total = current.reduce((sum, clip) => sum + clip.length, 0);
        const first = current.findIndex((clip) => clip.length > 0 && clip.src);
        if (first < 0 || total <= 0) {
            message.warning(t("editor.noPreviewDuration"));
            return;
        }
        totalRef.current = total;
        // 播放头停在末尾时从头开始，否则从当前播放头位置续播。
        const from = secondsRef.current >= total - 0.05 ? 0 : Math.max(0, secondsRef.current);
        const resolved = resolveCompositeSeek(current, from);
        const target = resolved && current[resolved.index]!.length > 0 ? resolved : { index: first, currentTime: current[first]!.start };
        playingRef.current = true;
        setPlaying(true);
        startClip(target.index, target.currentTime);
        if (!frameRef.current) frameRef.current = requestAnimationFrame(tick);
    }, [startClip, stop, t, tick]);

    // 点击/拖动标尺只改播放头（ref + DOM）；拖动过程中不提交给 <video>，松手时才 seek 一次。
    const seekFromClientX = useCallback(
        (clientX: number, commit: boolean) => {
            const box = timelineRef.current?.getBoundingClientRect();
            const total = totalRef.current;
            if (!box || box.width <= 0 || total <= 0) return;
            const seconds = Math.min(total, Math.max(0, ((clientX - box.left) / box.width) * total));
            secondsRef.current = seconds;
            paintPlayhead(seconds);
            if (commit) seek(seconds);
        },
        [paintPlayhead, seek],
    );

    const startSeek = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            event.stopPropagation();
            seekDraggingRef.current = true;
            seekFromClientX(event.clientX, false);
        },
        [seekFromClientX],
    );

    const moveSeek = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            if (!seekDraggingRef.current) return;
            event.stopPropagation();
            seekFromClientX(event.clientX, false);
        },
        [seekFromClientX],
    );

    const endSeek = useCallback(() => {
        if (!seekDraggingRef.current) return;
        seekDraggingRef.current = false;
        seek(secondsRef.current);
    }, [seek]);

    // 片段快照变化（改入出点、增删片段、换顺序）后同步给播放循环；总时长变化时重新对齐读数。
    // 两处都只写 ref / DOM，不触发重渲染。
    useEffect(() => {
        clipsRef.current = clips;
        totalRef.current = totalSeconds;
        const clamped = Math.min(secondsRef.current, totalSeconds);
        secondsRef.current = clamped;
        paintPlayhead(clamped, totalSeconds);
    }, [clips, totalSeconds, paintPlayhead]);

    // 组件卸载（离开剪辑台）时停表；<video> 已由上面的 callback ref 释放。
    useEffect(() => () => stop(), [stop]);

    return { playing, playheadRef, timelineRef, timeRef, clipRef, attachVideo, step, paintPlayhead, toggle, stop, startSeek, moveSeek, endSeek, seekFromClientX, secondsRef };
}

export type CompositePreview = ReturnType<typeof useCompositePreview>;
