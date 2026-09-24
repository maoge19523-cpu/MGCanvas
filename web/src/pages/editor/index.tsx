import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, Tooltip, message } from "antd";
import { Clapperboard, Download, LoaderCircle } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { nanoid } from "nanoid";

import { canvasThemes } from "@/lib/canvas-theme";
import { buildCompositePreviewClips, clipTotalSeconds, COMPOSITE_MUSIC_PORT_ID, COMPOSITE_SEGMENTS_PORT_ID, COMPOSITE_VOICE_PORT_ID, resolveCompositeSources } from "@/lib/canvas/composite-editing";
import { buildCompositeOutputConnection, buildCompositeOutputNode, composeCompositeVideo } from "@/lib/canvas/composite-run";
import { readCurrentCanvas } from "@/lib/canvas/current-canvas";
import { reorderCanvasConnections } from "@/lib/canvas/canvas-resource-references";
import { hydrateCanvasImages } from "@/lib/canvas/canvas-generation-helpers";
import { detectFfmpeg } from "@/services/platform/desktop-ffmpeg";
import { isTauriRuntime } from "@/services/platform/desktop-runtime";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasCompositeSegmentSettings, type CanvasCompositeSettings, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

import { EditorInspector } from "./components/editor-inspector";
import { EditorMaterialList } from "./components/editor-material-list";
import { EditorPreview } from "./components/editor-preview";
import { EditorTimeline } from "./components/editor-timeline";
import { useCompositePreview } from "./use-composite-preview";

const EMPTY_SETTINGS: CanvasCompositeSettings = {};
const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;

/**
 * 剪辑台：合成节点参数的独立编辑页。四区布局——左侧素材、上中预览、右侧属性、底部时间线。
 *
 * 片段顺序仍然是画布连线顺序，入出点等参数仍然写在节点的 compositeSettings 里，
 * 这里不新增任何数据模型；导出走的是和画布「开始合成」完全相同的 composeVideo 链路，
 * 成片同样回落成新的视频节点并自动连线。
 */
