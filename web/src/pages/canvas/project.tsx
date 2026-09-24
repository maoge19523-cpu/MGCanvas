import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent as ReactChangeEvent, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Group, Video } from "lucide-react";
import { useTranslation } from "react-i18next";

import { requestEdit, requestGeneration, requestImageQuestion } from "@/services/api/image";
import { requestAudioGeneration, storeGeneratedAudio } from "@/services/api/audio";
import { requestVideoGeneration, storeGeneratedVideo, type VideoGenerationResult } from "@/services/api/video";
import { GenericApiError, GenericPollingStoppedError, describeGenericError, resumeGenericTasks, runGenericOperationBatch, type GenericReference, type GenericRunResult, type GenericSubmission } from "@/services/api/generic";
import { getGenericOperation } from "@/services/api/generic-contract";
import type { GenericOutput } from "@/services/api/generic-protocol";
import { persistGenericRunResult } from "@/services/api/generic-storage";
import { clearGenericTaskJournal, journalGenericSubmission, mergeGenericTaskJournal } from "@/services/api/generic-task-journal";
import { requestGenericWalletRefresh } from "@/services/api/generic-wallet";
import {resolveModelChannel, resolveModelRequestConfig, useConfigStore, useEffectiveConfig, selectableModelsByCapability } from "@/stores/use-config-store";
import { uploadImage, type UploadedImage } from "@/services/image-storage";
import { uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { downloadBlobBackedMedia, downloadFilenameFromTitle, resolveDownloadBlob, type DownloadableMediaKind } from "@/services/media-download";
import { cacheRemoteMedia } from "@/services/local-media-cache";
import { nanoid } from "nanoid";
import { getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { buildNodeContext } from "@/lib/canvas/plugin-node-context";
import { runComfyWorkflowNode } from "@/integrations/comfyui-local/execution";
import { getComfyWorkflowDefinition } from "@/integrations/comfyui-local/workflow-library";
import { CANVAS_MATERIAL_ACCEPT, CANVAS_MATERIAL_ACCEPT_BY_KIND, validateCanvasMaterialFile, type CanvasMaterialKind } from "@/lib/canvas/canvas-upload-material";
import { useAssetStore } from "@/stores/use-asset-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { cropDataUrl, splitDataUrl, upscaleDataUrl } from "@/lib/canvas/canvas-image-data";
import { withCanvasImageOperationSource, type CanvasImageOperationSource } from "@/lib/canvas/canvas-image-operation-source";
import { imageHistoryMetadataPatch, mergeGeneratedImageOutputsHistory, shouldKeepGeneratedOutputInImageHistory, shouldReplaceImageNodeOnGeneration } from "@/lib/canvas/canvas-image-history";
import { fitMediaNodeGeometry, fitNodeSize, nodeSizeFromRatio } from "@/lib/canvas/canvas-node-size";
import { App, Button, Modal } from "antd";
import { NODE_DEFAULT_SIZE, getNodeSpec } from "@/constant/canvas";
import { ActiveConnectionPath, ConnectionPath } from "@/components/canvas/canvas-connections";
import { CanvasAlignmentGuideOverlay } from "@/components/canvas/canvas-alignment-guides";
import { CanvasConfigComposer } from "@/components/canvas/canvas-config-composer";
import { CanvasConfigNodePanel } from "@/components/canvas/canvas-config-node-panel";
import { CanvasNodeContextMenu } from "@/components/canvas/canvas-context-menu";
import { CanvasNodeAngleDialog, type CanvasImageAngleParams } from "@/components/canvas/canvas-node-angle-dialog";
import { CanvasNodeCropDialog, type CanvasImageCropRect } from "@/components/canvas/canvas-node-crop-dialog";
import { CanvasNodeSplitDialog, type CanvasImageSplitParams } from "@/components/canvas/canvas-node-split-dialog";
import { CanvasCompareNodeContent } from "@/components/canvas/canvas-compare-node";
import { CanvasCollageNodeContent } from "@/components/canvas/canvas-collage-node";
import { CanvasCollageEditor } from "@/components/canvas/canvas-collage-editor";
import { collectCompareSources as resolveCompareSources } from "@/lib/canvas/compare-sources";
import { COLLAGE_RESULT_PORT_ID, collectCollageSources as resolveCollageSources, type CollageLayout } from "@/lib/canvas/collage-layout";
import { CanvasNodeUpscaleDialog, type CanvasImageUpscaleParams } from "@/components/canvas/canvas-node-upscale-dialog";
import { useCanvasImageOperationPreview } from "@/components/canvas/use-canvas-image-operation-preview";
import { buildNodeGenerationContext, buildNodeGenerationInputs, buildNodeResponseMessages, hydrateNodeGenerationContext, type NodeGenerationInput } from "@/components/canvas/canvas-node-generation";
import { CanvasNodeHoverToolbar, CanvasNodeInfoModal } from "@/components/canvas/canvas-node-hover-toolbar";
import { GenericNativeGenerationPanel } from "@/components/canvas/generic-native-generation-panel";
import { TextNodePanel } from "@/components/canvas/text-node-panel";
import { CanvasDirectorDialog, type DirectorCandidate } from "@/components/canvas/canvas-director-dialog";
import {
    genericNativeModels,
    genericNativeNodeKind,
    changeGenericNativeModel,
    countGenericNativeReferences,
    createGenericNativePayload,
    isChannelModelValue,
    parseGenericNativePayload,
    prepareGenericNativePromptAssets,
    prepareGenericNativeRun,
    readGenericNativePrompt,
    writeGenericNativePrompt,
} from "@/components/canvas/generic-native-generation";
import { MGCanvasSurface } from "@/components/canvas/td-canvas-surface";
import { Minimap } from "@/components/canvas/canvas-mini-map";
import { CanvasNode } from "@/components/canvas/canvas-node";
import { CanvasNodePromptPanel, type CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import { CanvasToolbar } from "@/components/canvas/canvas-toolbar";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { CanvasSidePanel } from "@/components/canvas/canvas-side-panel";
import { CanvasZoomControls } from "@/components/canvas/canvas-zoom-controls";
import { CanvasEmptyGuide } from "@/components/canvas/canvas-empty-guide";
import { useAgentStore } from "@/stores/use-agent-store";
import { watermarkImageBlob } from "@/lib/canvas/canvas-watermark";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useAgentBridge } from "@/pages/canvas/hooks/use-agent-bridge";
import { useMissingImageQueue } from "@/pages/canvas/hooks/use-missing-image-queue";
import { usePluginHost } from "@/pages/canvas/hooks/use-plugin-host";
import { buildNodeMentionReferences, reorderCanvasConnections, reorderCanvasObjectReferences, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { applyNodeConfigPatch, audioMetadata, buildAudioGenerationMetadata, buildImageGenerationMetadata, createCanvasNode, imageMetadata, videoMetadata } from "@/lib/canvas/canvas-node-factory";
import { readLastUsedNodeConfig, rememberLastUsedNodeConfig } from "@/lib/canvas/canvas-node-preferences";
import { findContainingGroupId, findGroupDropTarget, isHiddenBatchChild, isHiddenBatchConnectionEndpoint, snapNodesIntoGroup } from "@/lib/canvas/canvas-node-geometry";
import { resolveCanvasNodeDrag, type CanvasAlignmentGuides, type CanvasDragFrame } from "@/lib/canvas/canvas-alignment-guides";
import { canvasPortHandle, getConnectionHandleAnchor, getHandlePorts, normalizeConnectionHandles } from "@/lib/canvas/canvas-node-ports";
import {
    audioExtension,
    buildAngleLabel,
    buildAnglePrompt,
    buildGenerationConfig,
    findRetrySourceNode,
    generationReferenceUrls,
    getGenerationCount,
    getInputSummary,
    hydrateAssistantImages,
    hydrateCanvasImages,
    imageExtension,
    isGenerationCanceled,
    mergeReferenceImages,
    resetInterruptedGeneration,
    resolveMetadataReferences,
    resolvePromptAssetReferences,
    sourceNodeReferenceImages,
} from "@/lib/canvas/canvas-generation-helpers";
import { getNodeDefinition, isBuiltinNodeType as isBuiltinType, useNodeRegistryVersion } from "@/lib/canvas/node-registry";
import { registerBuiltinNodes, COMPOSITE_SEGMENTS_PORT_ID, COMPOSITE_MUSIC_PORT_ID, COMPOSITE_VOICE_PORT_ID, COMPOSITE_VIDEO_OUTPUT_PORT_ID } from "@/components/canvas/nodes/builtin-nodes";
import { CanvasCompositePanel } from "@/components/canvas/canvas-composite-panel";
import { CanvasAudioMergeDialog } from "@/components/canvas/canvas-audio-merge-dialog";
import { canvasNodeToEditMedia } from "@/services/edit-media";
import { useEditStore } from "@/stores/use-edit-store";
import { composeVideo, concatAudio, readFfmpegPath, resolveCanvasMediaLocalPath } from "@/services/platform/desktop-ffmpeg";
import { open } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";

import { desktopFileUrl, invokeDesktop, isTauriRuntime, readDesktopFileBlob } from "@/services/platform/desktop-runtime";
import { CanvasRefreshShell } from "@/components/canvas/canvas-refresh-shell";
import { CanvasTopBar } from "@/components/canvas/canvas-top-bar";
import { CanvasMissingImageQueueButton } from "@/components/canvas/canvas-missing-image-queue-button";
import { ConnectionCreateMenu, NodeCreateMenu, type PendingConnectionCreate } from "@/components/canvas/canvas-create-menus";
import {
    CanvasNodeType,
    type CanvasAssistantImage,
    type CanvasAssistantSession,
    type CanvasConnection,
    type CanvasInputMode,
    type CanvasNodeData,
    type CanvasNodeMetadata,
    type CanvasNodeTypeId,
    type ConnectionHandle,
    type ContextMenuState,
    type Position,
    type SelectionBox,
    type ViewportTransform,
} from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio } from "@/types/media";

// Register built-in nodes in the shared registry once when the module loads.
registerBuiltinNodes();

type CanvasClipboard = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
};

type ConnectionDropTarget = {
    handle: ConnectionHandle | null;
    isNearNode: boolean;
};

type CanvasHistoryEntry = Pick<CanvasClipboard, "nodes" | "connections"> & {
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    inputMode: CanvasInputMode;
};

type CanvasGenerationRequest = {
    targetNodeId: string;
    originNodeId: string;
    runningNodeId: string;
    controller: AbortController;
};

const VIDEO_NODE_MAX_WIDTH = 660;
const VIDEO_NODE_MAX_HEIGHT = 520;
// Stable empty reference array prevents `... || []` from invalidating CanvasNode's React.memo on every render.
const EMPTY_REFERENCES: CanvasResourceReference[] = [];
const CONNECTION_HANDLE_HIT_RADIUS = 40;
const CONNECTION_NODE_HIT_PADDING = 32;
const CANVAS_GRID_STEP = 16;
const NODE_STATUS_IDLE = "idle" as const;
const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;

type NodeCreateAnchor = {
    world: Position;
    screen: Position;
};

function summarizeMaterialFiles(files: File[]) {
    const visible = files.slice(0, 3).map((file) => file.name);
    return files.length > visible.length ? `${visible.join(", ")} +${files.length - visible.length}` : visible.join(", ");
}

function fitMaterialPreviewSize(width: number, height: number, maxWidth: number, maxHeight: number, minWidth: number, minHeight: number) {
    const fitted = fitNodeSize(width, height, maxWidth, maxHeight);
    const grow = Math.max(1, minWidth / fitted.width, minHeight / fitted.height);
    const grown = { width: fitted.width * grow, height: fitted.height * grow };
    const shrink = Math.min(1, maxWidth / grown.width, maxHeight / grown.height);
    return {
        width: Math.max(minWidth, grown.width * shrink),
        height: Math.max(minHeight, grown.height * shrink),
    };
}
export default function CanvasPage() {
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    if (!mounted) return <CanvasRefreshShell />;

    return <MGCanvasProjectPage />;
}

function MGCanvasProjectPage() {
    const { message, modal } = App.useApp();
    const { t } = useTranslation();
    // Subscribe to the registry version so plugin registration changes rerender the canvas.
    const nodeRegistryVersion = useNodeRegistryVersion((state) => state.version);
    const params = useParams<{ id: string }>();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const projectId = params.id || "";
    const localAgentConnected = useAgentStore((state) => state.connected);
    const localAgentActivity = useAgentStore((state) => state.activity);
    const localAgentEnabled = useAgentStore((state) => state.enabled);
    const agentPanelOpen = useAgentStore((state) => state.panelOpen);
    const toggleAgentPanel = useAgentStore((state) => state.togglePanel);
    const containerRef = useRef<HTMLDivElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const uploadTargetRef = useRef<{ nodeId?: string; position?: Position; expectedKind?: CanvasMaterialKind; removeOnCancel?: boolean; returnToNodeId?: string } | null>(null);
    const clipboardRef = useRef<CanvasClipboard | null>(null);
    const historyRef = useRef<{ past: CanvasHistoryEntry[]; future: CanvasHistoryEntry[] }>({ past: [], future: [] });
    const lastHistoryRef = useRef<CanvasHistoryEntry | null>(null);
    const historyCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const viewportSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const applyingHistoryRef = useRef(false);
    const historyPausedRef = useRef(false);
    const didInitialCenterRef = useRef(false);
    const rafRef = useRef<number | null>(null);
    const nodeDraggingRef = useRef(false);
    const dragRef = useRef<{
        isDraggingNode: boolean;
        hasMoved: boolean;
        startX: number;
        startY: number;
        initialSelectedNodes: CanvasDragFrame[];
        stationaryNodes: CanvasDragFrame[];
    }>({
        isDraggingNode: false,
        hasMoved: false,
        startX: 0,
        startY: 0,
        initialSelectedNodes: [],
        stationaryNodes: [],
    });

    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const cleanupAssetImages = useAssetStore((state) => state.cleanupImages);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const createProject = useCanvasStore((state) => state.createProject);
    const openProject = useCanvasStore((state) => state.openProject);
    const updateProject = useCanvasStore((state) => state.updateProject);
    const renameProject = useCanvasStore((state) => state.renameProject);
    const deleteProjects = useCanvasStore((state) => state.deleteProjects);
    const currentProject = useCanvasStore((state) => state.projects.find((project) => project.id === projectId));
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [nodes, setNodes] = useState<CanvasNodeData[]>([]);
    const [connections, setConnections] = useState<CanvasConnection[]>([]);
    const [chatSessions, setChatSessions] = useState<CanvasAssistantSession[]>([]);
    const [activeChatId, setActiveChatId] = useState<string | null>(null);
    const [viewport, setViewport] = useState<ViewportTransform>({ x: 0, y: 0, k: 1 });
    const [size, setSize] = useState({ width: 1200, height: 720 });
    const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
    const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
    const [connectingParams, setConnectingParams] = useState<ConnectionHandle | null>(null);
    const [connectionTargetHandle, setConnectionTargetHandle] = useState<ConnectionHandle | null>(null);
    const connectionTargetNodeId = connectionTargetHandle?.nodeId || null;
    const [pendingConnectionCreate, setPendingConnectionCreate] = useState<PendingConnectionCreate | null>(null);
    const [mouseWorld, setMouseWorld] = useState<Position>({ x: 0, y: 0 });
    const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
    const [nodeCreatePosition, setNodeCreatePosition] = useState<NodeCreateAnchor | null>(null);
    const [runningNodeId, setRunningNodeId] = useState<string | null>(null);
    const [runningGenericNodeIds, setRunningGenericNodeIds] = useState<Set<string>>(new Set());
    const [isMiniMapOpen, setIsMiniMapOpen] = useState(false);
    const [connectionsVisible, setConnectionsVisible] = useState(true);
    const [inputMode, setInputMode] = useState<CanvasInputMode>("connections");
    const [snapToGrid, setSnapToGrid] = useState(false);
    const [alignmentGuides, setAlignmentGuides] = useState<CanvasAlignmentGuides>({ vertical: [], horizontal: [] });
    const [backgroundMode, setBackgroundMode] = useState<CanvasBackgroundMode>("dots");
    const [showImageInfo, setShowImageInfo] = useState(false);
    const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [projectLoaded, setProjectLoaded] = useState(false);
    const [toolbarNodeId, setToolbarNodeId] = useState<string | null>(null);
    const [nodeImageSettingsOpen, setNodeImageSettingsOpen] = useState(false);
    const [dialogNodeId, setDialogNodeId] = useState<string | null>(null);
    const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
    const [editRequestNonce, setEditRequestNonce] = useState(0);
    const [infoNodeId, setInfoNodeId] = useState<string | null>(null);
    const [cropNodeId, setCropNodeId] = useState<string | null>(null);
    const [splitNodeId, setSplitNodeId] = useState<string | null>(null);
    const [collageNodeId, setCollageNodeId] = useState<string | null>(null);
    const [collageSaving, setCollageSaving] = useState(false);
    const [audioMergeNodeId, setAudioMergeNodeId] = useState<string | null>(null);
    const [audioMergeBusy, setAudioMergeBusy] = useState(false);
    const [upscaleNodeId, setUpscaleNodeId] = useState<string | null>(null);
    const [angleNodeId, setAngleNodeId] = useState<string | null>(null);
    const [previewNodeId, setPreviewNodeId] = useState<string | null>(null);
    const [titleEditing, setTitleEditing] = useState(false);
    const [titleDraft, setTitleDraft] = useState("");
    const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
    const [collapsingBatchIds, setCollapsingBatchIds] = useState<Set<string>>(new Set());
    const [openingBatchIds, setOpeningBatchIds] = useState<Set<string>>(new Set());
    const [isNodeDragging, setIsNodeDragging] = useState(false);
    const [isNodeResizing, setIsNodeResizing] = useState(false);
    const [dropTargetGroupId, setDropTargetGroupId] = useState<string | null>(null);

    const nodesRef = useRef(nodes);
    const connectionsRef = useRef(connections);
    const selectedNodeIdsRef = useRef(selectedNodeIds);
    const viewportRef = useRef(viewport);
    const focusAnimRef = useRef<number | null>(null);
    const generateNodeRef = useRef<((nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => Promise<boolean | undefined>) | null>(null);
    const connectingParamsRef = useRef(connectingParams);
    const selectionBoxRef = useRef(selectionBox);
    const pendingConnectionCreateRef = useRef(pendingConnectionCreate);
    const generationRequestsRef = useRef(new Map<string, CanvasGenerationRequest>());
    const genericRequestLocksRef = useRef(new Set<string>());

    const createHistoryEntry = useCallback(
        (): CanvasHistoryEntry => ({
            nodes: nodesRef.current,
            connections: connectionsRef.current,
            chatSessions,
            activeChatId,
            backgroundMode,
            showImageInfo,
            inputMode,
        }),
        [activeChatId, backgroundMode, chatSessions, inputMode, showImageInfo],
    );

    const cleanupCanvasFiles = useCallback(
        (extra?: unknown) => {
            cleanupAssetImages({ extra, history: historyRef.current, lastHistory: lastHistoryRef.current });
        },
        [cleanupAssetImages],
    );

    const startGenerationRequest = useCallback((targetNodeId: string, originNodeId: string, runningId = originNodeId, controller = new AbortController()) => {
        const previous = generationRequestsRef.current.get(targetNodeId);
        if (previous?.controller !== controller) previous?.controller.abort();
        generationRequestsRef.current.set(targetNodeId, { targetNodeId, originNodeId, runningNodeId: runningId, controller });
        return controller;
    }, []);

    const finishGenerationRequest = useCallback((targetNodeId: string, controller: AbortController) => {
        const request = generationRequestsRef.current.get(targetNodeId);
        if (request?.controller === controller) generationRequestsRef.current.delete(targetNodeId);
    }, []);

    const stopGenerationByRunningId = useCallback((runningId: string) => {
        const affectedNodeIds = new Set<string>();
        generationRequestsRef.current.forEach((request) => {
            if (request.runningNodeId !== runningId) return;
            request.controller.abort();
            generationRequestsRef.current.delete(request.targetNodeId);
            affectedNodeIds.add(request.targetNodeId);
            affectedNodeIds.add(request.originNodeId);
        });
        setRunningNodeId((current) => (current === runningId ? null : current));
        if (!affectedNodeIds.size) return;
        setNodes((prev) => prev.map((node) => (affectedNodeIds.has(node.id) && node.metadata?.status === NODE_STATUS_LOADING ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_IDLE, errorDetails: undefined } } : node)));
    }, []);

    const confirmStopGeneration = useCallback(
        (nodeId: string) => {
            modal.confirm({
                title: t("canvas.projectPage.stopTitle"),
                content: t("canvas.projectPage.stopDescription"),
                okText: t("canvas.projectPage.stop"),
                cancelText: t("canvas.projectPage.continue"),
                okButtonProps: { danger: true },
                onOk: () => stopGenerationByRunningId(nodeId),
            });
        },
        [modal, stopGenerationByRunningId, t],
    );

    useEffect(() => {
        if (!hydrated) return;
        setProjectLoaded(false);
        const project = openProject(projectId);
        if (!project) {
            navigate("/canvas", { replace: true });
            return;
        }

        const restore = async () => {
            const restoredNodes = await hydrateCanvasImages(resetInterruptedGeneration(migrateLegacyGenerationNodes(mergeGenericTaskJournal(projectId, project.nodes))));
            const restoredSessions = await hydrateAssistantImages(project.chatSessions || []);
            setNodes(restoredNodes);
            setConnections(project.connections);
            setChatSessions(restoredSessions);
            setActiveChatId(project.activeChatId || null);
            setInputMode(project.inputMode || "connections");
            setBackgroundMode(migrateCanvasBackgroundMode(projectId, project.backgroundMode));
            setShowImageInfo(project.showImageInfo || false);
            setViewport(project.viewport);
            historyRef.current = { past: [], future: [] };
            if (historyCommitTimerRef.current) {
                clearTimeout(historyCommitTimerRef.current);
                historyCommitTimerRef.current = null;
            }
            lastHistoryRef.current = {
                nodes: restoredNodes,
                connections: project.connections,
                chatSessions: restoredSessions,
                activeChatId: project.activeChatId || null,
                backgroundMode: project.backgroundMode,
                showImageInfo: project.showImageInfo || false,
                inputMode: project.inputMode || "connections",
            };
            setHistoryState({ canUndo: false, canRedo: false });
            setProjectLoaded(true);
        };
        void restore();
    }, [hydrated, navigate, openProject, projectId]);

    useEffect(() => {
        if (!projectLoaded || applyingHistoryRef.current || historyPausedRef.current) return;
        const next = createHistoryEntry();
        const previous = lastHistoryRef.current;
        if (
            previous?.nodes === next.nodes &&
            previous.connections === next.connections &&
            previous.chatSessions === next.chatSessions &&
            previous.activeChatId === next.activeChatId &&
            previous.backgroundMode === next.backgroundMode &&
            previous.showImageInfo === next.showImageInfo &&
            previous.inputMode === next.inputMode
        )
            return;

        if (historyCommitTimerRef.current) clearTimeout(historyCommitTimerRef.current);
        historyCommitTimerRef.current = setTimeout(() => {
            const current = createHistoryEntry();
            const last = lastHistoryRef.current;
            if (!last) return;
            historyRef.current.past = [...historyRef.current.past.slice(-49), last];
            historyRef.current.future = [];
            setHistoryState({ canUndo: true, canRedo: false });
            lastHistoryRef.current = current;
            historyCommitTimerRef.current = null;
        }, 180);

        return () => {
            if (historyCommitTimerRef.current) {
                clearTimeout(historyCommitTimerRef.current);
                historyCommitTimerRef.current = null;
            }
        };
    }, [activeChatId, backgroundMode, chatSessions, connections, createHistoryEntry, inputMode, nodes, projectLoaded, showImageInfo]);

    useEffect(() => {
        if (!projectLoaded || historyPausedRef.current) return;
        updateProject(projectId, { nodes, connections, chatSessions, activeChatId, inputMode, backgroundMode, showImageInfo });
    }, [activeChatId, backgroundMode, chatSessions, connections, inputMode, nodes, projectId, projectLoaded, showImageInfo, updateProject]);

    useEffect(() => {
        if (!dialogNodeId) setNodeImageSettingsOpen(false);
    }, [dialogNodeId]);

    useEffect(() => {
        if (!projectLoaded) return;
        if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        viewportSaveTimerRef.current = setTimeout(() => {
            updateProject(projectId, { viewport: viewportRef.current });
            viewportSaveTimerRef.current = null;
        }, 500);
        return () => {
            if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        };
    }, [projectId, projectLoaded, updateProject, viewport]);

    useLayoutEffect(() => {
        nodesRef.current = nodes;
        connectionsRef.current = connections;
        selectedNodeIdsRef.current = selectedNodeIds;
        viewportRef.current = viewport;
        connectingParamsRef.current = connectingParams;
        pendingConnectionCreateRef.current = pendingConnectionCreate;
    }, [nodes, connections, selectedNodeIds, viewport, connectingParams, pendingConnectionCreate]);

    useLayoutEffect(() => {
        selectionBoxRef.current = selectionBox;
    }, [selectionBox]);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        const updateSize = () => {
            const rect = el.getBoundingClientRect();
            setSize({ width: rect.width, height: rect.height });
            if (!didInitialCenterRef.current) {
                didInitialCenterRef.current = true;
                setViewport({ x: rect.width / 2, y: rect.height / 2, k: 1 });
            }
        };

        updateSize();
        const resizeObserver = new ResizeObserver(updateSize);
        resizeObserver.observe(el);
        return () => resizeObserver.disconnect();
    }, []);

    const screenToCanvas = useCallback((clientX: number, clientY: number) => {
        const rect = containerRef.current?.getBoundingClientRect();
        const currentViewport = viewportRef.current;
        const localX = clientX - (rect?.left || 0);
        const localY = clientY - (rect?.top || 0);

        return {
            x: (localX - currentViewport.x) / currentViewport.k,
            y: (localY - currentViewport.y) / currentViewport.k,
        };
    }, []);

    const getCanvasCenter = useCallback(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        return screenToCanvas((rect?.left || 0) + (rect?.width || size.width) / 2, (rect?.top || 0) + (rect?.height || size.height) / 2);
    }, [screenToCanvas, size.height, size.width]);

    const setConnecting = useCallback((next: ConnectionHandle | null) => {
        connectingParamsRef.current = next;
        setConnectingParams(next);
        if (!next) {
            setConnectionTargetHandle(null);
        }
    }, []);

    const keepNodeToolbar = useCallback(
        (nodeId: string) => {
            if (nodeDraggingRef.current || nodeImageSettingsOpen || !selectedNodeIdsRef.current.has(nodeId)) return;
            setToolbarNodeId(nodeId);
        },
        [nodeImageSettingsOpen],
    );

    const hideNodeToolbar = useCallback(() => {}, []);

    const connectNodes = useCallback(
        (current: ConnectionHandle, target: ConnectionHandle) => {
            if (current.nodeId === target.nodeId) return;

            const connection = normalizeConnectionHandles(current, target, nodesRef.current, connectionsRef.current);
            if (!connection) {
                message.warning(t("canvas.projectPage.configConnection"));
                return;
            }
            const { fromNodeId, toNodeId, fromPortId, toPortId } = connection;
            const exists = connectionsRef.current.some((conn) => conn.fromNodeId === fromNodeId && conn.toNodeId === toNodeId && conn.fromPortId === fromPortId && conn.toPortId === toPortId);
            if (!exists) {
                setConnections((prev) => [...prev, { id: `conn-${Date.now()}`, fromNodeId, toNodeId, fromPortId, toPortId }]);
            }
            setContextMenu(null);
        },
        [message, t],
    );

    const createConnectedNode = useCallback(
        (type: CanvasNodeType.Image | CanvasNodeType.Text | CanvasNodeType.Video | CanvasNodeType.Audio, pending: PendingConnectionCreate) => {
            const newNode = createCanvasNode(type, pending.position);
            const newHandleType = pending.connection.handleType === "source" ? "target" : "source";
            const newPort = getHandlePorts(newNode, newHandleType)[0];
            const connection = newPort ? normalizeConnectionHandles(pending.connection, canvasPortHandle(newNode.id, newHandleType, newPort), [...nodesRef.current, newNode], connectionsRef.current) : null;
            if (!connection) {
                message.warning(t("canvas.projectPage.configConnection"));
                return;
            }
            setNodes((prev) => [...prev, newNode]);
            setConnections((prev) => [...prev, { id: nanoid(), ...connection }]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(newNode.id);
            setPendingConnectionCreate(null);
            setConnecting(null);
        },
        [message, setConnecting, t],
    );

    const cancelPendingConnectionCreate = useCallback(() => {
        setPendingConnectionCreate(null);
        setConnecting(null);
    }, [setConnecting]);

    const getConnectionDropTarget = useCallback(
        (clientX: number, clientY: number, current: ConnectionHandle): ConnectionDropTarget => {
            const world = screenToCanvas(clientX, clientY);
            const scale = Math.max(viewportRef.current.k, 0.05);
            const padding = CONNECTION_NODE_HIT_PADDING / scale;
            const handleRadius = CONNECTION_HANDLE_HIT_RADIUS / scale;
            let isNearNode = false;
            let bestHandle: ConnectionHandle | null = null;
            let bestPriority = Number.POSITIVE_INFINITY;

            [...nodesRef.current]
                .filter((node) => !isHiddenBatchChild(node, nodesRef.current))
                .reverse()
                .forEach((node) => {
                    const hitsInside = world.x >= node.position.x && world.x <= node.position.x + node.width && world.y >= node.position.y && world.y <= node.position.y + node.height;
                    const hitsExpanded = world.x >= node.position.x - padding && world.x <= node.position.x + node.width + padding && world.y >= node.position.y - padding && world.y <= node.position.y + node.height + padding;
                    if (!hitsInside && !hitsExpanded) return;
                    isNearNode = true;
                    if (node.id === current.nodeId) return;

                    const candidatePorts = getHandlePorts(node, current.handleType === "source" ? "target" : "source");
                    candidatePorts.forEach((port) => {
                        const handle = canvasPortHandle(node.id, current.handleType === "source" ? "target" : "source", port);
                        if (!normalizeConnectionHandles(current, handle, nodesRef.current, connectionsRef.current)) return;
                        const anchor = getConnectionHandleAnchor(node, handle);
                        if (!anchor) return;
                        const dx = world.x - anchor.x;
                        const dy = world.y - anchor.y;
                        const distance = Math.sqrt(dx * dx + dy * dy);
                        const hitsHandle = distance <= handleRadius;
                        if (!port.legacy && candidatePorts.length > 1 && !hitsHandle) return;
                        const priority = (hitsHandle ? 0 : hitsInside ? 1 : 2) * 100000 + distance;
                        if (priority < bestPriority) {
                            bestHandle = handle;
                            bestPriority = priority;
                        }
                    });
                });

            return { handle: bestHandle, isNearNode };
        },
        [screenToCanvas],
    );

    const visibleNodes = useMemo(() => {
        const padding = 280;
        const rect = containerRef.current?.getBoundingClientRect();
        const width = rect?.width || size.width;
        const height = rect?.height || size.height;
        const viewLeft = -viewport.x / viewport.k - padding;
        const viewTop = -viewport.y / viewport.k - padding;
        const viewRight = viewLeft + width / viewport.k + padding * 2;
        const viewBottom = viewTop + height / viewport.k + padding * 2;

        return nodes.filter((node) => !isHiddenBatchChild(node, nodes, collapsingBatchIds) && node.position.x + node.width > viewLeft && node.position.x < viewRight && node.position.y + node.height > viewTop && node.position.y < viewBottom);
    }, [collapsingBatchIds, nodes, size.height, size.width, viewport.k, viewport.x, viewport.y]);

    const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
    // The toolbar follows a single selected node selected by click, creation, marquee, or keyboard.
    // It stays hidden for multi-selection and while isNodeDragging is true.
    const singleSelectedNodeId = selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null;
    const toolbarNode = singleSelectedNodeId ? nodeById.get(singleSelectedNodeId) || null : null;
    const infoNode = infoNodeId ? nodeById.get(infoNodeId) || null : null;
    const cropNode = cropNodeId ? nodeById.get(cropNodeId) || null : null;
    const splitNode = splitNodeId ? nodeById.get(splitNodeId) || null : null;
    const collageNode = collageNodeId ? nodeById.get(collageNodeId) || null : null;
    const upscaleNode = upscaleNodeId ? nodeById.get(upscaleNodeId) || null : null;
    const angleNode = angleNodeId ? nodeById.get(angleNodeId) || null : null;
    const previewNode = previewNodeId ? nodeById.get(previewNodeId) || null : null;
    const imageEditorNode = cropNode || splitNode || upscaleNode || angleNode;
    const imageEditorOperationSource = useMemo(() => (imageEditorNode ? canvasImageOperationSource(imageEditorNode) : null), [imageEditorNode]);
    const imageEditorPreview = useCanvasImageOperationPreview(imageEditorOperationSource, Boolean(imageEditorNode));
    useEffect(() => {
        if (imageEditorPreview.error) message.error(`图片读取失败：${imageEditorPreview.error}`);
    }, [imageEditorPreview.error, message]);
    const hasMultipleSelectedNodes = selectedNodeIds.size > 1;
    const activeNodeId = hasMultipleSelectedNodes ? null : hoveredNodeId || (selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null);
    const batchChildCountById = useMemo(() => {
        const map = new Map<string, number>();
        nodes.forEach((node) => {
            if (node.metadata?.isBatchRoot) map.set(node.id, node.metadata.batchChildIds?.length || 0);
        });
        return map;
    }, [nodes]);
    const groupChildCountById = useMemo(() => {
        const map = new Map<string, number>();
        nodes.forEach((node) => {
            const groupId = node.metadata?.groupId;
            if (groupId) map.set(groupId, (map.get(groupId) || 0) + 1);
        });
        return map;
    }, [nodes]);
    const batchMotionById = useMemo(() => {
        const map = new Map<string, { x: number; y: number; index: number }>();
        nodes.forEach((node) => {
            const rootId = node.metadata?.batchRootId;
            if (!rootId) return;
            const root = nodeById.get(rootId);
            const index = root?.metadata?.batchChildIds?.indexOf(node.id) ?? 0;
            const stackX = root ? root.position.x + 34 + index * 14 : node.position.x;
            const stackY = root ? root.position.y + 14 + index * 8 : node.position.y;
            map.set(node.id, { x: stackX - node.position.x, y: stackY - node.position.y, index: Math.max(index, 0) });
        });
        return map;
    }, [nodeById, nodes]);
    const relatedHighlight = useMemo(() => {
        const nodeIds = new Set<string>();
        const connectionIds = new Set<string>();

        if (!activeNodeId) return { nodeIds, connectionIds };

        nodeIds.add(activeNodeId);
        connections.forEach((connection) => {
            if (connection.fromNodeId !== activeNodeId && connection.toNodeId !== activeNodeId) return;
            connectionIds.add(connection.id);
            nodeIds.add(connection.fromNodeId);
            nodeIds.add(connection.toNodeId);
        });

        return { nodeIds, connectionIds };
    }, [activeNodeId, connections]);
    const runningWorkflowNodeIds = useMemo(() => {
        const nodeIds = new Set(runningGenericNodeIds);
        if (runningNodeId) nodeIds.add(runningNodeId);
        nodes.forEach((node) => {
            if (node.metadata?.status === NODE_STATUS_LOADING) nodeIds.add(node.id);
        });
        return nodeIds;
    }, [nodes, runningGenericNodeIds, runningNodeId]);
    const runningConnectionIds = useMemo(() => {
        const connectionIds = new Set<string>();
        connections.forEach((connection) => {
            if (runningWorkflowNodeIds.has(connection.fromNodeId) || runningWorkflowNodeIds.has(connection.toNodeId)) connectionIds.add(connection.id);
        });
        return connectionIds;
    }, [connections, runningWorkflowNodeIds]);

    const configInputsById = useMemo(() => {
        const map = new Map<string, NodeGenerationInput[]>();
        nodes.forEach((node) => {
            if (node.type !== CanvasNodeType.Config && node.type !== CanvasNodeType.Generic) return;
            map.set(node.id, buildNodeGenerationInputs(node.id, nodes, connections));
        });
        return map;
    }, [connections, nodes]);
    const mentionReferencesByNodeId = useMemo(() => {
        const map = new Map<string, ReturnType<typeof buildNodeMentionReferences>>();
        nodes.forEach((node) => map.set(node.id, buildNodeMentionReferences(node, nodes, connections)));
        return map;
    }, [connections, nodes]);
    const { applyAgentOps } = useAgentBridge({
        projectId,
        title: currentProject?.title,
        nodes,
        connections,
        selectedNodeIds,
        viewport,
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        viewportRef,
        generateNodeRef,
        setNodes,
        setConnections,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setViewport,
        setContextMenu,
    });

    const { pluginHost, renderPluginPanel, buildNodeToolbarItems } = usePluginHost({
        effectiveConfig,
        isAiConfigReady,
        openConfigDialog,
        theme,
        nodesRef,
        connectionsRef,
        viewportRef,
        setNodes,
        setDialogNodeId,
        applyAgentOps,
    });
    // 缺图队列：串行补齐当前项目里还没有图的图片节点，generateNodeRef 在下面回填。
    const runMissingImageNode = useCallback((nodeId: string, prompt: string) => generateNodeRef.current?.(nodeId, "image", prompt) ?? Promise.resolve(false), []);
    const missingQueue = useMissingImageQueue({ projectId, ready: projectLoaded, nodes, runNode: runMissingImageNode });
    const createNode = useCallback(
        (type: CanvasNodeTypeId, position?: Position) => {
            const targetPosition = position || getCanvasCenter();
            const rememberedMetadata = readLastUsedNodeConfig(type);
            const configMetadata =
                type === CanvasNodeType.Config
                    ? {
                          model: effectiveConfig.imageModel || effectiveConfig.model,
                          size: effectiveConfig.size,
                          count: getGenerationCount(effectiveConfig.canvasImageCount || effectiveConfig.count),
                      }
                    : undefined;
            const newNode = createCanvasNode(type, targetPosition, { ...rememberedMetadata, ...configMetadata });

            setNodes((prev) => [...prev, newNode]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            const definition = getNodeDefinition(type);
            // Display-only plugin nodes with hidePanel do not open a panel; custom Panels require autoOpenPanel on creation.
            // Plugin nodes declaring useBuiltinPanel open the built-in generation panel on creation, like image nodes.
            // Native media/text nodes open their integrated Generic workbench on creation.
            const wantsPanel = definition?.hidePanel ? false : definition?.Panel ? Boolean(definition.autoOpenPanel) : definition?.useBuiltinPanel ? true : isBuiltinType(type) && type !== CanvasNodeType.Group && type !== CanvasNodeType.Generic;
            if (wantsPanel) setDialogNodeId(newNode.id);
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, getCanvasCenter],
    );

    const createUploadMaterialNode = useCallback(
        (position?: Position, openPicker = true) => {
            const targetPosition = position || getCanvasCenter();
            const node = {
                ...createCanvasNode(CanvasNodeType.Image, targetPosition, { content: "", status: NODE_STATUS_IDLE, sourceOrigin: "upload" }),
                title: t("canvas.material.nodeTitle"),
            };
            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(null);
            setContextMenu(null);
            if (openPicker) {
                uploadTargetRef.current = { nodeId: node.id, position: targetPosition, removeOnCancel: true };
                if (imageInputRef.current) {
                    imageInputRef.current.accept = CANVAS_MATERIAL_ACCEPT;
                    imageInputRef.current.click();
                }
            }
            return node.id;
        },
        [getCanvasCenter, t],
    );

    // AI 导演：把画布上已有的图片/音频节点作为参考素材候选。
    const [directorOpen, setDirectorOpen] = useState(false);
    const directorImageCandidates = useMemo<DirectorCandidate[]>(
        () =>
            nodes
                .filter((node) => node.type === CanvasNodeType.Image && typeof node.metadata?.content === "string" && node.metadata.content)
                .slice(0, 12)
                .map((node, index) => ({ id: node.id, label: node.title || t("canvas.director.imageLabel", { index: index + 1 }), url: node.metadata?.content as string })),
        [nodes, t],
    );
    const directorAudioCandidates = useMemo<DirectorCandidate[]>(
        () =>
            nodes
                .filter((node) => node.type === CanvasNodeType.Audio && typeof node.metadata?.content === "string" && node.metadata.content)
                .slice(0, 6)
                .map((node, index) => ({ id: node.id, label: node.title || t("canvas.director.audioLabel", { index: index + 1 }), url: node.metadata?.content as string })),
        [nodes, t],
    );

    // 分镜提示词本身就是一条完整提示词（内部用 [Shot N] 把几个镜头连续排下来），
    // 所以只落一个文本节点；勾选时再配一个视频生成节点并连线，由那一次生成出整片。
    const buildDirectorNodes = useCallback(
        (prompt: string, withGeneration: boolean) => {
            const center = getCanvasCenter();
            const created: CanvasNodeData[] = [];
            const links: NonNullable<ReturnType<typeof normalizeConnectionHandles>>[] = [];

            const textNode = createCanvasNode(CanvasNodeType.Text, { x: center.x, y: center.y }, { content: prompt, status: NODE_STATUS_IDLE });
            created.push(textNode);

            let configId: string | undefined;
            if (withGeneration) {
                const configNode = createCanvasNode(CanvasNodeType.Config, { x: center.x, y: center.y + 320 }, { mode: "video", count: 1 });
                created.push(configNode);
                configId = configNode.id;
                const fromPort = getHandlePorts(textNode, "source")[0];
                const toPort = getHandlePorts(configNode, "target")[0];
                if (fromPort && toPort) {
                    const normalized = normalizeConnectionHandles(
                        canvasPortHandle(textNode.id, "source", fromPort),
                        canvasPortHandle(configNode.id, "target", toPort),
                        [...nodesRef.current, ...created],
                        connectionsRef.current,
                    );
                    if (normalized) links.push(normalized);
                }
            }

            setNodes((prev) => [...prev, ...created]);
            if (links.length) setConnections((prev) => [...prev, ...links.map((link) => ({ id: nanoid(), ...link }))]);
            setSelectedNodeIds(new Set(created.map((node) => node.id)));
            setSelectedConnectionId(null);
            return { configId };
        },
        [createCanvasNode, getCanvasCenter],
    );

    const applyDirectorShots = useCallback(
        (prompt: string, withGeneration: boolean) => {
            buildDirectorNodes(prompt, withGeneration);
            message.success(t("canvas.director.applied"));
        },
        [buildDirectorNodes, message, t],
    );

    /**
     * 成片落回画布后，自动在它下面接一个合成节点。
     *
     * 整片返修（裁剪、淡入淡出）与加背景音乐都在合成面板里做，省得用户自己再拉一个节点连线。
     */
    const attachCompositeNode = useCallback(
        (film: CanvasNodeData) => {
            const composite = createCanvasNode(CanvasNodeType.Composite, { x: film.position.x, y: film.position.y + film.height + 96 }, {});
            const fromPort = getHandlePorts(film, "source")[0];
            const toPort = getHandlePorts(composite, "target").find((port) => port.id === COMPOSITE_SEGMENTS_PORT_ID);
            let link: NonNullable<ReturnType<typeof normalizeConnectionHandles>> | undefined;
            if (fromPort && toPort) {
                const normalized = normalizeConnectionHandles(
                    canvasPortHandle(film.id, "source", fromPort),
                    canvasPortHandle(composite.id, "target", toPort),
                    [...nodesRef.current, composite],
                    connectionsRef.current,
                );
                if (normalized) link = normalized;
            }
            setNodes((prev) => [...prev, composite]);
            if (link) setConnections((prev) => [...prev, { id: nanoid(), ...link }]);
        },
        [createCanvasNode],
    );

    /**
     * 「一键生成整片」：落成一条分镜提示词加一个视频生成节点，然后直接开始生成。
     *
     * 提示词里的 [Shot 1]/[Shot 2]… 由那一次生成一次出片，不需要再逐镜生成和合成。
     * 成片回到画布后自动接一个合成节点，方便加配乐与整片返修。
     */
    const applyDirectorShoot = useCallback(
        async (prompt: string) => {
            const { configId } = buildDirectorNodes(prompt, true);
            if (!configId) return;
            const before = new Set(nodesRef.current.map((node) => node.id));
            await generateNodeRef.current?.(configId, "video", prompt);
            const film = nodesRef.current.find((node) => !before.has(node.id) && node.type === CanvasNodeType.Video);
            if (film) attachCompositeNode(film);
        },
        [attachCompositeNode, buildDirectorNodes],
    );

    const createReferenceMaterialForNode = useCallback(
        (target: CanvasNodeData) => {
            const materialWidth = NODE_DEFAULT_SIZE[CanvasNodeType.Image].width;
            const center = { x: target.position.x - materialWidth / 2 - 96, y: target.position.y + target.height / 2 };
            const materialId = createUploadMaterialNode(center, false);
            if (inputMode === "objects") {
                const referenceId = nanoid();
                setNodes((current) =>
                    current.map((node) =>
                        node.id === target.id
                            ? {
                                  ...node,
                                  metadata: {
                                      ...node.metadata,
                                      objectReferences: [...(node.metadata?.objectReferences || []), { id: referenceId, sourceNodeId: materialId, versionMode: "latest", createdAt: new Date().toISOString() }],
                                  },
                              }
                            : node,
                    ),
                );
            } else {
                const connectionId = nanoid();
                connectionsRef.current = [...connectionsRef.current, { id: connectionId, fromNodeId: materialId, toNodeId: target.id }];
                setConnections((prev) => (prev.some((connection) => connection.id === connectionId) ? prev : [...prev, { id: connectionId, fromNodeId: materialId, toNodeId: target.id }]));
            }
            setDialogNodeId(target.id);
            uploadTargetRef.current = { nodeId: materialId, position: center, removeOnCancel: true, returnToNodeId: target.id };
            if (imageInputRef.current) {
                imageInputRef.current.accept = CANVAS_MATERIAL_ACCEPT;
                imageInputRef.current.click();
            }
        },
        [createUploadMaterialNode, inputMode],
    );

    const deleteNodes = useCallback(
        (ids: Set<string>) => {
            if (!ids.size) return;
            const allIds = new Set(ids);
            nodesRef.current.forEach((node) => {
                if (ids.has(node.id)) node.metadata?.batchChildIds?.forEach((childId) => allIds.add(childId));
            });
            allIds.forEach((id) => {
                stopGenerationByRunningId(id);
                // 一并清掉即时任务日志：日志会在下次打开画布时按 nodeSnapshot 重建节点，
                // 不清就会把用户刚删掉的节点复活。
                clearGenericTaskJournal(projectId, id);
            });
            setNodes((prev) => {
                const next = prev.filter((node) => !allIds.has(node.id));
                return next.map((node) => {
                    const objectReferences = node.metadata?.objectReferences?.filter((reference) => !allIds.has(reference.sourceNodeId));
                    let nextNode = objectReferences?.length === node.metadata?.objectReferences?.length ? node : { ...node, metadata: { ...node.metadata, objectReferences } };
                    const groupId = nextNode.metadata?.groupId;
                    if (groupId && allIds.has(groupId)) nextNode = { ...nextNode, metadata: { ...nextNode.metadata, groupId: undefined } };
                    const childIds = nextNode.metadata?.batchChildIds?.filter((childId) => !allIds.has(childId));
                    if (!nextNode.metadata?.isBatchRoot || childIds?.length === nextNode.metadata.batchChildIds?.length) return nextNode;
                    const primaryImageId = childIds?.includes(nextNode.metadata.primaryImageId || "") ? nextNode.metadata.primaryImageId : childIds?.[0];
                    const primaryNode = next.find((item) => item.id === primaryImageId);
                    return {
                        ...nextNode,
                        metadata: {
                            ...nextNode.metadata,
                            batchChildIds: childIds,
                            primaryImageId,
                            content: primaryNode?.metadata?.content || nextNode.metadata.content,
                            naturalWidth: primaryNode?.metadata?.naturalWidth || nextNode.metadata.naturalWidth,
                            naturalHeight: primaryNode?.metadata?.naturalHeight || nextNode.metadata.naturalHeight,
                        },
                    };
                });
            });
            setConnections((prev) => prev.filter((conn) => !allIds.has(conn.fromNodeId) && !allIds.has(conn.toNodeId)));
            setSelectedNodeIds(new Set());
            setSelectedConnectionId(null);
            setHoveredNodeId((current) => (current && allIds.has(current) ? null : current));
            setToolbarNodeId((current) => (current && allIds.has(current) ? null : current));
            setDialogNodeId((current) => (current && allIds.has(current) ? null : current));
            setEditingNodeId((current) => (current && allIds.has(current) ? null : current));
            setInfoNodeId((current) => (current && allIds.has(current) ? null : current));
            setCropNodeId((current) => (current && allIds.has(current) ? null : current));
            setAngleNodeId((current) => (current && allIds.has(current) ? null : current));
            setPreviewNodeId((current) => (current && allIds.has(current) ? null : current));
            setRunningNodeId((current) => (current && allIds.has(current) ? null : current));
            setRunningGenericNodeIds((current) => {
                const next = new Set(Array.from(current).filter((id) => !allIds.has(id)));
                return next.size === current.size ? current : next;
            });
            setContextMenu((current) => (current?.type === "node" && allIds.has(current.nodeId) ? null : current));
            cleanupCanvasFiles({ projectId, nodes: nodesRef.current.filter((node) => !allIds.has(node.id)), chatSessions });
        },
        [chatSessions, cleanupCanvasFiles, projectId, stopGenerationByRunningId],
    );

    const deleteConnection = useCallback((connectionId: string) => {
        setConnections((prev) => prev.filter((conn) => conn.id !== connectionId));
        setSelectedConnectionId((current) => (current === connectionId ? null : current));
        setContextMenu((current) => (current?.type === "connection" && current.connectionId === connectionId ? null : current));
    }, []);

    const reorderReferenceConnections = useCallback((sourceConnectionId: string, targetConnectionId: string) => {
        setConnections((current) => reorderCanvasConnections(current, sourceConnectionId, targetConnectionId));
    }, []);

    const addObjectReference = useCallback((targetNodeId: string, sourceNodeId: string) => {
        if (!sourceNodeId || sourceNodeId === targetNodeId) return;
        setConnections((current) => current.filter((connection) => connection.toNodeId !== targetNodeId));
        setSelectedConnectionId(null);
        setNodes((current) =>
            current.map((node) => {
                if (node.id !== targetNodeId) return node;
                const references = node.metadata?.objectReferences || [];
                if (references.some((reference) => reference.sourceNodeId === sourceNodeId && !reference.outputPortId)) return node;
                return {
                    ...node,
                    metadata: {
                        ...node.metadata,
                        objectReferences: [...references, { id: nanoid(), sourceNodeId, versionMode: "latest", createdAt: new Date().toISOString() }],
                    },
                };
            }),
        );
    }, []);

    const removeObjectReference = useCallback((targetNodeId: string, referenceId: string) => {
        setNodes((current) =>
            current.map((node) => {
                if (node.id !== targetNodeId) return node;
                const references = node.metadata?.objectReferences || [];
                const next = references.filter((reference) => reference.id !== referenceId);
                return next.length === references.length ? node : { ...node, metadata: { ...node.metadata, objectReferences: next } };
            }),
        );
    }, []);

    const toggleCanvasSet = useCallback(
        (source: CanvasNodeData) => {
            if (inputMode !== "objects") return;
            const enabled = !source.metadata?.canvasSetEnabled;
            const removedReferences = enabled ? 0 : nodesRef.current.reduce((count, node) => count + (node.metadata?.objectReferences?.filter((reference) => reference.sourceNodeId === source.id).length || 0), 0);
            setNodes((current) =>
                current.map((node) => {
                    const references = enabled ? node.metadata?.objectReferences : node.metadata?.objectReferences?.filter((reference) => reference.sourceNodeId !== source.id);
                    const sourceChanged = node.id === source.id;
                    const referencesChanged = references?.length !== node.metadata?.objectReferences?.length;
                    if (!sourceChanged && !referencesChanged) return node;
                    return {
                        ...node,
                        metadata: {
                            ...node.metadata,
                            ...(sourceChanged ? { canvasSetEnabled: enabled } : {}),
                            ...(referencesChanged ? { objectReferences: references } : {}),
                        },
                    };
                }),
            );
            message.success(t(enabled ? "canvas.objectReferences.setSuccess" : removedReferences ? "canvas.objectReferences.unsetSuccessWithReferences" : "canvas.objectReferences.unsetSuccess", { count: removedReferences }));
        },
        [inputMode, message, t],
    );

    const removeResourceReference = useCallback(
        (targetNodeId: string, reference: CanvasResourceReference) => {
            if (reference.objectReferenceId) removeObjectReference(targetNodeId, reference.objectReferenceId);
            else if (reference.connectionId) deleteConnection(reference.connectionId);
        },
        [deleteConnection, removeObjectReference],
    );

    const reorderResourceReference = useCallback(
        (targetNodeId: string, source: CanvasResourceReference, target: CanvasResourceReference) => {
            if (source.objectReferenceId && target.objectReferenceId) {
                setNodes((current) =>
                    current.map((node) =>
                        node.id === targetNodeId ? { ...node, metadata: { ...node.metadata, objectReferences: reorderCanvasObjectReferences(node.metadata?.objectReferences || [], source.objectReferenceId!, target.objectReferenceId!) } } : node,
                    ),
                );
                return;
            }
            if (source.connectionId && target.connectionId) reorderReferenceConnections(source.connectionId, target.connectionId);
        },
        [reorderReferenceConnections],
    );

    const deselectCanvas = useCallback(() => {
        cancelPendingConnectionCreate();
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        setSelectionBox(null);
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        setDialogNodeId(null);
        setEditingNodeId(null);
    }, [cancelPendingConnectionCreate]);

    const changeInputMode = useCallback(
        (mode: CanvasInputMode) => {
            setInputMode(mode);
            if (mode !== "objects") return;
            cancelPendingConnectionCreate();
            setConnectingParams(null);
            setConnectionTargetHandle(null);
            setSelectedConnectionId(null);
        },
        [cancelPendingConnectionCreate],
    );

    const clearCanvas = useCallback(() => {
        generationRequestsRef.current.forEach((request) => request.controller.abort());
        generationRequestsRef.current.clear();
        setNodes([]);
        setConnections([]);
        setInfoNodeId(null);
        setCropNodeId(null);
        setAngleNodeId(null);
        setPreviewNodeId(null);
        setRunningNodeId(null);
        setRunningGenericNodeIds(new Set());
        deselectCanvas();
        setClearConfirmOpen(false);
        cleanupCanvasFiles({ projectId, nodes: [], chatSessions: [] });
    }, [cleanupCanvasFiles, deselectCanvas, projectId]);

    const duplicateNode = useCallback((nodeId: string) => {
        const source = nodesRef.current.find((node) => node.id === nodeId);
        if (!source) return;

        const id = `${source.type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const next: CanvasNodeData = {
            ...source,
            id,
            title: `${source.title} Copy`,
            position: { x: source.position.x + 36, y: source.position.y + 36 },
        };

        setNodes((prev) => [...prev, next]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        if (next.type !== CanvasNodeType.Group) setDialogNodeId(id);
    }, []);

    const copySelectedNodes = useCallback(() => {
        const selectedIds = selectedNodeIdsRef.current;
        if (!selectedIds.size) return;

        const copiedNodes = nodesRef.current
            .filter((node) => selectedIds.has(node.id))
            .map((node) => ({
                ...node,
                position: { ...node.position },
                metadata: node.metadata ? { ...node.metadata } : undefined,
            }));

        if (!copiedNodes.length) return;

        clipboardRef.current = {
            nodes: copiedNodes,
            connections: connectionsRef.current.filter((connection) => selectedIds.has(connection.fromNodeId) && selectedIds.has(connection.toNodeId)).map((connection) => ({ ...connection })),
        };
    }, []);

    const copyAllNodes = useCallback(() => {
        if (!nodesRef.current.length) return;
        clipboardRef.current = {
            nodes: nodesRef.current.map((node) => ({
                ...node,
                position: { ...node.position },
                metadata: node.metadata ? { ...node.metadata } : undefined,
            })),
            connections: connectionsRef.current.map((connection) => ({ ...connection })),
        };
    }, []);

    const pasteCopiedNodes = useCallback(() => {
        const clipboard = clipboardRef.current;
        if (!clipboard?.nodes.length) return false;

        const center = getCanvasCenter();
        const bounds = clipboard.nodes.reduce(
            (acc, node) => ({
                left: Math.min(acc.left, node.position.x),
                top: Math.min(acc.top, node.position.y),
                right: Math.max(acc.right, node.position.x + node.width),
                bottom: Math.max(acc.bottom, node.position.y + node.height),
            }),
            { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
        );
        const dx = center.x - (bounds.left + bounds.right) / 2;
        const dy = center.y - (bounds.top + bounds.bottom) / 2;
        const idMap = new Map<string, string>();
        const nextNodes = clipboard.nodes.map((node, index) => {
            const id = `${node.type}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
            idMap.set(node.id, id);
            return {
                ...node,
                id,
                title: node.title.endsWith(" Copy") ? node.title : `${node.title} Copy`,
                position: {
                    x: node.position.x + dx,
                    y: node.position.y + dy,
                },
                metadata: node.metadata ? { ...node.metadata } : undefined,
            };
        });

        const pastedNodes = nextNodes.map((node) => {
            const groupId = node.metadata?.groupId;
            if (!groupId) return node;
            return { ...node, metadata: { ...node.metadata, groupId: idMap.get(groupId) } };
        });

        const nextConnections = clipboard.connections.flatMap((connection, index) => {
            const fromNodeId = idMap.get(connection.fromNodeId);
            const toNodeId = idMap.get(connection.toNodeId);
            if (!fromNodeId || !toNodeId) return [];
            return [
                {
                    ...connection,
                    id: `conn-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
                    fromNodeId,
                    toNodeId,
                },
            ];
        });

        setNodes((prev) => [...prev, ...pastedNodes]);
        setConnections((prev) => [...prev, ...nextConnections]);
        setSelectedNodeIds(new Set(pastedNodes.map((node) => node.id)));
        setSelectedConnectionId(null);
        setContextMenu(null);
        setDialogNodeId(pastedNodes[0]?.type === CanvasNodeType.Group ? null : pastedNodes[0]?.id || null);
        return true;
    }, [getCanvasCenter]);

    const resetViewport = useCallback(() => {
        const visible = nodesRef.current.filter((node) => !isHiddenBatchChild(node, nodesRef.current));
        let target: ViewportTransform;
        if (!visible.length) {
            target = { x: size.width / 2, y: size.height / 2, k: 1 };
        } else {
            const minX = Math.min(...visible.map((node) => node.position.x));
            const minY = Math.min(...visible.map((node) => node.position.y));
            const maxX = Math.max(...visible.map((node) => node.position.x + node.width));
            const maxY = Math.max(...visible.map((node) => node.position.y + node.height));
            const contentWidth = Math.max(1, maxX - minX);
            const contentHeight = Math.max(1, maxY - minY);
            const horizontalPadding = Math.min(180, size.width * 0.14);
            const verticalPadding = Math.min(140, size.height * 0.16);
            const k = Math.min(1, Math.max(0.05, Math.min((size.width - horizontalPadding * 2) / contentWidth, (size.height - verticalPadding * 2) / contentHeight)));
            target = {
                x: size.width / 2 - (minX + contentWidth / 2) * k,
                y: size.height / 2 - (minY + contentHeight / 2) * k,
                k,
            };
        }

        if (focusAnimRef.current) cancelAnimationFrame(focusAnimRef.current);
        const start = { ...viewportRef.current };
        let startTime: number | null = null;
        const animate = (now: number) => {
            if (startTime === null) startTime = now;
            const progress = Math.min((now - startTime) / 280, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            setViewport({
                x: start.x + (target.x - start.x) * eased,
                y: start.y + (target.y - start.y) * eased,
                k: start.k + (target.k - start.k) * eased,
            });
            focusAnimRef.current = progress < 1 ? requestAnimationFrame(animate) : null;
        };
        focusAnimRef.current = requestAnimationFrame(animate);
        setContextMenu(null);
    }, [size.height, size.width]);

    const focusNode = useCallback(
        (nodeId: string) => {
            const node = nodesRef.current.find((item) => item.id === nodeId);
            if (!node) return;
            const worldX = node.position.x + node.width / 2;
            const worldY = node.position.y + node.height / 2;
            const k = Math.min(Math.max(Math.min((size.width * 0.6) / node.width, (size.height * 0.6) / node.height), 0.05), 1.5);
            const target = { x: size.width / 2 - worldX * k, y: size.height / 2 - worldY * k, k };
            setSelectedNodeIds(new Set([nodeId]));
            setSelectedConnectionId(null);
            setContextMenu(null);

            if (focusAnimRef.current) cancelAnimationFrame(focusAnimRef.current);
            const start = { ...viewportRef.current };
            const duration = 450;
            const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
            let startTime: number | null = null;
            const step = (now: number) => {
                if (startTime === null) startTime = now;
                const progress = Math.min((now - startTime) / duration, 1);
                const t = easeOutCubic(progress);
                setViewport({ x: start.x + (target.x - start.x) * t, y: start.y + (target.y - start.y) * t, k: start.k + (target.k - start.k) * t });
                focusAnimRef.current = progress < 1 ? requestAnimationFrame(step) : null;
            };
            focusAnimRef.current = requestAnimationFrame(step);
        },
        [size.height, size.width],
    );

    useEffect(() => () => void (focusAnimRef.current && cancelAnimationFrame(focusAnimRef.current)), []);

    const setZoomScale = useCallback(
        (scale: number) => {
            const nextScale = Math.min(Math.max(scale, 0.05), 5);
            setViewport((prev) => ({
                x: size.width / 2 - ((size.width / 2 - prev.x) / prev.k) * nextScale,
                y: size.height / 2 - ((size.height / 2 - prev.y) / prev.k) * nextScale,
                k: nextScale,
            }));
            setContextMenu(null);
        },
        [size.height, size.width],
    );

    const applyHistory = useCallback((entry: CanvasHistoryEntry) => {
        if (historyCommitTimerRef.current) {
            clearTimeout(historyCommitTimerRef.current);
            historyCommitTimerRef.current = null;
        }
        applyingHistoryRef.current = true;
        setNodes(entry.nodes);
        setConnections(entry.connections);
        setChatSessions(entry.chatSessions);
        setActiveChatId(entry.activeChatId);
        setBackgroundMode(entry.backgroundMode);
        setShowImageInfo(entry.showImageInfo);
        setInputMode(entry.inputMode);
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        setTimeout(() => {
            lastHistoryRef.current = entry;
            applyingHistoryRef.current = false;
            setHistoryState({ canUndo: historyRef.current.past.length > 0, canRedo: historyRef.current.future.length > 0 });
        });
    }, []);

    const undoCanvas = useCallback(() => {
        const previous = historyRef.current.past.pop();
        const current = lastHistoryRef.current;
        if (!previous || !current) return;
        historyRef.current.future.push(current);
        applyHistory(previous);
    }, [applyHistory]);

    const redoCanvas = useCallback(() => {
        const next = historyRef.current.future.pop();
        const current = lastHistoryRef.current;
        if (!next || !current) return;
        historyRef.current.past.push(current);
        applyHistory(next);
    }, [applyHistory]);

    const createAndOpenProject = useCallback(() => {
        const id = createProject(t("canvas.defaultTitle", { count: useCanvasStore.getState().projects.length + 1 }));
        navigate(`/canvas/${id}`);
    }, [createProject, navigate, t]);

    const deleteCurrentProject = useCallback(() => {
        deleteProjects([projectId]);
        cleanupAssetImages();
        navigate("/canvas");
    }, [cleanupAssetImages, deleteProjects, navigate, projectId]);

    const handleCanvasMouseDown = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            setContextMenu(null);
            setNodeCreatePosition(null);
            if (pendingConnectionCreateRef.current) cancelPendingConnectionCreate();
            if (event.button !== 0) return;

            if (!event.ctrlKey && !event.metaKey) {
                setSelectionBox(null);
                setSelectedNodeIds(new Set());
                setSelectedConnectionId(null);
                return;
            }

            const world = screenToCanvas(event.clientX, event.clientY);
            const nextSelectionBox = {
                startWorldX: world.x,
                startWorldY: world.y,
                currentWorldX: world.x,
                currentWorldY: world.y,
                additive: event.shiftKey,
                initialSelectedNodeIds: event.shiftKey ? Array.from(selectedNodeIdsRef.current) : [],
            };
            selectionBoxRef.current = nextSelectionBox;
            setSelectionBox(nextSelectionBox);
            if (!event.shiftKey) {
                setSelectedNodeIds(new Set());
            }

            setSelectedConnectionId(null);
        },
        [cancelPendingConnectionCreate, screenToCanvas],
    );

    // Selection-only logic shared by the bubbling drag entry point and outer capture handler.
    // Returns the single target ID after the click, or null for multi-selection or deselection, to sync the toolbar.
    const selectNodeByEvent = useCallback((event: Pick<ReactMouseEvent, "shiftKey" | "metaKey" | "ctrlKey">, nodeId: string) => {
        const nextSelected = new Set(selectedNodeIdsRef.current);
        if (event.shiftKey || event.metaKey || event.ctrlKey) {
            if (nextSelected.has(nodeId)) nextSelected.delete(nodeId);
            else nextSelected.add(nodeId);
        } else if (!nextSelected.has(nodeId)) {
            nextSelected.clear();
            nextSelected.add(nodeId);
        }
        setSelectedNodeIds(nextSelected);
        const soloId = nextSelected.size === 1 && nextSelected.has(nodeId) ? nodeId : null;
        setToolbarNodeId(soloId);
        return { nextSelected, soloId };
    }, []);

    // Capture-phase selection lets any inner element, including textarea or iframe, select the node and show its toolbar.
    // It only selects; body onMouseDown still starts dragging, so text selection inside editors does not drag the node.
    // Cache the capture result for the following bubbling drag handler to avoid applying shift-selection twice.
    const pendingSelectionRef = useRef<Set<string> | null>(null);
    const handleNodeSelectCapture = useCallback(
        (event: ReactMouseEvent, nodeId: string) => {
            if (event.button !== 0) return;
            setContextMenu(null);
            setHoveredNodeId(null);
            setSelectedConnectionId(null);
            const { nextSelected } = selectNodeByEvent(event, nodeId);
            pendingSelectionRef.current = nextSelected;
        },
        [selectNodeByEvent],
    );

    const handleNodeMouseDown = useCallback((event: ReactMouseEvent, nodeId: string) => {
        event.stopPropagation();
        // Capture already selected the node; this only starts dragging, with a fallback selection if capture did not run.
        const currentNodes = nodesRef.current;
        const nextSelected = pendingSelectionRef.current ?? selectNodeByEvent(event, nodeId).nextSelected;
        pendingSelectionRef.current = null;
        const dragIds = new Set(nextSelected);
        currentNodes.forEach((node) => {
            if (!nextSelected.has(node.id)) return;
            node.metadata?.batchChildIds?.forEach((childId) => dragIds.add(childId));
            if (node.type === CanvasNodeType.Group) {
                currentNodes.forEach((child) => {
                    if (child.metadata?.groupId === node.id) dragIds.add(child.id);
                });
            }
        });
        dragRef.current = {
            isDraggingNode: true,
            hasMoved: false,
            startX: event.clientX,
            startY: event.clientY,
            initialSelectedNodes: currentNodes.filter((node) => dragIds.has(node.id)).map((node) => ({ id: node.id, x: node.position.x, y: node.position.y, width: node.width, height: node.height })),
            stationaryNodes: currentNodes.filter((node) => !dragIds.has(node.id) && !isHiddenBatchChild(node, currentNodes)).map((node) => ({ id: node.id, x: node.position.x, y: node.position.y, width: node.width, height: node.height })),
        };
        setAlignmentGuides({ vertical: [], horizontal: [] });
        historyPausedRef.current = true;
        nodeDraggingRef.current = true;
        setIsNodeDragging(true);
    }, []);

    const finishNodeDrag = useCallback(
        (clientX?: number, clientY?: number) => {
            if (rafRef.current) {
                cancelAnimationFrame(rafRef.current);
                rafRef.current = null;
            }
            if (!dragRef.current.isDraggingNode) return;

            const wasClick = !dragRef.current.hasMoved && dragRef.current.initialSelectedNodes.length === 1;
            const clickedNodeId = dragRef.current.initialSelectedNodes[0]?.id;
            const currentViewport = viewportRef.current;
            const initialPositions = dragRef.current.initialSelectedNodes;
            const rawDx = clientX == null ? 0 : (clientX - dragRef.current.startX) / currentViewport.k;
            const rawDy = clientY == null ? 0 : (clientY - dragRef.current.startY) / currentViewport.k;
            const { dx, dy } = resolveCanvasNodeDrag({
                moving: initialPositions,
                stationary: dragRef.current.stationaryNodes,
                rawDx,
                rawDy,
                scale: currentViewport.k,
                snapToGrid,
                gridStep: CANVAS_GRID_STEP,
            });

            historyPausedRef.current = false;
            nodeDraggingRef.current = false;
            setIsNodeDragging(false);
            setDropTargetGroupId(null);
            setAlignmentGuides({ vertical: [], horizontal: [] });
            if (dragRef.current.hasMoved && clientX != null && clientY != null) {
                const movedIds = new Set(initialPositions.map((item) => item.id));
                setNodes((prev) => {
                    const moved = prev.map((node) => {
                        const initial = initialPositions.find((item) => item.id === node.id);
                        return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
                    });
                    const targetGroup = findGroupDropTarget(movedIds, moved);
                    if (targetGroup) return snapNodesIntoGroup(movedIds, moved, targetGroup);
                    return moved.map((node) => {
                        if (!movedIds.has(node.id) || node.type === CanvasNodeType.Group) return node;
                        const groupId = findContainingGroupId(node, moved);
                        if (node.metadata?.groupId === groupId) return node;
                        return { ...node, metadata: { ...node.metadata, groupId } };
                    });
                });
            }

            dragRef.current.isDraggingNode = false;
            dragRef.current.hasMoved = false;
            dragRef.current.initialSelectedNodes = [];
            dragRef.current.stationaryNodes = [];
            if (wasClick && clickedNodeId) {
                const clickedNode = nodesRef.current.find((node) => node.id === clickedNodeId);
                const clickedDefinition = clickedNode ? getNodeDefinition(clickedNode.type) : undefined;
                if (clickedDefinition?.hidePanel) {
                    // Clicking a display-only plugin node selects it without opening a lower panel.
                    setDialogNodeId((current) => (current === clickedNodeId ? current : null));
                } else if (clickedNode?.metadata?.sourceOrigin === "upload") {
                    setDialogNodeId(null);
                } else if (clickedNode?.type !== CanvasNodeType.Group) {
                    setDialogNodeId(clickedNodeId);
                }
            }
        },
        [snapToGrid],
    );

    const handleGlobalMouseMove = useCallback(
        (event: MouseEvent) => {
            const currentViewport = viewportRef.current;

            if (dragRef.current.isDraggingNode) {
                const initialPositions = dragRef.current.initialSelectedNodes;
                const rawDx = (event.clientX - dragRef.current.startX) / currentViewport.k;
                const rawDy = (event.clientY - dragRef.current.startY) / currentViewport.k;
                const { dx, dy, guides } = resolveCanvasNodeDrag({
                    moving: initialPositions,
                    stationary: dragRef.current.stationaryNodes,
                    rawDx,
                    rawDy,
                    scale: currentViewport.k,
                    snapToGrid,
                    gridStep: CANVAS_GRID_STEP,
                });
                if (Math.abs(event.clientX - dragRef.current.startX) > 3 || Math.abs(event.clientY - dragRef.current.startY) > 3) {
                    dragRef.current.hasMoved = true;
                }

                const movedIds = new Set(initialPositions.map((item) => item.id));
                const previewNodes = nodesRef.current.map((node) => {
                    const initial = initialPositions.find((item) => item.id === node.id);
                    return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
                });
                setDropTargetGroupId(findGroupDropTarget(movedIds, previewNodes)?.id || null);

                if (rafRef.current) cancelAnimationFrame(rafRef.current);
                rafRef.current = requestAnimationFrame(() => {
                    setAlignmentGuides(guides);
                    setNodes((prev) =>
                        prev.map((node) => {
                            const initial = initialPositions.find((item) => item.id === node.id);
                            return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
                        }),
                    );
                    rafRef.current = null;
                });
                return;
            }

            if (connectingParamsRef.current && !pendingConnectionCreateRef.current) {
                const dropTarget = getConnectionDropTarget(event.clientX, event.clientY, connectingParamsRef.current);
                setConnectionTargetHandle(dropTarget.handle);
                setMouseWorld(screenToCanvas(event.clientX, event.clientY));
            }
        },
        [finishNodeDrag, getConnectionDropTarget, screenToCanvas, snapToGrid],
    );

    const handleGlobalPointerMove = useCallback(
        (event: PointerEvent) => {
            const currentSelection = selectionBoxRef.current;
            if (!currentSelection) return;

            if (event.buttons === 0) {
                selectionBoxRef.current = null;
                setSelectionBox(null);
                return;
            }

            const world = screenToCanvas(event.clientX, event.clientY);
            const rectX = Math.min(currentSelection.startWorldX, world.x);
            const rectY = Math.min(currentSelection.startWorldY, world.y);
            const rectW = Math.abs(world.x - currentSelection.startWorldX);
            const rectH = Math.abs(world.y - currentSelection.startWorldY);
            const nextSelected = new Set<string>(currentSelection.additive ? currentSelection.initialSelectedNodeIds : []);

            nodesRef.current
                .filter((node) => !isHiddenBatchChild(node, nodesRef.current))
                .forEach((node) => {
                    const intersects = rectX < node.position.x + node.width && rectX + rectW > node.position.x && rectY < node.position.y + node.height && rectY + rectH > node.position.y;

                    if (intersects) nextSelected.add(node.id);
                });

            const nextSelectionBox = { ...currentSelection, currentWorldX: world.x, currentWorldY: world.y };
            selectionBoxRef.current = nextSelectionBox;
            setSelectionBox(nextSelectionBox);
            setSelectedNodeIds(nextSelected);
        },
        [screenToCanvas],
    );

    const handleGlobalMouseUp = useCallback(
        (event: MouseEvent) => {
            finishNodeDrag(event.clientX, event.clientY);

            selectionBoxRef.current = null;
            setSelectionBox(null);

            if (pendingConnectionCreateRef.current) return;

            const currentConnection = connectingParamsRef.current;
            if (currentConnection) {
                const dropTarget = getConnectionDropTarget(event.clientX, event.clientY, currentConnection);
                if (dropTarget.handle) {
                    connectNodes(currentConnection, dropTarget.handle);
                    setConnecting(null);
                } else if (dropTarget.isNearNode) {
                    setConnecting(null);
                } else {
                    setMouseWorld(screenToCanvas(event.clientX, event.clientY));
                    setPendingConnectionCreate({ connection: currentConnection, position: screenToCanvas(event.clientX, event.clientY) });
                }
            }
        },
        [connectNodes, finishNodeDrag, getConnectionDropTarget, screenToCanvas, setConnecting],
    );

    useEffect(() => {
        const handlePointerUp = (event: PointerEvent) => finishNodeDrag(event.clientX, event.clientY);
        const cancelNodeDrag = () => finishNodeDrag();
        window.addEventListener("mousemove", handleGlobalMouseMove);
        window.addEventListener("mouseup", handleGlobalMouseUp);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", cancelNodeDrag);
        window.addEventListener("blur", cancelNodeDrag);
        window.addEventListener("pointermove", handleGlobalPointerMove);
        return () => {
            window.removeEventListener("mousemove", handleGlobalMouseMove);
            window.removeEventListener("mouseup", handleGlobalMouseUp);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", cancelNodeDrag);
            window.removeEventListener("blur", cancelNodeDrag);
            window.removeEventListener("pointermove", handleGlobalPointerMove);
        };
    }, [finishNodeDrag, handleGlobalMouseMove, handleGlobalMouseUp, handleGlobalPointerMove]);

    const createImageFileNode = useCallback(async (file: File, position: Position) => {
        const image = await uploadImage(file);
        const size = fitMaterialPreviewSize(image.width, image.height, 640, 640, 220, 160);
        const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const newNode: CanvasNodeData = {
            id,
            type: CanvasNodeType.Image,
            title: file.name,
            position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
            width: size.width,
            height: size.height,
            metadata: { ...imageMetadata(image), sourceOrigin: "upload" },
        };

        setNodes((prev) => [...prev, newNode]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(null);
    }, []);

    const createVideoFileNode = useCallback(async (file: File, position: Position) => {
        const video = await uploadMediaFile(file, "video");
        const size = fitMaterialPreviewSize(video.width || 1280, video.height || 720, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT, 320, 180);
        const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setNodes((prev) => [
            ...prev,
            {
                id,
                type: CanvasNodeType.Video,
                title: file.name,
                position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
                width: size.width,
                height: size.height,
                metadata: { ...videoMetadata(video), sourceOrigin: "upload" },
            },
        ]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(null);
    }, []);

    const createAudioFileNode = useCallback(async (file: File, position: Position) => {
        const audio = await uploadMediaFile(file, "audio");
        const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
        const id = `audio-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setNodes((prev) => [
            ...prev,
            {
                id,
                type: CanvasNodeType.Audio,
                title: file.name,
                position: { x: position.x - spec.width / 2, y: position.y - spec.height / 2 },
                width: spec.width,
                height: spec.height,
                metadata: { ...audioMetadata(audio), sourceOrigin: "upload" },
            },
        ]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
    }, []);

    const createMaterialFileNode = useCallback(
        async (file: File, kind: CanvasMaterialKind, position: Position) => {
            if (kind === "audio") return createAudioFileNode(file, position);
            if (kind === "video") return createVideoFileNode(file, position);
            return createImageFileNode(file, position);
        },
        [createAudioFileNode, createImageFileNode, createVideoFileNode],
    );

    const replaceNodeWithMaterialFile = useCallback(async (nodeId: string, file: File, kind: CanvasMaterialKind) => {
        if (kind === "audio") {
            const audio = await uploadMediaFile(file, "audio");
            const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
            setNodes((prev) =>
                prev.map((node) =>
                    node.id === nodeId
                        ? {
                              ...node,
                              type: CanvasNodeType.Audio,
                              title: file.name,
                              position: { x: node.position.x + node.width / 2 - spec.width / 2, y: node.position.y + node.height / 2 - spec.height / 2 },
                              width: spec.width,
                              height: spec.height,
                              metadata: { ...audioMetadata(audio), sourceOrigin: "upload", groupId: node.metadata?.groupId, canvasSetEnabled: node.metadata?.canvasSetEnabled },
                          }
                        : node,
                ),
            );
            return;
        }

        if (kind === "video") {
            const video = await uploadMediaFile(file, "video");
            const nextSize = fitMaterialPreviewSize(video.width || 1280, video.height || 720, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT, 320, 180);
            setNodes((prev) =>
                prev.map((node) =>
                    node.id === nodeId
                        ? {
                              ...node,
                              type: CanvasNodeType.Video,
                              title: file.name,
                              position: { x: node.position.x + node.width / 2 - nextSize.width / 2, y: node.position.y + node.height / 2 - nextSize.height / 2 },
                              width: nextSize.width,
                              height: nextSize.height,
                              metadata: { ...videoMetadata(video), sourceOrigin: "upload", groupId: node.metadata?.groupId, canvasSetEnabled: node.metadata?.canvasSetEnabled },
                          }
                        : node,
                ),
            );
            return;
        }

        const image = await uploadImage(file);
        const nextSize = fitMaterialPreviewSize(image.width, image.height, 640, 640, 220, 160);
        setNodes((prev) =>
            prev.map((node) =>
                node.id === nodeId
                    ? {
                          ...node,
                          type: CanvasNodeType.Image,
                          title: file.name,
                          position: { x: node.position.x + node.width / 2 - nextSize.width / 2, y: node.position.y + node.height / 2 - nextSize.height / 2 },
                          width: nextSize.width,
                          height: nextSize.height,
                          metadata: { ...imageMetadata(image), sourceOrigin: "upload", groupId: node.metadata?.groupId, canvasSetEnabled: node.metadata?.canvasSetEnabled, freeResize: false },
                      }
                    : node,
            ),
        );
    }, []);

    const createTextNodeFromClipboard = useCallback(
        (text: string) => {
            const trimmed = text.trim();
            if (!trimmed) return false;

            const node = {
                ...createCanvasNode(CanvasNodeType.Text, getCanvasCenter(), { content: trimmed, status: NODE_STATUS_SUCCESS }),
                title: trimmed.slice(0, 32) || t("canvas.projectPage.clipboardText"),
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
            setContextMenu(null);
            setDialogNodeId(node.id);
            return true;
        },
        [getCanvasCenter, t],
    );

    const pasteSystemClipboard = useCallback(async () => {
        if (!navigator.clipboard) return;

        const items = await navigator.clipboard.read();
        const imageItem = items.find((item) => item.types.some((type) => type.startsWith("image/")));
        if (imageItem) {
            const imageType = imageItem.types.find((type) => type.startsWith("image/"));
            if (!imageType) return;
            const blob = await imageItem.getType(imageType);
            const file = new File([blob], "clipboard-image.png", { type: imageType });
            void createImageFileNode(file, getCanvasCenter());
            message.success(t("canvas.projectPage.clipboardImageAdded"));
            return;
        }

        const text = await navigator.clipboard.readText();
        if (createTextNodeFromClipboard(text)) message.success(t("canvas.projectPage.clipboardTextAdded"));
    }, [createImageFileNode, createTextNodeFromClipboard, getCanvasCenter, message, t]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true'],[data-canvas-no-zoom],[data-canvas-shortcuts-ignore]"))
                return;

            const key = event.key.toLowerCase();
            const isModifierShortcut = event.metaKey || event.ctrlKey;

            if (isModifierShortcut && key === "c" && window.getSelection()?.toString()) return;

            if (isModifierShortcut && !event.altKey && key === "z") {
                event.preventDefault();
                if (event.shiftKey) redoCanvas();
                else undoCanvas();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "y") {
                event.preventDefault();
                redoCanvas();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "a") {
                event.preventDefault();
                setSelectedNodeIds(new Set(nodesRef.current.map((node) => node.id)));
                setSelectedConnectionId(null);
                setContextMenu(null);
                setSelectionBox(null);
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "c") {
                event.preventDefault();
                copySelectedNodes();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "v") {
                event.preventDefault();
                if (!pasteCopiedNodes()) void pasteSystemClipboard();
                return;
            }

            if (event.key === "Delete" || event.key === "Backspace") {
                if (selectedNodeIdsRef.current.size) {
                    deleteNodes(new Set(selectedNodeIdsRef.current));
                } else if (selectedConnectionId) {
                    deleteConnection(selectedConnectionId);
                }
            }

            if (event.key === "Escape") {
                setSelectedNodeIds(new Set());
                setSelectedConnectionId(null);
                setContextMenu(null);
                setNodeCreatePosition(null);
                setSelectionBox(null);
                setConnecting(null);
                setHoveredNodeId(null);
                setToolbarNodeId(null);
                setDialogNodeId(null);
                setEditingNodeId(null);
                setInfoNodeId(null);
                setCropNodeId(null);
                setPendingConnectionCreate(null);
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [copySelectedNodes, deleteConnection, deleteNodes, pasteCopiedNodes, pasteSystemClipboard, redoCanvas, selectedConnectionId, setConnecting, undoCanvas]);

    const handleConnectStart = useCallback(
        (event: ReactMouseEvent, nodeId: string, handleType: "source" | "target", portId?: string) => {
            event.stopPropagation();
            setMouseWorld(screenToCanvas(event.clientX, event.clientY));
            setConnecting({ nodeId, handleType, portId });
            setConnectionTargetHandle(null);
            setSelectedConnectionId(null);
        },
        [screenToCanvas, setConnecting],
    );

    const handleNodeResize = useCallback((nodeId: string, width: number, height: number, position?: Position) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, width, height, position: position || node.position } : node)));
    }, []);

    const handleNodeResizeStart = useCallback(() => setIsNodeResizing(true), []);
    const handleNodeResizeEnd = useCallback(() => setIsNodeResizing(false), []);

    const toggleNodeFreeResize = useCallback((nodeId: string) => {
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                const freeResize = !node.metadata?.freeResize;
                if (freeResize || node.type !== CanvasNodeType.Image) return { ...node, metadata: { ...node.metadata, freeResize } };
                const ratio = (node.metadata?.naturalWidth || node.width) / (node.metadata?.naturalHeight || node.height || 1);
                const height = node.width / ratio;
                return { ...node, height, position: { x: node.position.x, y: node.position.y + node.height / 2 - height / 2 }, metadata: { ...node.metadata, freeResize } };
            }),
        );
    }, []);

    const handleNodeContentChange = useCallback((nodeId: string, content: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, content } } : node)));
    }, []);

    const handleSelectImageHistory = useCallback((nodeId: string, historyId: string) => {
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId || node.type !== CanvasNodeType.Image) return node;
                const metadataPatch = imageHistoryMetadataPatch(node.metadata, historyId);
                if (!metadataPatch) return node;
                const spec = getNodeSpec(CanvasNodeType.Image);
                const geometry = fitMediaNodeGeometry(node, metadataPatch.naturalWidth, metadataPatch.naturalHeight, spec.width, spec.height);
                return {
                    ...node,
                    ...geometry,
                    metadata: {
                        ...node.metadata,
                        ...metadataPatch,
                        status: NODE_STATUS_SUCCESS,
                        errorDetails: undefined,
                    },
                };
            }),
        );
    }, []);

    const handleNodeTitleChange = useCallback((nodeId: string, title: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, title } : node)));
    }, []);

    const toggleBatchExpanded = useCallback((nodeId: string) => {
        const isExpanded = Boolean(nodesRef.current.find((node) => node.id === nodeId)?.metadata?.imageBatchExpanded);
        if (isExpanded) {
            setCollapsingBatchIds((prev) => new Set(prev).add(nodeId));
            window.setTimeout(() => {
                setCollapsingBatchIds((prev) => {
                    const next = new Set(prev);
                    next.delete(nodeId);
                    return next;
                });
            }, 320);
        } else {
            setOpeningBatchIds((prev) => new Set(prev).add(nodeId));
            window.setTimeout(() => {
                setOpeningBatchIds((prev) => {
                    const next = new Set(prev);
                    next.delete(nodeId);
                    return next;
                });
            }, 260);
        }
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                return { ...node, metadata: { ...node.metadata, imageBatchExpanded: !node.metadata?.imageBatchExpanded } };
            }),
        );
    }, []);

    const setBatchPrimary = useCallback((child: CanvasNodeData) => {
        const rootId = child.metadata?.batchRootId;
        if (!rootId || !child.metadata?.content) return;
        setNodes((prev) =>
            prev.map((node) =>
                node.id === rootId
                    ? {
                          ...node,
                          width: child.width,
                          height: child.height,
                          metadata: {
                              ...node.metadata,
                              content: child.metadata?.content,
                              primaryImageId: child.id,
                              naturalWidth: child.metadata?.naturalWidth,
                              naturalHeight: child.metadata?.naturalHeight,
                              freeResize: child.metadata?.freeResize,
                          },
                      }
                    : node,
            ),
        );
    }, []);

    const openTextEditor = useCallback((node: CanvasNodeData) => {
        if (node.type !== CanvasNodeType.Text) return;
        setSelectedNodeIds(new Set([node.id]));
        setSelectedConnectionId(null);
        setDialogNodeId(node.id);
        setEditingNodeId(node.id);
        setEditRequestNonce((value) => value + 1);
    }, []);

    const handleNodePromptChange = useCallback((nodeId: string, prompt: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt } } : node)));
    }, []);

    const handleConfigNodeChange = useCallback((nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => {
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                const next = applyNodeConfigPatch(node, patch);
                rememberLastUsedNodeConfig(next);
                return next;
            }),
        );
    }, []);

    const resolveGenericChannel = useCallback(
        (_node: CanvasNodeData) => {
            const channel = resolveModelChannel(config, config.model);
            const apiKey = channel.apiKey.trim();
            const baseUrl = channel.baseUrl.trim();
            if (!apiKey || !baseUrl) {
                message.warning("请先在设置中配置渠道接口地址与 API Key。");
                openConfigDialog(false, "channels");
                return null;
            }
            return { channel, requestConfig: { apiKey, baseUrl } };
        },
        [config, message, openConfigDialog],
    );

    // extraReferences 由面板给出（提示词里 @ 到的素材图片），必须追加在已连接的参考图之后：
    // payload 里的 `@Image N` 下标就是按这个顺序算出来的。
    const buildGenericReferences = useCallback((nodeId: string, extraReferences: GenericReference[] = []): GenericReference[] => {
        const resourceReferences = buildNodeGenerationInputs(nodeId, nodesRef.current, connectionsRef.current).flatMap((input): GenericReference[] => {
            if (input.type === "text") return [{ kind: "text", name: input.title, text: input.text || "" }];
            if (input.type === "image" && input.image) return [{ kind: "image", name: input.image.name, url: input.image.dataUrl, storageKey: input.image.storageKey, localPath: input.image.localPath, mimeType: input.image.type }];
            if (input.type === "video" && input.video) return [{ kind: "video", name: input.video.name, url: input.video.url, storageKey: input.video.storageKey, localPath: input.video.localPath, mimeType: input.video.type }];
            if (input.type === "audio" && input.audio) return [{ kind: "audio", name: input.audio.name, url: input.audio.url, storageKey: input.audio.storageKey, localPath: input.audio.localPath, mimeType: input.audio.type }];
            return [];
        });
        const seenTaskReferences = new Set<string>();
        const taskReferences = connectionsRef.current
            .filter((connection) => connection.toNodeId === nodeId)
            .map((connection) => nodesRef.current.find((item) => item.id === connection.fromNodeId))
            .flatMap((source): GenericReference[] => {
                const taskId = source?.metadata?.providerResult?.taskId || source?.metadata?.providerTask?.taskId;
                if (!source || !taskId) return [];
                const lineageOutput =
                    source.metadata?.providerResult?.outputs?.find((output) => output.taskId === taskId && (output.audioIndex || output.selectionIndex)) ||
                    source.metadata?.providerResult?.outputs?.find((output) => output.audioIndex || output.selectionIndex);
                const referenceKey = `${taskId}:${lineageOutput?.audioIndex ?? ""}:${lineageOutput?.selectionIndex ?? ""}`;
                if (seenTaskReferences.has(referenceKey)) return [];
                seenTaskReferences.add(referenceKey);
                return [{ kind: "task", name: source.title, taskId, audioIndex: lineageOutput?.audioIndex, selectionIndex: lineageOutput?.selectionIndex }];
            });
        return [...resourceReferences, ...taskReferences, ...extraReferences];
    }, []);

    const updateGenericSubmission = useCallback((nodeId: string, submission: GenericSubmission) => {
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                const existingTaskIds = node.metadata?.providerTask?.taskIds || (node.metadata?.providerTask?.taskId ? [node.metadata.providerTask.taskId] : []);
                const taskIds = Array.from(new Set([...existingTaskIds, submission.taskId]));
                const existingPollPaths = node.metadata?.providerTask?.pollPaths || (node.metadata?.providerTask?.pollPath ? [node.metadata.providerTask.pollPath] : []);
                const pollPaths = Array.from(new Set([...existingPollPaths, submission.pollPath]));
                return {
                    ...node,
                    metadata: {
                        ...node.metadata,
                        status: NODE_STATUS_LOADING,
                        channelId: node.metadata?.channelId,
                        providerTask: {
                            provider: "generic",
                            taskId: taskIds[0],
                            taskIds,
                            action: submission.operationId,
                            family: submission.family,
                            phase: "queued",
                            status: "submitted",
                            progress: 0,
                            pollPath: pollPaths[0],
                            pollPaths,
                            submittedAt: new Date().toISOString(),
                            raw: submission.raw,
                        },
                    },
                };
            }),
        );
    }, []);

    const updateGenericTaskState = useCallback(
        (nodeId: string, state: { taskId: string; family: "video" | "image" | "audio" | "midjourney" | "music"; phase: "queued" | "running" | "succeeded" | "failed" | "attention"; status: string; progress?: number; message?: string; raw: unknown }) => {
            setNodes((prev) =>
                prev.map((node) =>
                    node.id === nodeId
                        ? {
                              ...node,
                              metadata: {
                                  ...node.metadata,
                                  status: state.phase === "failed" ? NODE_STATUS_ERROR : state.phase === "succeeded" || state.phase === "attention" ? NODE_STATUS_SUCCESS : NODE_STATUS_LOADING,
                                  providerTask: {
                                      provider: "generic",
                                      ...node.metadata?.providerTask,
                                      taskId: node.metadata?.providerTask?.taskId || state.taskId,
                                      family: state.family,
                                      action: node.metadata?.genericOperation,
                                      phase: state.phase,
                                      status: state.status,
                                      progress: state.progress,
                                      message: state.message,
                                      // 失败等终态也要记录完成时间，否则界面算不出运行耗时。
                                      completedAt: state.phase === "failed" || state.phase === "succeeded" || state.phase === "attention" ? new Date().toISOString() : node.metadata?.providerTask?.completedAt,
                                      raw: state.raw,
                                  },
                              },
                          }
                        : node,
                ),
            );
        },
        [],
    );

    const finishGenericResult = useCallback((sourceNodeId: string, result: GenericRunResult) => {
        const source = nodesRef.current.find((node) => node.id === sourceNodeId);
        if (!source) return;
        const operation = getGenericOperation(result.operationId);
        const primaryState = result.taskStates.find((state) => state.phase === "succeeded" || state.phase === "attention") || result.taskStates[0];
        const taskIds = Array.from(new Set([...(source.metadata?.providerTask?.taskIds || []), ...(source.metadata?.providerTask?.taskId ? [source.metadata.providerTask.taskId] : []), ...result.taskIds].filter(Boolean)));
        const taskId = primaryState?.taskId || taskIds[0];
        const hasPollingInterruption = result.taskStates.some((state) => state.status === "polling_interrupted");
        const sourceOutputIndex = isNativeGenerationNode(source) && (!source.metadata?.content || shouldReplaceImageNodeOnGeneration(source)) ? result.outputs.findIndex((output) => genericOutputMatchesNode(output, source.type)) : -1;
        const sourceOutput = sourceOutputIndex >= 0 ? result.outputs[sourceOutputIndex] : undefined;
        const sourceImageOutputs = result.outputs.filter((output) => shouldKeepGeneratedOutputInImageHistory(source, output));
        const providerTask: NonNullable<CanvasNodeMetadata["providerTask"]> = {
            provider: "generic",
            ...source.metadata?.providerTask,
            taskId,
            taskIds,
            action: result.operationId,
            family: primaryState?.family || operation.taskFamily,
            phase: hasPollingInterruption ? "stopped" : result.status === "attention" ? "attention" : result.status === "partial" ? "partial" : "succeeded",
            status: hasPollingInterruption ? "partial_interrupted" : result.status === "partial" ? "partial" : primaryState?.status || result.status,
            progress: primaryState?.progress ?? (result.status === "succeeded" || (result.status === "partial" && !hasPollingInterruption) ? 100 : source.metadata?.providerTask?.progress),
            message: result.status === "partial" ? genericPartialSummary(result) : primaryState?.message,
            // 本次运行已经结束（成功 / 部分成功 / 失败）就要记录完成时间，界面据此算运行耗时。
            completedAt: new Date().toISOString(),
            raw: primaryState?.raw || result.raw,
        };
        const buttons = extractGenericButtons(result.raw);
        const urls = result.outputs.map((output) => output.url || output.sourceUrl).filter((url): url is string => Boolean(url));
        const providerResult: NonNullable<CanvasNodeMetadata["providerResult"]> = {
            taskId: sourceOutput?.taskId || taskId,
            taskIds,
            resultUrl: urls[0],
            urls,
            outputs: result.outputs,
            buttons,
            raw: result.raw,
        };

        const existingOutputSignatures = new Set(
            connectionsRef.current
                .filter((connection) => connection.fromNodeId === sourceNodeId)
                .map((connection) => nodesRef.current.find((node) => node.id === connection.toNodeId))
                .flatMap((node) => node?.metadata?.providerResult?.outputs || [])
                .map(genericOutputSignature),
        );
        const newOutputs = result.outputs.filter((output, index) => index !== sourceOutputIndex && !shouldKeepGeneratedOutputInImageHistory(source, output) && !existingOutputSignatures.has(genericOutputSignature(output)));
        const outputNodes = newOutputs.map((output, index) => createGenericOutputNode(source, output, index, operation.label, providerTask));
        setNodes((prev) => prev.map((node) => (node.id === sourceNodeId ? applyGenericResultToSource(node, sourceOutput, providerTask, providerResult, sourceImageOutputs) : node)).concat(outputNodes));
        if (outputNodes.length) {
            setConnections((prev) => [...prev, ...outputNodes.map((node) => ({ id: nanoid(), fromNodeId: sourceNodeId, toNodeId: node.id }))]);
            setSelectedNodeIds(new Set(outputNodes.map((node) => node.id)));
        }
    }, []);

    /**
     * 用户渠道模型（OpenAI / Gemini / 火山方舟等）走渠道协议生成；
     * 内置目录模型继续走异步任务协议，两条路径互不影响。
     */
    const handleChannelModelRun = useCallback(
        async (node: CanvasNodeData, modelValue: string, payload: Record<string, unknown>) => {
            const nativeKind = genericNativeNodeKind(node.type);
            // 文本与音频在上层已改走通用生成流程，这里只作为兜底。
            if (nativeKind !== "image" && nativeKind !== "video" && nativeKind !== "audio") return;
            const requestConfig = resolveModelRequestConfig(effectiveConfig, modelValue);
            if (!isAiConfigReady(requestConfig, requestConfig.model)) {
                openConfigDialog(true);
                return;
            }
            genericRequestLocksRef.current.add(node.id);
            const controller = startGenerationRequest(node.id, node.id, node.id);
            const typedPrompt = typeof payload.prompt === "string" ? payload.prompt : "";
            // 音频节点常把文案放在上游文本节点里、自己的输入框留空，而占位符替换只在通用流程里做，
            // 所以这里要用画布上下文把上游文本解析出来，否则会把 "@Text 1" 原样当成台词念出去。
            const prompt = nativeKind === "audio" ? buildNodeGenerationContext(node.id, nodesRef.current, connectionsRef.current, typedPrompt).prompt.trim() || typedPrompt : typedPrompt;
            const metadata = payload.metadata && typeof payload.metadata === "object" ? (payload.metadata as Record<string, unknown>) : {};
            const size = typeof metadata.size === "string" ? metadata.size : "";
            const requested = Number(payload.n);
            const count = Number.isInteger(requested) && requested >= 1 ? String(Math.min(requested, 10)) : "1";
            const seconds = payload.seconds === undefined || payload.seconds === null || payload.seconds === "" ? "" : String(payload.seconds);
            // 渠道模型是同步直连请求，没有服务商轮询上报进度：必须自己写入提交时间与阶段，
            // 否则进度环取不到计时起点，会永远停在 8%。
            const channelTaskBase: NonNullable<CanvasNodeMetadata["providerTask"]> = {
                provider: "generic",
                action: nativeKind === "video" ? "video.generate" : nativeKind === "audio" ? "audio.generate" : "image.generate",
                family: nativeKind === "video" ? "video" : nativeKind === "audio" ? "audio" : "image",
                submittedAt: new Date().toISOString(),
            };
            const channelRunningTask: NonNullable<CanvasNodeMetadata["providerTask"]> = { ...channelTaskBase, phase: "running", status: "running", progress: 0 };
            // 完成时间必须在请求结束后才取：提前算会把耗时算成 0。
            const channelDoneTask = (): NonNullable<CanvasNodeMetadata["providerTask"]> => ({
                ...channelTaskBase,
                phase: "succeeded",
                status: "succeeded",
                progress: 100,
                completedAt: new Date().toISOString(),
            });
            setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, model: modelValue, prompt, status: NODE_STATUS_LOADING, errorDetails: undefined, providerTask: channelRunningTask } } : item)));
            try {
                // 提示词里 @ 到的素材图片一并作为参考图，按 storageKey / id 与已连接的参考图去重。
                const references = mergeReferenceImages(
                    buildNodeGenerationInputs(node.id, nodesRef.current, connectionsRef.current).flatMap((input) => (input.type === "image" && input.image ? [input.image] : [])),
                    resolvePromptAssetReferences(prompt),
                );
                if (nativeKind === "video") {
                    const video = await requestVideoGeneration({ ...requestConfig, size, videoSeconds: seconds }, prompt, references, [], [], { signal: controller.signal });
                    const uploadedVideo = await storeProviderVideo(video);
                    const videoSpec = getNodeSpec(CanvasNodeType.Video);
                    setNodes((prev) =>
                        prev.map((item) => {
                            if (item.id !== node.id) return item;
                            const videoPatch = {
                                ...videoMetadata(uploadedVideo),
                                prompt,
                                model: modelValue,
                                status: NODE_STATUS_SUCCESS,
                                errorDetails: undefined,
                                providerTask: channelDoneTask(),
                            };
                            // 画面框按成片实际宽高比自适应，避免被默认横屏框裁切。
                            return { ...item, ...fitMediaNodeGeometry(item, videoPatch.naturalWidth, videoPatch.naturalHeight, videoSpec.width, videoSpec.height), metadata: { ...item.metadata, ...videoPatch } };
                        }),
                    );
                } else if (nativeKind === "audio") {
                    // 语音走 OpenAI 形状的 /audio/speech，与「通用生成流程」里的 /audio/generations 不同：
                    // 后者是为音乐类接口写的，普通渠道模型打过去只会 404。
                    // 音色、格式、语速、指令都存在节点上，必须并进请求配置：
                    // 只用全局配置的话，面板里选了 WAV 与智谱音色，发出去的仍是全局的 mp3 与 alloy，
                    // 服务商只会回一句「不支持当前 response_format 值」，看着像对方的问题。
                    const audioConfig = {
                        ...requestConfig,
                        audioVoice: node.metadata?.audioVoice || requestConfig.audioVoice,
                        audioFormat: node.metadata?.audioFormat || requestConfig.audioFormat,
                        audioSpeed: node.metadata?.audioSpeed || requestConfig.audioSpeed,
                        audioInstructions: node.metadata?.audioInstructions || requestConfig.audioInstructions,
                    };
                    const audio = await storeGeneratedAudio(await requestAudioGeneration(audioConfig, prompt, { signal: controller.signal }), audioConfig.audioFormat);
                    setNodes((prev) =>
                        prev.map((item) =>
                            item.id === node.id
                                ? { ...item, metadata: { ...item.metadata, ...audioMetadata(audio), prompt, model: modelValue, status: NODE_STATUS_SUCCESS, errorDetails: undefined, providerTask: channelDoneTask() } }
                                : item,
                        ),
                    );
                } else {
                    const items = references.length
                        ? await requestEdit({ ...requestConfig, size, count }, prompt, references, undefined, { signal: controller.signal })
                        : await requestGeneration({ ...requestConfig, size, count }, prompt, { signal: controller.signal });
                    const generated = items.filter((item) => Boolean(item?.dataUrl));
                    if (!generated.length) throw new Error("渠道模型没有返回图片，请检查模型能力与接口地址。");
                    // 生成数量 >1 时上游会返回多张：首张作为节点主图，其余并入图片历史，避免被静默丢弃。
                    // 取图统一走 resolveProviderMediaBlob：服务商临时地址用 WebView 直连会被 CORS 拦下。
                    // 单张取回失败不影响其余结果，只有全部失败才判定为错误。
                    const uploads = await Promise.all(
                        generated.map(async (item): Promise<UploadedImage | null> => {
                            try {
                                return await uploadImage(item.dataUrl.startsWith("data:") ? item.dataUrl : await resolveProviderMediaBlob(item.dataUrl, "image"));
                            } catch {
                                return null;
                            }
                        }),
                    );
                    const uploadedImages = uploads.filter((image): image is UploadedImage => image !== null);
                    if (!uploadedImages.length) throw new Error("渠道模型返回的图片无法读取：可能被跨域策略拦截或地址已过期，请检查模型能力与接口地址。");
                    const [primaryImage, ...extraImages] = uploadedImages;
                    const toOutput = (image: (typeof uploadedImages)[number]): GenericOutput => ({
                        kind: "image",
                        url: image.url,
                        sourceUrl: image.url,
                        storageKey: image.storageKey,
                        mimeType: image.mimeType,
                        bytes: image.bytes,
                        width: image.width,
                        height: image.height,
                    });
                    const primaryOutput = toOutput(primaryImage);
                    const extraOutputs = extraImages.map(toOutput);
                    const imageSpec = getNodeSpec(CanvasNodeType.Image);
                    setNodes((prev) =>
                        prev.map((item) => {
                            if (item.id !== node.id) return item;
                            const imagePatch = { ...imageMetadata(primaryImage), prompt, model: modelValue, status: NODE_STATUS_SUCCESS, errorDetails: undefined, providerTask: channelDoneTask() };
                            // 用打补丁前的 metadata 做基底：渠道模型重跑会覆盖节点上的原图，
                            // 先把上一版并进图片历史，否则这一版就再也找不回来了。
                            const historyPatch = mergeGeneratedImageOutputsHistory(item.metadata, [primaryOutput, ...extraOutputs], channelDoneTask(), primaryOutput);
                            // 图片框按生成结果的实际宽高比自适应：选了 1024×1024 就应显示为方框，而不是横屏框裁切。
                            return { ...item, ...fitMediaNodeGeometry(item, imagePatch.naturalWidth, imagePatch.naturalHeight, imageSpec.width, imageSpec.height), metadata: { ...item.metadata, ...imagePatch, ...historyPatch } };
                        }),
                    );
                }
            } catch (error) {
                if (!isGenerationCanceled(error)) {
                    const errorDetails = error instanceof Error ? error.message : "生成失败";
                    message.error(errorDetails);
                    const failedTask: NonNullable<CanvasNodeMetadata["providerTask"]> = { ...channelTaskBase, phase: "failed", status: "failed", completedAt: new Date().toISOString() };
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails, providerTask: failedTask } } : item)));
                }
            } finally {
                genericRequestLocksRef.current.delete(node.id);
                finishGenerationRequest(node.id, controller);
            }
        },
        [effectiveConfig, finishGenerationRequest, message, openConfigDialog, startGenerationRequest],
    );

    // 合成节点：片段、配音与背景音乐按连线读取，连线顺序即片段顺序。
    type CompositeSourceItem = { connectionId: string; node: CanvasNodeData };
    const collectCompositeSources = useCallback((compositeNodeId: string): { segments: CompositeSourceItem[]; music: CompositeSourceItem | null; voice: CompositeSourceItem | null } => {
        const segments: CompositeSourceItem[] = [];
        let music: CompositeSourceItem | null = null;
        let voice: CompositeSourceItem | null = null;
        connectionsRef.current.forEach((connection) => {
            if (connection.toNodeId !== compositeNodeId) return;
            const source = nodesRef.current.find((item) => item.id === connection.fromNodeId);
            if (!source || !source.metadata?.content) return;
            if (connection.toPortId === COMPOSITE_SEGMENTS_PORT_ID && source.type === CanvasNodeType.Video) segments.push({ connectionId: connection.id, node: source });
            if (!voice && connection.toPortId === COMPOSITE_VOICE_PORT_ID && source.type === CanvasNodeType.Audio) voice = { connectionId: connection.id, node: source };
            if (!music && connection.toPortId === COMPOSITE_MUSIC_PORT_ID && source.type === CanvasNodeType.Audio) music = { connectionId: connection.id, node: source };
        });
        return { segments, music, voice };
    }, []);

    // 对比节点：按连线顺序取前两张图片，连线顺序决定左右。
    const collectCompareSources = useCallback((compareNodeId: string) => resolveCompareSources(compareNodeId, nodesRef.current, connectionsRef.current), []);

    // 拼合节点：按连线顺序取最多 10 张图片当图层，图层尺寸取图片原始像素。
    const collectCollageSources = useCallback((collageNodeId: string) => resolveCollageSources(collageNodeId, nodesRef.current, connectionsRef.current), []);

    const handleRunComposite = useCallback(
        async (node: CanvasNodeData) => {
            const current = nodesRef.current.find((item) => item.id === node.id);
            if (!current) return;
            if (!isTauriRuntime()) {
                message.warning("视频合成仅在桌面客户端可用");
                return;
            }
            if (genericRequestLocksRef.current.has(node.id)) {
                message.warning("该节点正在合成中，请等待完成。");
                return;
            }
            const { segments, music, voice } = collectCompositeSources(node.id);
            if (!segments.length) {
                message.warning("请先连接至少 1 个视频节点作为片段");
                setDialogNodeId(node.id);
                return;
            }
            genericRequestLocksRef.current.add(node.id);
            setRunningGenericNodeIds((prev) => new Set(prev).add(node.id));
            setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined } } : item)));
            try {
                const settings = current.metadata?.compositeSettings || {};
                const requests = await Promise.all(
                    segments.map(async (segment) => {
                        const segmentSettings = settings.segments?.[segment.node.id] || {};
                        return { path: await resolveCanvasMediaLocalPath(segment.node), start: segmentSettings.start, end: segmentSettings.end, volume: segmentSettings.volume, transition: segmentSettings.transition, transitionDuration: segmentSettings.transitionDuration, subtitle: segmentSettings.subtitle, fadeIn: segmentSettings.fadeIn, fadeOut: segmentSettings.fadeOut };
                    }),
                );
                // 配音与背景音乐是两条独立音轨，各自音量与淡出都在合成面板里调。
                const tracks: { path: string; volume?: number; fadeOut?: number; loop?: boolean }[] = [];
                if (voice) tracks.push({ path: await resolveCanvasMediaLocalPath(voice.node), volume: settings.voiceVolume, fadeOut: settings.voiceFadeOut, loop: settings.voiceLoop });
                if (music) tracks.push({ path: await resolveCanvasMediaLocalPath(music.node), volume: settings.musicVolume, fadeOut: settings.musicFadeOut, loop: settings.musicLoop });
                const result = await composeVideo({
                    ffmpegPath: readFfmpegPath() || undefined,
                    segments: requests,
                    tracks,
                    longEdge: settings.longEdge,
                    fps: settings.fps,
                    fadeIn: settings.fadeIn,
                    fadeOut: settings.fadeOut,
                    title: current.title,
                    subtitleStyle: settings.subtitleStyle,
                    subtitleSize: settings.subtitleSize,
                });
                const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                // 合成要跑很久，期间画布可能已经切走、节点也可能被删：这时不能再往当前画布追加成片节点。
                if (!nodesRef.current.some((item) => item.id === node.id)) return;
                const videoSize = fitNodeSize(result.width || spec.width, result.height || spec.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                const outputId = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                const outputNode: CanvasNodeData = {
                    id: outputId,
                    type: CanvasNodeType.Video,
                    title: `${current.title || "合成"} · 成片`,
                    position: { x: current.position.x + current.width + 96, y: current.position.y + current.height / 2 - videoSize.height / 2 },
                    width: videoSize.width,
                    height: videoSize.height,
                    metadata: {
                        content: desktopFileUrl(result.absolutePath),
                        localPath: result.absolutePath,
                        filename: result.filename,
                        mimeType: result.mimeType,
                        bytes: result.bytes,
                        naturalWidth: result.width,
                        naturalHeight: result.height,
                        durationMs: result.durationMs,
                        status: NODE_STATUS_SUCCESS,
                        sourceOrigin: "generated",
                    },
                };
                setNodes((prev) => [
                    ...prev.map((item) =>
                        item.id === node.id
                            ? {
                                  ...item,
                                  metadata: {
                                      ...item.metadata,
                                      status: NODE_STATUS_SUCCESS,
                                      compositeResult: { filename: result.filename, bytes: result.bytes, width: result.width, height: result.height, durationMs: result.durationMs, createdAt: new Date().toISOString() },
                                  },
                              }
                            : item,
                    ),
                    outputNode,
                ]);
                setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: outputId, fromPortId: COMPOSITE_VIDEO_OUTPUT_PORT_ID }]);
                setSelectedNodeIds(new Set([outputId]));
                message.success("视频合成完成，成片已生成新的视频节点");
            } catch (error) {
                const errorDetails = error instanceof Error ? error.message : String(error);
                message.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                genericRequestLocksRef.current.delete(node.id);
                setRunningGenericNodeIds((prev) => {
                    const next = new Set(prev);
                    next.delete(node.id);
                    return next;
                });
            }
        },
        [collectCompositeSources, message],
    );

    // 多角色配音合并：选中的音频节点按面板里的顺序交给本机 FFmpeg 拼成一个音频文件，结果生成新的音频节点。
    const handleMergeAudio = useCallback(
        async (sources: CanvasNodeData[]) => {
            if (!isTauriRuntime()) {
                message.warning("音频合并仅在桌面客户端可用");
                return;
            }
            if (sources.length < 2) {
                message.warning("请至少选择 2 个音频节点");
                return;
            }
            setAudioMergeBusy(true);
            try {
                const paths = await Promise.all(sources.map((node) => resolveCanvasMediaLocalPath(node)));
                const result = await concatAudio(paths, "合并配音");
                const last = sources[sources.length - 1];
                const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
                const outputId = `audio-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                const outputNode: CanvasNodeData = {
                    id: outputId,
                    type: CanvasNodeType.Audio,
                    title: "合并配音",
                    position: { x: last.position.x + last.width + 96, y: last.position.y },
                    width: spec.width,
                    height: spec.height,
                    metadata: {
                        content: desktopFileUrl(result.absolutePath),
                        localPath: result.absolutePath,
                        filename: result.filename,
                        mimeType: result.mimeType,
                        bytes: result.bytes,
                        durationMs: result.durationMs,
                        status: NODE_STATUS_SUCCESS,
                        sourceOrigin: "generated",
                    },
                };
                setNodes((prev) => [...prev, outputNode]);
                setSelectedNodeIds(new Set([outputId]));
                setAudioMergeNodeId(null);
                message.success("配音合并完成，已生成新的音频节点");
            } catch (error) {
                message.error(error instanceof Error ? error.message : String(error));
            } finally {
                setAudioMergeBusy(false);
            }
        },
        [message],
    );

    const handleRunGeneric = useCallback(
        async (node: CanvasNodeData, payload: Record<string, unknown>, options?: { references?: GenericReference[]; persistPayload?: Record<string, unknown> }) => {
            if (genericRequestLocksRef.current.has(node.id) || generationRequestsRef.current.has(node.id)) {
                message.warning("该节点正在提交或查询任务，请勿重复发起，以免重复计费。");
                return;
            }
            if (hasUnresolvedGenericTask(node)) {
                message.warning("该节点仍有关联的远端任务。为避免串用 Task ID 或重复计费，请先恢复查询；如需并行生成，请新建一个同类型节点。");
                return;
            }
            const channelModel = typeof payload.model === "string" ? payload.model : "";
            // 渠道模型为图片、视频与音频实现了专门的渠道协议分支（音频走 /audio/speech，
            // 和通用流程里给音乐接口准备的 /audio/generations 不是一回事）；
            // 文本仍走下面的通用生成流程。
            const channelKind = genericNativeNodeKind(node.type);
            if (isChannelModelValue(channelModel) && (channelKind === "image" || channelKind === "video" || channelKind === "audio")) {
                await handleChannelModelRun(node, channelModel, payload);
                return;
            }
            const resolved = resolveGenericChannel(node);
            if (!resolved) return;
            genericRequestLocksRef.current.add(node.id);
            const operationId = node.metadata?.genericOperation || "video.generate";
            const runPlan = prepareGenericNativeRun(payload);
            // 提示词里 @ 到的素材参考图由面板追加；落盘仍用面板给的原文 payload，
            // 否则节点上会留下 `@Image N` 这种只在本次请求里成立的占位符。
            const extraReferences = options?.references || [];
            const persistedPayload = JSON.stringify(options?.persistPayload || runPlan.payload, null, 2);
            let controller: AbortController | undefined;
            let remoteSubmitted = false;
            let journalWarningShown = false;
            try {
                clearGenericTaskJournal(projectId, node.id);
                controller = startGenerationRequest(node.id, node.id, node.id);
                setRunningGenericNodeIds((current) => new Set(current).add(node.id));
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === node.id
                            ? {
                                  ...item,
                                  metadata: {
                                      ...item.metadata,
                                      channelId: node.metadata?.channelId || resolved.channel.id,
                                      genericOperation: operationId,
                                      genericPayload: persistedPayload,
                                      status: NODE_STATUS_LOADING,
                                      errorDetails: undefined,
                                      providerTask: { provider: "generic", action: operationId, family: getGenericOperation(operationId).taskFamily, phase: "queued", status: "submitting", progress: 0 },
                                      providerResult: undefined,
                                  },
                              }
                            : item,
                    ),
                );
                const result = await runGenericOperationBatch(resolved.requestConfig, operationId, runPlan.payload, runPlan.batchCount, {
                    signal: controller.signal,
                    references: buildGenericReferences(node.id, extraReferences),
                    onSubmitted: (submission) => {
                        remoteSubmitted = true;
                        const journaled = journalGenericSubmission({
                            projectId,
                            node: {
                                ...node,
                                metadata: {
                                    ...node.metadata,
                                    channelId: resolved.channel.id,
                                    genericOperation: operationId,
                                    genericPayload: persistedPayload,
                                },
                            },
                            operationId,
                            channelId: resolved.channel.id,
                            submission,
                        });
                        if (!journaled && !journalWarningShown) {
                            journalWarningShown = true;
                            message.warning("浏览器无法写入即时任务恢复日志，请勿在 Task ID 完整保存前刷新页面。");
                        }
                        updateGenericSubmission(node.id, submission);
                    },
                    onUpdate: (state) => updateGenericTaskState(node.id, state),
                });
                requestGenericWalletRefresh();
                const persisted = await persistGenericRunResult(result);
                finishGenericResult(node.id, persisted.result);
                if (result.status === "partial" || persisted.failures.length || persisted.diskFailures.length)
                    message.warning(
                        [
                            result.status === "partial" ? genericPartialSummary(result) : "",
                            persisted.failures.length ? `${persisted.failures.length} 个结果无法完成任何本地转存，已保留官方临时地址。` : "",
                            persisted.diskFailures.length ? `${persisted.diskFailures.length} 个结果未写入磁盘缓存 data/media-cache。` : "",
                        ]
                            .filter(Boolean)
                            .join("；"),
                    );
                else message.success(result.status === "attention" ? "任务正在等待补充参数，请查看节点状态。" : "Generic 任务已完成，并已缓存到 data/media-cache。");
            } catch (error) {
                if (error instanceof GenericPollingStoppedError || isGenerationCanceled(error)) {
                    const stoppedMessage = error instanceof GenericPollingStoppedError ? error.message : "本地请求已停止；如果 Generic 已收到提交，远端任务仍可能继续执行并计费。";
                    setNodes((prev) =>
                        prev.map((item) =>
                            item.id === node.id
                                ? {
                                      ...item,
                                      metadata: {
                                          ...item.metadata,
                                          status: NODE_STATUS_IDLE,
                                          errorDetails: undefined,
                                          providerTask: { provider: "generic", ...item.metadata?.providerTask, phase: "stopped", message: stoppedMessage },
                                      },
                                  }
                                : item,
                        ),
                    );
                    message.info(stoppedMessage);
                } else if (remoteSubmitted && isGenericPollingUncertain(error)) {
                    const interruption = `本地查询中断：${error instanceof Error ? error.message : String(error)}。远端任务可能仍在执行并计费，可使用已保存的 Task ID 恢复查询。`;
                    setNodes((prev) =>
                        prev.map((item) =>
                            item.id === node.id
                                ? {
                                      ...item,
                                      metadata: {
                                          ...item.metadata,
                                          status: NODE_STATUS_IDLE,
                                          errorDetails: undefined,
                                          providerTask: { provider: "generic", ...item.metadata?.providerTask, phase: "stopped", status: "polling_interrupted", message: interruption },
                                      },
                                  }
                                : item,
                        ),
                    );
                    message.warning(interruption);
                } else {
                    const failure = describeGenericError(error, { operationId, payload: runPlan.payload });
                    message.error(failure.summary);
                    setNodes((prev) =>
                        prev.map((item) =>
                            item.id === node.id
                                ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails: failure.details, providerTask: { provider: "generic", ...item.metadata?.providerTask, phase: "failed", message: failure.summary } } }
                                : item,
                        ),
                    );
                }
            } finally {
                if (controller) finishGenerationRequest(node.id, controller);
                genericRequestLocksRef.current.delete(node.id);
                setRunningGenericNodeIds((current) => {
                    if (!current.has(node.id)) return current;
                    const next = new Set(current);
                    next.delete(node.id);
                    return next;
                });
            }
        },
        [buildGenericReferences, finishGenericResult, finishGenerationRequest, message, projectId, resolveGenericChannel, startGenerationRequest, updateGenericSubmission, updateGenericTaskState],
    );

    const handleResumeGeneric = useCallback(
        async (node: CanvasNodeData) => {
            if (genericRequestLocksRef.current.has(node.id) || generationRequestsRef.current.has(node.id)) {
                message.warning("该节点正在提交或查询任务，请稍候。");
                return;
            }
            const taskIds = Array.from(
                new Set([
                    ...(node.metadata?.providerTask?.taskIds || []),
                    ...(node.metadata?.providerTask?.taskId ? [node.metadata.providerTask.taskId] : []),
                    ...(node.metadata?.providerResult?.taskIds || []),
                    ...(node.metadata?.providerResult?.taskId ? [node.metadata.providerResult.taskId] : []),
                ]),
            );
            const operationId = node.metadata?.genericOperation;
            if (!taskIds.length || !operationId) return;
            const resolved = resolveGenericChannel(node);
            if (!resolved) return;
            genericRequestLocksRef.current.add(node.id);
            let controller: AbortController | undefined;
            try {
                controller = startGenerationRequest(node.id, node.id, node.id);
                setRunningGenericNodeIds((current) => new Set(current).add(node.id));
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === node.id
                            ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined, providerTask: { provider: "generic", ...item.metadata?.providerTask, phase: "running", status: "resuming" } } }
                            : item,
                    ),
                );
                const result = await resumeGenericTasks(resolved.requestConfig, operationId, taskIds, { signal: controller.signal, onUpdate: (state) => updateGenericTaskState(node.id, state) });
                requestGenericWalletRefresh();
                const persisted = await persistGenericRunResult(result);
                finishGenericResult(node.id, persisted.result);
                if (result.status === "partial" || persisted.failures.length || persisted.diskFailures.length)
                    message.warning(
                        [
                            result.status === "partial" ? genericPartialSummary(result) : "",
                            persisted.failures.length ? `${persisted.failures.length} 个结果无法完成任何本地转存，已保留官方临时地址。` : "",
                            persisted.diskFailures.length ? `${persisted.diskFailures.length} 个结果未写入磁盘缓存 data/media-cache。` : "",
                        ]
                            .filter(Boolean)
                            .join("；"),
                    );
                else message.success(result.status === "attention" ? "任务正在等待补充参数。" : "Generic 任务查询完成，并已缓存到 data/media-cache。");
            } catch (error) {
                if (error instanceof GenericPollingStoppedError) {
                    setNodes((prev) =>
                        prev.map((item) =>
                            item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_IDLE, providerTask: { provider: "generic", ...item.metadata?.providerTask, phase: "stopped", message: error.message } } } : item,
                        ),
                    );
                    message.info(error.message);
                } else if (isGenericPollingUncertain(error)) {
                    const interruption = `任务查询中断：${error instanceof Error ? error.message : String(error)}。远端状态未知，可稍后从本节点恢复查询。`;
                    setNodes((prev) =>
                        prev.map((item) =>
                            item.id === node.id
                                ? {
                                      ...item,
                                      metadata: {
                                          ...item.metadata,
                                          status: NODE_STATUS_IDLE,
                                          errorDetails: undefined,
                                          providerTask: { provider: "generic", ...item.metadata?.providerTask, phase: "stopped", status: "polling_interrupted", message: interruption },
                                      },
                                  }
                                : item,
                        ),
                    );
                    message.warning(interruption);
                } else {
                    const failure = describeGenericError(error, { operationId, taskIds }, "Generic 任务查询失败");
                    message.error(failure.summary);
                    setNodes((prev) =>
                        prev.map((item) =>
                            item.id === node.id
                                ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails: failure.details, providerTask: { provider: "generic", ...item.metadata?.providerTask, phase: "failed", message: failure.summary } } }
                                : item,
                        ),
                    );
                }
            } finally {
                if (controller) finishGenerationRequest(node.id, controller);
                genericRequestLocksRef.current.delete(node.id);
                setRunningGenericNodeIds((current) => {
                    if (!current.has(node.id)) return current;
                    const next = new Set(current);
                    next.delete(node.id);
                    return next;
                });
            }
        },
        [finishGenericResult, finishGenerationRequest, message, projectId, resolveGenericChannel, startGenerationRequest, updateGenericTaskState],
    );

    const confirmStopGenericPolling = useCallback(
        (node: CanvasNodeData) => {
            modal.confirm({
                title: "停止本地轮询？",
                content: "Generic 没有取消任务接口。停止后远端任务仍会继续执行并可能计费，Task ID 会保留，可稍后恢复查询。",
                okText: "停止轮询",
                cancelText: "继续等待",
                okButtonProps: { danger: true },
                onOk: () => stopGenerationByRunningId(node.id),
            });
        },
        [modal, stopGenerationByRunningId],
    );

    const downloadNodeImage = useCallback(
        async (node: CanvasNodeData) => {
            const providerOutputs = node.metadata?.providerResult?.outputs || [];
            const fileOutput = providerOutputs.find((output) => output.kind === "file");
            const mediaOutput =
                fileOutput ||
                providerOutputs.find((output) => output.localPath && output.localPath === node.metadata?.localPath) ||
                providerOutputs.find((output) => output.url && output.url === node.metadata?.content) ||
                providerOutputs.find((output) => output.kind === node.type);
            const isDownloadableType = node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio || Boolean(fileOutput);
            const url = node.metadata?.content || mediaOutput?.url || mediaOutput?.sourceUrl || "";
            if (!isDownloadableType || !url) return;
            const kind: DownloadableMediaKind = fileOutput ? "file" : node.type === CanvasNodeType.Video ? "video" : node.type === CanvasNodeType.Audio ? "audio" : "image";
            const fallbackFilename = fileOutput
                ? fileOutput.filename || fileOutput.name || `generic-file-${node.id}.${genericFileExtension(fileOutput)}`
                : node.metadata?.filename ||
                  mediaOutput?.filename ||
                  mediaOutput?.name ||
                  `canvas-${node.type}-${node.id}.${node.type === CanvasNodeType.Video ? "mp4" : node.type === CanvasNodeType.Audio ? audioExtension(node.metadata?.mimeType) : imageExtension(url)}`;
            const filename = downloadFilenameFromTitle(node.title, fallbackFilename);
            const messageKey = `canvas-download-${node.id}`;
            message.open({ key: messageKey, type: "loading", content: t("canvas.projectPage.downloading"), duration: 0 });
            try {
                await downloadBlobBackedMedia({
                    kind,
                    url,
                    storageKey: node.metadata?.storageKey || mediaOutput?.storageKey,
                    localPath: node.metadata?.localPath || mediaOutput?.localPath,
                    sourceUrl: mediaOutput?.sourceUrl,
                    filename,
                    mimeType: node.metadata?.mimeType || mediaOutput?.mimeType,
                });
                message.success({ key: messageKey, content: t("canvas.projectPage.downloadStarted") });
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                message.error({ key: messageKey, content: t("canvas.projectPage.downloadFailed", { message: reason }), duration: 4 });
            }
        },
        [message, t],
    );

    const saveNodeAsset = useCallback(
        async (node: CanvasNodeData) => {
            if (node.type === CanvasNodeType.Text) {
                const content = node.metadata?.content?.trim();
                if (!content) return message.error(t("canvas.projectPage.noTextToSave"));
                addAsset({
                    kind: "text",
                    title: node.title || node.metadata?.prompt?.slice(0, 24) || t("canvas.projectPage.canvasText"),
                    coverUrl: "",
                    tags: [],
                    source: "Canvas",
                    data: { content },
                    metadata: { source: "canvas", nodeId: node.id, projectId, projectTitle: currentProject?.title },
                });
                message.success(t("common.addedToAssets"));
                return;
            }
            if (node.type === CanvasNodeType.Video) {
                if (!node.metadata?.content) return message.error(t("canvas.projectPage.noVideoToSave"));
                addAsset({
                    kind: "video",
                    title: node.title || node.metadata?.prompt?.slice(0, 24) || t("canvas.projectPage.canvasVideo"),
                    coverUrl: "",
                    tags: [],
                    source: "Canvas",
                    data: { url: node.metadata.content, storageKey: node.metadata.storageKey, width: node.width, height: node.height, bytes: node.metadata.bytes || 0, mimeType: node.metadata.mimeType || "video/mp4" },
                    metadata: { source: "canvas", nodeId: node.id, projectId, projectTitle: currentProject?.title, prompt: node.metadata?.prompt },
                });
                message.success(t("common.addedToAssets"));
                return;
            }
            if (!node.metadata?.content) return message.error(t("canvas.projectPage.noImageToSave"));
            const dataUrl = node.metadata.storageKey ? "" : node.metadata.content;
            addAsset({
                kind: "image",
                title: node.title || node.metadata?.prompt?.slice(0, 24) || t("canvas.projectPage.canvasImage"),
                coverUrl: node.metadata.content,
                tags: [],
                source: "Canvas",
                data: {
                    dataUrl,
                    storageKey: node.metadata.storageKey,
                    width: node.metadata.naturalWidth || node.width,
                    height: node.metadata.naturalHeight || node.height,
                    bytes: node.metadata.bytes || getDataUrlByteSize(dataUrl),
                    mimeType: node.metadata.mimeType || "image/png",
                },
                metadata: { source: "canvas", nodeId: node.id, projectId, projectTitle: currentProject?.title, prompt: node.metadata?.prompt },
            });
            message.success(t("common.addedToAssets"));
        },
        [addAsset, currentProject?.title, message, projectId, t],
    );

    // 画布产物发送到独立剪辑台：只把节点上的媒体信息登记为剪辑台素材，
    // 不改动画布数据（节点、连线、compositeSettings 全部原样保留）。
    const sendNodeToEditor = useCallback(
        (node: CanvasNodeData) => {
            const media = canvasNodeToEditMedia(node);
            if (!media) {
                message.warning(t("editor.importUnsupported"));
                return;
            }
            const store = useEditStore.getState();
            const targetId = store.ensureProject(currentProject?.title || t("editor.untitled"));
            store.addMedia(targetId, media);
            const targetName = useEditStore.getState().projects.find((project) => project.id === targetId)?.name || "";
            message.success({
                content: (
                    <span className="inline-flex items-center gap-2">
                        {t("editor.sentToEditor", { name: targetName })}
                        <button type="button" className="cursor-pointer rounded-[8px] px-2 py-0.5 text-[11px] font-medium text-[#756bff] transition-colors hover:bg-[#756bff]/10" onClick={() => navigate(`/editor/${targetId}`)}>
                            {t("editor.openEditor")}
                        </button>
                    </span>
                ),
                duration: 5,
            });
        },
        [currentProject?.title, message, navigate, t],
    );

    const createImageReversePromptNodes = useCallback(
        (node: CanvasNodeData) => {
            if (node.type !== CanvasNodeType.Image || !node.metadata?.content) {
                message.warning(t("canvas.projectPage.emptyReverse"));
                return;
            }

            const gap = 96;
            const textSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
            const centerY = node.position.y + node.height / 2;
            const payload = createGenericNativePayload("midjourney.describe", undefined, { image: 1, video: 0, audio: 0, text: 0, task: 0 });
            const textNode = {
                ...createCanvasNode(
                    CanvasNodeType.Text,
                    { x: node.position.x + node.width + gap + textSpec.width / 2, y: centerY },
                    {
                        genericOperation: "midjourney.describe",
                        genericPayload: JSON.stringify(payload, null, 2),
                        status: NODE_STATUS_IDLE,
                        fontSize: 14,
                    },
                ),
                title: t("canvas.projectPage.reverseTitle"),
            };

            setNodes((prev) => [...prev, textNode]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: textNode.id }]);
            setSelectedNodeIds(new Set([textNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(textNode.id);
            setContextMenu(null);
        },
        [message, t],
    );

    const cropImageNode = useCallback(
        async (node: CanvasNodeData, crop: CanvasImageCropRect) => {
            if (!node.metadata?.content) return;
            try {
                const cropped = await withCanvasImageOperationSource(canvasImageOperationSource(node), (localUrl) => cropDataUrl(localUrl, crop));
                const image = await uploadImage(cropped);
                const width = Math.min(node.width, Math.max(220, image.width));
                const childId = nanoid();
                const child: CanvasNodeData = {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title: "Cropped Image",
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width,
                    height: width * (image.height / image.width),
                    metadata: {
                        ...imageMetadata(image),
                        prompt: node.metadata?.prompt,
                    },
                };
                setNodes((prev) => [...prev, child]);
                setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
                setSelectedNodeIds(new Set([childId]));
                setToolbarNodeId(childId);
                setDialogNodeId(childId);
                setCropNodeId(null);
            } catch (error) {
                message.error(`裁剪失败：${error instanceof Error ? error.message : String(error)}`);
            }
        },
        [message],
    );

    const splitImageNode = useCallback(
        async (node: CanvasNodeData, params: CanvasImageSplitParams) => {
            if (!node.metadata?.content) return;
            try {
                const pieces = await withCanvasImageOperationSource(canvasImageOperationSource(node), (localUrl) => splitDataUrl(localUrl, params));
                const gap = 16;
                const cellWidth = node.width / params.columns;
                const cellHeight = node.height / params.rows;
                const startX = node.position.x + node.width + 96;
                const startY = node.position.y;
                const childNodes = await Promise.all(
                    pieces.map(async (piece) => {
                        const image = await uploadImage(piece.dataUrl);
                        const id = nanoid();
                        return {
                            id,
                            type: CanvasNodeType.Image,
                            title: t("canvas.projectPage.splitTitle", { name: node.title || t("assets.kinds.image"), row: piece.row + 1, column: piece.column + 1 }),
                            position: { x: startX + piece.column * (cellWidth + gap), y: startY + piece.row * (cellHeight + gap) },
                            width: cellWidth,
                            height: cellHeight,
                            metadata: {
                                ...imageMetadata(image),
                                prompt: node.metadata?.prompt,
                            },
                        } satisfies CanvasNodeData;
                    }),
                );
                setNodes((prev) => [...prev, ...childNodes]);
                setConnections((prev) => [...prev, ...childNodes.map((child) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: child.id }))]);
                setSelectedNodeIds(new Set(childNodes.map((child) => child.id)));
                setToolbarNodeId(null);
                setSelectedConnectionId(null);
                setDialogNodeId(null);
                setSplitNodeId(null);
                message.success(t("canvas.projectPage.splitSuccess", { count: childNodes.length }));
            } catch (error) {
                message.error(`切图失败：${error instanceof Error ? error.message : String(error)}`);
            }
        },
        [message, t],
    );

    const upscaleImageNode = useCallback(
        async (node: CanvasNodeData, params: CanvasImageUpscaleParams) => {
            if (!node.metadata?.content) return;
            try {
                const upscaled = await withCanvasImageOperationSource(canvasImageOperationSource(node), (localUrl) => upscaleDataUrl(localUrl, params));
                const image = await uploadImage(upscaled);
                const size = fitNodeSize(image.width, image.height);
                const childId = nanoid();
                const child: CanvasNodeData = {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title: "Upscaled Image",
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: size.width,
                    height: size.height,
                    metadata: {
                        ...imageMetadata(image),
                        prompt: node.metadata?.prompt,
                    },
                };
                setNodes((prev) => [...prev, child]);
                setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
                setSelectedNodeIds(new Set([childId]));
                setToolbarNodeId(childId);
                setDialogNodeId(childId);
                setUpscaleNodeId(null);
            } catch (error) {
                message.error(`图片放大失败：${error instanceof Error ? error.message : String(error)}`);
            }
        },
        [message],
    );

    const generateAngleNode = useCallback(
        (node: CanvasNodeData, params: CanvasImageAngleParams) => {
            if (!node.metadata?.content) return;
            const imageToImageModel = genericNativeModels("image.generate").find((profile) => profile.inputKind === "image-to-image");
            if (!imageToImageModel) {
                message.error("当前官方模型目录没有可用的图生图模型。");
                return;
            }
            const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            const title = buildAngleLabel(params);
            const prompt = buildAnglePrompt(params);
            const referenceCounts = { image: 1, video: 0, audio: 0, text: 0, task: 0 };
            let payload = createGenericNativePayload("image.generate", undefined, referenceCounts);
            payload = changeGenericNativeModel("image.generate", payload, imageToImageModel.id, referenceCounts);
            writeGenericNativePrompt("image.generate", payload, prompt);
            const child = {
                ...createCanvasNode(
                    CanvasNodeType.Image,
                    {
                        x: node.position.x + node.width + 96 + imageConfig.width / 2,
                        y: node.position.y + node.height / 2,
                    },
                    {
                        prompt,
                        model: imageToImageModel.id,
                        genericOperation: "image.generate",
                        genericPayload: JSON.stringify(payload, null, 2),
                        status: NODE_STATUS_IDLE,
                    },
                ),
                title,
            };
            setAngleNodeId(null);
            setNodes((prev) => [...prev, child]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: child.id }]);
            setSelectedNodeIds(new Set([child.id]));
            setToolbarNodeId(child.id);
            setDialogNodeId(child.id);
        },
        [message],
    );

    const handleFontSizeChange = useCallback((nodeId: string, fontSize: number) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, fontSize } } : node)));
    }, []);

    /** 把画布上所有生成结果批量导出到用户选择的目录。 */
    const exportCanvasMedia = useCallback(async () => {
        if (!isTauriRuntime()) {
            message.warning(t("canvas.exportMedia.desktopOnly"));
            return;
        }
        const paths = nodesRef.current.map((node) => node.metadata?.localPath).filter((value): value is string => Boolean(value));
        if (!paths.length) {
            message.warning(t("canvas.exportMedia.empty"));
            return;
        }
        const selected = await open({ directory: true, multiple: false, title: t("canvas.exportMedia.pickDirectory") });
        if (typeof selected !== "string" || !selected) return;
        try {
            await invokeDesktop("allow_download_directory", { directory: selected });
            const result = await invokeDesktop<{ exported: number; failed: string[]; directory: string }>("export_canvas_media", { paths, directory: selected });
            message.success(t("canvas.exportMedia.done", { count: result.exported }));
            if (result.failed.length) message.warning(t("canvas.exportMedia.partial", { count: result.failed.length }));
            await invokeDesktop("open_downloads_directory", { directory: selected });
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        }
    }, [message, t]);
    /** 导出带品牌水印的作品图，便于用户直接分享。 */
    const exportWatermarkedMedia = useCallback(async () => {
        if (!isTauriRuntime()) {
            message.warning(t("canvas.exportMedia.desktopOnly"));
            return;
        }
        const sources = nodesRef.current
            .filter((node) => node.type === CanvasNodeType.Image && node.metadata?.localPath)
            .map((node) => ({ path: node.metadata!.localPath!, name: node.metadata?.filename || node.title || "mgcanvas" }));
        if (!sources.length) {
            message.warning(t("canvas.exportMedia.empty"));
            return;
        }
        const selected = await open({ directory: true, multiple: false, title: t("canvas.exportMedia.pickDirectory") });
        if (typeof selected !== "string" || !selected) return;
        try {
            await invokeDesktop("allow_download_directory", { directory: selected });
            const label = t("meta.title");
            const paths: string[] = [];
            for (const source of sources) {
                const blob = await readDesktopFileBlob(source.path);
                if (!blob) continue;
                const watermarked = await watermarkImageBlob(blob, label);
                const target = `${selected.replace(/[\\/]+$/, "")}\\${source.name.replace(/\.[^.]+$/, "")}-watermark.png`;
                await writeFile(target, new Uint8Array(await watermarked.arrayBuffer()));
                paths.push(target);
            }
            message.success(t("canvas.exportMedia.watermarkDone", { count: paths.length }));
            await invokeDesktop("open_downloads_directory", { directory: selected });
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        }
    }, [message, t]);
    const handleUploadRequest = useCallback((nodeId?: string, position?: Position) => {
        const targetNode = nodeId ? nodesRef.current.find((node) => node.id === nodeId) : undefined;
        const isEmptyGenericMaterial = targetNode?.metadata?.sourceOrigin === "upload" && !targetNode.metadata.content;
        const expectedKind: CanvasMaterialKind | undefined = isEmptyGenericMaterial
            ? undefined
            : targetNode?.type === CanvasNodeType.Image
              ? "image"
              : targetNode?.type === CanvasNodeType.Video
                ? "video"
                : targetNode?.type === CanvasNodeType.Audio
                  ? "audio"
                  : undefined;
        uploadTargetRef.current = { nodeId, position, expectedKind };
        if (imageInputRef.current) {
            imageInputRef.current.accept = expectedKind ? CANVAS_MATERIAL_ACCEPT_BY_KIND[expectedKind] : CANVAS_MATERIAL_ACCEPT;
            imageInputRef.current.click();
        }
    }, []);

    const handleUploadCancel = useCallback(() => {
        const target = uploadTargetRef.current;
        if (target?.removeOnCancel && target.nodeId) {
            setNodes((prev) => {
                const removed = prev.some((node) => node.id === target.nodeId && !node.metadata?.content);
                if (!removed) return prev;
                return prev
                    .filter((node) => node.id !== target.nodeId)
                    .map((node) => {
                        const references = node.metadata?.objectReferences;
                        if (!references?.some((reference) => reference.sourceNodeId === target.nodeId)) return node;
                        return { ...node, metadata: { ...node.metadata, objectReferences: references.filter((reference) => reference.sourceNodeId !== target.nodeId) } };
                    });
            });
            setConnections((prev) => {
                const next = prev.filter((connection) => connection.fromNodeId !== target.nodeId && connection.toNodeId !== target.nodeId);
                connectionsRef.current = next;
                return next;
            });
            setSelectedNodeIds((current) => {
                const next = new Set(current);
                next.delete(target.nodeId!);
                if (target.returnToNodeId) next.add(target.returnToNodeId);
                return next;
            });
            setSelectedConnectionId(null);
            setDialogNodeId(target.returnToNodeId || null);
        }
        uploadTargetRef.current = null;
        if (imageInputRef.current) {
            imageInputRef.current.value = "";
            imageInputRef.current.accept = CANVAS_MATERIAL_ACCEPT;
        }
    }, []);

    useEffect(() => {
        const input = imageInputRef.current;
        if (!input) return;
        input.addEventListener("cancel", handleUploadCancel);
        return () => input.removeEventListener("cancel", handleUploadCancel);
    }, [handleUploadCancel]);

    const handleImageInputChange = useCallback(
        async (event: ReactChangeEvent<HTMLInputElement>) => {
            if (!event.target.files?.length) {
                handleUploadCancel();
                return;
            }
            const target = uploadTargetRef.current;
            const inspected = Array.from(event.target.files || []).map((file) => ({ file, validation: validateCanvasMaterialFile(file) }));
            const validFiles = inspected.flatMap(({ file, validation }) => (validation.ok ? [{ file, kind: validation.kind }] : []));
            const mismatched = target?.expectedKind ? validFiles.filter(({ kind }) => kind !== target.expectedKind).map(({ file }) => file) : [];
            const accepted = target?.expectedKind ? validFiles.filter(({ kind }) => kind === target.expectedKind) : validFiles;
            const oversized = inspected.filter(({ validation }) => !validation.ok && validation.reason === "too-large").map(({ file }) => file);
            const unsupported = inspected.filter(({ validation }) => !validation.ok && validation.reason === "unsupported").map(({ file }) => file);

            if (oversized.length) message.error(t("canvas.material.tooLargeFiles", { files: summarizeMaterialFiles(oversized) }));
            if (unsupported.length) message.error(t("canvas.material.unsupportedFiles", { files: summarizeMaterialFiles(unsupported) }));
            if (mismatched.length && target?.expectedKind) {
                message.error(t("canvas.material.wrongKindFiles", { files: summarizeMaterialFiles(mismatched), kind: t(`canvas.material.kinds.${target.expectedKind}`) }));
            }

            try {
                if (!accepted.length) return;

                const basePosition = target?.position || screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
                const stagger = 40;
                const tasks: Array<Promise<void>> = [];

                if (target?.nodeId) {
                    const [first, ...rest] = accepted;
                    tasks.push(replaceNodeWithMaterialFile(target.nodeId, first.file, first.kind));
                    rest.forEach(({ file, kind }, index) => {
                        tasks.push(createMaterialFileNode(file, kind, { x: basePosition.x + (index + 1) * stagger, y: basePosition.y + (index + 1) * stagger }));
                    });
                } else {
                    accepted.forEach(({ file, kind }, index) => {
                        tasks.push(createMaterialFileNode(file, kind, { x: basePosition.x + index * stagger, y: basePosition.y + index * stagger }));
                    });
                }

                const results = await Promise.allSettled(tasks);
                const completed = results.filter((result) => result.status === "fulfilled").length;
                const failed = results.length - completed;
                if (completed) message.success(t("canvas.material.uploadSuccess", { count: completed }));
                if (failed) message.error(t("canvas.material.uploadFailed", { count: failed }));
                if (target?.nodeId && results[0]?.status === "fulfilled") {
                    setSelectedNodeIds(new Set([target.returnToNodeId || target.nodeId]));
                    setSelectedConnectionId(null);
                }
                const connectedGenerationNodeId = target?.returnToNodeId || (target?.nodeId ? connectionsRef.current.find((connection) => connection.fromNodeId === target.nodeId)?.toNodeId : undefined);
                setDialogNodeId(connectedGenerationNodeId || null);
            } finally {
                uploadTargetRef.current = null;
                event.target.value = "";
                event.target.accept = CANVAS_MATERIAL_ACCEPT;
            }
        },
        [createMaterialFileNode, handleUploadCancel, message, replaceNodeWithMaterialFile, screenToCanvas, size.height, size.width, t],
    );

    const handleDrop = useCallback(
        async (event: ReactDragEvent<HTMLDivElement>) => {
            event.preventDefault();
            const inspected = Array.from(event.dataTransfer.files).map((file) => ({ file, validation: validateCanvasMaterialFile(file) }));
            const accepted = inspected.flatMap(({ file, validation }) => (validation.ok ? [{ file, kind: validation.kind }] : []));
            const oversized = inspected.filter(({ validation }) => !validation.ok && validation.reason === "too-large").map(({ file }) => file);
            const unsupported = inspected.filter(({ validation }) => !validation.ok && validation.reason === "unsupported").map(({ file }) => file);
            if (oversized.length) message.error(t("canvas.material.tooLargeFiles", { files: summarizeMaterialFiles(oversized) }));
            if (unsupported.length) message.error(t("canvas.material.unsupportedFiles", { files: summarizeMaterialFiles(unsupported) }));
            if (!accepted.length) return;

            const basePos = screenToCanvas(event.clientX, event.clientY);
            const results = await Promise.allSettled(accepted.map(({ file, kind }, index) => createMaterialFileNode(file, kind, { x: basePos.x + index * 40, y: basePos.y + index * 40 })));
            const completed = results.filter((result) => result.status === "fulfilled").length;
            const failed = results.length - completed;
            if (completed) message.success(t("canvas.material.uploadSuccess", { count: completed }));
            if (failed) message.error(t("canvas.material.uploadFailed", { count: failed }));
        },
        [createMaterialFileNode, message, screenToCanvas, t],
    );

    const startTitleEditing = useCallback(() => {
        setTitleDraft(currentProject?.title || t("canvas.projectPage.untitledCanvas"));
        setTitleEditing(true);
    }, [currentProject?.title, t]);

    const finishTitleEditing = useCallback(() => {
        const nextTitle = titleDraft.trim();
        if (nextTitle) renameProject(projectId, nextTitle);
        setTitleEditing(false);
    }, [projectId, renameProject, titleDraft]);

    const preventCanvasContextMenu = useCallback(
        (event: ReactMouseEvent) => {
            if ((event.target as HTMLElement).closest("[data-node-id],[data-canvas-no-zoom]")) return;
            event.preventDefault();
            setNodeCreatePosition(null);
            setContextMenu({
                type: "canvas",
                x: event.clientX,
                y: event.clientY,
                world: screenToCanvas(event.clientX, event.clientY),
            });
        },
        [screenToCanvas],
    );

    const handleGenerateNode = useCallback(
        async (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => {
            const sourceNode = nodesRef.current.find((node) => node.id === nodeId);
            let generationConfig = buildGenerationConfig(effectiveConfig, sourceNode, mode);
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                // 节点还没选模型时，自动挑一个已配置的同能力渠道模型；
                // 只有用户完全没配渠道时才弹配置窗口（此前会误弹，被当成「没配置」）。
                const autoModel = selectableModelsByCapability(effectiveConfig, mode)[0];
                if (!autoModel) {
                    openConfigDialog(true);
                    return;
                }
                generationConfig = { ...generationConfig, model: autoModel };
                // 把自动选中的模型写回节点：否则面板上仍显示「请选择模型」，
                // 用户看到的是「没选模型却跑起来了」。
                setNodes((prev) => prev.map((item) => (item.id === nodeId ? { ...item, metadata: { ...item.metadata, model: autoModel } } : item)));
            }

            // useBuiltinPanel.writeBackToSelf reuses built-in generation while writing the result back to the plugin node.
            // Image mode currently supports display-only nodes such as panoramas, with a useBuiltinPanel.promptPrefix.
            const builtinPanel = sourceNode ? getNodeDefinition(sourceNode.type)?.useBuiltinPanel : undefined;
            if (sourceNode && builtinPanel?.writeBackToSelf && builtinPanel.mode === "image") {
                const scene = prompt.trim();
                if (!scene) return;
                setRunningNodeId(nodeId);
                const controller = startGenerationRequest(nodeId, nodeId, nodeId);
                setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt: scene, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)));
                try {
                    const fullPrompt = (builtinPanel.promptPrefix || "") + scene;
                    // Upstream image nodes become references; without them this is text-to-image.
                    const refs = buildNodeGenerationInputs(nodeId, nodesRef.current, connectionsRef.current).flatMap((input) => (input.type === "image" && input.image ? [input.image] : []));
                    const image = refs.length
                        ? await requestEdit({ ...generationConfig, count: "1" }, fullPrompt, refs, undefined, { signal: controller.signal }).then((items) => items[0])
                        : await requestGeneration({ ...generationConfig, count: "1" }, fullPrompt, { signal: controller.signal }).then((items) => items[0]);
                    const uploaded = await uploadImage(image.dataUrl);
                    setNodes((prev) =>
                        prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...imageMetadata(uploaded), prompt: scene, model: generationConfig.model, status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : node)),
                    );
                    setDialogNodeId(null);
                } catch (error) {
                    if (!isGenerationCanceled(error)) {
                        const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                        message.error(errorDetails);
                        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } } : node)));
                    }
                } finally {
                    finishGenerationRequest(nodeId, controller);
                }
                return;
            }

            setRunningNodeId(nodeId);
            const runController = startGenerationRequest(nodeId, nodeId, nodeId);
            const sourceTextContent = sourceNode?.type === CanvasNodeType.Text ? sourceNode.metadata?.content?.trim() || "" : "";
            const editingTextNode = mode === "text" && Boolean(sourceTextContent);
            const generationContext = await hydrateNodeGenerationContext(
                buildNodeGenerationContext(nodeId, nodesRef.current, connectionsRef.current, editingTextNode ? t("canvas.projectPage.editTextPrompt", { source: sourceTextContent, prompt }) : prompt),
            );
            const effectivePrompt = generationContext.prompt.trim();
            if (runController.signal.aborted) {
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId(null);
                return;
            }
            const markSourceStatus = sourceNode?.type !== CanvasNodeType.Image && !editingTextNode;
            if (!effectivePrompt && (mode === "text" || mode === "audio")) {
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId(null);
                return;
            }
            let pendingChildIds: string[] = [];
            if (markSourceStatus)
                setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...(node.type === CanvasNodeType.Config ? {} : { prompt }), status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)));

            try {
                if (mode === "image") {
                    const count = getGenerationCount(generationConfig.count);
                    const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
                    const isImageNode = sourceNode?.type === CanvasNodeType.Image;
                    const isEmptyImageNode = isImageNode && !sourceNode?.metadata?.content;
                    const sourceReference =
                        isImageNode && sourceNode?.metadata?.content
                            ? [
                                  {
                                      id: sourceNode.id,
                                      name: `${sourceNode.title || sourceNode.id}.png`,
                                      type: sourceNode.metadata.mimeType || "image/png",
                                      dataUrl: sourceNode.metadata.content,
                                      storageKey: sourceNode.metadata.storageKey,
                                      localPath: sourceNode.metadata.localPath,
                                  },
                              ]
                            : [];
                    const referenceImages = mergeReferenceImages(sourceReference.length ? sourceReference : generationContext.referenceImages, resolvePromptAssetReferences(effectivePrompt));
                    const generationType = referenceImages.length ? ("edit" as const) : ("generation" as const);
                    const generationMetadata = buildImageGenerationMetadata(generationType, generationConfig, count, referenceImages);
                    const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : isImageNode ? CanvasNodeType.Image : CanvasNodeType.Text];
                    const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                    const parentPosition = sourceNode?.position || { x: 0, y: 0 };
                    const gap = 96;
                    const rowGap = 36;
                    const rootId = isEmptyImageNode ? nodeId : nanoid();
                    const childIds = count > 1 ? Array.from({ length: count }, () => nanoid()) : [];
                    const targetIds = count > 1 ? childIds : [rootId];
                    pendingChildIds = isEmptyImageNode ? childIds : [rootId, ...childIds];
                    const rootNode: CanvasNodeData = {
                        id: rootId,
                        type: CanvasNodeType.Image,
                        title: effectivePrompt.slice(0, 32) || "Generated Image",
                        position: {
                            x: isEmptyImageNode ? parentPosition.x : parentPosition.x + parentConfig.width + gap,
                            y: parentPosition.y + parentConfig.height / 2 - imageConfig.height / 2,
                        },
                        width: isEmptyImageNode ? sourceNode?.width || imageConfig.width : imageConfig.width,
                        height: isEmptyImageNode ? sourceNode?.height || imageConfig.height : imageConfig.height,
                        metadata: {
                            prompt: effectivePrompt,
                            status: NODE_STATUS_LOADING,
                            isBatchRoot: count > 1,
                            batchChildIds: count > 1 ? childIds : undefined,
                            batchUsesReferenceImages: referenceImages.length > 0,
                            ...generationMetadata,
                            imageBatchExpanded: count > 1 ? true : undefined,
                        },
                    };
                    const childNodes: CanvasNodeData[] = childIds.map((id, index) => ({
                        id,
                        type: CanvasNodeType.Image,
                        title: effectivePrompt.slice(0, 32) || "Generated Image",
                        position: {
                            x: rootNode.position.x + rootNode.width + 120 + (index % 2) * (imageConfig.width + 36),
                            y: rootNode.position.y + Math.floor(index / 2) * (imageConfig.height + rowGap),
                        },
                        width: imageConfig.width,
                        height: imageConfig.height,
                        metadata: { prompt: effectivePrompt, status: NODE_STATUS_LOADING, batchRootId: count > 1 ? rootId : undefined, ...generationMetadata },
                    }));
                    const batchConnections = [...(isEmptyImageNode ? [] : [{ id: nanoid(), fromNodeId: nodeId, toNodeId: rootId }]), ...childIds.map((childId) => ({ id: nanoid(), fromNodeId: rootId, toNodeId: childId }))];

                    setNodes((prev) => [
                        ...prev.map((node) =>
                            node.id === nodeId
                                ? isConfigNode
                                    ? {
                                          ...node,
                                          metadata: { ...node.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined },
                                      }
                                    : isEmptyImageNode
                                      ? {
                                            ...node,
                                            position: rootNode.position,
                                            width: rootNode.width,
                                            height: rootNode.height,
                                            title: rootNode.title,
                                            metadata: { ...node.metadata, ...rootNode.metadata, errorDetails: undefined },
                                        }
                                      : isImageNode
                                        ? {
                                              ...node,
                                              metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined },
                                          }
                                        : {
                                              ...node,
                                              type: CanvasNodeType.Text,
                                              title: prompt.slice(0, 32) || "Prompt",
                                              width: parentConfig.width,
                                              height: parentConfig.height,
                                              metadata: { ...node.metadata, content: prompt, prompt, status: NODE_STATUS_SUCCESS, fontSize: 14, errorDetails: undefined },
                                          }
                                : node,
                        ),
                        ...(isEmptyImageNode ? [] : [rootNode]),
                        ...childNodes,
                    ]);
                    setConnections((prev) => [...prev, ...batchConnections]);
                    setSelectedNodeIds(new Set([nodeId]));
                    setSelectedConnectionId(null);
                    setDialogNodeId(nodeId);

                    const controller = runController;
                    targetIds.forEach((targetId) => startGenerationRequest(targetId, nodeId, nodeId, controller));
                    if (count > 1) startGenerationRequest(rootId, nodeId, nodeId, controller);
                    let hasSuccess = false;
                    let hasFailure = false;
                    let firstError = "";
                    await Promise.all(
                        targetIds.map(async (targetId) => {
                            try {
                                const image = referenceImages.length
                                    ? await requestEdit({ ...generationConfig, count: "1" }, effectivePrompt, referenceImages, undefined, { signal: controller.signal }).then((items) => items[0])
                                    : await requestGeneration({ ...generationConfig, count: "1" }, effectivePrompt, { signal: controller.signal }).then((items) => items[0]);
                                const uploaded = await uploadImage(image.dataUrl);
                                const imageSize = fitNodeSize(uploaded.width, uploaded.height, imageConfig.width, imageConfig.height);
                                setNodes((prev) => {
                                    const root = prev.find((node) => node.id === rootId);
                                    return prev.map((node) => {
                                        if (node.id !== targetId && node.id !== rootId) return node;
                                        const center = { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 };
                                        if (node.id === rootId && (targetId === rootId || !root?.metadata?.primaryImageId))
                                            return {
                                                ...node,
                                                position: { x: center.x - imageSize.width / 2, y: center.y - imageSize.height / 2 },
                                                width: imageSize.width,
                                                height: imageSize.height,
                                                metadata: { ...node.metadata, ...imageMetadata(uploaded), primaryImageId: targetId },
                                            };
                                        if (node.id === targetId)
                                            return {
                                                ...node,
                                                position: { x: center.x - imageSize.width / 2, y: center.y - imageSize.height / 2 },
                                                width: imageSize.width,
                                                height: imageSize.height,
                                                metadata: { ...node.metadata, ...imageMetadata(uploaded) },
                                            };
                                        return node;
                                    });
                                });
                                hasSuccess = true;
                                if (isConfigNode) setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : node)));
                                return true;
                            } catch (error) {
                                if (isGenerationCanceled(error)) return false;
                                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                                if (!firstError) firstError = errorDetails;
                                hasFailure = true;
                                setNodes((prev) => prev.map((node) => (node.id === targetId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } } : node)));
                            } finally {
                                finishGenerationRequest(targetId, controller);
                            }
                            return false;
                        }),
                    );
                    if (count > 1) finishGenerationRequest(rootId, controller);
                    if (controller.signal.aborted) {
                        setNodes((prev) => prev.map((node) => (node.id === nodeId && isConfigNode && node.metadata?.status === NODE_STATUS_LOADING ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_IDLE, errorDetails: undefined } } : node)));
                        return;
                    }
                    if (hasFailure) {
                        message.error(hasSuccess ? t("canvas.projectPage.partialFailed") : firstError || t("canvas.projectPage.generationFailed"));
                    }
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === nodeId && isConfigNode
                                ? { ...node, metadata: { ...node.metadata, status: hasSuccess ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: hasSuccess ? undefined : t("canvas.projectPage.generationFailed") } }
                                : node.id === nodeId && isEmptyImageNode
                                  ? { ...node, metadata: { ...node.metadata, status: hasSuccess ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: hasSuccess ? undefined : t("canvas.projectPage.generationFailed") } }
                                  : node.id === rootId && !hasSuccess && !targetIds.includes(node.id)
                                    ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails: t("canvas.projectPage.allFailed") } }
                                    : node,
                        ),
                    );
                    // 返回本次是否至少成功一张：缺图队列靠它判断该节点要不要进失败列表。
                    return hasSuccess;
                }

                if (mode === "video") {
                    const spec = nodeSizeFromRatio(generationConfig.size, NODE_DEFAULT_SIZE[CanvasNodeType.Video].width, NODE_DEFAULT_SIZE[CanvasNodeType.Video].height) || NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                    const isEmptyVideoNode = sourceNode?.type === CanvasNodeType.Video && !sourceNode.metadata?.content;
                    const videoId = isEmptyVideoNode ? nodeId : nanoid();
                    const parent = sourceNode?.position || { x: 0, y: 0 };
                    const videoNode: CanvasNodeData = {
                        id: videoId,
                        type: CanvasNodeType.Video,
                        title: effectivePrompt.slice(0, 32) || "Generated Video",
                        position: isEmptyVideoNode ? sourceNode.position : { x: parent.x + (sourceNode?.width || spec.width) + 96, y: parent.y },
                        width: isEmptyVideoNode ? sourceNode.width : spec.width,
                        height: isEmptyVideoNode ? sourceNode.height : spec.height,
                        metadata: {
                            prompt: effectivePrompt,
                            status: NODE_STATUS_LOADING,
                            model: generationConfig.model,
                            size: generationConfig.size,
                            seconds: generationConfig.videoSeconds,
                            vquality: generationConfig.vquality,
                            generateAudio: generationConfig.videoGenerateAudio,
                            watermark: generationConfig.videoWatermark,
                            references: generationReferenceUrls(generationContext),
                        },
                    };
                    pendingChildIds = [videoId];
                    setNodes((prev) =>
                        isEmptyVideoNode
                            ? prev.map((node) => (node.id === nodeId ? { ...node, ...videoNode } : node))
                            : [...prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } } : node)), videoNode],
                    );
                    if (!isEmptyVideoNode) setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: nodeId, toNodeId: videoId }]);
                    const controller = startGenerationRequest(videoId, nodeId, nodeId, runController);
                    try {
                        const video = await storeGeneratedVideo(
                            await requestVideoGeneration(generationConfig, effectivePrompt, generationContext.referenceImages, generationContext.referenceVideos, generationContext.referenceAudios, { signal: controller.signal }),
                        );
                        const videoSize = fitNodeSize(video.width || spec.width, video.height || spec.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                        setNodes((prev) =>
                            prev.map((node) =>
                                node.id === videoId
                                    ? {
                                          ...node,
                                          width: videoSize.width,
                                          height: videoSize.height,
                                          position: { x: node.position.x + node.width / 2 - videoSize.width / 2, y: node.position.y + node.height / 2 - videoSize.height / 2 },
                                          metadata: {
                                              ...node.metadata,
                                              ...videoMetadata(video),
                                              prompt: effectivePrompt,
                                              model: generationConfig.model,
                                              size: generationConfig.size,
                                              seconds: generationConfig.videoSeconds,
                                              vquality: generationConfig.vquality,
                                              generateAudio: generationConfig.videoGenerateAudio,
                                              watermark: generationConfig.videoWatermark,
                                              references: generationReferenceUrls(generationContext),
                                          },
                                      }
                                    : node,
                            ),
                        );
                    } finally {
                        finishGenerationRequest(videoId, controller);
                    }
                    return;
                }

                if (mode === "audio") {
                    const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
                    const isEmptyAudioNode = sourceNode?.type === CanvasNodeType.Audio && !sourceNode.metadata?.content;
                    const audioId = isEmptyAudioNode ? nodeId : nanoid();
                    const parent = sourceNode?.position || { x: 0, y: 0 };
                    const audioNode: CanvasNodeData = {
                        id: audioId,
                        type: CanvasNodeType.Audio,
                        title: effectivePrompt.slice(0, 32) || "Generated Audio",
                        position: isEmptyAudioNode ? sourceNode.position : { x: parent.x + (sourceNode?.width || spec.width) + 96, y: parent.y + ((sourceNode?.height || spec.height) - spec.height) / 2 },
                        width: isEmptyAudioNode ? sourceNode.width : spec.width,
                        height: isEmptyAudioNode ? sourceNode.height : spec.height,
                        metadata: { prompt: effectivePrompt, status: NODE_STATUS_LOADING, ...buildAudioGenerationMetadata(generationConfig) },
                    };
                    pendingChildIds = [audioId];
                    setNodes((prev) =>
                        isEmptyAudioNode
                            ? prev.map((node) => (node.id === nodeId ? { ...node, ...audioNode } : node))
                            : [...prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } } : node)), audioNode],
                    );
                    if (!isEmptyAudioNode) setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: nodeId, toNodeId: audioId }]);
                    const controller = startGenerationRequest(audioId, nodeId, nodeId, runController);
                    try {
                        const audio = await storeGeneratedAudio(await requestAudioGeneration(generationConfig, effectivePrompt, { signal: controller.signal }), generationConfig.audioFormat);
                        setNodes((prev) => prev.map((node) => (node.id === audioId ? { ...node, metadata: { ...node.metadata, ...audioMetadata(audio), prompt: effectivePrompt, ...buildAudioGenerationMetadata(generationConfig) } } : node)));
                    } finally {
                        finishGenerationRequest(audioId, controller);
                    }
                    return;
                }

                let streamed = "";
                const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
                const textCount = isConfigNode ? getGenerationCount(generationConfig.count) : 1;
                const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : CanvasNodeType.Text];
                const textConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
                const parentPosition = sourceNode?.position || { x: 0, y: 0 };
                const childIds = isConfigNode || editingTextNode ? Array.from({ length: textCount }, () => nanoid()) : [];
                pendingChildIds = childIds;
                if (isConfigNode || editingTextNode) {
                    const childNodes: CanvasNodeData[] = childIds.map((id, index) => ({
                        id,
                        type: CanvasNodeType.Text,
                        title: effectivePrompt.slice(0, 32) || "Generated Text",
                        position: {
                            x: parentPosition.x + parentConfig.width + 96,
                            y: parentPosition.y + parentConfig.height / 2 - textConfig.height / 2 + (index - (textCount - 1) / 2) * (textConfig.height + 36),
                        },
                        width: textConfig.width,
                        height: textConfig.height,
                        metadata: { prompt: effectivePrompt, status: NODE_STATUS_LOADING, fontSize: 14, model: generationConfig.model, reasoningEffort: generationConfig.reasoningEffort },
                    }));
                    setNodes((prev) => [...prev.map((node) => (node.id === nodeId && isConfigNode ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)), ...childNodes]);
                    setConnections((prev) => [...prev, ...childIds.map((childId) => ({ id: nanoid(), fromNodeId: nodeId, toNodeId: childId }))]);
                }

                const controller = runController;
                const textTargetIds = childIds.length ? childIds : [nodeId];
                textTargetIds.forEach((targetNodeId) => startGenerationRequest(targetNodeId, nodeId, nodeId, controller));
                const answers = await Promise.all(
                    textTargetIds.map((targetNodeId) => {
                        let localStreamed = "";
                        return requestImageQuestion(
                            generationConfig,
                            buildNodeResponseMessages({ ...generationContext, prompt: effectivePrompt }),
                            (text) => {
                                localStreamed = text;
                                streamed = text;
                                if (isConfigNode) return;
                                setNodes((prev) => prev.map((node) => (node.id === targetNodeId ? { ...node, type: CanvasNodeType.Text, metadata: { ...node.metadata, content: text, status: NODE_STATUS_LOADING } } : node)));
                            },
                            { signal: controller.signal },
                        )
                            .then((answer) => ({ nodeId: targetNodeId, content: answer || localStreamed }))
                            .finally(() => finishGenerationRequest(targetNodeId, controller));
                    }),
                );
                if (controller.signal.aborted) return;
                const answerByNodeId = new Map(answers.map((item) => [item.nodeId, item.content]));
                setNodes((prev) =>
                    prev.map((node) =>
                        childIds.includes(node.id)
                            ? { ...node, metadata: { ...node.metadata, content: answerByNodeId.get(node.id) || streamed, status: NODE_STATUS_SUCCESS } }
                            : node.id === nodeId && isConfigNode
                              ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } }
                              : node.id === nodeId && !editingTextNode
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Text,
                                      title: prompt.slice(0, 32) || "Generated Text",
                                      metadata: { ...node.metadata, content: answerByNodeId.get(node.id) || streamed, model: generationConfig.model, reasoningEffort: generationConfig.reasoningEffort, status: NODE_STATUS_SUCCESS },
                                  }
                                : node,
                    ),
                );
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                message.error(errorDetails);
                setNodes((prev) =>
                    prev.map((node) => (node.id === nodeId || pendingChildIds.includes(node.id) ? (node.id === nodeId && !markSourceStatus ? node : { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } }) : node)),
                );
            } finally {
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, message, openConfigDialog, startGenerationRequest, t],
    );
    useEffect(() => {
        generateNodeRef.current = handleGenerateNode;
    }, [handleGenerateNode]);

    const handleRetryNode = useCallback(
        async (node: CanvasNodeData) => {
            if (node.type === CanvasNodeType.Composite) {
                await handleRunComposite(node);
                return;
            }
            // ComfyUI 工作流节点：重试就是重跑该工作流，不能落到生成参数面板逻辑上。
            if (node.metadata?.comfyuiLocal) {
                const target = nodesRef.current.find((item) => item.id === node.id) || node;
                const workflowId = (target.metadata?.comfyuiLocal as { workflowId?: string } | undefined)?.workflowId;
                if (!workflowId || !(await getComfyWorkflowDefinition(workflowId))) {
                    message.error("这个节点引用的工作流已不存在，请在「ComfyUI 本地」页重新导入，或用「参数」里的「更换工作流」另选一个。");
                    return;
                }
                void runComfyWorkflowNode(buildNodeContext(pluginHost, target, theme, viewport.k, true));
                return;
            }
            const sourceNode = findRetrySourceNode(node.id, nodesRef.current, connectionsRef.current) || node;
            const nativeRetryNode = isNativeGenerationNode(node) ? node : isNativeGenerationNode(sourceNode) ? sourceNode : null;
            const genericNode = nativeRetryNode && (nativeRetryNode.metadata?.providerTask?.provider === "generic" || nativeRetryNode.metadata?.genericOperation) ? nativeRetryNode : null;
            if (genericNode) {
                if (hasUnresolvedGenericTask(genericNode)) {
                    await handleResumeGeneric(genericNode);
                    return;
                }
                const payload = parseGenericNativePayload(genericNode.metadata?.genericPayload);
                if (!payload) {
                    setDialogNodeId(genericNode.id);
                    message.warning("请先在节点面板中确认生成参数。");
                    return;
                }
                // 落盘的 payload 里提示词是 `@素材名` 原文，重试时要和面板一样换成参考图占位符；
                // 渠道模型不走占位符（参考图在 handleChannelModelRun 里直接拼），所以不改写。
                const retryOperationId = genericNode.metadata?.genericOperation || "video.generate";
                const retryChannelModel = isChannelModelValue(typeof payload.model === "string" ? payload.model : "");
                const retryMentions = retryChannelModel ? [] : resolvePromptAssetReferences(readGenericNativePrompt(retryOperationId, payload));
                const retryAssets = prepareGenericNativePromptAssets(retryOperationId, payload, countGenericNativeReferences(buildGenericReferences(genericNode.id)), retryMentions);
                await handleRunGeneric(genericNode, retryAssets?.payload || payload, retryAssets?.references.length ? { references: retryAssets.references, persistPayload: payload } : undefined);
                return;
            }
            if (nativeRetryNode) {
                const operationId = nativeRetryNode.type === CanvasNodeType.Video ? "video.generate" : nativeRetryNode.type === CanvasNodeType.Audio ? "audio.generate" : nativeRetryNode.type === CanvasNodeType.Text ? "text.chat" : "image.generate";
                const payload = createGenericNativePayload(operationId);
                const prompt = nativeRetryNode.metadata?.prompt || nativeRetryNode.metadata?.content || "";
                if (prompt.trim()) writeGenericNativePrompt(operationId, payload, prompt);
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === nativeRetryNode.id
                            ? {
                                  ...item,
                                  metadata: {
                                      ...item.metadata,
                                      genericOperation: operationId,
                                      genericPayload: JSON.stringify(payload, null, 2),
                                      status: NODE_STATUS_IDLE,
                                      errorDetails: undefined,
                                  },
                              }
                            : item,
                    ),
                );
                setDialogNodeId(nativeRetryNode.id);
                message.info("该旧节点已切换到新的原生生成面板，请确认模型和参数后再提交。");
                return;
            }
            const batchRoot = node.metadata?.batchRootId ? nodesRef.current.find((item) => item.id === node.metadata?.batchRootId) : null;
            const savedImageMetadata = node.type === CanvasNodeType.Image ? { ...batchRoot?.metadata, ...node.metadata } : undefined;
            const hasSavedImageMetadata = Boolean(savedImageMetadata?.generationType);
            const generationConfig =
                hasSavedImageMetadata && savedImageMetadata
                    ? {
                          ...effectiveConfig,
                          model: savedImageMetadata.model || effectiveConfig.imageModel || effectiveConfig.model,
                          quality: savedImageMetadata.quality || effectiveConfig.quality,
                          size: savedImageMetadata.size || effectiveConfig.size,
                          background: savedImageMetadata.background ?? effectiveConfig.background,
                          count: "1",
                      }
                    : { ...buildGenerationConfig(effectiveConfig, sourceNode, node.type === CanvasNodeType.Text ? "text" : node.type === CanvasNodeType.Video ? "video" : node.type === CanvasNodeType.Audio ? "audio" : "image"), count: "1" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }

            const context = hasSavedImageMetadata ? null : await hydrateNodeGenerationContext(buildNodeGenerationContext(sourceNode.id, nodesRef.current, connectionsRef.current, sourceNode.metadata?.prompt || node.metadata?.prompt || ""));
            const prompt = (savedImageMetadata?.prompt || context?.prompt || "").trim();
            if (!prompt) {
                message.warning(t("canvas.projectPage.retryPromptMissing"));
                return;
            }
            const generationType = savedImageMetadata?.generationType;
            const useReferenceImages = generationType ? generationType === "edit" : Boolean(context?.referenceImages.length);
            const retryReferenceImages =
                hasSavedImageMetadata && savedImageMetadata ? await resolveMetadataReferences(savedImageMetadata) : useReferenceImages ? (context?.referenceImages.length ? context.referenceImages : sourceNodeReferenceImages(batchRoot || sourceNode)) : [];
            if (useReferenceImages && !retryReferenceImages) {
                message.error(t("canvas.projectPage.referenceMissing"));
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails: t("canvas.projectPage.referenceMissing") } } : item)));
                return;
            }
            const retryImages = retryReferenceImages || [];

            setRunningNodeId(node.id);
            setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined } } : item)));
            const controller = startGenerationRequest(node.id, sourceNode.id, node.id);

            try {
                if (node.type === CanvasNodeType.Text) {
                    if (!context) return;
                    let streamed = "";
                    const answer = await requestImageQuestion(
                        generationConfig,
                        buildNodeResponseMessages({ ...context, prompt }),
                        (text) => {
                            streamed = text;
                            setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, type: CanvasNodeType.Text, metadata: { ...item.metadata, content: text, status: NODE_STATUS_LOADING } } : item)));
                        },
                        { signal: controller.signal },
                    );
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, type: CanvasNodeType.Text, metadata: { ...item.metadata, content: answer || streamed, prompt, status: NODE_STATUS_SUCCESS } } : item)));
                    return;
                }
                if (node.type === CanvasNodeType.Video) {
                    const video = await storeGeneratedVideo(await requestVideoGeneration(generationConfig, prompt, retryImages, context?.referenceVideos || [], context?.referenceAudios || [], { signal: controller.signal }));
                    const videoSize = fitNodeSize(video.width || node.width, video.height || node.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                    setNodes((prev) =>
                        prev.map((item) =>
                            item.id === node.id
                                ? {
                                      ...item,
                                      width: videoSize.width,
                                      height: videoSize.height,
                                      position: { x: item.position.x + item.width / 2 - videoSize.width / 2, y: item.position.y + item.height / 2 - videoSize.height / 2 },
                                      metadata: {
                                          ...item.metadata,
                                          ...videoMetadata(video),
                                          prompt,
                                          model: generationConfig.model,
                                          size: generationConfig.size,
                                          seconds: generationConfig.videoSeconds,
                                          vquality: generationConfig.vquality,
                                          generateAudio: generationConfig.videoGenerateAudio,
                                          watermark: generationConfig.videoWatermark,
                                      },
                                  }
                                : item,
                        ),
                    );
                    return;
                }
                if (node.type === CanvasNodeType.Audio) {
                    const audio = await storeGeneratedAudio(await requestAudioGeneration(generationConfig, prompt, { signal: controller.signal }), generationConfig.audioFormat);
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, ...audioMetadata(audio), prompt, ...buildAudioGenerationMetadata(generationConfig) } } : item)));
                    return;
                }

                const image = useReferenceImages
                    ? await requestEdit(generationConfig, prompt, retryImages, undefined, { signal: controller.signal }).then((items) => items[0])
                    : await requestGeneration(generationConfig, prompt, { signal: controller.signal }).then((items) => items[0]);
                const uploadedImage = await uploadImage(image.dataUrl);
                // 这次生成如果来自风格馆的选择，就把这张图存成那个风格的封面。
                // 动态引入：封面只是附带效果，不该让主流程多背一份依赖。
                void import("@/services/api/style-covers").then((module) => module.captureStyleCover(image.dataUrl));
                const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                const imageSize = fitNodeSize(uploadedImage.width, uploadedImage.height, imageConfig.width, imageConfig.height);
                const generationMetadata = savedImageMetadata?.generationType
                    ? {
                          generationType: savedImageMetadata.generationType,
                          model: generationConfig.model,
                          size: generationConfig.size,
                          quality: generationConfig.quality,
                          ...(generationConfig.background ? { background: generationConfig.background } : {}),
                          count: savedImageMetadata.count || 1,
                          references: savedImageMetadata.references,
                      }
                    : buildImageGenerationMetadata(useReferenceImages ? "edit" : "generation", generationConfig, 1, retryImages);
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === node.id
                            ? {
                                  ...item,
                                  type: CanvasNodeType.Image,
                                  width: imageSize.width,
                                  height: imageSize.height,
                                  metadata: {
                                      ...item.metadata,
                                      ...imageMetadata(uploadedImage),
                                      prompt,
                                      ...generationMetadata,
                                      // 重新生成会直接覆盖节点上的原图：先把上一版并进图片历史，
                                      // 用户可以在节点右上角的版本列表里切回去。
                                      ...mergeGeneratedImageOutputsHistory(
                                          item.metadata,
                                          [{ kind: "image", url: uploadedImage.url, sourceUrl: uploadedImage.url, storageKey: uploadedImage.storageKey, mimeType: uploadedImage.mimeType, bytes: uploadedImage.bytes, width: uploadedImage.width, height: uploadedImage.height }],
                                          item.metadata?.providerTask || { provider: "generic" as const },
                                      ),
                                  },
                              }
                            : item,
                    ),
                );
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                message.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                finishGenerationRequest(node.id, controller);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, handleResumeGeneric, handleRunComposite, handleRunGeneric, isAiConfigReady, message, openConfigDialog, pluginHost, startGenerationRequest, t, theme, viewport.k],
    );

    const generateImageFromTextNode = useCallback(
        (node: CanvasNodeData) => {
            const prompt = (node.metadata?.content || node.metadata?.prompt || "").trim();
            if (!prompt) {
                message.warning(t("canvas.projectPage.emptyTextImage"));
                return;
            }
            const sourceNode = nodesRef.current.find((item) => item.id === node.id);
            if (!sourceNode) return;
            const nodeSize = getNodeSpec(CanvasNodeType.Image);
            const imageNode = createCanvasNode(CanvasNodeType.Image, {
                x: sourceNode.position.x + sourceNode.width + 96 + nodeSize.width / 2,
                y: sourceNode.position.y + sourceNode.height / 2,
            });
            const connection = { id: nanoid(), fromNodeId: sourceNode.id, toNodeId: imageNode.id };
            const nextNodes = nodesRef.current.map((item) => (item.id === sourceNode.id ? { ...item, metadata: { ...item.metadata, content: prompt, prompt, status: NODE_STATUS_SUCCESS } } : item)).concat(imageNode);
            const nextConnections = [...connectionsRef.current, connection];
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            setNodes(nextNodes);
            setConnections(nextConnections);
            setSelectedNodeIds(new Set([imageNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(imageNode.id);
        },
        [message, t],
    );

    const insertAssistantImage = useCallback(
        async (image: CanvasAssistantImage) => {
            const storedImage = image.storageKey ? { url: image.dataUrl, storageKey: image.storageKey, width: 1, height: 1, bytes: 0, mimeType: "image/png" } : await uploadImage(image.dataUrl);
            const meta = storedImage.width === 1 && storedImage.height === 1 ? await readImageMeta(storedImage.url) : storedImage;
            const config = fitNodeSize(meta.width, meta.height);
            const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const node: CanvasNodeData = {
                id,
                type: CanvasNodeType.Image,
                title: image.prompt.slice(0, 32) || "Generated Image",
                position: { x: center.x - config.width / 2, y: center.y - config.height / 2 },
                width: config.width,
                height: config.height,
                metadata: { ...imageMetadata({ ...storedImage, width: meta.width, height: meta.height }), prompt: image.prompt },
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([id]));
            setSelectedConnectionId(null);
            setDialogNodeId(id);
        },
        [screenToCanvas, size.height, size.width],
    );

    const insertAssistantText = useCallback(
        (text: string, title?: string) => {
            const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            const node = {
                ...createCanvasNode(CanvasNodeType.Text, center, { content: text, status: NODE_STATUS_SUCCESS }),
                title: title || text.slice(0, 32) || "Assistant Text",
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
        },
        [screenToCanvas, size.height, size.width],
    );

    const handleAssetInsert = useCallback(
        (payload: InsertAssetPayload) => {
            if (payload.kind === "text") {
                insertAssistantText(payload.content, payload.title);
            } else if (payload.kind === "video") {
                const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
                const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                const nextSize = fitNodeSize(payload.width || spec.width, payload.height || spec.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                setNodes((prev) => [
                    ...prev,
                    {
                        id,
                        type: CanvasNodeType.Video,
                        title: payload.title,
                        position: { x: center.x - nextSize.width / 2, y: center.y - nextSize.height / 2 },
                        width: nextSize.width,
                        height: nextSize.height,
                        metadata: { content: payload.url, storageKey: payload.storageKey, status: NODE_STATUS_SUCCESS, naturalWidth: payload.width, naturalHeight: payload.height },
                    },
                ]);
                setSelectedNodeIds(new Set([id]));
            } else {
                insertAssistantImage({ id: `asset-${Date.now()}`, prompt: payload.title, dataUrl: payload.dataUrl, storageKey: payload.storageKey });
            }
            setAssetPickerOpen(false);
        },
        [insertAssistantImage, insertAssistantText, screenToCanvas, size.height, size.width],
    );

    // Memoize every callback and render function passed to CanvasNode.
    // CanvasNode uses React.memo, but new prop references would invalidate it on every render and rerender every node
    // during click, hover, or viewport changes, which is especially expensive for Markdown. These useCallback values
    // and their memoized map/handler dependencies remain stable during interaction, so unchanged nodes do not rerender.
    const handleNodeHoverStart = useCallback((nodeId: string) => {
        if (nodeDraggingRef.current) return;
        setHoveredNodeId(nodeId);
    }, []);
    const handleNodeHoverEnd = useCallback((nodeId: string) => {
        setHoveredNodeId((current) => (current === nodeId ? null : current));
    }, []);
    const handleNodeViewImage = useCallback((node: CanvasNodeData) => setPreviewNodeId(node.id), []);
    const handleNodeRetry = useCallback((node: CanvasNodeData) => void handleRetryNode(node), [handleRetryNode]);
    const handleNodeContextMenu = useCallback((event: ReactMouseEvent, nodeId: string) => {
        event.preventDefault();
        event.stopPropagation();
        setContextMenu({ type: "node", x: event.clientX, y: event.clientY, nodeId });
    }, []);

    const renderNodePanel = useCallback(
        (panelNode: CanvasNodeData) => {
            const definition = getNodeDefinition(panelNode.type);
            if (definition?.Panel) return renderPluginPanel(panelNode);
            if (panelNode.type === CanvasNodeType.Composite) {
                const { segments, music, voice } = collectCompositeSources(panelNode.id);
                return (
                    <CanvasCompositePanel
                        node={panelNode}
                        segments={segments}
                        music={music}
                        voice={voice}
                        isRunning={runningGenericNodeIds.has(panelNode.id)}
                        onChange={handleConfigNodeChange}
                        onRun={(compositeNode) => void handleRunComposite(compositeNode)}
                        onReorderConnections={reorderReferenceConnections}
                        onRemoveConnection={deleteConnection}
                        onFocusReference={focusNode}
                    />
                );
            }
            // 文本节点是「内容载体」：直接编辑文字并连线给下游当提示词，
            // 需要模型改写时用节点上的「编辑文字」，因此不提供模型选择与生成按钮。
            if (panelNode.type === CanvasNodeType.Text) {
                return <TextNodePanel node={panelNode} theme={theme} onChange={handleConfigNodeChange} />;
            }            const nativeKind = genericNativeNodeKind(panelNode.type);
            if (nativeKind) {
                const hasSubmittedTask = Boolean(panelNode.metadata?.providerTask?.taskId || panelNode.metadata?.providerTask?.taskIds?.length);
                return (
                    <GenericNativeGenerationPanel
                        node={panelNode}
                        kind={nativeKind}
                        referenceCounts={countGenericNativeReferences(buildGenericReferences(panelNode.id))}
                        mentionReferences={mentionReferencesByNodeId.get(panelNode.id) || EMPTY_REFERENCES}
                        canvasNodes={nodes}
                        objectMode={inputMode === "objects"}
                        isRunning={runningGenericNodeIds.has(panelNode.id)}
                        isPolling={hasSubmittedTask && runningGenericNodeIds.has(panelNode.id)}
                        onChange={handleConfigNodeChange}
                        onRun={(nativeNode, _operationId, payload, options) => handleRunGeneric(nativeNode, payload, options)}
                        onStartPolling={handleResumeGeneric}
                        onStopPolling={confirmStopGenericPolling}
                        onFocusReference={focusNode}
                        onDisconnectReference={deleteConnection}
                        onReorderReferences={reorderReferenceConnections}
                        onRemoveReference={(reference) => removeResourceReference(panelNode.id, reference)}
                        onReorderReference={(source, target) => reorderResourceReference(panelNode.id, source, target)}
                        onAddObjectReference={(sourceNodeId) => addObjectReference(panelNode.id, sourceNodeId)}
                        onRemoveObjectReference={(referenceId) => removeObjectReference(panelNode.id, referenceId)}
                        onAddReference={() => createReferenceMaterialForNode(panelNode)}
                    />
                );
            }
            if (panelNode.type === CanvasNodeType.Config) {
                return (
                    <CanvasConfigComposer
                        value={panelNode.metadata?.composerContent ?? panelNode.metadata?.prompt ?? ""}
                        inputs={configInputsById.get(panelNode.id) || []}
                        onChange={(composerContent) => handleConfigNodeChange(panelNode.id, { composerContent })}
                        onClose={() => setDialogNodeId(null)}
                    />
                );
            }
            return (
                <CanvasNodePromptPanel
                    node={panelNode}
                    isRunning={runningNodeId === panelNode.id}
                    mentionReferences={mentionReferencesByNodeId.get(panelNode.id) || EMPTY_REFERENCES}
                    canvasNodes={nodes}
                    objectMode={inputMode === "objects"}
                    onFocusReference={focusNode}
                    onReorderReferences={reorderReferenceConnections}
                    onRemoveReference={(reference) => removeResourceReference(panelNode.id, reference)}
                    onReorderReference={(source, target) => reorderResourceReference(panelNode.id, source, target)}
                    onAddObjectReference={(sourceNodeId) => addObjectReference(panelNode.id, sourceNodeId)}
                    onRemoveObjectReference={(referenceId) => removeObjectReference(panelNode.id, referenceId)}
                    onPromptChange={handleNodePromptChange}
                    onConfigChange={handleConfigNodeChange}
                    onGenerate={handleGenerateNode}
                    onStop={confirmStopGeneration}
                    modeOverride={definition?.useBuiltinPanel?.mode}
                    onImageSettingsOpenChange={(open) => {
                        setNodeImageSettingsOpen(open);
                        if (open) setToolbarNodeId(null);
                    }}
                />
            );
        },
        [
            configInputsById,
            connections,
            addObjectReference,
            buildGenericReferences,
            collectCompositeSources,
            confirmStopGenericPolling,
            confirmStopGeneration,
            createReferenceMaterialForNode,
            deleteConnection,
            inputMode,
            nodes,
            removeObjectReference,
            removeResourceReference,
            reorderReferenceConnections,
            reorderResourceReference,
            handleConfigNodeChange,
            handleGenerateNode,
            handleNodePromptChange,
            handleResumeGeneric,
            handleRunComposite,
            handleRunGeneric,
            focusNode,
            mentionReferencesByNodeId,
            renderPluginPanel,
            runningGenericNodeIds,
            runningNodeId,
        ],
    );

    const renderNodeContentPanel = useCallback(
        (contentNode: CanvasNodeData) =>
            contentNode.type === CanvasNodeType.Compare ? (
                <CanvasCompareNodeContent node={contentNode} sources={collectCompareSources(contentNode.id)} />
            ) : contentNode.type === CanvasNodeType.Collage ? (
                <CanvasCollageNodeContent node={contentNode} sources={collectCollageSources(contentNode.id)} onOpen={() => setCollageNodeId(contentNode.id)} />
            ) : (
                <CanvasConfigNodePanel
                    node={contentNode}
                    isRunning={runningNodeId === contentNode.id}
                    inputSummary={getInputSummary(configInputsById.get(contentNode.id) || [])}
                    onConfigChange={handleConfigNodeChange}
                    onComposerToggle={() => setDialogNodeId((current) => (current === contentNode.id ? null : contentNode.id))}
                    onStop={confirmStopGeneration}
                    onGenerate={(nodeId) => {
                        const target = nodesRef.current.find((item) => item.id === nodeId);
                        void handleGenerateNode(nodeId, target?.metadata?.generationMode || "image", target?.metadata?.composerContent ?? target?.metadata?.prompt ?? "");
                    }}
                />
            ),
        [collectCollageSources, collectCompareSources, configInputsById, confirmStopGeneration, handleConfigNodeChange, handleGenerateNode, runningNodeId],
    );

    // 编辑器关掉或保存时把图层布局写回节点，这样再次双击能带着原布局继续编辑。
    const commitCollageLayout = useCallback(
        (layout: CollageLayout, order: string[]) => {
            if (!collageNodeId) return;
            setNodes((prev) => prev.map((item) => (item.id === collageNodeId ? { ...item, metadata: { ...item.metadata, collageLayout: layout, collageOrder: order } } : item)));
        },
        [collageNodeId],
    );

    const saveCollage = useCallback(
        async (dataUrl: string, layout: CollageLayout, order: string[]) => {
            const target = nodesRef.current.find((item) => item.id === collageNodeId);
            if (!target) return;
            setCollageSaving(true);
            try {
                const stored = await uploadImage(dataUrl);
                const meta = stored.width === 1 && stored.height === 1 ? await readImageMeta(stored.url) : stored;
                const config = fitNodeSize(meta.width, meta.height);
                const node: CanvasNodeData = {
                    id: `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                    type: CanvasNodeType.Image,
                    title: t("canvas.collage.resultTitle"),
                    position: { x: target.position.x + target.width + 96, y: target.position.y + Math.max(0, (target.height - config.height) / 2) },
                    width: config.width,
                    height: config.height,
                    metadata: imageMetadata({ ...stored, width: meta.width, height: meta.height }),
                };
                const connection = { id: nanoid(), fromNodeId: target.id, fromPortId: COLLAGE_RESULT_PORT_ID, toNodeId: node.id };
                setNodes((prev) => [...prev.map((item) => (item.id === target.id ? { ...item, metadata: { ...item.metadata, collageLayout: layout, collageOrder: order } } : item)), node]);
                setConnections((prev) => [...prev, connection]);
                setSelectedNodeIds(new Set([node.id]));
                setSelectedConnectionId(null);
                setCollageNodeId(null);
                message.success(t("canvas.collage.saved"));
            } catch {
                message.error(t("canvas.collage.saveFailed"));
            } finally {
                setCollageSaving(false);
            }
        },
        [collageNodeId, message, t],
    );

    if (!projectLoaded) return <CanvasRefreshShell />;

    return (
        <main className="mg-glass relative flex h-full min-h-0 overflow-hidden" style={{ background: theme.canvas.background, color: theme.node.text }}>
            <CanvasSidePanel nodes={nodes} selectedNodeIds={selectedNodeIds} onFocusNode={focusNode} onPreviewNode={setPreviewNodeId} onInsertAsset={handleAssetInsert} />
            <section className="relative min-w-0 flex-1 overflow-hidden">
                <CanvasTopBar
                    title={currentProject?.title || t("canvas.projectPage.untitledCanvas")}
                    titleDraft={titleDraft}
                    isTitleEditing={titleEditing}
                    onTitleDraftChange={setTitleDraft}
                    onStartTitleEditing={startTitleEditing}
                    onFinishTitleEditing={finishTitleEditing}
                    onCancelTitleEditing={() => setTitleEditing(false)}
                    canUndo={historyState.canUndo}
                    canRedo={historyState.canRedo}
                    onHome={() => navigate("/")}
                    onProjects={() => navigate("/canvas")}
                    onCreateProject={createAndOpenProject}
                    onDeleteProject={deleteCurrentProject}
                    onImportImage={() => handleUploadRequest()}
                    onExportMedia={() => void exportCanvasMedia()}
                    onExportWatermarked={() => void exportWatermarkedMedia()}
                    onUndo={undoCanvas}
                    onRedo={redoCanvas}
                    agentOpen={agentPanelOpen}
                    compactAgentStatus={{ connected: localAgentConnected, enabled: localAgentEnabled, activity: localAgentActivity }}
                    onToggleAgent={toggleAgentPanel}
                    queueControl={
                        <CanvasMissingImageQueueButton
                            missingCount={missingQueue.missingCount}
                            total={missingQueue.total}
                            done={missingQueue.done}
                            failedCount={missingQueue.failedCount}
                            running={missingQueue.running}
                            skipped={missingQueue.modelSkipped}
                            onRun={missingQueue.runMissing}
                            onStop={missingQueue.stop}
                            onRetryFailed={missingQueue.retryFailed}
                        />
                    }
                />

                <MGCanvasSurface
                    containerRef={containerRef}
                    viewport={viewport}
                    backgroundMode={backgroundMode}
                    onViewportChange={(next) => {
                        setViewport(next);
                        setContextMenu(null);
                    }}
                    onCanvasMouseDown={handleCanvasMouseDown}
                    onCanvasDeselect={deselectCanvas}
                    onCanvasDoubleClick={(event) => {
                        setContextMenu(null);
                        setNodeCreatePosition({
                            world: screenToCanvas(event.clientX, event.clientY),
                            screen: { x: event.clientX, y: event.clientY },
                        });
                    }}
                    onContextMenu={preventCanvasContextMenu}
                    onDrop={handleDrop}
                >
                    <svg className="absolute left-0 top-0 h-[10000px] w-[10000px] overflow-visible" style={{ pointerEvents: "none", transform: "translateZ(0)", zIndex: 0 }}>
                        {inputMode === "connections" && connectionsVisible
                            ? connections
                                  .filter((connection) => {
                                      const from = nodeById.get(connection.fromNodeId);
                                      const to = nodeById.get(connection.toNodeId);
                                      return Boolean(from && to && !isHiddenBatchConnectionEndpoint(from, nodes) && !isHiddenBatchConnectionEndpoint(to, nodes));
                                  })
                                  .map((connection) => {
                                      const from = nodeById.get(connection.fromNodeId);
                                      const to = nodeById.get(connection.toNodeId);
                                      if (!from || !to) return null;

                                      return (
                                          <ConnectionPath
                                              key={connection.id}
                                              connection={connection}
                                              from={from}
                                              to={to}
                                              active={selectedConnectionId === connection.id || relatedHighlight.connectionIds.has(connection.id)}
                                              running={runningConnectionIds.has(connection.id)}
                                              onSelect={() => {
                                                  setSelectedConnectionId(connection.id);
                                                  setSelectedNodeIds(new Set());
                                                  setContextMenu(null);
                                              }}
                                              onContextMenu={(event) => {
                                                  setSelectedConnectionId(connection.id);
                                                  setSelectedNodeIds(new Set());
                                                  setContextMenu({ type: "connection", x: event.clientX, y: event.clientY, connectionId: connection.id });
                                              }}
                                          />
                                      );
                                  })
                            : null}
                        {inputMode === "connections" && connectingParams ? (
                            <ActiveConnectionPath
                                node={nodeById.get(connectingParams.nodeId)}
                                handle={connectingParams}
                                mouseWorld={mouseWorld}
                                target={connectionTargetNodeId ? nodeById.get(connectionTargetNodeId) : undefined}
                                targetHandle={connectionTargetHandle || undefined}
                            />
                        ) : null}
                    </svg>

                    <CanvasAlignmentGuideOverlay guides={alignmentGuides} viewport={viewport} viewportSize={size} />

                    {visibleNodes.map((node) => (
                        <CanvasNode
                            key={node.id}
                            data={node}
                            scale={viewport.k}
                            isSelected={selectedNodeIds.has(node.id)}
                            isRelated={relatedHighlight.nodeIds.has(node.id)}
                            isFocusRelated={activeNodeId === node.id}
                            isConnectionTarget={connectionTargetNodeId === node.id}
                            isConnecting={inputMode === "connections" && Boolean(connectingParams)}
                            connectionsEnabled={inputMode === "connections"}
                            objectMode={inputMode === "objects"}
                            editRequestNonce={editingNodeId === node.id ? editRequestNonce : 0}
                            showPanel={dialogNodeId === node.id && !selectionBox && !getNodeDefinition(node.type)?.hidePanel}
                            batchCount={batchChildCountById.get(node.id) || 0}
                            groupChildCount={groupChildCountById.get(node.id) || 0}
                            isGroupDropTarget={dropTargetGroupId === node.id}
                            batchExpanded={Boolean(node.metadata?.imageBatchExpanded)}
                            batchClosing={Boolean(node.metadata?.batchRootId && collapsingBatchIds.has(node.metadata.batchRootId))}
                            batchOpening={openingBatchIds.has(node.id)}
                            batchRecovering={collapsingBatchIds.has(node.id)}
                            batchMotion={batchMotionById.get(node.id)}
                            showImageInfo={showImageInfo}
                            mentionReferences={mentionReferencesByNodeId.get(node.id) || EMPTY_REFERENCES}
                            pluginHost={pluginHost}
                            registryVersion={nodeRegistryVersion}
                            renderPanel={renderNodePanel}
                            renderNodeContent={renderNodeContentPanel}
                            onMouseDown={handleNodeMouseDown}
                            onSelectCapture={handleNodeSelectCapture}
                            onHoverStart={handleNodeHoverStart}
                            onHoverEnd={handleNodeHoverEnd}
                            onConnectStart={handleConnectStart}
                            onResizeStart={handleNodeResizeStart}
                            onResize={handleNodeResize}
                            onResizeEnd={handleNodeResizeEnd}
                            onContentChange={handleNodeContentChange}
                            onSelectImageHistory={handleSelectImageHistory}
                            onTitleChange={handleNodeTitleChange}
                            onToggleBatch={toggleBatchExpanded}
                            onSetBatchPrimary={setBatchPrimary}
                            onRetry={handleNodeRetry}
                            onShowErrorDetails={(errorNode) => setInfoNodeId(errorNode.id)}
                            onGenerateImage={generateImageFromTextNode}
                            onViewImage={handleNodeViewImage}
                            onUpload={(node) => handleUploadRequest(node.id)}
                            onContextMenu={handleNodeContextMenu}
                        />
                    ))}

                    {selectionBox ? (
                        <div
                            className="pointer-events-none absolute z-[100] border"
                            style={{
                                left: Math.min(selectionBox.startWorldX, selectionBox.currentWorldX),
                                top: Math.min(selectionBox.startWorldY, selectionBox.currentWorldY),
                                width: Math.abs(selectionBox.currentWorldX - selectionBox.startWorldX),
                                height: Math.abs(selectionBox.currentWorldY - selectionBox.startWorldY),
                                borderColor: theme.canvas.selectionStroke,
                                background: theme.canvas.selectionFill,
                            }}
                        />
                    ) : null}
                    {pendingConnectionCreate ? <ConnectionCreateMenu pending={pendingConnectionCreate} onCreate={(type) => createConnectedNode(type, pendingConnectionCreate)} onClose={cancelPendingConnectionCreate} /> : null}
                    {nodeCreatePosition ? (
                        <NodeCreateMenu
                            position={nodeCreatePosition.screen}
                            onCreate={(type) => {
                                createNode(type, nodeCreatePosition.world);
                                setNodeCreatePosition(null);
                            }}
                            onUploadMaterial={() => {
                                createUploadMaterialNode(nodeCreatePosition.world);
                                setNodeCreatePosition(null);
                            }}
                            onClose={() => setNodeCreatePosition(null)}
                        />
                    ) : null}
                </MGCanvasSurface>

                {nodes.length === 0 ? <CanvasEmptyGuide onCreate={(type) => createNode(type)} onUploadMaterial={() => createUploadMaterialNode()} onOpenDirector={() => setDirectorOpen(true)} /> : null}

                <CanvasDirectorDialog
                    open={directorOpen}
                    onClose={() => setDirectorOpen(false)}
                    imageCandidates={directorImageCandidates}
                    audioCandidates={directorAudioCandidates}
                    onUploadMaterial={() => createUploadMaterialNode()}
                    onApply={applyDirectorShots}
                    onShoot={applyDirectorShoot}
                />

                <CanvasNodeHoverToolbar
                    node={isNodeDragging || isNodeResizing || nodeImageSettingsOpen ? null : toolbarNode}
                    viewport={viewport}
                    extraTools={toolbarNode ? buildNodeToolbarItems(toolbarNode) : undefined}
                    onKeep={keepNodeToolbar}
                    onLeave={hideNodeToolbar}
                    onInfo={(node) => setInfoNodeId(node.id)}
                    onEditText={openTextEditor}
                    onDecreaseFont={(node) => handleFontSizeChange(node.id, Math.max(10, (node.metadata?.fontSize || 14) - 2))}
                    onIncreaseFont={(node) => handleFontSizeChange(node.id, Math.min(32, (node.metadata?.fontSize || 14) + 2))}
                    onToggleDialog={(node) => setDialogNodeId((current) => (current === node.id ? null : node.id))}
                    onGenerateImage={generateImageFromTextNode}
                    onUpload={(node) => handleUploadRequest(node.id)}
                    onMergeAudio={(node) => setAudioMergeNodeId(node.id)}
                    onDownload={downloadNodeImage}
                    onSaveAsset={(node) => void saveNodeAsset(node)}
                    onSendToEditor={sendNodeToEditor}
                    onCrop={(node) => setCropNodeId(node.id)}
                    onSplit={(node) => setSplitNodeId(node.id)}
                    onUpscale={(node) => setUpscaleNodeId(node.id)}
                    onAngle={(node) => setAngleNodeId(node.id)}
                    onViewImage={(node) => setPreviewNodeId(node.id)}
                    onReversePrompt={createImageReversePromptNodes}
                    onRetry={(node) => void handleRetryNode(node)}
                    onToggleFreeResize={(node) => toggleNodeFreeResize(node.id)}
                    canvasSetAvailable={inputMode === "objects"}
                    onToggleCanvasSet={toggleCanvasSet}
                    onDelete={(node) => deleteNodes(new Set([node.id]))}
                />

                <CanvasToolbar
                    selectedCount={selectedNodeIds.size}
                    canUndo={historyState.canUndo}
                    canRedo={historyState.canRedo}
                    backgroundMode={backgroundMode}
                    showImageInfo={showImageInfo}
                    inputMode={inputMode}
                    onAddImage={() => createNode(CanvasNodeType.Image)}
                    onAddVideo={() => createNode(CanvasNodeType.Video)}
                    onAddAudio={() => createNode(CanvasNodeType.Audio)}
                    onAddComposite={() => createNode(CanvasNodeType.Composite)}
                    onAddCompare={() => createNode(CanvasNodeType.Compare)}
                    onAddCollage={() => createNode(CanvasNodeType.Collage)}
                    onAddText={() => createNode(CanvasNodeType.Text)}
                    onAddMaterial={() => createUploadMaterialNode()}
                    onAddGroup={() => createNode(CanvasNodeType.Group)}
                onOpenDirector={() => setDirectorOpen(true)}
                    onAddExtensionNode={(type) => createNode(type)}
                    onUndo={undoCanvas}
                    onRedo={redoCanvas}
                    onUpload={() => handleUploadRequest()}
                    onDelete={() => deleteNodes(new Set(selectedNodeIds))}
                    onClear={() => setClearConfirmOpen(true)}
                    onDeselect={deselectCanvas}
                    onBackgroundModeChange={setBackgroundMode}
                    onShowImageInfoChange={setShowImageInfo}
                    onInputModeChange={changeInputMode}
                />

                {isMiniMapOpen ? <Minimap nodes={nodes} viewport={viewport} viewportSize={size} onViewportChange={setViewport} /> : null}

                <CanvasZoomControls
                    scale={viewport.k}
                    onScaleChange={setZoomScale}
                    onReset={resetViewport}
                    isMiniMapOpen={isMiniMapOpen}
                    onToggleMiniMap={() => setIsMiniMapOpen((value) => !value)}
                    connectionsVisible={connectionsVisible}
                    connectionsEnabled={inputMode === "connections"}
                    onToggleConnections={() => setConnectionsVisible((value) => !value)}
                    snapToGrid={snapToGrid}
                    onToggleSnapToGrid={() => setSnapToGrid((value) => !value)}
                />

                {contextMenu ? (
                    <CanvasNodeContextMenu
                        menu={contextMenu}
                        canUndo={historyState.canUndo}
                        canRedo={historyState.canRedo}
                        canCopyAll={nodes.length > 0}
                        onClose={() => setContextMenu(null)}
                        onUpload={() => handleUploadRequest(undefined, contextMenu.type === "canvas" ? contextMenu.world : undefined)}
                        onAddNode={() => {
                            if (contextMenu.type !== "canvas") return;
                            setNodeCreatePosition({ world: contextMenu.world, screen: { x: contextMenu.x, y: contextMenu.y } });
                        }}
                        onUndo={undoCanvas}
                        onRedo={redoCanvas}
                        onCopyAll={copyAllNodes}
                        onPaste={() => {
                            if (!pasteCopiedNodes()) void pasteSystemClipboard();
                        }}
                        onDuplicate={() => {
                            if (contextMenu.type !== "node") return;
                            duplicateNode(contextMenu.nodeId);
                            setContextMenu(null);
                        }}
                        onDelete={() => {
                            if (contextMenu.type === "node") {
                                deleteNodes(new Set([contextMenu.nodeId]));
                            } else if (contextMenu.type === "connection") {
                                deleteConnection(contextMenu.connectionId);
                            }
                            setContextMenu(null);
                        }}
                    />
                ) : null}

                <input ref={imageInputRef} type="file" multiple accept={CANVAS_MATERIAL_ACCEPT} className="hidden" onChange={handleImageInputChange} />

                <CanvasNodeInfoModal node={infoNode} open={Boolean(infoNode)} onClose={() => setInfoNodeId(null)} />
                <CanvasAudioMergeDialog open={Boolean(audioMergeNodeId)} nodes={nodes} busy={audioMergeBusy} onClose={() => setAudioMergeNodeId(null)} onMerge={(sources) => void handleMergeAudio(sources)} />
                {cropNode?.metadata?.content ? (
                    <CanvasNodeCropDialog dataUrl={imageEditorPreview.url || cropNode.metadata.content} open={Boolean(cropNode)} onClose={() => setCropNodeId(null)} onConfirm={(crop) => void cropImageNode(cropNode!, crop)} />
                ) : null}

                {splitNode?.metadata?.content ? (
                    <CanvasNodeSplitDialog dataUrl={imageEditorPreview.url || splitNode.metadata.content} open={Boolean(splitNode)} onClose={() => setSplitNodeId(null)} onConfirm={(params) => void splitImageNode(splitNode!, params)} />
                ) : null}

                {collageNode ? (
                    <CanvasCollageEditor
                        open={Boolean(collageNode)}
                        node={collageNode}
                        sources={collectCollageSources(collageNode.id)}
                        saving={collageSaving}
                        onClose={() => setCollageNodeId(null)}
                        onCommit={commitCollageLayout}
                        onSave={(dataUrl, layout, order) => void saveCollage(dataUrl, layout, order)}
                    />
                ) : null}

                {upscaleNode?.metadata?.content ? (
                    <CanvasNodeUpscaleDialog dataUrl={imageEditorPreview.url || upscaleNode.metadata.content} open={Boolean(upscaleNode)} onClose={() => setUpscaleNodeId(null)} onConfirm={(params) => void upscaleImageNode(upscaleNode!, params)} />
                ) : null}

                {angleNode?.metadata?.content ? (
                    <CanvasNodeAngleDialog dataUrl={imageEditorPreview.url || angleNode.metadata.content} open={Boolean(angleNode)} onClose={() => setAngleNodeId(null)} onConfirm={(params) => void generateAngleNode(angleNode!, params)} />
                ) : null}

                <Modal
                    title={t("canvas.projectPage.imageDetails")}
                    open={Boolean(previewNode?.metadata?.content)}
                    centered
                    onCancel={() => setPreviewNodeId(null)}
                    footer={null}
                    width="auto"
                    styles={{ body: { padding: 0, display: "flex", justifyContent: "center", alignItems: "center", maxHeight: "80vh" } }}
                >
                    {previewNode?.metadata?.content ? <img src={previewNode.metadata.content} alt={previewNode.title || t("assets.kinds.image")} style={{ maxWidth: "100%", maxHeight: "80vh", objectFit: "contain" }} /> : null}
                </Modal>

                <Modal
                    title={t("canvas.projectPage.clearTitle")}
                    open={clearConfirmOpen}
                    centered
                    onCancel={() => setClearConfirmOpen(false)}
                    footer={
                        <>
                            <Button onClick={() => setClearConfirmOpen(false)}>{t("common.cancel")}</Button>
                            <Button danger type="primary" onClick={clearCanvas}>
                                {t("canvas.projectPage.clear")}
                            </Button>
                        </>
                    }
                >
                    <p className="text-sm opacity-60">{t("canvas.projectPage.clearDescription")}</p>
                </Modal>

                <AssetPickerModal open={assetPickerOpen} onInsert={handleAssetInsert} onClose={() => setAssetPickerOpen(false)} />
            </section>
        </main>
    );
}

