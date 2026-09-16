import { useEffect, useMemo, useState } from "react";
import { Button, Input, InputNumber, Popover, Select, Slider, Switch, Tooltip } from "antd";
import { ArrowUp, CircleStop, FileText, Image as ImageIcon, Info, LoaderCircle, Music2, Plus, RefreshCw, SlidersHorizontal, Video } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CanvasPromptChipInput } from "@/components/canvas/canvas-prompt-chip-input";
import { CanvasConnectedReferences } from "@/components/canvas/canvas-connected-references";
import { CanvasResizableArea } from "@/components/canvas/canvas-resizable-area";
import { CanvasObjectReferencePicker } from "@/components/canvas/canvas-object-reference-picker";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { canvasThemes } from "@/lib/canvas-theme";
import { getGenericOperation } from "@/services/api/generic-contract";
import { getGenericModelProfile } from "@/services/api/generic-models";
import { formatGenericPriceQuote, getCachedGenericPricingCatalog, loadGenericPricingCatalog, quoteGenericPrice, type GenericPriceQuote, type GenericPricingCatalog } from "@/services/api/generic-pricing";
import { modelOptionLabel, resolveModelRequestConfig, selectableModelsByCapability, useConfigStore, type ModelCapability } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import { GENERIC_SEEDREAM_VIRTUAL_RATIO_PATH, GENERIC_SEEDREAM_VIRTUAL_RESOLUTION_PATH, inferGenericSeedreamGeometry, isGenericSeedreamVirtualPath } from "./generic-aspect-dimensions";
import { getCanvasNodePopupContainer } from "./canvas-node-popup";
import {
    GENERIC_NATIVE_CANVAS_BATCH_COUNT_PATH,
    GENERIC_NATIVE_OUTPUT_COUNT_PATH,
    GENERIC_NATIVE_SIZE_RATIO_PATH,
    EMPTY_GENERIC_NATIVE_REFERENCE_COUNTS,
    genericNativeModelChoiceGroups,
    genericNativeModelCapability,
    genericNativeReferencedInputCounts,
    genericNativeVideoModelCategories,
    genericNativeNodeKind,
    genericNativeParameterDefinitions,
    genericNativeUsesPrompt,
    changeGenericNativeModelChoice,
    createGenericNativePayload,
    getGenericNativeOperation,
    parseGenericNativePayload,
    readGenericNativeParameter,
    readGenericNativeModelChoice,
    readGenericNativePrompt,
    validateGenericNativePayload,
    writeGenericNativeParameter,
    writeGenericNativePrompt,
    type GenericNativeNodeKind,
    type GenericNativeParameterDefinition,
    type GenericNativeReferenceCounts,
} from "./generic-native-generation";
import { GenericVideoModelPicker } from "./generic-video-model-picker";

export type GenericNativeGenerationPanelProps = {
    node: CanvasNodeData;
    kind?: GenericNativeNodeKind;
    referenceCounts?: GenericNativeReferenceCounts;
    mentionReferences?: CanvasResourceReference[];
    canvasNodes?: CanvasNodeData[];
    objectMode?: boolean;
    isRunning?: boolean;
    isPolling?: boolean;
    onChange: (nodeId: string, metadata: Partial<CanvasNodeMetadata>) => void;
    onRun?: (node: CanvasNodeData, operationId: string, payload: Record<string, unknown>) => void | Promise<void>;
    onStartPolling?: (node: CanvasNodeData) => void | Promise<void>;
    onStopPolling?: (node: CanvasNodeData) => void;
    onFocusReference?: (nodeId: string) => void;
    onDisconnectReference?: (connectionId: string) => void;
    onReorderReferences?: (sourceConnectionId: string, targetConnectionId: string) => void;
    onRemoveReference?: (reference: CanvasResourceReference) => void;
    onReorderReference?: (source: CanvasResourceReference, target: CanvasResourceReference) => void;
    onAddObjectReference?: (sourceNodeId: string) => void;
    onRemoveObjectReference?: (referenceId: string) => void;
    onAddReference?: () => void;
};

