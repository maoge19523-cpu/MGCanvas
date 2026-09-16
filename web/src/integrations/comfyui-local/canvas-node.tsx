import { App, Button, Input, InputNumber, Select, Switch } from "antd";
import { ArrowRight, CheckCircle2, Cpu, FileJson, Link2, LoaderCircle, Play, Search, SlidersHorizontal, Square, Trash2, Upload, Workflow } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { comfyNativeClient, type ComfyExposedInput, type ComfyWorkflowDefinition } from "./index";
import { isComfyWorkflowRunning, runComfyWorkflowNode, stopComfyWorkflowNode } from "./execution";
import { comfyInputPreviewUrl } from "./media-preview";
import { ensureComfyResultNodeOps, replaceComfyResultNodeOps } from "./result-nodes";
import { listComfyWorkflowDefinitions } from "./workflow-library";
import { createCanvasNode } from "@/lib/canvas/canvas-node-factory";
import { CanvasObjectReferencePicker } from "@/components/canvas/canvas-object-reference-picker";
import type { CanvasResourceKind } from "@/lib/canvas/canvas-resource-references";
import { registerNodeDefinitions } from "@/lib/canvas/node-registry";
import type { CanvasNodeData, CanvasNodeMetadata, CanvasNodePort, CanvasPortDataType, Position } from "@/types/canvas";
import type { CanvasNodeContext } from "@/types/canvas-plugin";

export const COMFY_WORKFLOW_NODE_TYPE = "comfyui-local:workflow";
const COMFY_PLUGIN_ID = "comfyui-local";

export type ComfyCanvasNodeSnapshot = {
    workflowId: string;
    environmentId: string;
    workflowHash: string;
    description?: string;
    runnable: boolean;
    inputs: ComfyWorkflowDefinition["inputs"];
    outputs: ComfyWorkflowDefinition["outputs"];
    values: Record<string, unknown>;
};

let registered = false;

export function registerComfyWorkflowCanvasNode() {
    if (registered) return;
    registered = true;
    registerNodeDefinitions(
        [
            {
                type: COMFY_WORKFLOW_NODE_TYPE,
                title: "ComfyUI 工作流",
                description: "本地 ComfyUI API 工作流",
                icon: <Cpu className="size-4" />,
                defaultSize: { width: 460, height: 280 },
                defaultMetadata: { status: "idle" },
                minimapColor: "#8b5cf6",
                showInCreateMenu: true,
                createMenuPlacement: "primary",
                autoOpenPanel: true,
                ports: (node) => comfyCanvasPorts(readComfySnapshot(node.metadata)),
                Content: ComfyWorkflowNodeContent,
                Panel: ComfyWorkflowNodePanel,
                toolbar: (ctx) => {
                    const running = isComfyWorkflowRunning(ctx.node);
                    return [
                        {
                            id: running ? "comfy-stop" : "comfy-run",
                            title: i18n.t(running ? "comfyuiLocal.canvasNode.stop" : "comfyuiLocal.canvasNode.run"),
                            label: i18n.t(running ? "comfyuiLocal.canvasNode.stop" : "comfyuiLocal.canvasNode.run"),
                            icon: running ? <Square className="size-3.5 fill-current" /> : <Play className="size-4 fill-current" />,
                            danger: running,
                            onClick: () => void (running ? stopComfyWorkflowNode(ctx) : runComfyWorkflowNode(ctx)),
                        },
                        { id: "comfy-parameters", title: i18n.t("comfyuiLocal.canvasNode.editParameters"), label: i18n.t("comfyuiLocal.canvasNode.parametersShort"), icon: <SlidersHorizontal className="size-4" />, onClick: ctx.openPanel },
                    ];
                },
            },
        ],
        COMFY_PLUGIN_ID,
    );
}

export function createComfyWorkflowCanvasNode(definition: ComfyWorkflowDefinition, position: Position): CanvasNodeData {
    return {
        ...createCanvasNode(COMFY_WORKFLOW_NODE_TYPE, position, {
            comfyuiLocal: createComfyCanvasNodeSnapshot(definition),
            status: definition.dependencySnapshot.runnable ? "idle" : "error",
            errorDetails: definition.dependencySnapshot.runnable ? undefined : "当前环境缺少工作流依赖",
        }),
        title: definition.name,
    };
}