function migrateLegacyGenerationNodes(nodes: CanvasNodeData[]) {
    return nodes.map((node) => {
        if (node.type !== CanvasNodeType.Generic && node.type !== CanvasNodeType.Config) return node;
        const operation = node.type === CanvasNodeType.Generic ? getGenericOperation(node.metadata?.genericOperation) : null;
        const legacyMode = node.metadata?.generationMode || "image";
        const type = operation
            ? operation.outputHint === "image"
                ? CanvasNodeType.Image
                : operation.outputHint === "video"
                  ? CanvasNodeType.Video
                  : operation.outputHint === "audio"
                    ? CanvasNodeType.Audio
                    : CanvasNodeType.Text
            : legacyMode === "video"
              ? CanvasNodeType.Video
              : legacyMode === "audio"
                ? CanvasNodeType.Audio
                : legacyMode === "text"
                  ? CanvasNodeType.Text
                  : CanvasNodeType.Image;
        const operationId = operation?.id || (type === CanvasNodeType.Video ? "video.generate" : type === CanvasNodeType.Audio ? "audio.generate" : type === CanvasNodeType.Text ? "text.chat" : "image.generate");
        const prompt = node.metadata?.prompt || node.metadata?.composerContent || "";
        const payload = createGenericNativePayload(operationId, parseGenericNativePayload(node.metadata?.genericPayload) || undefined);
        if (prompt.trim()) writeGenericNativePrompt(operationId, payload, prompt);
        const spec = getNodeSpec(type);
        return {
            ...node,
            type,
            title: getNodeSpec(type).title,
            position: {
                x: node.position.x + node.width / 2 - spec.width / 2,
                y: node.position.y + node.height / 2 - spec.height / 2,
            },
            width: spec.width,
            height: spec.height,
            metadata: {
                ...node.metadata,
                content: node.type === CanvasNodeType.Config ? "" : node.metadata?.content,
                prompt,
                composerContent: undefined,
                genericOperation: operationId,
                genericPayload: JSON.stringify(payload, null, 2),
                generationMode: (type === CanvasNodeType.Image ? "image" : type === CanvasNodeType.Video ? "video" : type === CanvasNodeType.Audio ? "audio" : "text") as CanvasNodeMetadata["generationMode"],
            },
        };
    });
}

