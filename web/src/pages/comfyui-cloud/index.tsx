import { useCallback, useEffect, useState } from "react";
import { App, Button, Input, Tag } from "antd";
import { AlertCircle, Cloud, Link2, Play, RefreshCw, Sparkles, Square, Trash2, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { WorkspacePage } from "@/components/layout/workspace-page";
import { comfyNativeClient, type ComfyEnvironmentStatus, type ComfyWorkflowDefinition } from "@/integrations/comfyui-local";
import { createComfyWorkflowCanvasNode } from "@/integrations/comfyui-local/canvas-node";
import { createComfyResultNodes } from "@/integrations/comfyui-local/result-nodes";
import { deleteComfyWorkflowDefinition, listComfyWorkflowDefinitions } from "@/integrations/comfyui-local/workflow-library";
import { useComfyWorkflowImport } from "@/integrations/comfyui-local/use-workflow-import";
import { isTauriRuntime } from "@/services/platform/desktop-runtime";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

const EMPTY_STATUS: ComfyEnvironmentStatus = { phase: "idle" };

/** 云端 ComfyUI 页面：填入代理地址直连，无需本地安装。 */
export default function ComfyUiCloudPage() {
    const { message, modal } = App.useApp();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const desktop = isTauriRuntime();
    const createProject = useCanvasStore((state) => state.createProject);
    const updateProject = useCanvasStore((state) => state.updateProject);
    const [url, setUrl] = useState("");
    const [status, setStatus] = useState<ComfyEnvironmentStatus>(EMPTY_STATUS);
    const [connecting, setConnecting] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [workflows, setWorkflows] = useState<ComfyWorkflowDefinition[]>([]);


    const workflowImport = useComfyWorkflowImport({ onImported: () => loadWorkflows() });

    const loadWorkflows = useCallback(async () => {
        setWorkflows(await listComfyWorkflowDefinitions());
    }, []);

    useEffect(() => {
        void loadWorkflows();
        void comfyNativeClient.status().then(setStatus).catch(() => undefined);
    }, [loadWorkflows]);

    const connected = Boolean(status.remoteBaseUrl);

    const connect = async () => {
        const target = url.trim();
        if (!target) {
            message.warning(t("comfyuiLocal.cloud.empty"));
            return;
        }
        setConnecting(true);
        try {
            setStatus(await comfyNativeClient.connectRemote(target));
            message.success(t("comfyuiLocal.cloud.connected"));
            await loadWorkflows();
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setConnecting(false);
        }
    };

    /** 断开云端连接（同时清掉本地运行态）。 */
    const disconnect = async () => {
        setConnecting(true);
        try {
            setStatus(await comfyNativeClient.disconnectRemote());
            message.success(t("comfyuiCloud.disconnectDone"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setConnecting(false);
        }
    };

    /** 刷新云端状态：给出 loading 与结果提示，避免"点了没反应"。 */
    const refresh = async () => {
        setRefreshing(true);
        try {
            setStatus(await comfyNativeClient.status());
            await loadWorkflows();
            message.success(t("comfyuiCloud.refreshed"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setRefreshing(false);
        }
    };

    /** 把云端工作流作为节点加入一个全新画布。 */
    const addToCanvas = (definition: ComfyWorkflowDefinition) => {
        const projectId = createProject(definition.name);
        const target = useCanvasStore.getState().openProject(projectId);
        if (!target) return;
        const viewport = target.viewport;
        const position = {
            x: (Math.max(900, window.innerWidth) / 2 - viewport.x) / viewport.k,
            y: (Math.max(640, window.innerHeight) / 2 - viewport.y) / viewport.k,
        };
        const workflowNode = createComfyWorkflowCanvasNode(definition, position);
        const resultGraph = createComfyResultNodes(workflowNode, definition);
        updateProject(projectId, {
            nodes: [...target.nodes, workflowNode, ...resultGraph.nodes],
            connections: [...target.connections, ...resultGraph.connections],
        });
        navigate(`/canvas/${projectId}`);
    };

    const removeWorkflow = (definition: ComfyWorkflowDefinition) => {
        modal.confirm({
            title: t("comfyuiLocal.library.deleteTitle"),
            content: t("comfyuiLocal.library.deleteDescription", { name: definition.name }),
            okText: t("common.delete"),
            okButtonProps: { danger: true },
            cancelText: t("common.cancel"),
            onOk: async () => {
                await deleteComfyWorkflowDefinition(definition.id);
                setWorkflows((current) => current.filter((item) => item.id !== definition.id));
            },
        });
    };

    return (
        <WorkspacePage icon={Cloud} title={t("comfyuiCloud.title")} description={t("comfyuiCloud.description")}>
            <input ref={workflowImport.packInputRef} type="file" accept=".json,.mgpack,application/json" multiple hidden onChange={(event) => void workflowImport.importFiles(event.target.files)} />
            <div className="mx-auto max-w-[1080px]">
                {!desktop ? (
                    <section className="border-y border-amber-500/20 bg-amber-500/[0.04] px-5 py-8 sm:px-8">
                        <h2 className="text-[15px] font-semibold">{t("comfyuiLocal.desktopOnly.title")}</h2>
                        <p className="mt-2 max-w-2xl text-[12px] leading-6 text-stone-500 dark:text-zinc-400">{t("comfyuiLocal.desktopOnly.description")}</p>
                    </section>
                ) : (
                    <section className="py-6">
                        <div className="border border-violet-500/25 bg-violet-500/[0.035] p-5">
                            <div className="flex flex-wrap items-center gap-2">
                                <Link2 className="size-4 text-violet-500" strokeWidth={2} />
                                <h2 className="text-[15px] font-semibold text-stone-950 dark:text-zinc-100">{t("comfyuiCloud.endpointTitle")}</h2>
                                {connected ? (
                                    <Tag color="success" className="!mr-0">
                                        {t("comfyuiLocal.setup.cloudConnected")}
                                    </Tag>
                                ) : null}
                            </div>
                            <p className="mt-2 max-w-3xl text-[12px] leading-6 text-stone-500 dark:text-zinc-400">{t("comfyuiCloud.endpointHint")}</p>
                            <div className="mt-4 flex flex-wrap items-center gap-2">
                                <Input
                                    value={url}
                                    onChange={(event) => setUrl(event.target.value)}
                                    placeholder="https://www.runninghub.cn/proxy/your-api-key"
                                    allowClear
                                    className="min-w-[280px] flex-1"
                                />
                                <Button type="primary" icon={<Play className="size-4" />} onClick={() => void connect()} loading={connecting}>
                                    {t("comfyuiLocal.cloud.connect")}
                                </Button>
                                <Button icon={<RefreshCw className="size-4" />} onClick={() => void refresh()} loading={refreshing}>
                                    {t("comfyuiLocal.runtime.refresh")}
                                </Button>
                                <Button danger icon={<Square className="size-4" />} onClick={() => void disconnect()} disabled={!connected} loading={connecting}>
                                    {t("comfyuiCloud.disconnect")}
                                </Button>
                            </div>
                            <dl className="mt-5 grid gap-3 text-[11px] sm:grid-cols-2">
                                <div className="flex items-center justify-between gap-3">
                                    <dt className="text-stone-400 dark:text-zinc-600">{t("comfyuiCloud.state")}</dt>
                                    <dd className="tabular-nums text-stone-700 dark:text-zinc-300">
                                        {connected ? status.remoteBaseUrl : t("comfyuiCloud.disconnected")}
                                    </dd>
                                </div>
                                <div className="flex items-center justify-between gap-3">
                                    <dt className="text-stone-400 dark:text-zinc-600">{t("comfyuiCloud.workflowCount")}</dt>
                                    <dd className="tabular-nums text-stone-700 dark:text-zinc-300">{workflows.length}</dd>
                                </div>
                            </dl>
                        </div>

                        <div className="mt-8">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                                <h3 className="text-[15px] font-semibold text-stone-950 dark:text-zinc-100">{t("comfyuiCloud.libraryTitle")}</h3>
                                <div className="flex flex-wrap gap-2">
                                    <Button icon={<Sparkles className="size-4" />} onClick={() => void workflowImport.installDemo()} loading={workflowImport.importing}>
                                        {t("comfyuiLocal.pack.installDemo")}
                                    </Button>
                                    <Button icon={<Upload className="size-4" />} onClick={() => workflowImport.openPicker()} loading={workflowImport.importing}>
                                        {t("comfyuiLocal.pack.import")}
                                    </Button>
                                </div>
                            </div>
                            <p className="mt-2 text-[11px] leading-5 text-stone-500 dark:text-zinc-500">{t("comfyuiCloud.libraryHint")}</p>
                            {workflows.length ? (
                                <ul className="mt-4 border-t border-black/[0.07] dark:border-white/[0.07]">
                                    {workflows.map((item) => (
                                        <li key={item.id} className="flex items-center gap-4 border-b border-black/[0.07] py-3 dark:border-white/[0.07]">
                                            <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-violet-500/[0.12] text-violet-500">
                                                <Cloud className="size-4" strokeWidth={2} />
                                            </span>
                                            <span className="min-w-0 flex-1">
                                                <span className="block truncate text-[13px] font-medium text-stone-900 dark:text-zinc-100">{item.name}</span>
                                                <span className="mt-0.5 block text-[11px] text-stone-400 dark:text-zinc-600">
                                                    {item.inputs.length} inputs · {item.outputs.length} outputs · {item.id.slice(0, 8)}
                                                </span>
                                            </span>
                                            <Button size="small" icon={<Trash2 className="size-3.5" />} danger type="text" onClick={() => removeWorkflow(item)} aria-label={t("common.delete")} />
                                            <Button size="small" icon={<Play className="size-3.5" />} onClick={() => addToCanvas(item)}>
                                                {t("comfyuiCloud.addToCanvas")}
                                            </Button>
                                        </li>
                                    ))}
                                </ul>
                            ) : (
                                <div className="mt-4 flex min-h-[140px] items-center gap-3 border-y border-black/[0.07] text-[12px] text-stone-400 dark:border-white/[0.07] dark:text-zinc-600">
                                    <AlertCircle className="size-4 shrink-0 text-amber-500" strokeWidth={2} />
                                    {t("comfyuiCloud.emptyLibraryCloud")}
                                </div>
                            )}
                        </div>
                    </section>
                )}
            </div>
        </WorkspacePage>
    );
}