export function createComfyCanvasNodeSnapshot(definition: ComfyWorkflowDefinition): ComfyCanvasNodeSnapshot {
    return {
        workflowId: definition.id,
        environmentId: definition.environmentId,
        workflowHash: definition.workflowHash,
        description: definition.description,
        runnable: definition.dependencySnapshot.runnable,
        inputs: definition.inputs,
        outputs: definition.outputs,
        values: Object.fromEntries(definition.inputs.map((input) => [input.id, input.defaultValue])),
    };
}

export function comfyCanvasPorts(snapshot: ComfyCanvasNodeSnapshot | null): CanvasNodePort[] {
    if (!snapshot) return [];
    return [
        ...snapshot.inputs.filter((input) => input.canvasPort).map((input) => ({ id: input.id, label: input.label, direction: "input" as const, dataType: inputPortType(input), required: input.required, multiple: false })),
        // Every selected workflow output owns a managed result node, so it must
        // remain addressable even when the user did not expose it for ad-hoc wiring.
        ...snapshot.outputs.map((output) => ({ id: output.id, label: output.label, direction: "output" as const, dataType: outputPortType(output.resourceType), multiple: true })),
    ];
}

function ComfyWorkflowNodeContent({ ctx }: { ctx: CanvasNodeContext }) {
    const { t } = useTranslation();
    const snapshot = readComfySnapshot(ctx.node.metadata);
    if (!snapshot)
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-8 text-center" style={{ color: ctx.theme.node.muted }}>
                <div className="grid size-16 place-items-center rounded-[20px] border" style={{ borderColor: ctx.theme.node.stroke, background: `${ctx.theme.toolbar.activeBg}88` }}>
                    <Workflow className="size-7 opacity-65" />
                </div>
                <div className="text-[14px] font-semibold" style={{ color: ctx.theme.node.text }}>
                    {t("comfyuiLocal.canvasNode.chooseWorkflow")}
                </div>
                <div className="max-w-72 text-[11px] leading-5 opacity-55">{t("comfyuiLocal.canvasNode.chooseWorkflowHint")}</div>
            </div>
        );
    const visibleInputs = snapshot.inputs.slice(0, 4);
    const outputTypes = [...new Set(snapshot.outputs.map((output) => output.resourceType))];
    const runPhase = readComfyRunPhase(ctx.node.metadata);
    const elapsed = formatComfyRunDuration(ctx.node.metadata);
    const running = runPhase === "preparing" || runPhase === "queued" || runPhase === "running";
    return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden px-5 py-4">
            <div className="flex items-center justify-between gap-3 border-b pb-3" style={{ borderColor: ctx.theme.toolbar.border }}>
                <div className="flex items-center gap-2.5 text-[12px] font-semibold" style={{ color: ctx.theme.node.text }}>
                    <span className="grid size-8 place-items-center rounded-lg bg-violet-500/10 text-violet-400">
                        <Cpu className="size-4" />
                    </span>
                    ComfyUI
                </div>
                <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-medium" style={{ borderColor: ctx.theme.toolbar.border, color: ctx.theme.node.muted }}>
                    {running ? (
                        <LoaderCircle className="size-3 animate-spin text-violet-400" />
                    ) : (
                        <span className={runPhase === "failed" ? "size-1.5 rounded-full bg-red-400" : snapshot.runnable ? "size-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.65)]" : "size-1.5 rounded-full bg-amber-400"} />
                    )}
                    {t(runPhase ? `comfyuiLocal.canvasNode.phase.${runPhase}` : snapshot.runnable ? "comfyuiLocal.canvasNode.ready" : "comfyuiLocal.canvasNode.missingDependencies")}
                    {elapsed ? <span className="font-medium tabular-nums opacity-90">· {t("comfyuiLocal.canvasNode.elapsed", { duration: elapsed })}</span> : null}
                </span>
            </div>
            {/* 右侧为绝对定位的端口标签留出空间，避免参数值与输出类型标签被覆盖。 */}
            <div className="grid min-h-0 flex-1 gap-4 py-4 pr-[76px] sm:grid-cols-[minmax(0,1fr)_auto]">
                <div className="grid content-start gap-2 overflow-hidden">
                    {visibleInputs.map((input) => (
                        <div key={input.id} className="flex min-w-0 items-center justify-between gap-4 text-[11px]">
                            <span className="truncate" style={{ color: ctx.theme.node.muted }}>
                                {input.label}
                            </span>
                            <span className="max-w-[58%] truncate font-mono text-[10px]" style={{ color: ctx.theme.node.text }}>
                                {displayValue(snapshot.values[input.id])}
                            </span>
                        </div>
                    ))}
                    {snapshot.inputs.length > visibleInputs.length ? (
                        <div className="pt-0.5 text-[10px] opacity-40">
                            +{snapshot.inputs.length - visibleInputs.length} {t("comfyuiLocal.canvasNode.moreParameters")}
                        </div>
                    ) : null}
                </div>
                <div className="flex flex-wrap items-start justify-end gap-1.5">
                    {outputTypes.map((type) => (
                        <span key={type} className="rounded-md border px-2 py-1 text-[9px] uppercase tracking-[0.08em]" style={{ borderColor: ctx.theme.toolbar.border, color: ctx.theme.node.muted }}>
                            {type}
                        </span>
                    ))}
                </div>
            </div>
            <div className="flex items-center justify-between border-t pt-3 text-[10px]" style={{ borderColor: ctx.theme.toolbar.border, color: ctx.theme.node.muted }}>
                <span>{t("comfyuiLocal.canvasNode.clickToEdit")}</span>
                <span className="tabular-nums">
                    {snapshot.inputs.length} {t("comfyuiLocal.canvasNode.inputs")} · {snapshot.outputs.length} {t("comfyuiLocal.canvasNode.outputs")}
                </span>
            </div>
        </div>
    );
}