function isNativeGenerationNode(node: CanvasNodeData) {
    return node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio || node.type === CanvasNodeType.Text;
}

function genericOutputMatchesNode(output: GenericOutput, type: CanvasNodeData["type"]) {
    return genericOutputNodeType(output) === type;
}

function applyGenericResultToSource(
    node: CanvasNodeData,
    output: GenericOutput | undefined,
    providerTask: NonNullable<CanvasNodeMetadata["providerTask"]>,
    providerResult: NonNullable<CanvasNodeMetadata["providerResult"]>,
    imageOutputs: GenericOutput[] = output ? [output] : [],
): CanvasNodeData {
    const spec = getNodeSpec(node.type);
    const geometry = output && (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video) ? fitMediaNodeGeometry(node, output.width, output.height, spec.width, spec.height) : {};
    const imageHistory = output && node.type === CanvasNodeType.Image && output.kind === "image" ? mergeGeneratedImageOutputsHistory(node.metadata, imageOutputs, providerTask, output) : {};
    return {
        ...node,
        ...geometry,
        metadata: {
            ...node.metadata,
            ...imageHistory,
            ...(output
                ? {
                      content: output.text || output.url || "",
                      mimeType: output.mimeType || inferGenericOutputMimeType(output),
                      storageKey: output.storageKey,
                      localPath: output.localPath,
                      filename: output.filename,
                      bytes: output.bytes,
                      naturalWidth: output.width,
                      naturalHeight: output.height,
                      durationMs: output.durationMs,
                      // 已经有了新的本地文件，清掉上一轮载入时标记的「文件已丢失」。
                      fileMissing: undefined,
                  }
                : {}),
            status: output ? NODE_STATUS_SUCCESS : providerTask.phase === "failed" ? NODE_STATUS_ERROR : NODE_STATUS_IDLE,
            errorDetails: providerTask.phase === "failed" ? providerTask.message : undefined,
            providerTask,
            providerResult,
        },
    };
}