export default function EditorPage() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const params = useParams<{ id: string }>();
    const [searchParams] = useSearchParams();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const hydrated = useCanvasStore((state) => state.hydrated);
    const projectId = params.id || readCurrentCanvas();
    const updateProject = useCanvasStore((state) => state.updateProject);
    // 首屏直接用 store 快照渲染（避免空态闪一下），之后再跟随 store 的更新。
    const [initialProject] = useState(() => useCanvasStore.getState().projects.find((item) => item.id === projectId) || null);
    const project = useCanvasStore((state) => state.projects.find((item) => item.id === projectId)) || initialProject;

    const [nodes, setNodes] = useState<CanvasNodeData[]>(() => initialProject?.nodes || []);
    const [connections, setConnections] = useState<CanvasConnection[]>(() => initialProject?.connections || []);
    const [loaded, setLoaded] = useState(Boolean(initialProject));
    const [initialized, setInitialized] = useState(false);
    const [activeCompositeId, setActiveCompositeId] = useState("");
    const [selectedClipId, setSelectedClipId] = useState("");
    const [exporting, setExporting] = useState(false);
    const [ffmpegState, setFfmpegState] = useState<{ status: "checking" | "ready" | "missing"; path: string }>({ status: "checking", path: "" });
    const nodesRef = useRef(nodes);
    const connectionsRef = useRef(connections);

    useLayoutEffect(() => {
        nodesRef.current = nodes;
        connectionsRef.current = connections;
    }, [nodes, connections]);

    // 进页面时把媒体地址水合一次（视频/音频走 storageKey → 可用 URL），与画布页加载口径一致。
    // 只认 projectId 挂载一次：项目对象每次落盘都会换成新引用，跟着它跑会把编辑内容反复重置。
    useEffect(() => {
        if (!hydrated || initialized || !projectId) return;
        const source = useCanvasStore.getState().projects.find((item) => item.id === projectId);
        if (!source) return;
        let active = true;
        void hydrateCanvasImages(source.nodes).then((restored) => {
            if (!active) return;
            setNodes(restored);
            setConnections(source.connections);
            setInitialized(true);
        });
        return () => {
            active = false;
        };
    }, [hydrated, initialized, projectId]);

    // 剪辑台的改动直接落回画布项目（只改 nodes/connections，不碰视口等其它字段）。
    useEffect(() => {
        if (!loaded || !projectId) return;
        updateProject(projectId, { nodes, connections });
    }, [loaded, nodes, connections, projectId, updateProject]);

    useEffect(() => {
        if (!isTauriRuntime()) return;
        let active = true;
        // 探测结果与当前状态一致时返回同一个对象，避免 effect 反复触发渲染（React #185 的教训）。
        const apply = (next: { status: "ready" | "missing"; path: string }) => setFfmpegState((current) => (current.status === next.status && current.path === next.path ? current : next));
        void detectFfmpeg()
            .then((path) => {
                if (active) apply(path ? { status: "ready", path } : { status: "missing", path: "" });
            })
            .catch(() => {
                if (active) apply({ status: "missing", path: "" });
            });
        return () => {
            active = false;
        };
    }, []);

    const compositeNodes = useMemo(() => nodes.filter((node) => node.type === CanvasNodeType.Composite), [nodes]);
    const requestedNodeId = searchParams.get("node") || "";
    const activeComposite = compositeNodes.find((node) => node.id === (activeCompositeId || requestedNodeId)) || compositeNodes[0] || null;
    const settings = activeComposite?.metadata?.compositeSettings || EMPTY_SETTINGS;

    const mediaNodes = useMemo(() => nodes.filter((node) => (node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) && Boolean(node.metadata?.content)), [nodes]);
    const videoNodes = mediaNodes.filter((node) => node.type === CanvasNodeType.Video);
    const audioNodes = mediaNodes.filter((node) => node.type === CanvasNodeType.Audio);

    const sources = useMemo(() => (activeComposite ? resolveCompositeSources(nodes, connections, activeComposite.id) : { segments: [], music: null, voice: null }), [nodes, connections, activeComposite]);
    const clips = useMemo(() => buildCompositePreviewClips(sources.segments, settings), [sources, settings]);
    const totalSeconds = clipTotalSeconds(clips);
    const segmentNodeIds = useMemo(() => new Set(clips.map((clip) => clip.id)), [clips]);
    const selectedIndex = clips.findIndex((clip) => clip.id === selectedClipId);
    const selectedClip = selectedIndex >= 0 ? clips[selectedIndex]! : null;

    const preview = useCompositePreview(clips, totalSeconds);

    const updateSettings = useCallback(
        (patch: Partial<CanvasCompositeSettings>) => {
            if (!activeComposite) return;
            setNodes((prev) => prev.map((node) => (node.id === activeComposite.id ? { ...node, metadata: { ...node.metadata, compositeSettings: { ...node.metadata?.compositeSettings, ...patch } } } : node)));
        },
        [activeComposite],
    );

    const updateSegment = useCallback(
        (sourceNodeId: string, patch: Partial<CanvasCompositeSegmentSettings>) => {
            if (!activeComposite) return;
            setNodes((prev) =>
                prev.map((node) =>
                    node.id === activeComposite.id
                        ? {
                              ...node,
                              metadata: {
                                  ...node.metadata,
                                  compositeSettings: {
                                      ...node.metadata?.compositeSettings,
                                      segments: { ...node.metadata?.compositeSettings?.segments, [sourceNodeId]: { ...node.metadata?.compositeSettings?.segments?.[sourceNodeId], ...patch } },
                                  },
                              },
                          }
                        : node,
                ),
            );
        },
        [activeComposite],
    );

    // 加入时间线 = 在画布上建立「素材节点 → 合成节点对应端口」的连线；换序仍然只动连线顺序。
    const addSegment = useCallback(
        (node: CanvasNodeData) => {
            if (!activeComposite) return;
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: activeComposite.id, toPortId: COMPOSITE_SEGMENTS_PORT_ID }]);
            setSelectedClipId(node.id);
        },
        [activeComposite],
    );

    const removeSegment = useCallback(
        (node: CanvasNodeData) => {
            if (!activeComposite) return;
            setConnections((prev) => prev.filter((connection) => !(connection.toNodeId === activeComposite.id && connection.fromNodeId === node.id)));
            setSelectedClipId((current) => (current === node.id ? "" : current));
        },
        [activeComposite],
    );

    const setTrack = useCallback(
        (node: CanvasNodeData, port: "voice" | "music") => {
            if (!activeComposite) return;
            const portId = port === "voice" ? COMPOSITE_VOICE_PORT_ID : COMPOSITE_MUSIC_PORT_ID;
            setConnections((prev) => [...prev.filter((connection) => !(connection.toNodeId === activeComposite.id && connection.toPortId === portId)), { id: nanoid(), fromNodeId: node.id, toNodeId: activeComposite.id, toPortId: portId }]);
        },
        [activeComposite],
    );

    const reorderSegments = useCallback((sourceConnectionId: string, targetConnectionId: string) => {
        setConnections((prev) => reorderCanvasConnections(prev, sourceConnectionId, targetConnectionId));
    }, []);

    const handleExport = useCallback(async () => {
        if (!activeComposite || exporting) return;
        if (!isTauriRuntime()) {
            message.warning(t("editor.desktopOnly"));
            return;
        }
        if (!clips.length) {
            message.warning(t("editor.needClip"));
            return;
        }
        const target = activeComposite;
        setExporting(true);
        setNodes((prev) => prev.map((node) => (node.id === target.id ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)));
        try {
            const result = await composeCompositeVideo(target, nodesRef.current, connectionsRef.current);
            const outputNode = buildCompositeOutputNode(target, result);
            setNodes((prev) => [
                ...prev.map((node) =>
                    node.id === target.id
                        ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, compositeResult: { filename: result.filename, bytes: result.bytes, width: result.width, height: result.height, durationMs: result.durationMs, createdAt: new Date().toISOString() } } }
                        : node,
                ),
                outputNode,
            ]);
            setConnections((prev) => [...prev, buildCompositeOutputConnection(target.id, outputNode.id)]);
            message.success(t("editor.exportDone"));
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            message.error(t("editor.exportFailed", { reason }));
            setNodes((prev) => prev.map((node) => (node.id === target.id ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails: reason } } : node)));
        } finally {
            setExporting(false);
        }
    }, [activeComposite, clips.length, exporting, t]);

    if (!project) {
        return (
            <EditorEmptyState icon={<Clapperboard className="size-8 opacity-40" />} title={t("editor.noProject")} hint={t("editor.noProjectHint")} actionLabel={t("editor.goCanvas")} onAction={() => navigate("/canvas")} theme={theme} />
        );
    }

    if (!activeComposite) {
        return (
            <EditorEmptyState icon={<Clapperboard className="size-8 opacity-40" />} title={t("editor.noComposite")} hint={t("editor.noCompositeHint")} actionLabel={t("editor.goProject")} onAction={() => navigate(`/canvas/${projectId}`)} theme={theme} />
        );
    }

    const ffmpegText = !isTauriRuntime() ? t("editor.desktopOnly") : ffmpegState.status === "checking" ? t("editor.ffmpegChecking") : ffmpegState.status === "ready" ? t("editor.ffmpegReady", { path: ffmpegState.path }) : t("editor.ffmpegMissing");
    const canExport = isTauriRuntime() && !exporting && clips.length > 0 && ffmpegState.status !== "missing";

    return (
        <div className="flex h-full min-h-0 flex-col" style={{ background: theme.canvas.background, color: theme.node.text }}>
            <header className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2" style={{ borderColor: theme.toolbar.border }}>
                <span className="shrink-0" style={{ color: theme.node.muted }}>
                    <Clapperboard className="size-4" />
                </span>
                <span className="shrink-0 text-[13px] font-medium">{t("editor.title")}</span>
                <span className="min-w-0 truncate text-[11px]" style={{ color: theme.node.faint }} title={project.title}>
                    {project.title}
                </span>
                {compositeNodes.length > 1 ? (
                    <span className="flex min-w-0 items-center gap-1 text-[11px]" style={{ color: theme.node.muted }}>
                        {t("editor.compositeLabel")}
                        <select
                            className="max-w-[180px] rounded-md bg-transparent px-1 py-0.5 text-[11px] outline-none"
                            style={{ color: theme.node.text, border: `1px solid ${theme.toolbar.border}` }}
                            value={activeComposite.id}
                            onChange={(event) => {
                                setActiveCompositeId(event.target.value);
                                setSelectedClipId("");
                            }}
                        >
                            {compositeNodes.map((node) => (
                                <option key={node.id} value={node.id}>
                                    {node.title || t("canvas.node.untitled")}
                                </option>
                            ))}
                        </select>
                    </span>
                ) : null}
                <span className="ml-auto min-w-0 truncate text-[10px]" style={{ color: ffmpegState.status === "missing" && isTauriRuntime() ? "#fbbf24" : theme.node.faint }} title={ffmpegState.path}>
                    {ffmpegText}
                </span>
                <Tooltip title={clips.length ? t("editor.outputHint") : t("editor.needClip")}>
                    <span className="shrink-0">
                        <Button type="primary" size="small" className="!h-8 !rounded-full !px-4" loading={exporting} disabled={!canExport} icon={exporting ? <LoaderCircle className="size-3.5 animate-spin" /> : <Download className="size-3.5" />} onClick={() => void handleExport()}>
                            {exporting ? t("editor.exporting") : t("editor.export")}
                        </Button>
                    </span>
                </Tooltip>
            </header>

            <div className="flex min-h-0 flex-1">
                <EditorMaterialList videoNodes={videoNodes} audioNodes={audioNodes} segmentNodeIds={segmentNodeIds} voiceNodeId={sources.voice?.node.id || ""} musicNodeId={sources.music?.node.id || ""} disabled={exporting} onAddSegment={addSegment} onRemoveSegment={removeSegment} onSetTrack={setTrack} />
                <EditorPreview preview={preview} totalSeconds={totalSeconds} hasClips={clips.length > 0} />
                <EditorInspector clip={selectedClip} clipIndex={selectedIndex} settings={settings} voice={sources.voice?.node || null} music={sources.music?.node || null} disabled={exporting} onUpdateSegment={updateSegment} onUpdateSettings={updateSettings} />
            </div>

            <EditorTimeline preview={preview} clips={clips} settings={settings} totalSeconds={totalSeconds} selectedClipId={selectedClipId} disabled={exporting} onSelectClip={setSelectedClipId} onReorder={reorderSegments} onTrim={updateSegment} />
        </div>
    );
}

function EditorEmptyState({ icon, title, hint, actionLabel, onAction, theme }: { icon: ReactNode; title: string; hint: string; actionLabel: string; onAction: () => void; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    return (
        <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 px-10 text-center" style={{ background: theme.canvas.background, color: theme.node.muted }}>
            {icon}
            <span className="text-[14px] font-medium" style={{ color: theme.node.text }}>
                {title}
            </span>
            <span className="max-w-[520px] text-[12px] leading-5" style={{ color: theme.node.faint }}>
                {hint}
            </span>
            <Button type="text" className="!mt-1" style={{ color: theme.node.text }} onClick={onAction}>
                {actionLabel}
            </Button>
        </div>
    );
}