function ComfyWorkflowNodePanel({ ctx, onClose }: { ctx: CanvasNodeContext; onClose: () => void }) {
    const { t } = useTranslation();
    const snapshot = readComfySnapshot(ctx.node.metadata);
    const [selectingWorkflow, setSelectingWorkflow] = useState(!snapshot);
    useEffect(() => setSelectingWorkflow(!snapshot), [snapshot]);

    const useWorkflow = (definition: ComfyWorkflowDefinition) => {
        const next = createComfyCanvasNodeSnapshot(definition);
        const metadata: CanvasNodeMetadata = {
            comfyuiLocal: next,
            comfyuiRun: undefined,
            status: definition.dependencySnapshot.runnable ? "idle" : "error",
            errorDetails: definition.dependencySnapshot.runnable ? undefined : t("comfyuiLocal.canvasNode.dependencyError"),
        };
        const source = { ...ctx.node, title: definition.name, metadata: { ...ctx.node.metadata, ...metadata } };
        const nodes = ctx.getNodes().map((node) => (node.id === source.id ? source : node));
        const resultOps = snapshot?.workflowId && snapshot.workflowId !== definition.id ? replaceComfyResultNodeOps(source, definition, nodes, ctx.getConnections()) : ensureComfyResultNodeOps(source, definition, nodes, ctx.getConnections());
        ctx.applyOps([{ type: "update_node", id: source.id, patch: { title: definition.name }, metadata }, ...resultOps]);
        setSelectingWorkflow(false);
    };

    return (
        <div
            className="overflow-hidden rounded-[22px] border p-5 shadow-[0_22px_70px_rgba(0,0,0,.28)] backdrop-blur-2xl"
            style={{ background: ctx.theme.node.panel, borderColor: ctx.theme.node.stroke, color: ctx.theme.node.text }}
            data-canvas-no-zoom
            onPointerDown={(event) => event.stopPropagation()}
        >
            {selectingWorkflow || !snapshot ? (
                <ComfyWorkflowPicker currentWorkflowId={snapshot?.workflowId} onSelect={useWorkflow} onClose={snapshot ? () => setSelectingWorkflow(false) : onClose} />
            ) : (
                <ComfyWorkflowParameters ctx={ctx} snapshot={snapshot} onChangeWorkflow={() => setSelectingWorkflow(true)} onClose={onClose} />
            )}
        </div>
    );
}