/**
 * 把服务商返回的临时 HTTPS 地址读成 Blob（图片 / 视频通用）。
 *
 * 渠道模型直连取素材走的是 WebView 的 fetch，会被服务商的 CORS 策略拦下
 * （表现为「请求 … 失败（Failed to fetch）」）。这里复用内置模型同款的兜底顺序：
 * 桌面原生磁盘缓存（走 Rust，无跨域限制）→ 带 SSRF 防护的下载中转 → 直连。
 */
async function resolveProviderMediaBlob(url: string, kind: DownloadableMediaKind): Promise<Blob> {
    try {
        const cached = await cacheRemoteMedia({ url });
        const blob = await readDesktopFileBlob(cached.absolutePath, cached.mimeType);
        if (blob?.size) return blob;
    } catch {
        // 桌面缓存不可用时继续走下载链路
    }
    return resolveDownloadBlob({ kind, url });
}

/**
 * 渠道模型视频入库：与图片同款兜底，先把服务商临时地址落成本地 Blob 再入库，
 * 否则 uploadMediaFile 内部同样是一次会被 CORS 拦下的 fetch，视频只会静默退化成远端地址、永不落盘。
 * 取回失败时退回 storeGeneratedVideo 原有行为（保底登记远端地址，不中断生成）。
 */