export function GenericNativeGenerationPanel({
    node,
    kind: kindOverride,
    referenceCounts = EMPTY_GENERIC_NATIVE_REFERENCE_COUNTS,
    mentionReferences = [],
    canvasNodes = [],
    objectMode = false,
    isRunning = false,
    isPolling = false,
    onChange,
    onRun,
    onStartPolling,
    onStopPolling,
    onFocusReference,
    onDisconnectReference,
    onReorderReferences,
    onRemoveReference,
    onReorderReference,
    onAddObjectReference,
    onRemoveObjectReference,
    onAddReference,
}: GenericNativeGenerationPanelProps) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const config = useConfigStore((state) => state.config);
    const pricingBaseUrl = useMemo(() => resolveModelRequestConfig(config, config.model).baseUrl, [config]);
    const inferredKind = genericNativeNodeKind(node.type);
    const kind = kindOverride || inferredKind || "image";
    const operation = getGenericNativeOperation(kind, node.metadata?.genericOperation);
    const [payload, setPayload] = useState(() => createGenericNativePayload(operation.id, parseGenericNativePayload(node.metadata?.genericPayload) || undefined, referenceCounts));
    const [pricingCatalog, setPricingCatalog] = useState<GenericPricingCatalog | null>(() => getCachedGenericPricingCatalog());
    const [pricingFailed, setPricingFailed] = useState(false);

    useEffect(() => {
        const nextOperation = getGenericNativeOperation(kind, node.metadata?.genericOperation);
        setPayload(createGenericNativePayload(nextOperation.id, parseGenericNativePayload(node.metadata?.genericPayload) || undefined, referenceCounts));
        // Reference changes are deliberately not persisted as node data; they are materialized at run time.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [kind, node.id, node.metadata?.genericOperation, node.metadata?.genericPayload]);

    useEffect(() => {
        let active = true;
        setPricingFailed(false);
        void loadGenericPricingCatalog(false, pricingBaseUrl)
            .then((catalog) => {
                if (active) setPricingCatalog(catalog);
            })
            .catch(() => {
                if (active) setPricingFailed(true);
            });
        return () => {
            active = false;
        };
    }, [pricingBaseUrl]);

    const effectivePayload = useMemo(() => createGenericNativePayload(operation.id, payload, referenceCounts), [operation.id, payload, referenceCounts]);
    // 渠道模型优先展示：用户在设置里配置的模型按当前节点能力筛选后与内置目录并列。
    // 图像与视频已接入渠道协议；音频/文本仍走内置目录，避免误选后调用到错误接口。
    const channelModelGroup = useMemo(() => {
        if (kind !== "image" && kind !== "video") return null;
        const values = selectableModelsByCapability(config, kind as ModelCapability);
        if (!values.length) return null;
        return { label: "渠道模型", options: values.map((value) => ({ label: modelOptionLabel(config, value), value })) };
    }, [config, kind]);
    const modelGroups = useMemo(() => {
        const builtinGroups = genericNativeModelChoiceGroups(kind, operation.id);
        // 已配置渠道模型时只列出渠道模型；没有可用渠道模型时回退内置目录，避免列表为空。
        return channelModelGroup ? [channelModelGroup] : builtinGroups;
    }, [kind, operation.id, channelModelGroup]);
    const videoModelCategories = useMemo(() => (kind === "video" ? genericNativeVideoModelCategories(operation.id) : []), [kind, operation.id]);
    // 视频节点在有渠道模型时也使用统一的下拉（否则才回退内置的两级分类选择器）。
    const hasModelChoices =
        kind === "video" && !channelModelGroup ? videoModelCategories.some((category) => category.options.length > 0) : modelGroups.some((group) => group.options.length > 0);
    const parameters = useMemo(() => genericNativeParameterDefinitions(operation.id, effectivePayload), [effectivePayload, operation.id]);
    const prompt = readGenericNativePrompt(operation.id, payload);
    const visiblePrompt = prompt === "@Text 1" ? "" : prompt;
    const validationError = validateGenericNativePayload(kind, operation.id, effectivePayload, referenceCounts);
    const selectedModel = typeof effectivePayload.model === "string" ? effectivePayload.model : undefined;
    const modelProfile = selectedModel ? getGenericModelProfile(selectedModel) : undefined;
    const modelCapability = useMemo(() => genericNativeModelCapability(modelProfile), [modelProfile]);
    const usedReferenceCounts = useMemo(() => genericNativeReferencedInputCounts(effectivePayload), [effectivePayload]);
    const unusedReferenceCounts = {
        image: Math.max(0, referenceCounts.image - usedReferenceCounts.image),
        video: Math.max(0, referenceCounts.video - usedReferenceCounts.video),
        audio: Math.max(0, referenceCounts.audio - usedReferenceCounts.audio),
        text: Math.max(0, referenceCounts.text - usedReferenceCounts.text),
    };
    const unusedReferenceTotal = Object.values(unusedReferenceCounts).reduce((sum, count) => sum + count, 0);
    const referenceLimitNotice = unusedReferenceCounts.image > 0 && usedReferenceCounts.image > 0 ? `已连接 ${referenceCounts.image} 张图片，当前模型按排序只读取前 ${usedReferenceCounts.image} 张` : unusedReferenceTotal > 0 ? `${unusedReferenceTotal} 个素材不符合当前模型的输入要求` : null;
    const selectedModelKey = readGenericNativeModelChoice(kind, operation.id, effectivePayload);
    // 用户是否主动选过模型：未选择前不展示预估费用，也不允许直接运行。
    const modelPinned = node.metadata?.genericModelPinned === true;
    const taskIds = Array.from(
        new Set([
            ...(node.metadata?.providerTask?.taskIds || []),
            ...(node.metadata?.providerTask?.taskId ? [node.metadata.providerTask.taskId] : []),
            ...(node.metadata?.providerResult?.taskIds || []),
            ...(node.metadata?.providerResult?.taskId ? [node.metadata.providerResult.taskId] : []),
        ]),
    );
    const taskId = taskIds[0];
    const taskPhase = node.metadata?.providerTask?.phase;
    const hasUnresolvedTask = Boolean(taskId && !["succeeded", "failed", "partial"].includes(taskPhase || ""));
    const promptEnabled = genericNativeUsesPrompt(operation.id);
    const emptyPromptIsOnlyValidationIssue = useMemo(() => {
        if (!validationError || !promptEnabled || visiblePrompt.trim() || referenceCounts.text > 0) return false;
        const probePayload = writeGenericNativePrompt(operation.id, { ...effectivePayload }, "MGCanvas 验证提示词");
        return validateGenericNativePayload(kind, operation.id, probePayload, referenceCounts) === null;
    }, [effectivePayload, kind, operation.id, promptEnabled, referenceCounts, validationError, visiblePrompt]);
    const visibleValidationError = emptyPromptIsOnlyValidationIssue ? null : validationError;

    const persist = (nextPayload: Record<string, unknown>, operationId = operation.id, resetTask = false) => {
        setPayload(nextPayload);
        const nextOperation = getGenericOperation(operationId);
        const nextPrompt = readGenericNativePrompt(operationId, nextPayload);
        const seconds = readGenericNativeParameter(nextPayload, "seconds");
        const outputDefinition = genericNativeParameterDefinitions(operationId, nextPayload).find(isOutputCountParameter);
        const outputs = outputDefinition ? Number(readGenericNativeParameter(nextPayload, outputDefinition.path)) : undefined;
        onChange(node.id, {
            genericOperation: operationId,
            genericPayload: JSON.stringify(nextPayload, null, 2),
            model: typeof nextPayload.model === "string" ? nextPayload.model : undefined,
            prompt: nextPrompt === "@Text 1" ? "" : nextPrompt,
            seconds: seconds === undefined ? undefined : String(seconds),
            count: typeof outputs === "number" && Number.isInteger(outputs) && outputs >= 1 ? outputs : undefined,
            errorDetails: undefined,
            ...(resetTask
                ? {
                      status: "idle",
                      providerTask: { provider: "generic", action: operationId, family: nextOperation.taskFamily, phase: "idle", status: "idle", progress: 0 },
                      providerResult: undefined,
                  }
                : {}),
        });
    };

    const selectModel = (modelId: string) => {
        const next = changeGenericNativeModelChoice(kind, operation.id, effectivePayload, modelId, referenceCounts);
        persist(next.payload, next.operationId, true);
        // 标记为已主动选择，费用预估与运行按钮据此解锁。
        onChange(node.id, { genericModelPinned: true });
    };

    const updatePrompt = (value: string) => persist(writeGenericNativePrompt(operation.id, { ...payload }, value));

    const updateParameter = (definition: GenericNativeParameterDefinition, value: unknown) => {
        const normalized = definition.path === "seconds" && value !== undefined && value !== null && value !== "" ? String(value) : value;
        persist(writeGenericNativeParameter(payload, definition.path, normalized));
    };

    const run = async () => {
        if (isRunning || !onRun || validationError || hasUnresolvedTask || !modelPinned) return;
        const configuredNode: CanvasNodeData = {
            ...node,
            metadata: {
                ...node.metadata,
                genericOperation: operation.id,
                genericPayload: JSON.stringify(effectivePayload, null, 2),
                model: selectedModel,
                prompt: visiblePrompt,
            },
        };
        persist(effectivePayload);
        await onRun(configuredNode, operation.id, effectivePayload);
    };

    const icon = nativeKindIcon(kind, "size-4");
    const isMediaKind = kind === "image" || kind === "video";
    const countParameter = isMediaKind ? parameters.find(isOutputCountParameter) : undefined;
    const settingsParameters = countParameter ? parameters.filter((definition) => definition.path !== countParameter.path) : parameters;
    const connectedReferences = mentionReferences.filter((reference) => reference.active && reference.nodeId !== node.id);
    const connectedSummary = referenceSummary(referenceCounts);
    const automaticMode = nativeAutomaticMode(kind, operation.id, referenceCounts);
    const progress = node.metadata?.providerTask?.progress;
    // 运行耗时：由任务的提交与完成时间计算。
    const elapsed = formatGenericTaskDuration(node.metadata?.providerTask?.submittedAt, node.metadata?.providerTask?.completedAt);
    const pricingContext = useMemo(() => ({ imageReferences: referenceCounts.image, videoReferences: referenceCounts.video, audioReferences: referenceCounts.audio }), [referenceCounts.audio, referenceCounts.image, referenceCounts.video]);
    const basePriceQuote = useMemo(() => quoteGenericPrice(pricingCatalog, operation.id, effectivePayload, pricingContext), [effectivePayload, operation.id, pricingCatalog, pricingContext]);
    const canvasBatchCount = countParameter?.path === GENERIC_NATIVE_CANVAS_BATCH_COUNT_PATH ? Number(readGenericNativeParameter(effectivePayload, countParameter.path)) || 1 : 1;
    const priceQuote = useMemo(() => scaleCanvasBatchQuote(basePriceQuote, canvasBatchCount), [basePriceQuote, canvasBatchCount]);
    const pricingLoading = !pricingCatalog && !pricingFailed;
    const formattedPrice = pricingLoading ? "读取价格…" : formatGenericPriceQuote(priceQuote);
    const priceMeaning = priceQuote.status === "rate" ? "计费标准" : priceQuote.status === "dynamic" ? "结算方式" : "预计费用";
    const pricePill = splitPriceForPill(formattedPrice);
    const modelPriceByChoice = useMemo(() => {
        const entries = new Map<string, GenericPriceQuote>();
        for (const group of modelGroups) {
            for (const option of group.options) {
                const changed = changeGenericNativeModelChoice(kind, operation.id, effectivePayload, option.value, referenceCounts);
                const candidateQuote = quoteGenericPrice(pricingCatalog, changed.operationId, changed.payload, pricingContext);
                entries.set(option.value, scaleCanvasBatchQuoteFromPayload(candidateQuote, changed.payload));
            }
        }
        return entries;
    }, [effectivePayload, kind, modelGroups, operation.id, pricingCatalog, pricingContext, referenceCounts]);
    const modelPriceLabels = useMemo(() => new Map(Array.from(modelPriceByChoice, ([value, quote]) => [value, formatGenericPriceQuote(quote, "menu")])), [modelPriceByChoice]);

    return (
        <div
            data-canvas-no-zoom
            className="overflow-visible rounded-2xl border shadow-xl backdrop-blur"
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            {isMediaKind ? (
                <div className="flex min-w-0 items-center gap-2 px-3 pt-2.5 text-[11px]" style={{ color: theme.node.faint }}>
                    <span className="shrink-0" style={{ color: theme.node.muted }}>
                        {icon}
                    </span>
                    <span className="shrink-0 font-medium" style={{ color: theme.node.text }}>
                        {automaticMode || operation.label}
                    </span>
                    <span className="shrink-0 rounded-full border px-1.5 py-0.5 text-[9px]" style={{ borderColor: theme.toolbar.border, color: theme.node.faint }}>
                        自动识别
                    </span>
                    <span className="min-w-0 flex-1 truncate" title={referenceLimitNotice || connectedSummary || undefined} style={referenceLimitNotice ? { color: "#fbbf24" } : undefined}>
                        {referenceLimitNotice || connectedSummary || "未连接素材"}
                    </span>
                    {elapsed ? (
                        <span className="shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] tabular-nums" style={{ borderColor: theme.toolbar.border, color: theme.node.muted }}>
                            用时 {elapsed}
                        </span>
                    ) : null}
                    {taskId ? <TaskStatus taskIds={taskIds} taskPhase={taskPhase} progress={progress} theme={theme} /> : null}
                </div>
            ) : (
                <div className="flex min-w-0 items-center gap-2 border-b px-3 py-2.5" style={{ borderColor: theme.toolbar.border }}>
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg" style={{ color: theme.node.muted }}>
                        {icon}
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold">{nativeKindTitle(kind)}创作</div>
                        <div className="mt-0.5 truncate text-[10px]" style={{ color: theme.node.faint }}>
                            {[automaticMode ? automaticMode : null, connectedSummary || (automaticMode ? null : operation.description), elapsed ? `用时 ${elapsed}` : null].filter(Boolean).join(" · ")}
                        </div>
                    </div>
                    {elapsed ? (
                        <span className="shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] tabular-nums" style={{ borderColor: theme.toolbar.border, color: theme.node.muted }}>
                            用时 {elapsed}
                        </span>
                    ) : null}
                    {taskId ? <TaskStatus taskIds={taskIds} taskPhase={taskPhase} progress={progress} theme={theme} /> : null}
                </div>
            )}

            {modelCapability ? (
                <div data-generic-model-capability className="mx-3 mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b pb-2 text-[10px] leading-4" style={{ borderColor: theme.toolbar.border, color: theme.node.faint }} title={selectedModel}>
                    <Info className="size-3.5 shrink-0" style={{ color: theme.node.muted }} aria-hidden="true" />
                    <span>
                        模式 <strong style={{ color: theme.node.text }}>{modelCapability.modeLabel}</strong>
                    </span>
                    <span>
                        输入 <strong style={{ color: theme.node.text }}>{modelCapability.inputLabel}</strong>
                    </span>
                    <span className="min-w-0 truncate">
                        参数 <strong style={{ color: theme.node.text }}>{modelCapability.parameterLabel}</strong>
                    </span>
                </div>
            ) : null}

            <div>
                {isMediaKind ? (
                    <CanvasResizableArea storageKey={`mgcanvas:node-reference-height:${node.id}`} defaultHeight={84} minHeight={72} maxHeight={220} resizeLabel={t("canvas.references.resizePreview")} className="mx-3 mt-2 border-b">
                        <div className="flex h-full min-w-0 items-center gap-2 pb-1" title={connectedReferences.length > 1 ? t("canvas.references.reorder") : undefined}>
                            <CanvasConnectedReferences
                                references={mentionReferences}
                                currentNodeId={node.id}
                                className="min-w-0 flex-1"
                                fillHeight
                                usedReferenceCounts={usedReferenceCounts}
                                onFocusNode={onFocusReference}
                                onDisconnect={isRunning || hasUnresolvedTask ? undefined : onDisconnectReference}
                                onReorder={isRunning || hasUnresolvedTask ? undefined : onReorderReferences}
                                onRemoveReference={isRunning || hasUnresolvedTask ? undefined : onRemoveReference}
                                onReorderReference={isRunning || hasUnresolvedTask ? undefined : onReorderReference}
                            />
                            {objectMode && onAddObjectReference && onRemoveObjectReference ? (
                                <CanvasObjectReferencePicker
                                    currentNodeId={node.id}
                                    nodes={canvasNodes}
                                    references={node.metadata?.objectReferences || []}
                                    disabled={isRunning}
                                    square
                                    onAdd={onAddObjectReference}
                                    onRemove={onRemoveObjectReference}
                                />
                            ) : null}
                            {onAddReference ? (
                                <button
                                    type="button"
                                    className="grid h-full aspect-square shrink-0 place-items-center rounded-xl border border-dashed transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
                                    style={{ borderColor: theme.node.stroke, color: theme.node.muted }}
                                    aria-label="上传新的参考素材节点"
                                    title="上传新的参考素材节点"
                                    disabled={isRunning || hasUnresolvedTask}
                                    onClick={onAddReference}
                                >
                                    <Plus className="size-4" />
                                </button>
                            ) : null}
                            {!connectedReferences.length ? (
                                <span className="min-w-0 flex-1 text-[10px] leading-4" style={{ color: theme.node.faint }}>
                                    {objectMode ? "从当前画布选择任意节点结果作为参考" : "从画布连线后会自动带入参考素材"}
                                </span>
                            ) : null}
                        </div>
                    </CanvasResizableArea>
                ) : connectedReferences.length ? (
                    <CanvasResizableArea storageKey={`mgcanvas:node-reference-height:${node.id}`} defaultHeight={84} minHeight={72} maxHeight={220} resizeLabel={t("canvas.references.resizePreview")} className="mx-3 mt-2.5">
                        <CanvasConnectedReferences
                            references={mentionReferences}
                            currentNodeId={node.id}
                            className="h-full"
                            fillHeight
                            usedReferenceCounts={usedReferenceCounts}
                            onFocusNode={onFocusReference}
                            onDisconnect={isRunning || hasUnresolvedTask ? undefined : onDisconnectReference}
                            onReorder={isRunning || hasUnresolvedTask ? undefined : onReorderReferences}
                            onRemoveReference={isRunning || hasUnresolvedTask ? undefined : onRemoveReference}
                            onReorderReference={isRunning || hasUnresolvedTask ? undefined : onReorderReference}
                        />
                    </CanvasResizableArea>
                ) : null}

                {promptEnabled ? (
                    <CanvasResizableArea
                        storageKey={`mgcanvas:node-prompt-height:${node.id}`}
                        defaultHeight={kind === "text" ? 180 : kind === "video" ? 148 : 128}
                        minHeight={96}
                        maxHeight={420}
                        resizeLabel={t("canvas.promptPanel.resizeInput")}
                        className={isMediaKind ? "mx-3 border-b" : "mx-3 mt-2.5"}
                    >
                        <CanvasPromptChipInput
                            value={visiblePrompt}
                            references={mentionReferences}
                            onChange={updatePrompt}
                            onSubmit={() => void run()}
                            className="thin-scrollbar block h-full w-full cursor-text overflow-y-auto bg-transparent px-1 py-2 text-sm leading-6 outline-none"
                            style={{ color: theme.node.text }}
                            placeholder={nativePromptPlaceholder(kind, operation.id, referenceCounts.text > 0)}
                        />
                    </CanvasResizableArea>
                ) : (
                    <div
                        className={isMediaKind ? "mx-3 flex min-h-20 items-center border-b text-xs leading-5" : "mx-3 mt-3 flex min-h-20 items-center rounded-xl border border-dashed px-3 text-xs leading-5"}
                        style={{ borderColor: theme.node.stroke, color: theme.node.muted }}
                    >
                        {operation.description}
                    </div>
                )}
            </div>

            {visibleValidationError ? (
                <div className="mx-3 mt-2 rounded-lg px-2.5 py-2 text-[11px] leading-4 text-red-400" style={{ background: "rgba(239,68,68,.08)" }}>
                    {visibleValidationError}
                </div>
            ) : null}

            <div className={`${isMediaKind ? "mt-0" : "mt-2.5 border-t"} flex min-w-0 items-center gap-2 px-3 py-2.5`} style={{ borderColor: theme.toolbar.border }}>
                {hasModelChoices && kind === "video" && !channelModelGroup ? (
                    <GenericVideoModelPicker
                        categories={videoModelCategories}
                        value={selectedModelKey}
                        priceLabels={modelPriceLabels}
                        pricingLoading={pricingLoading}
                        automaticMode={automaticMode}
                        disabled={hasUnresolvedTask}
                        theme={theme}
                        onChange={selectModel}
                    />
                ) : hasModelChoices ? (
                    <Select
                        showSearch
                        disabled={hasUnresolvedTask}
                        placeholder="请选择模型"
                        value={modelPinned ? selectedModelKey : undefined}
                        options={modelGroups.map((group) => ({
                            label: group.label,
                            options: group.options,
                        }))}
                        popupMatchSelectWidth={false}
                        getPopupContainer={getCanvasNodePopupContainer}
                        optionFilterProp="label"
                        className="min-w-0 max-w-[260px] flex-1"
                        optionRender={(option) => {
                            const quote = modelPriceByChoice.get(String(option.value));
                            return (
                                <div className="flex min-w-[330px] items-center justify-between gap-4 py-0.5">
                                    <span className="min-w-0 truncate">{String(option.label)}</span>
                                    <span data-generic-model-price={String(option.value)} className="shrink-0 tabular-nums text-[11px] opacity-60">
                                        {pricingLoading ? "读取价格…" : quote ? formatGenericPriceQuote(quote, "menu") : "价格待确认"}
                                    </span>
                                </div>
                            );
                        }}
                        onChange={selectModel}
                    />
                ) : (
                    <span className="min-w-0 flex-1 truncate px-1 text-xs font-medium" style={{ color: theme.node.muted }}>
                        {operation.label}
                    </span>
                )}
                <Popover
                    getPopupContainer={getCanvasNodePopupContainer}
                    placement="topRight"
                    trigger={settingsParameters.length ? "click" : []}
                    content={<NativeParameterPanel definitions={settingsParameters} payload={effectivePayload} theme={theme} onChange={updateParameter} />}
                >
                    <Button disabled={hasUnresolvedTask || !settingsParameters.length} className="!h-8 !min-w-[110px] !max-w-[190px] !flex-1 !rounded-full !px-2.5" icon={<SlidersHorizontal className="size-3.5" />}>
                        <span className="truncate text-xs">{summarizeVisibleParameters(settingsParameters, effectivePayload)}</span>
                    </Button>
                </Popover>
                {countParameter ? (
                    <Popover getPopupContainer={getCanvasNodePopupContainer} placement="topRight" trigger="click" content={<OutputCountPanel definition={countParameter} payload={effectivePayload} theme={theme} onChange={updateParameter} />}>
                        <Button disabled={hasUnresolvedTask} className="!h-8 !rounded-full !px-3" aria-label={`生成数量 ${String(readGenericNativeParameter(effectivePayload, countParameter.path) || 1)}`}>
                            <span className="text-xs tabular-nums">{String(readGenericNativeParameter(effectivePayload, countParameter.path) || 1)}x</span>
                        </Button>
                    </Popover>
                ) : null}
                {!modelPinned ? (
                    <span
                        className="inline-flex h-9 max-w-[190px] shrink-0 items-center rounded-full border px-3 text-[11px] font-medium"
                        style={{ background: theme.node.fill, borderColor: theme.toolbar.border, color: theme.node.faint }}
                    >
                        选择模型后显示预估费用
                    </span>
                ) : (
                <Tooltip
                    title={
                        pricingLoading
                            ? "正在读取 Generic 官方价格清单"
                            : pricingFailed
                              ? `${pricingCatalog ? "官方价格刷新失败，当前保留上次成功读取的价格。" : "官方动态价格暂时不可用，当前显示文档计费规则。"}${priceQuote.explanation}`
                              : priceQuote.explanation
                    }
                >
                    <span
                        className="inline-flex h-9 max-w-[190px] shrink-0 items-center gap-1.5 rounded-full border px-3 text-[11px] font-medium tabular-nums"
                        style={{ background: theme.node.fill, borderColor: theme.toolbar.border, color: theme.node.text }}
                        data-generic-current-price
                        aria-live="polite"
                        aria-label={`${priceMeaning} ${formattedPrice}`}
                        tabIndex={0}
                    >
                        {pricePill.prefix ? <span style={{ color: theme.node.faint }}>{pricePill.prefix}</span> : null}
                        {pricePill.currency ? <span style={{ color: "#66d99b" }}>{pricePill.currency}</span> : null}
                        <span className="truncate">{pricePill.value}</span>
                    </span>
                </Tooltip>
                )}
                {/* 停止按钮与运行按钮并存：运行中随时可以停下来改参数。 */}
                {(isRunning || isPolling) ? (
                    <Tooltip title="停止等待当前任务（远端任务可能仍在继续）">
                        <Button danger shape="circle" className="!size-9 shrink-0" icon={<CircleStop className="size-4" />} disabled={!onStopPolling} onClick={() => onStopPolling?.(node)} />
                    </Tooltip>
                ) : hasUnresolvedTask ? (
                    <Tooltip title="恢复查询远端任务">
                        <Button shape="circle" className="!size-9 shrink-0" icon={<RefreshCw className="size-4" />} disabled={!onStartPolling} onClick={() => void onStartPolling?.(node)} />
                    </Tooltip>
                ) : null}
                <Tooltip title={!modelPinned ? "请先选择模型" : validationError || `开始生成 · ${formattedPrice}`}>
                    <Button
                        type="primary"
                        shape="circle"
                        className="!size-9 shrink-0"
                        disabled={isRunning || isPolling || hasUnresolvedTask || !onRun || Boolean(validationError) || !modelPinned}
                        aria-label={`开始生成，${formattedPrice}`}
                        icon={isRunning ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
                        onClick={() => void run()}
                    />
                </Tooltip>
            </div>

            {modelProfile?.constraints?.notes?.length ? (
                <div className="border-t px-3 py-2 text-[10px] leading-4" style={{ borderColor: theme.toolbar.border, color: theme.node.faint }}>
                    {modelProfile.constraints.notes.join(" · ")}
                </div>
            ) : null}
        </div>
    );
}

function TaskStatus({ taskIds, taskPhase, progress, theme }: { taskIds: string[]; taskPhase?: string; progress?: number; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    return (
        <Tooltip title={taskIds.join("\n")}>
            <span className="max-w-32 shrink-0 truncate rounded-full px-2 py-1 font-mono text-[10px]" style={{ background: theme.node.fill, color: theme.node.muted }}>
                {taskPhase || "task"}
                {typeof progress === "number" ? ` · ${Math.round(progress)}%` : ""}
            </span>
        </Tooltip>
    );
}

function OutputCountPanel({
    definition,
    payload,
    theme,
    onChange,
}: {
    definition: GenericNativeParameterDefinition;
    payload: Record<string, unknown>;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    onChange: (definition: GenericNativeParameterDefinition, value: unknown) => void;
}) {
    const rawValue = Number(readGenericNativeParameter(payload, definition.path));
    const value = Number.isInteger(rawValue) && rawValue >= 1 ? rawValue : 1;
    return (
        <div className="w-[220px] p-1" data-canvas-no-zoom>
            <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-xs font-semibold" style={{ color: theme.node.muted }}>
                    生成数量
                </span>
                <span className="text-[10px] tabular-nums" style={{ color: theme.node.faint }}>
                    最多 {definition.max ?? 1}
                </span>
            </div>
            <InputNumber className="w-full" value={value} min={definition.min ?? 1} max={definition.max} step={1} precision={0} onChange={(next) => onChange(definition, next ?? 1)} />
            <div className="mt-2 text-[10px] leading-4" style={{ color: theme.node.faint }}>
                费用会随生成数量变化
            </div>
        </div>
    );
}

function NativeParameterPanel({
    definitions,
    payload,
    theme,
    onChange,
}: {
    definitions: readonly GenericNativeParameterDefinition[];
    payload: Record<string, unknown>;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    onChange: (definition: GenericNativeParameterDefinition, value: unknown) => void;
}) {
    const seedreamGeometry = inferGenericSeedreamGeometry(payload);
    return (
        <div className="thin-scrollbar max-h-[420px] w-[310px] overflow-y-auto p-1" data-canvas-no-zoom>
            {definitions.map((definition, index) => (
                <div key={definition.path} className={index ? "mt-4" : ""}>
                    <div className="mb-2 flex items-center justify-between gap-3 text-xs font-semibold" style={{ color: theme.node.muted }}>
                        <span>{definition.label}</span>
                        {definition.path === GENERIC_SEEDREAM_VIRTUAL_RESOLUTION_PATH && seedreamGeometry.dimensions ? (
                            <span className="truncate text-[10px] font-normal tabular-nums" style={{ color: theme.node.text }}>
                                {seedreamGeometry.dimensions.width} × {seedreamGeometry.dimensions.height} 已自动填写
                            </span>
                        ) : definition.optional && !isGenericSeedreamVirtualPath(definition.path) && readGenericNativeParameter(payload, definition.path) !== undefined ? (
                            <button type="button" className="text-[10px] font-normal opacity-60 transition hover:opacity-100" onClick={() => onChange(definition, undefined)}>
                                使用默认
                            </button>
                        ) : null}
                    </div>
                    <ParameterControl definition={definition} value={readGenericNativeParameter(payload, definition.path)} theme={theme} onChange={(value) => onChange(definition, value)} />
                </div>
            ))}
        </div>
    );
}

function ParameterControl({ definition, value, theme, onChange }: { definition: GenericNativeParameterDefinition; value: unknown; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onChange: (value: unknown) => void }) {
    if (definition.control === "boolean") return <Switch checked={Boolean(value)} onChange={onChange} />;
    if (definition.control === "slider") return <GenericDurationParameterControl definition={definition} value={value} theme={theme} onChange={onChange} />;
    if (definition.control === "number") {
        const numberValue = value === undefined || value === "" ? null : Number(value);
        return <InputNumber className="w-full" value={Number.isFinite(numberValue) ? numberValue : null} min={definition.min} max={definition.max} step={definition.step} placeholder="使用接口默认值" onChange={onChange} />;
    }
    if (definition.control === "text") return <Input value={typeof value === "string" ? value : ""} placeholder="请输入" onChange={(event) => onChange(event.target.value)} />;

    const options = definition.options || [];
    if (isRatioParameter(definition) && options.length) {
        return <GenericRatioParameterControl options={options} value={value} theme={theme} onChange={onChange} />;
    }
    if (isResolutionParameter(definition) && options.length) {
        return (
            <div className="flex gap-1 rounded-lg p-1" style={{ background: `${theme.node.fill}99` }} data-generic-resolution-segments>
                {options.map((option) => {
                    const normalizedValue = value === undefined && options.some((candidate) => String(candidate.value).toLowerCase() === "adaptive") ? "adaptive" : String(value).toLowerCase();
                    const selected = normalizedValue === String(option.value).toLowerCase();
                    return (
                        <button
                            type="button"
                            key={String(option.value)}
                            aria-pressed={selected}
                            className="h-7 min-w-0 flex-1 rounded-md px-2 text-[11px] font-medium transition-colors duration-150 hover:bg-black/[0.04] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 dark:hover:bg-white/[0.06]"
                            style={{ background: selected ? theme.toolbar.activeBg : "transparent", color: selected ? theme.node.text : theme.node.muted, opacity: selected ? 1 : 0.75 }}
                            onClick={() => onChange(option.value)}
                        >
                            {option.label}
                        </button>
                    );
                })}
            </div>
        );
    }
    if (options.length <= 12) {
        return (
            <div className="grid grid-cols-4 gap-1.5 rounded-xl p-1.5" style={{ background: `${theme.node.fill}99` }}>
                {options.map((option) => {
                    const selected = String(value) === String(option.value);
                    return (
                        <button
                            type="button"
                            key={String(option.value)}
                            className="min-h-8 rounded-lg px-1.5 text-[11px] transition hover:opacity-100"
                            style={{ background: selected ? theme.toolbar.activeBg : "transparent", color: selected ? theme.node.text : theme.node.muted, opacity: selected ? 1 : 0.75 }}
                            onClick={() => onChange(option.value)}
                        >
                            {option.label}
                        </button>
                    );
                })}
            </div>
        );
    }
    return <Select allowClear value={value as string | number | undefined} options={[...options]} className="w-full" placeholder="使用接口默认值" getPopupContainer={getCanvasNodePopupContainer} onChange={onChange} />;
}

export function GenericDurationParameterControl({ definition, value, theme, onChange }: { definition: GenericNativeParameterDefinition; value: unknown; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onChange: (value: unknown) => void }) {
    const min = definition.min ?? 1;
    const max = definition.max ?? Math.max(min, 60);
    const parsedValue = Number(value);
    const currentValue = Number.isFinite(parsedValue) ? Math.min(max, Math.max(min, parsedValue)) : min;
    return (
        <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5" style={{ background: `${theme.node.fill}99` }} data-generic-duration-slider data-duration-min={min} data-duration-max={max}>
            <Slider className="min-w-0 flex-1" min={min} max={max} step={definition.step || 1} value={currentValue} tooltip={{ formatter: (nextValue) => `${nextValue} 秒` }} aria-label={`${definition.label}，${currentValue} 秒`} onChange={onChange} />
            <InputNumber
                aria-label={`${definition.label}秒数`}
                className="!w-[58px] shrink-0"
                controls={false}
                min={min}
                max={max}
                step={definition.step || 1}
                value={currentValue}
                onChange={(nextValue) => {
                    if (typeof nextValue === "number" && Number.isInteger(nextValue)) onChange(nextValue);
                }}
            />
            <span className="shrink-0 text-[11px]" style={{ color: theme.node.muted }}>
                秒
            </span>
        </div>
    );
}

export function GenericRatioParameterControl({
    options,
    value,
    theme,
    onChange,
}: {
    options: readonly { label: string; value: string | number | boolean }[];
    value: unknown;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    onChange: (value: unknown) => void;
}) {
    const adaptiveOption = options.find((option) => String(option.value).toLowerCase() === "adaptive");
    const ratioOptions = options.filter((option) => option !== adaptiveOption);

    return (
        <div className="flex gap-1.5 rounded-lg p-1.5" style={{ background: `${theme.node.fill}99` }} data-generic-ratio-layout="rhtv">
            {adaptiveOption ? <RatioOptionButton option={adaptiveOption} value={value} theme={theme} adaptive className="w-[52px] shrink-0 self-stretch" onChange={onChange} /> : null}
            <div className="grid min-w-0 flex-1 grid-cols-4 gap-1.5" data-generic-ratio-grid>
                {ratioOptions.map((option) => (
                    <RatioOptionButton key={String(option.value)} option={option} value={value} theme={theme} onChange={onChange} />
                ))}
            </div>
        </div>
    );
}

function RatioOptionButton({
    option,
    value,
    theme,
    adaptive = false,
    className = "",
    onChange,
}: {
    option: { label: string; value: string | number | boolean };
    value: unknown;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    adaptive?: boolean;
    className?: string;
    onChange: (value: unknown) => void;
}) {
    const optionValue = String(option.value);
    const selected = String(value) === optionValue;
    return (
        <button
            type="button"
            aria-pressed={selected}
            data-generic-ratio-adaptive={adaptive || undefined}
            data-generic-ratio-value={optionValue}
            className={`${className} flex ${adaptive ? "h-auto" : "h-[52px]"} min-w-0 flex-col items-center justify-center gap-1 rounded-md px-1 text-[10px] transition-colors duration-150 hover:bg-black/[0.04] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 dark:hover:bg-white/[0.06]`}
            style={{
                background: selected ? theme.toolbar.activeBg : "transparent",
                color: selected ? theme.node.text : theme.node.muted,
                opacity: selected ? 1 : 0.82,
            }}
            onClick={() => onChange(option.value)}
        >
            <RatioOutline ratio={optionValue} color={selected ? theme.node.text : theme.node.muted} adaptive={adaptive} />
            <span className="max-w-full truncate">{option.label}</span>
        </button>
    );
}

function RatioOutline({ ratio, color, adaptive }: { ratio: string; color: string; adaptive: boolean }) {
    if (adaptive) {
        return (
            <span className="relative block size-[20px] rounded-[3px] border" style={{ borderColor: color }}>
                <span className="absolute inset-[3px] rounded-[2px] border border-dashed opacity-55" style={{ borderColor: color }} />
            </span>
        );
    }
    const match = ratio.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    const aspect = match ? Number(match[1]) / Number(match[2]) : 1;
    const width = aspect >= 1 ? 18 : Math.max(5, 18 * aspect);
    const height = aspect >= 1 ? Math.max(5, 18 / aspect) : 18;
    return (
        <span className="flex h-5 w-6 items-center justify-center">
            <span className="block rounded-[2px] border" style={{ borderColor: color, width, height }} />
        </span>
    );
}

function isRatioParameter(definition: GenericNativeParameterDefinition) {
    return (
        definition.path === GENERIC_SEEDREAM_VIRTUAL_RATIO_PATH ||
        definition.path === GENERIC_NATIVE_SIZE_RATIO_PATH ||
        definition.path === "metadata.ratio" ||
        (definition.path === "size" && definition.options?.every((option) => String(option.value).includes(":")))
    );
}

function isResolutionParameter(definition: GenericNativeParameterDefinition) {
    return definition.path === GENERIC_SEEDREAM_VIRTUAL_RESOLUTION_PATH || definition.path === "metadata.resolution";
}

function summarizeVisibleParameters(definitions: readonly GenericNativeParameterDefinition[], payload: Record<string, unknown>) {
    const priority = [
        GENERIC_SEEDREAM_VIRTUAL_RATIO_PATH,
        GENERIC_NATIVE_SIZE_RATIO_PATH,
        "metadata.ratio",
        "size",
        GENERIC_SEEDREAM_VIRTUAL_RESOLUTION_PATH,
        "metadata.resolution",
        "seconds",
        "metadata.duration",
        "duration",
        "response_format",
        "metadata.format",
    ];
    const ordered = [...definitions].sort((left, right) => {
        const leftIndex = priority.indexOf(left.path);
        const rightIndex = priority.indexOf(right.path);
        if (leftIndex < 0 && rightIndex < 0) return 0;
        if (leftIndex < 0) return 1;
        if (rightIndex < 0) return -1;
        return leftIndex - rightIndex;
    });
    const entries = ordered.map((definition) => ({ definition, value: readGenericNativeParameter(payload, definition.path) })).filter(({ definition, value }) => !isOutputCountParameter(definition) && value !== undefined && value !== null && value !== "");
    const hasDisplaySetting = entries.some(({ definition }) => priority.includes(definition.path));
    const visibleEntries = (hasDisplaySetting ? entries.filter(({ definition }) => priority.includes(definition.path)) : entries).slice(0, 4);
    const values = visibleEntries.map(({ definition, value }) => {
        const shown = typeof value === "boolean" ? (value ? "是" : "否") : value === "adaptive" ? "自适应" : ["seconds", "metadata.duration", "duration"].includes(definition.path) ? `${String(value)}秒` : String(value);
        return hasDisplaySetting ? shown : `${definition.label} ${shown}`;
    });
    return values.length ? values.join(" / ") : "默认参数";
}

function isOutputCountParameter(definition: GenericNativeParameterDefinition) {
    return ["n", "batch_size", "repeat", GENERIC_NATIVE_OUTPUT_COUNT_PATH, GENERIC_NATIVE_CANVAS_BATCH_COUNT_PATH].includes(definition.path);
}

function scaleCanvasBatchQuote(quote: GenericPriceQuote, count: number): GenericPriceQuote {
    if (!Number.isInteger(count) || count <= 1) return quote;
    const multiply = (value: number | undefined) => (typeof value === "number" ? Math.round(value * count * 1_000_000) / 1_000_000 : undefined);
    return {
        ...quote,
        amount: multiply(quote.amount),
        min: multiply(quote.min),
        max: multiply(quote.max),
        fixedAmount: multiply(quote.fixedAmount),
        explanation: `${quote.explanation} · 按 ${count} 次独立请求估算`,
    };
}

export function scaleCanvasBatchQuoteFromPayload(quote: GenericPriceQuote, payload: Record<string, unknown>): GenericPriceQuote {
    const count = Number(readGenericNativeParameter(payload, GENERIC_NATIVE_CANVAS_BATCH_COUNT_PATH)) || 1;
    return scaleCanvasBatchQuote(quote, count);
}

/** 任务耗时：不足一分钟只显示秒；缺少任一时间时返回空字符串。 */
function formatGenericTaskDuration(submittedAt?: string, completedAt?: string) {
    if (!submittedAt || !completedAt) return "";
    const start = Date.parse(submittedAt);
    const end = Date.parse(completedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "";
    const total = Math.max(1, Math.round((end - start) / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}

function splitPriceForPill(formatted: string) {
    const match = /^(约\s*)?(¥)(.+)$/.exec(formatted);
    if (!match) return { value: formatted };
    return { prefix: match[1]?.trim(), currency: match[2], value: match[3]?.trim() || "" };
}

function nativeKindTitle(kind: GenericNativeNodeKind) {
    return { image: "图片", video: "视频", audio: "音频", text: "文本" }[kind];
}

function nativeAutomaticMode(kind: GenericNativeNodeKind, operationId: string, counts: GenericNativeReferenceCounts) {
    if (kind === "image") return counts.image > 0 ? "参考生图" : "文生图";
    if (kind === "video") {
        if (operationId === "video.upscale" || operationId === "suno.generate-mp4" || counts.video > 0) return "视频编辑";
        if (counts.image > 1 || counts.audio > 0 || counts.task > 0) return "多参考生视频";
        if (counts.image === 1 || operationId === "midjourney.video") return "图生视频";
        return "文生视频";
    }
    if (operationId === "audio.generate") return counts.image + counts.audio > 0 ? "参考生成音频" : "文本生成音频";
    if (operationId === "text.chat") return counts.text > 0 ? "参考文本处理" : "文本处理";
    return "";
}

function nativeKindIcon(kind: GenericNativeNodeKind, className: string) {
    if (kind === "image") return <ImageIcon className={className} />;
    if (kind === "video") return <Video className={className} />;
    if (kind === "audio") return <Music2 className={className} />;
    return <FileText className={className} />;
}

function nativePromptPlaceholder(kind: GenericNativeNodeKind, operationId: string, hasConnectedText: boolean) {
    if (hasConnectedText) return "补充描述；留空时使用已连接的文本节点";
    if (operationId === "text.chat") return "输入你希望模型回答的内容";
    if (kind === "image") return "描述你想生成或编辑的画面";
    if (kind === "video") return "描述镜头、动作、节奏和声音";
    if (kind === "audio") return "描述声音、音乐或演唱要求";
    return "输入处理要求";
}

function referenceSummary(counts: GenericNativeReferenceCounts) {
    return (["image", "video", "audio", "text", "task"] as const)
        .filter((kind) => counts[kind] > 0)
        .map((kind) => `${{ image: "图片", video: "视频", audio: "音频", text: "文本", task: "任务" }[kind]} ${counts[kind]}`)
        .join(" · ");
}