function ComfyWorkflowPicker({ currentWorkflowId, onSelect, onClose }: { currentWorkflowId?: string; onSelect: (definition: ComfyWorkflowDefinition) => void; onClose: () => void }) {
    const { t } = useTranslation();
    const [workflows, setWorkflows] = useState<ComfyWorkflowDefinition[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [keyword, setKeyword] = useState("");

    useEffect(() => {
        let disposed = false;
        setLoading(true);
        listComfyWorkflowDefinitions()
            .then((items) => {
                if (!disposed) setWorkflows(items);
            })
            .catch((reason) => {
                if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
            })
            .finally(() => {
                if (!disposed) setLoading(false);
            });
        return () => {
            disposed = true;
        };
    }, []);

    const filtered = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        if (!query) return workflows;
        return workflows.filter((workflow) => [workflow.name, workflow.description || "", workflow.workflowHash].join(" ").toLowerCase().includes(query));
    }, [keyword, workflows]);

    return (
        <div>
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h3 className="text-[17px] font-semibold">{t(currentWorkflowId ? "comfyuiLocal.canvasNode.changeWorkflow" : "comfyuiLocal.canvasNode.chooseWorkflow")}</h3>
                    <p className="mt-1 text-[11px] opacity-50">{t("comfyuiLocal.canvasNode.workflowLibraryHint")}</p>
                </div>
                <Button size="small" onClick={onClose}>
                    {t("common.cancel")}
                </Button>
            </div>
            <Input className="mt-4" allowClear prefix={<Search className="size-4 opacity-45" />} placeholder={t("comfyuiLocal.canvasNode.searchWorkflow")} value={keyword} onChange={(event) => setKeyword(event.target.value)} />
            <div className="thin-scrollbar mt-4 max-h-[310px] space-y-2 overflow-y-auto pr-1">
                {loading ? <div className="grid min-h-32 place-items-center text-[12px] opacity-45">{t("comfyuiLocal.canvasNode.loadingWorkflows")}</div> : null}
                {!loading && error ? <div className="grid min-h-32 place-items-center px-5 text-center text-[12px] text-red-400">{error}</div> : null}
                {!loading && !error
                    ? filtered.map((workflow) => {
                          const current = workflow.id === currentWorkflowId;
                          return (
                              <button
                                  key={workflow.id}
                                  type="button"
                                  className={`group flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition hover:border-violet-500/45 hover:bg-violet-500/[0.045] ${current ? "border-violet-500/45 bg-violet-500/[0.035]" : "border-black/[0.09] dark:border-white/[0.09]"}`}
                                  onClick={() => onSelect(workflow)}
                              >
                                  <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-violet-500/10 text-violet-400">
                                      <FileJson className="size-[18px]" />
                                  </span>
                                  <span className="min-w-0 flex-1">
                                      <span className="flex items-center gap-2">
                                          <span className="truncate text-[13px] font-semibold">{workflow.name}</span>
                                          {current ? <CheckCircle2 className="size-3.5 shrink-0 text-violet-400" /> : null}
                                      </span>
                                      <span className="mt-1 block truncate text-[10px] opacity-45">
                                          {workflow.inputs.length} {t("comfyuiLocal.canvasNode.inputs")} · {workflow.outputs.length} {t("comfyuiLocal.canvasNode.outputs")}
                                      </span>
                                  </span>
                                  <ArrowRight className="size-4 shrink-0 opacity-30 transition group-hover:translate-x-0.5 group-hover:opacity-80" />
                              </button>
                          );
                      })
                    : null}
                {!loading && !error && !filtered.length ? (
                    <div className="grid min-h-32 place-items-center px-5 text-center text-[12px] opacity-45">{workflows.length ? t("comfyuiLocal.canvasNode.noMatchingWorkflow") : t("comfyuiLocal.canvasNode.noWorkflows")}</div>
                ) : null}
            </div>
        </div>
    );
}

/** 常用比例预设；换算时以当前短边为基准，避免放大到模型不擅长的分辨率。 */
const ASPECT_PRESETS = [
    { key: "square", label: "1:1", ratio: 1 },
    { key: "portrait", label: "3:4", ratio: 0.75 },
    { key: "landscape", label: "4:3", ratio: 4 / 3 },
    { key: "tall", label: "9:16", ratio: 0.5625 },
    { key: "wide", label: "16:9", ratio: 16 / 9 },
] as const;

/** 尺寸取 8 的倍数：多数采样器要求分辨率对齐。 */
function align8(value: number) {
    return Math.max(64, Math.round(value / 8) * 8);
}

/** 找出工作流里成对的宽高参数（不同工作流的字段名大小写可能不同）。 */
function resolveSizePair(snapshot: ComfyCanvasNodeSnapshot) {
    const width = snapshot.inputs.find((input) => input.field.toLowerCase() === "width");
    const height = snapshot.inputs.find((input) => input.field.toLowerCase() === "height");
    if (!width || !height) return null;
    return { width, height };
}

/** 读取当前宽高数值，非有效数字时返回 null。 */
function readSizeValue(snapshot: ComfyCanvasNodeSnapshot, pair: { width: ComfyExposedInput; height: ComfyExposedInput }) {
    const width = Number(snapshot.values[pair.width.id] ?? pair.width.defaultValue);
    const height = Number(snapshot.values[pair.height.id] ?? pair.height.defaultValue);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return { width, height };
}