async function storeProviderVideo(result: VideoGenerationResult): Promise<UploadedFile> {
    if (result.blob || !result.url) return storeGeneratedVideo(result);
    try {
        return await uploadMediaFile(await resolveProviderMediaBlob(result.url, "video"), "video");
    } catch {
        return storeGeneratedVideo(result);
    }
}

function createGenericOutputNode(source: CanvasNodeData, output: GenericOutput, index: number, operationLabel: string, providerTask: NonNullable<CanvasNodeMetadata["providerTask"]>) {
    const type = genericOutputNodeType(output);
    const spec = getNodeSpec(type);
    const column = Math.floor(index / 6);
    const row = index % 6;
    const center = {
        x: source.position.x + source.width + 96 + spec.width / 2 + column * (spec.width + 44),
        y: source.position.y + spec.height / 2 + row * (spec.height + 28),
    };
    const content = output.text || output.url || "";
    const outputTaskId = output.taskId || providerTask.taskId;
    const outputProviderTask = {
        ...providerTask,
        taskId: outputTaskId,
        taskIds: outputTaskId ? [outputTaskId] : providerTask.taskIds,
    };
    const node = createCanvasNode(type, center, {
        content,
        status: NODE_STATUS_SUCCESS,
        mimeType: output.mimeType || inferGenericOutputMimeType(output),
        storageKey: output.storageKey,
        localPath: output.localPath,
        filename: output.filename,
        bytes: output.bytes,
        naturalWidth: output.width,
        naturalHeight: output.height,
        durationMs: output.durationMs,
        providerTask: outputProviderTask,
        providerResult: {
            taskId: outputTaskId,
            taskIds: outputTaskId ? [outputTaskId] : providerTask.taskIds,
            resultUrl: output.url || output.sourceUrl,
            urls: output.url || output.sourceUrl ? [output.url || output.sourceUrl!] : [],
            outputs: [output],
            raw: output.metadata,
        },
    });
    return {
        ...node,
        ...(type === CanvasNodeType.Image || type === CanvasNodeType.Video ? fitMediaNodeGeometry(node, output.width, output.height, spec.width, spec.height) : {}),
        title: output.name || output.filename || `${operationLabel} · ${output.kind === "file" ? "文件" : output.kind.toUpperCase()} ${index + 1}`,
    };
}

