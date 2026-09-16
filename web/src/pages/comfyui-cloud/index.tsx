import { useCallback, useEffect, useState } from "react";
import { App, Button, Input, Modal, Tag } from "antd";
import { AlertCircle, Cloud, Link2, Play, RefreshCw, Sparkles, Square, Trash2, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { WorkspacePage } from "@/components/layout/workspace-page";
import { comfyNativeClient, type ComfyEnvironmentStatus, type ComfyWorkflowDefinition } from "@/integrations/comfyui-local";
import { createComfyWorkflowCanvasNode } from "@/integrations/comfyui-local/canvas-node";
import { openWorkflowInNewCanvas } from "@/integrations/comfyui-local/open-workflow-canvas";
import { deleteComfyWorkflowDefinition, listComfyWorkflowDefinitions } from "@/integrations/comfyui-local/workflow-library";
import { demosForScope, groupDemosByCategory, isCloudWorkflow, type ComfyDemoWorkflow } from "@/integrations/comfyui-local/demo-workflows";
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


    const cloudDemos = demosForScope("cloud");
    const demoGroups = groupDemosByCategory(cloudDemos);
    const [demoPickerOpen, setDemoPickerOpen] = useState(false);
    // 明确声明云端场景：未连接云端时不会回退到本地环境，避免装成本地示例。
    const workflowImport = useComfyWorkflowImport({ scope: "cloud", onImported: () => loadWorkflows() });

    const loadWorkflows = useCallback(async () => {
        // 只展示云端环境的工作流：本地导入的工作流不在云端列表出现。
        setWorkflows((await listComfyWorkflowDefinitions()).filter(isCloudWorkflow));
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

    /** 刷新云端状态：明确告知云端连接是否成功。 */
    const refresh = async () => {
        setRefreshing(true);
        try {
            const next = await comfyNativeClient.status();
            setStatus(next);
            await loadWorkflows();
            if (next.remoteBaseUrl) message.success(t("comfyuiCloud.refreshConnected", { url: next.remoteBaseUrl }));
            else message.warning(t("comfyuiCloud.refreshDisconnected"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setRefreshing(false);
        }
    };

    /** 安装选中的示例并直接打开带该工作流的新画布。 */
    const installDemo = async (demo: ComfyDemoWorkflow) => {
        setDemoPickerOpen(false);
        const installed = await workflowImport.installDemo(demo);
        if (installed) navigate(`/canvas/${openWorkflowInNewCanvas(installed)}`);
    };

    /** 把云端工作流作为节点加入一个全新画布。 */
    const addToCanvas = (definition: ComfyWorkflowDefinition) => {
        navigate(`/canvas/${openWorkflowInNewCanvas(definition)}`);
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
                            <dl className="mt-5 grid gap-4 border-t border-black/[0.06] pt-4 text-[11px] dark:border-white/[0.06] sm:grid-cols-2">
                                <div className="min-w-0">
                                    <dt className="text-stone-400 dark:text-zinc-600">{t("comfyuiCloud.state")}</dt>
                                    <dd className="mt-1 truncate text-stone-700 dark:text-zinc-300" title={connected ? (status.remoteBaseUrl ?? undefined) : undefined}>
                                        {connected ? status.remoteBaseUrl : t("comfyuiCloud.disconnected")}
                                    </dd>
                                </div>
                                <div className="min-w-0">
                                    <dt className="text-stone-400 dark:text-zinc-600">{t("comfyuiCloud.workflowCount")}</dt>
                                    <dd className="mt-1 tabular-nums text-stone-700 dark:text-zinc-300">{workflows.length}</dd>
                                </div>
                            </dl>
                        </div>

                        <div className="mt-8">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                                <h3 className="text-[15px] font-semibold text-stone-950 dark:text-zinc-100">{t("comfyuiCloud.libraryTitle")}</h3>
                                <div className="flex flex-wrap gap-2">
                                    <Button icon={<Sparkles className="size-4" />} onClick={() => setDemoPickerOpen(true)} loading={workflowImport.importing} disabled={!cloudDemos.length}>
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

            <Modal open={demoPickerOpen} title={t("comfyuiCloud.demoPickerTitle")} footer={null} onCancel={() => setDemoPickerOpen(false)} width={560}>
                <div className="max-h-[60vh] overflow-y-auto pt-2">
                    {demoGroups.map((group) => (
                        <div key={group.category} className="mb-5 last:mb-0">
                            <div className="mb-2 text-[11px] font-semibold tracking-[0.16em] text-stone-400 dark:text-zinc-600">{group.label}</div>
                            <div className="grid gap-2">
                                {group.items.map((demo) => (
                                    <button
                                        key={demo.id}
                                        type="button"
                                        className="cursor-pointer rounded-[12px] border border-black/[0.08] p-3 text-left transition-colors hover:border-[#756bff]/40 hover:bg-[#756bff]/[0.04] dark:border-white/[0.08] dark:hover:bg-[#756bff]/[0.06]"
                                        onClick={() => void installDemo(demo)}
                                    >
                                        <div className="text-[13px] font-medium text-stone-900 dark:text-zinc-100">{demo.name}</div>
                                        <div className="mt-1 text-[11px] leading-5 text-stone-500 dark:text-zinc-500">{demo.description}</div>
                                    </button>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            </Modal>
        </WorkspacePage>
    );
}