function ComfyWorkflowParameters({ ctx, snapshot, onChangeWorkflow, onClose }: { ctx: CanvasNodeContext; snapshot: ComfyCanvasNodeSnapshot; onChangeWorkflow: () => void; onClose: () => void }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const mediaInputRef = useRef<HTMLInputElement | null>(null);
    const pendingMediaInput = useRef<string | null>(null);
    const [uploadingMedia, setUploadingMedia] = useState(false);
    const updateValue = (id: string, value: unknown) => ctx.updateMetadata({ comfyuiLocal: { ...snapshot, values: { ...snapshot.values, [id]: value } } });
    // 一次写入多个参数：连续调用 updateValue 会基于同一份旧快照，后者覆盖前者的修改。
    const updateValues = (patch: Record<string, unknown>) => ctx.updateMetadata({ comfyuiLocal: { ...snapshot, values: { ...snapshot.values, ...patch } } });

    /** 打开文件选择器，并把结果写回指定参数。 */
    const pickMedia = (inputId: string) => {
        pendingMediaInput.current = inputId;
        mediaInputRef.current?.click();
    };

    /** 把本地文件上传到当前 ComfyUI，文件名写回参数值。 */
    const handleMediaFile = async (file: File | undefined) => {
        const inputId = pendingMediaInput.current;
        pendingMediaInput.current = null;
        if (mediaInputRef.current) mediaInputRef.current.value = "";
        if (!file || !inputId) return;
        setUploadingMedia(true);
        try {
            const uploaded = await comfyNativeClient.uploadInput(
                snapshot.environmentId,
                file.name,
                file.type || "application/octet-stream",
                Array.from(new Uint8Array(await file.arrayBuffer())),
            );
            updateValue(inputId, uploaded.subfolder ? `${uploaded.subfolder.replace(/\\/g, "/")}/${uploaded.name}` : uploaded.name);
            message.success(t("comfyuiLocal.canvasNode.mediaUploaded", { name: uploaded.name }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setUploadingMedia(false);
        }
    };
    const updateObjectReference = (inputId: string, sourceNodeId: string) => {
        const connectedIds = ctx.getInputConnections(inputId).map((connection) => connection.id);
        if (connectedIds.length) ctx.applyOps([{ type: "delete_connections", ids: connectedIds }]);
        const references = (ctx.node.metadata?.objectReferences || []).filter((reference) => reference.targetInputId !== inputId);
        ctx.updateMetadata({ objectReferences: [...references, { id: nanoid(), sourceNodeId, targetInputId: inputId, versionMode: "latest", createdAt: new Date().toISOString() }] });
    };
    const removeObjectReference = (referenceId: string) => {
        ctx.updateMetadata({ objectReferences: (ctx.node.metadata?.objectReferences || []).filter((reference) => reference.id !== referenceId) });
    };
    // 随机种子：默认每次生成随机结果，关闭后使用固定值，避免用户误调导致结果变差。
    const seedField = snapshot.inputs.find((input) => input.field === "seed" || input.field === "noise_seed");
    const seedRandom = snapshot.values.__seedRandom !== "0";
    const visibleInputs = snapshot.inputs.filter((input) => (seedRandom ? input.field !== "seed" && input.field !== "noise_seed" : true));

    // 尺寸比例预设：任何工作流只要有成对的宽高参数就会自动出现，
    // 换算时以当前尺寸的短边为基准，只改比例、不改用户的整体规模。
    const sizePair = resolveSizePair(snapshot);
    // 换算锚点：以用户最后手动编辑的那一边为准，只调整另一边，避免改动他刚填的数字。
    const sizeAnchor = useRef<"width" | "height">("width");
    const applyRatio = (ratio: number) => {
        if (!sizePair) return;
        const current = readSizeValue(snapshot, sizePair);
        if (!current) return;
        const next =
            sizeAnchor.current === "width"
                ? { width: current.width, height: Math.round(current.width / ratio) }
                : { width: Math.round(current.height * ratio), height: current.height };
        // 统一取 8 的倍数，避免模型对非对齐尺寸报错。
        updateValues({
            [sizePair.width.id]: align8(next.width),
            [sizePair.height.id]: align8(next.height),
        });
    };
    return (
        <div>
            <div className="flex items-start justify-between gap-4 border-b pb-4" style={{ borderColor: ctx.theme.toolbar.border }}>
                <div>
                    <div className="text-[17px] font-semibold">{t("comfyuiLocal.canvasNode.parameters")}</div>
                    <div className="mt-1 text-[11px] opacity-50">{t("comfyuiLocal.canvasNode.connectedOverride")}</div>
                </div>
                <div className="flex gap-2">
                    <Button size="small" onClick={onChangeWorkflow}>
                        {t("comfyuiLocal.canvasNode.changeWorkflow")}
                    </Button>
                    <Button type="primary" size="small" onClick={onClose}>
                        {t("common.done")}
                    </Button>
                </div>
            </div>
            {seedField ? (
                <div className="flex items-center justify-between gap-3 border-b py-3" style={{ borderColor: ctx.theme.node.stroke }}>
                    <span className="min-w-0">
                        <span className="block text-[12px] font-medium">{t("comfyuiLocal.canvasNode.randomSeed")}</span>
                        <span className="mt-0.5 block text-[10px] opacity-50">{t("comfyuiLocal.canvasNode.randomSeedHint")}</span>
                    </span>
                    <Switch size="small" checked={seedRandom} onChange={(checked) => updateValue("__seedRandom", checked ? "1" : "0")} />
                </div>
            ) : null}
            {sizePair ? (
                <div className="border-b py-3" style={{ borderColor: ctx.theme.node.stroke }}>
                    <div className="mb-2 text-[12px] font-medium">{t("comfyuiLocal.canvasNode.aspectRatio")}</div>
                    <div className="flex flex-wrap gap-1.5">
                        {ASPECT_PRESETS.map((preset) => (
                            <button
                                key={preset.key}
                                type="button"
                                onClick={() => applyRatio(preset.ratio)}
                                title={t(`comfyuiLocal.canvasNode.ratio.${preset.key}`)}
                                className="cursor-pointer rounded-[8px] border px-2.5 py-1 text-[11px] transition-colors hover:border-[#756bff]/50 hover:bg-[#756bff]/[0.08]"
                                style={{ borderColor: ctx.theme.node.stroke }}
                            >
                                {preset.label}
                            </button>
                        ))}
                    </div>
                </div>
            ) : null}
            <input ref={mediaInputRef} type="file" accept="image/*,video/*,audio/*" hidden onChange={(event) => void handleMediaFile(event.target.files?.[0])} />
            <div className="thin-scrollbar grid max-h-[430px] gap-4 overflow-y-auto py-5 pr-1 sm:grid-cols-2">
                {visibleInputs.map((input) => {
                    const allowedKinds = comfyInputObjectKinds(input);
                    return (
                        <ParameterControl
                            key={input.id}
                            input={input}
                            value={snapshot.values[input.id]}
                            onChange={(value) => {
                                if (input.id === sizePair?.width.id) sizeAnchor.current = "width";
                                else if (input.id === sizePair?.height.id) sizeAnchor.current = "height";
                                updateValue(input.id, value);
                            }}
                            onPickMedia={() => pickMedia(input.id)}
                            uploadingMedia={uploadingMedia}
                            referencePicker={
                                input.canvasPort && allowedKinds.length ? (
                                    <CanvasObjectReferencePicker
                                        currentNodeId={ctx.node.id}
                                        nodes={ctx.getNodes()}
                                        references={ctx.node.metadata?.objectReferences || []}
                                        targetInputId={input.id}
                                        allowedKinds={allowedKinds}
                                        onAdd={(sourceNodeId) => updateObjectReference(input.id, sourceNodeId)}
                                        onRemove={removeObjectReference}
                                    />
                                ) : undefined
                            }
                        />
                    );
                })}
            </div>
            {!snapshot.inputs.length ? <div className="py-12 text-center text-[12px] opacity-45">{t("comfyuiLocal.canvasNode.noParameters")}</div> : null}
        </div>
    );
}

/** 分辨率档位：数值为百万像素，对应常见的清晰度档位。 */
const MEGAPIXEL_PRESETS = [
    { value: 0.4, label: "480P 标清" },
    { value: 0.9, label: "720P 高清" },
    { value: 2.0, label: "1080P 全高清" },
];

/**
 * ComfyUI 枚举值的中文显示。
 * 提交给后端时必须用原始值，这里只改下拉里显示的文字。
 */
const ENUM_LABELS: Record<string, string> = {
    "1:1 (Square)": "1:1 方形",
    "2:3 (Portrait Photo)": "2:3 竖版照片",
    "3:2 (Photo)": "3:2 横版照片",
    "3:4 (Portrait Standard)": "3:4 竖版",
    "4:3 (Standard)": "4:3 横版",
    "9:16 (Portrait Widescreen)": "9:16 竖屏",
    "16:9 (Widescreen)": "16:9 横屏",
    "21:9 (Ultrawide)": "21:9 超宽",
    match: "按生成尺寸匹配",
    max: "最高精度（较慢）",
};

/** 清空素材时使用的占位值：ComfyUI 把 None 视为「没有素材」。 */
const EMPTY_MEDIA = "None";

/** 解析已上传素材在当前环境的预览地址。 */
function useComfyInputPreview(filename: string) {
    const [url, setUrl] = useState("");
    useEffect(() => {
        let active = true;
        if (!filename) {
            setUrl("");
            return undefined;
        }
        void comfyInputPreviewUrl(filename)
            .then((next) => {
                if (active) setUrl(next);
            })
            .catch(() => undefined);
        return () => {
            active = false;
        };
    }, [filename]);
    return url;
}

/** 已上传素材的预览：图片看缩略图（可点击放大）、音频可试听、视频可播放。 */
function MediaPreview({ name, kind }: { name: string; kind: string }) {
    const url = useComfyInputPreview(name);
    const [expanded, setExpanded] = useState(false);
    if (!url) return null;
    if (kind === "image")
        return (
            <>
                <img
                    src={url}
                    alt={name}
                    className="mt-2 max-h-32 w-full cursor-zoom-in rounded-lg object-contain transition-opacity hover:opacity-90"
                    style={{ background: "rgba(0,0,0,.18)" }}
                    onClick={(event) => {
                        event.stopPropagation();
                        setExpanded(true);
                    }}
                />
                {/* 放大层挂到 body：画布节点带缩放变换，直接定位会被一起缩放 */}
                {expanded
                    ? createPortal(
                          <div
                              className="fixed inset-0 z-[9999] flex cursor-zoom-out items-center justify-center bg-black/75 p-6"
                              onClick={(event) => {
                                  event.stopPropagation();
                                  setExpanded(false);
                              }}
                          >
                              <img src={url} alt={name} className="max-h-full max-w-full rounded-lg object-contain shadow-2xl" />
                          </div>,
                          document.body,
                      )
                    : null}
            </>
        );
    if (kind === "audio") return <audio src={url} controls className="mt-2 w-full" />;
    if (kind === "video") return <video src={url} controls className="mt-2 max-h-40 w-full rounded-lg" />;
    return null;
}
function ParameterControl({ input, value, onChange, onPickMedia, uploadingMedia, referencePicker }: { input: ComfyExposedInput; value: unknown; onChange: (value: unknown) => void; onPickMedia: () => void; uploadingMedia: boolean; referencePicker?: ReactNode }) {
    const { t } = useTranslation();
    const label = (
        <div className="mb-2 flex min-w-0 items-center gap-2 text-[11px] font-medium opacity-65" title={input.label}>
            <span className="truncate">{input.label}</span>
            {input.canvasPort ? (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-violet-500/10 px-1.5 py-0.5 text-[9px] text-violet-400">
                    <Link2 className="size-2.5" />
                    {t("comfyuiLocal.canvasNode.port")}
                </span>
            ) : null}
            <span className="ml-auto">{referencePicker}</span>
        </div>
    );
    if (input.control === "media") {
        // 媒体参数必须能直接上传本地文件，也要能清空：用不到的参考图 / 音频不应强制保留。
        const mediaName = typeof value === "string" && value && value !== EMPTY_MEDIA ? value : "";
        return (
            <div className="block">
                {label}
                <div className="flex flex-wrap items-center gap-2">
                    <Button size="small" icon={<Upload className="size-3.5" />} loading={uploadingMedia} onClick={onPickMedia}>
                        {t("comfyuiLocal.canvasNode.uploadMedia")}
                    </Button>
                    {mediaName ? (
                        <>
                            <span className="min-w-0 flex-1 truncate text-[11px] opacity-60" title={mediaName}>
                                {mediaName}
                            </span>
                            <Button
                                size="small"
                                type="text"
                                danger
                                icon={<Trash2 className="size-3.5" />}
                                onClick={() => onChange(EMPTY_MEDIA)}
                                aria-label={t("comfyuiLocal.canvasNode.clearMedia")}
                            />
                        </>
                    ) : (
                        <span className="text-[11px] opacity-45">{t("comfyuiLocal.canvasNode.noMedia", { type: input.valueType })}</span>
                    )}
                </div>
                <MediaPreview name={mediaName} kind={input.valueType} />
            </div>
        );
    }
    if (input.control === "switch")
        return (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.07] px-3 py-2.5">
                {label}
                <Switch size="small" checked={Boolean(value)} onChange={onChange} />
            </div>
        );
    if (input.control === "select")
        return (
            <div className="block">
                {label}
                <Select className="w-full" size="small" value={typeof value === "string" ? value : undefined} options={(input.enumValues || []).map((item) => ({ value: item, label: ENUM_LABELS[item] ?? item }))} onChange={onChange} />
            </div>
        );
    // 分辨率档位用固定三档下拉，比让用户填百万像素直观。
    if (input.classType === "ResolutionSelector" && input.field === "megapixels")
        return (
            <div className="block">
                {label}
                <Select
                    className="w-full"
                    size="small"
                    value={typeof value === "number" ? value : undefined}
                    options={MEGAPIXEL_PRESETS.map((preset) => ({ value: preset.value, label: preset.label }))}
                    onChange={onChange}
                />
            </div>
        );
    if (input.control === "number")
        return (
            <div className="block">
                {label}
                <InputNumber className="w-full" size="small" value={typeof value === "number" ? value : undefined} min={numberConstraint(input, "min")} max={numberConstraint(input, "max")} step={numberConstraint(input, "step")} onChange={onChange} />
            </div>
        );
    if (input.control === "textarea" || input.control === "json")
        return (
            <div className="block sm:col-span-2">
                {label}
                <Input.TextArea
                    rows={4}
                    className="!resize-y"
                    value={input.control === "json" ? JSON.stringify(value, null, 2) : String(value ?? "")}
                    onChange={(event) => onChange(input.control === "json" ? parseJsonOrText(event.target.value) : event.target.value)}
                />
            </div>
        );
    return (
        <div className="block">
            {label}
            <Input size="small" value={String(value ?? "")} onChange={(event) => onChange(event.target.value)} />
        </div>
    );
}

function comfyInputObjectKinds(input: ComfyExposedInput): CanvasResourceKind[] {
    if (input.valueType === "image") return ["image"];
    if (input.valueType === "video") return ["video"];
    if (input.valueType === "audio") return ["audio"];
    if (input.valueType === "string" || input.valueType === "enum" || input.valueType === "json" || input.valueType === "integer" || input.valueType === "number" || input.valueType === "boolean") return ["text"];
    return [];
}

function readComfySnapshot(metadata?: CanvasNodeMetadata): ComfyCanvasNodeSnapshot | null {
    const value = metadata?.comfyuiLocal;
    if (!value || typeof value !== "object") return null;
    const snapshot = value as Partial<ComfyCanvasNodeSnapshot>;
    return snapshot.workflowId && snapshot.environmentId && Array.isArray(snapshot.inputs) && Array.isArray(snapshot.outputs) && snapshot.values ? (snapshot as ComfyCanvasNodeSnapshot) : null;
}

/** 运行耗时：不足一分钟只显示秒，未完成时返回空字符串。 */
function formatComfyRunDuration(metadata?: CanvasNodeMetadata) {
    const value = metadata?.comfyuiRun;
    if (!value || typeof value !== "object") return "";
    const run = value as { startedAt?: unknown; completedAt?: unknown };
    const startedAt = typeof run.startedAt === "number" ? run.startedAt : 0;
    const completedAt = typeof run.completedAt === "number" ? run.completedAt : 0;
    if (!startedAt || !completedAt || completedAt < startedAt) return "";
    const total = Math.max(1, Math.round((completedAt - startedAt) / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}

function readComfyRunPhase(metadata?: CanvasNodeMetadata) {
    const value = metadata?.comfyuiRun;
    if (!value || typeof value !== "object") return "";
    const phase = (value as { phase?: unknown }).phase;
    return typeof phase === "string" ? phase : "";
}

function inputPortType(input: ComfyExposedInput): CanvasPortDataType {
    if (input.valueType === "integer" || input.valueType === "number") return "number";
    if (input.valueType === "boolean") return "boolean";
    if (input.valueType === "json") return "json";
    if (input.valueType === "enum" || input.valueType === "string") return "text";
    return input.valueType;
}

function outputPortType(resourceType: ComfyWorkflowDefinition["outputs"][number]["resourceType"]): CanvasPortDataType {
    return resourceType === "file" ? "any" : resourceType;
}

function displayValue(value: unknown) {
    if (value === undefined || value === null || value === "") return "—";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
}

function numberConstraint(input: ComfyExposedInput, key: "min" | "max" | "step") {
    const value = input.constraints?.[key];
    return typeof value === "number" ? value : undefined;
}

function parseJsonOrText(value: string) {
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return value;
    }
}