export function canvasImageOperationSource(node: CanvasNodeData): CanvasImageOperationSource {
    const metadata = node.metadata;
    const outputs = metadata?.providerResult?.outputs || [];
    const output =
        outputs.find((item) => item.localPath && item.localPath === metadata?.localPath) ||
        outputs.find((item) => item.url && item.url === metadata?.content) ||
        outputs.find((item) => item.sourceUrl && item.sourceUrl === metadata?.content) ||
        outputs.find((item) => item.kind === "image");
    return {
        url: metadata?.content || output?.url || output?.sourceUrl || "",
        storageKey: metadata?.storageKey || output?.storageKey,
        localPath: metadata?.localPath || output?.localPath,
        sourceUrl: output?.sourceUrl || (/^https:\/\//i.test(output?.url || "") ? output?.url : undefined),
        filename: metadata?.filename || output?.filename || output?.name,
        mimeType: metadata?.mimeType || output?.mimeType,
    };
}

function genericOutputNodeType(output: GenericOutput) {
    if (output.kind === "image") return CanvasNodeType.Image;
    if (output.kind === "video") return CanvasNodeType.Video;
    if (output.kind === "audio") return CanvasNodeType.Audio;
    if (output.kind === "file") {
        const mimeType = output.mimeType?.toLowerCase() || "";
        const path = (output.name || output.url || output.sourceUrl || "").split(/[?#]/)[0].toLowerCase();
        if (mimeType.startsWith("image/") || /\.(?:png|jpe?g|webp|gif|avif)$/.test(path)) return CanvasNodeType.Image;
        if (mimeType.startsWith("video/") || /\.(?:mp4|webm|mov|m4v)$/.test(path)) return CanvasNodeType.Video;
        if (mimeType.startsWith("audio/") || /\.(?:mp3|wav|flac|m4a|aac|ogg|opus|mid|midi)$/.test(path)) return CanvasNodeType.Audio;
    }
    return CanvasNodeType.Text;
}

function inferGenericOutputMimeType(output: GenericOutput) {
    const path = output.url?.split(/[?#]/)[0].toLowerCase() || "";
    if (output.kind === "image") return path.endsWith(".png") ? "image/png" : path.endsWith(".webp") ? "image/webp" : "image/jpeg";
    if (output.kind === "video") return path.endsWith(".webm") ? "video/webm" : "video/mp4";
    if (output.kind === "audio") return path.endsWith(".wav") ? "audio/wav" : path.endsWith(".flac") ? "audio/flac" : "audio/mpeg";
    return output.kind === "file" ? "application/octet-stream" : "text/plain";
}

function genericFileExtension(output: Pick<GenericOutput, "name" | "url" | "sourceUrl" | "mimeType">) {
    const source = output.name || output.sourceUrl || output.url || "";
    const extension = source.split(/[?#]/)[0].match(/\.([a-z0-9]{1,8})$/i)?.[1];
    if (extension) return extension.toLowerCase();
    if (output.mimeType === "audio/midi" || output.mimeType === "audio/x-midi") return "mid";
    return "bin";
}

function genericOutputSignature(output: Pick<GenericOutput, "kind" | "url" | "sourceUrl" | "text" | "taskId" | "audioIndex" | "selectionIndex">) {
    return `${output.kind}|${output.sourceUrl || output.url || ""}|${output.text || ""}|${output.taskId || ""}|${output.audioIndex || ""}|${output.selectionIndex || ""}`;
}

function genericPartialSummary(result: GenericRunResult) {
    const failed = result.taskStates.filter((state) => state.phase === "failed").map((state) => state.taskId);
    const interrupted = result.taskStates.filter((state) => state.status === "polling_interrupted").map((state) => state.taskId);
    return [`${result.outputs.length} 个结果已完成`, failed.length ? `${failed.length} 个任务失败（${failed.join("、")}）` : "", interrupted.length ? `${interrupted.length} 个任务查询中断，可稍后恢复（${interrupted.join("、")}）` : ""]
        .filter(Boolean)
        .join("；");
}

function isGenericPollingUncertain(error: unknown) {
    if (error instanceof GenericApiError && error.status > 0) return true;
    if (error instanceof TypeError) return true;
    const message = error instanceof Error ? error.message : String(error);
    return /轮询超过|failed to fetch|networkerror|network request failed|load failed/i.test(message);
}

function hasUnresolvedGenericTask(node: CanvasNodeData) {
    const task = node.metadata?.providerTask;
    const hasTaskId = Boolean(task?.taskId || task?.taskIds?.length || node.metadata?.providerResult?.taskId || node.metadata?.providerResult?.taskIds?.length);
    return hasTaskId && task?.phase !== "succeeded" && task?.phase !== "failed" && task?.phase !== "partial";
}

function migrateCanvasBackgroundMode(projectId: string, mode: CanvasBackgroundMode) {
    if (mode !== "lines") return mode;
    try {
        const key = `mgcanvas:dots-grid-v1:${projectId}`;
        if (localStorage.getItem(key)) return mode;
        localStorage.setItem(key, "1");
        return "dots";
    } catch {
        return "dots";
    }
}

function extractGenericButtons(value: unknown) {
    const buttons: Array<{ customId?: string; action?: string; label?: string; emoji?: string; disabled?: boolean; raw?: unknown }> = [];
    const seen = new Set<string>();
    const visit = (item: unknown) => {
        if (!item || typeof item !== "object") return;
        if (Array.isArray(item)) {
            item.forEach(visit);
            return;
        }
        const record = item as Record<string, unknown>;
        if (Array.isArray(record.buttons)) {
            record.buttons.forEach((button) => {
                if (!button || typeof button !== "object") return;
                const raw = button as Record<string, unknown>;
                const customId = typeof raw.customId === "string" ? raw.customId : typeof raw.custom_id === "string" ? raw.custom_id : undefined;
                const key = customId || JSON.stringify(raw);
                if (seen.has(key)) return;
                seen.add(key);
                buttons.push({
                    customId,
                    action: typeof raw.action === "string" ? raw.action : undefined,
                    label: typeof raw.label === "string" ? raw.label : undefined,
                    emoji: typeof raw.emoji === "string" ? raw.emoji : undefined,
                    disabled: typeof raw.disabled === "boolean" ? raw.disabled : undefined,
                    raw,
                });
            });
        }
        Object.values(record).forEach(visit);
    };
    visit(value);
    return buttons;
}
