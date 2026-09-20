import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { App, Button, Input, Modal, Progress, Tooltip } from "antd";
import { AlertCircle, ArrowRight, ChevronDown, CircleStop, Cloud, Cpu, ExternalLink, FileJson, FolderOpen, LoaderCircle, Play, Plus, RefreshCw, Sparkles, TerminalSquare, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { WorkspacePage } from "@/components/layout/workspace-page";
import { comfyNativeClient, inferComfyStartupStage, summarizeComfyDevice, summarizeComfyModelCounts, type ComfyDeviceSummary, type ComfyEnvironmentDetection, type ComfyEnvironmentLogEntry, type ComfyEnvironmentProfile, type ComfyEnvironmentStatus, type ComfyModelCount, type ComfyStartupStage, type ComfyWorkflowDefinition } from "@/integrations/comfyui-local";
import { isCloudWorkflow } from "@/integrations/comfyui-local/demo-workflows";
import { upgradeLegacyDemoWorkflows } from "@/integrations/comfyui-local/demo-sync";
import { useComfyWorkflowImport } from "@/integrations/comfyui-local/use-workflow-import";
import { openWorkflowInNewCanvas } from "@/integrations/comfyui-local/open-workflow-canvas";
import { createComfyResultNodes } from "@/integrations/comfyui-local/result-nodes";
import { ComfyWorkflowImportWizard } from "@/integrations/comfyui-local/workflow-import-wizard";
import { comfyWorkflowPackName, importComfyWorkflowPack, parseComfyWorkflowPack, type ComfyWorkflowPackEntry } from "@/integrations/comfyui-local/workflow-pack";
import { deleteComfyWorkflowDefinition, listComfyWorkflowDefinitions } from "@/integrations/comfyui-local/workflow-library";
import { cn } from "@/lib/utils";
import { invokeDesktop, isTauriRuntime } from "@/services/platform/desktop-runtime";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

const EMPTY_STATUS: ComfyEnvironmentStatus = { phase: "idle" };

/** 云端环境没有本地 profile，用固定标识绑定工作流。 */
const CLOUD_ENVIRONMENT_ID = "cloud-remote";

/** 依赖名可能很多，只列前几个再补总数，避免撑爆工作流列表。 */
const MAX_LISTED_DEPENDENCIES = 5;

/** 每个启动阶段允许到达的最大进度：阶段没变就不该让进度条自己先跑满。 */
const STARTUP_STAGE_CEILING: Record<ComfyStartupStage, number> = {
    checking: 18,
    process: 42,
    loading: 88,
    endpoint: 96,
    ready: 100,
    failed: 100,
};

function summarizeDependencies(names: string[]) {
    return names.length > MAX_LISTED_DEPENDENCIES
        ? `${names.slice(0, MAX_LISTED_DEPENDENCIES).join("、")} +${names.length - MAX_LISTED_DEPENDENCIES}`
        : names.join("、");
}

export default function ComfyUiLocalPage() {
    const { message, modal } = App.useApp();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const createProject = useCanvasStore((state) => state.createProject);
    const updateProject = useCanvasStore((state) => state.updateProject);
    const desktop = isTauriRuntime();
    const [profile, setProfile] = useState<ComfyEnvironmentProfile | null>(null);
    const [status, setStatus] = useState<ComfyEnvironmentStatus>(EMPTY_STATUS);
    const [logs, setLogs] = useState<ComfyEnvironmentLogEntry[]>([]);
    const [detection, setDetection] = useState<ComfyEnvironmentDetection | null>(null);
    const [selectedRoot, setSelectedRoot] = useState("");
    const [editing, setEditing] = useState(false);
    const [loading, setLoading] = useState(desktop);
    const [detecting, setDetecting] = useState(false);
    const [action, setAction] = useState<"start" | "stop" | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    // 云端 ComfyUI（如 RunningHub 代理）：填地址即可直连，无需本地环境
    const [cloudOpen, setCloudOpen] = useState(false);
    const [cloudUrl, setCloudUrl] = useState("");
    const [connecting, setConnecting] = useState(false);
    const [workflows, setWorkflows] = useState<ComfyWorkflowDefinition[]>([]);
    const [importOpen, setImportOpen] = useState(false);

    const refreshRuntime = useCallback(async () => {
        if (!desktop) return;
        const [nextStatus, nextLogs] = await Promise.all([comfyNativeClient.status(), comfyNativeClient.logs()]);
        setStatus(nextStatus);
        setLogs(nextLogs);
        return nextStatus;
    }, [desktop]);

    /** 手动刷新：报告真实的连接 / 启动结果，而不是笼统的"已刷新"。 */
    const refreshFromButton = async () => {
        if (!desktop) return;
        setRefreshing(true);
        try {
            const next = await refreshRuntime();
            if (next?.remoteBaseUrl) message.success(t("comfyuiLocal.runtime.refreshCloud", { url: next.remoteBaseUrl }));
            else if (next?.phase === "running") message.success(t("comfyuiLocal.runtime.refreshRunning", { port: next.port ? `127.0.0.1:${next.port}` : "—" }));
            else if (next?.phase === "starting") message.info(t("comfyuiLocal.runtime.refreshStarting"));
            else message.warning(t("comfyuiLocal.runtime.refreshIdle"));
        } catch (error) {
            message.error(errorMessage(error));
        } finally {
            setRefreshing(false);
        }
    };

    useEffect(() => {
        let disposed = false;
        const unlisten: UnlistenFn[] = [];
        const initialize = async () => {
            try {
                const saved = desktop ? await comfyNativeClient.savedEnvironments() : { profiles: [], activeProfileId: undefined };
                const savedProfile = saved.profiles.find((item) => item.id === saved.activeProfileId) || saved.profiles[0] || null;
                if (!disposed) setProfile(savedProfile);
                if (desktop) await refreshRuntime();
                if (!desktop) return;
                const statusUnlisten = await listen<ComfyEnvironmentStatus>("comfyui-local://status", ({ payload }) => {
                    if (!disposed) setStatus(payload);
                });
                if (disposed) statusUnlisten();
                else unlisten.push(statusUnlisten);
                const logUnlisten = await listen<ComfyEnvironmentLogEntry>("comfyui-local://log", ({ payload }) => {
                    if (!disposed) setLogs((current) => [...current.slice(-999), payload]);
                });
                if (disposed) logUnlisten();
                else unlisten.push(logUnlisten);
            } catch (error) {
                if (!disposed) message.error(errorMessage(error));
            } finally {
                if (!disposed) setLoading(false);
            }
        };
        void initialize();
        return () => {
            disposed = true;
            unlisten.forEach((dispose) => dispose());
        };
    }, [desktop, message, refreshRuntime]);

    /** 手动刷新：给出 loading 与结果提示，避免"点了没反应"。 */

    useEffect(() => {
        let disposed = false;
        void listComfyWorkflowDefinitions()
            .then((items) => {
                if (!disposed) setWorkflows(items);
            })
            .catch((error) => {
                if (!disposed) message.error(errorMessage(error));
            });
        return () => {
            disposed = true;
        };
    }, [message]);

    // 老版本随包分发的示例引用了本机不存在的模型，首次在本机环境就绪时就地升级，
    // 这样库里和画布上已引用的节点都会换成当前示例。
    // 本地页只展示本地环境的工作流，云端导入的工作流不在本地列表出现。
    const localWorkflows = useMemo(() => workflows.filter((item) => !isCloudWorkflow(item)), [workflows]);

    const demoImport = useComfyWorkflowImport({
        localEnvironmentId: profile?.id,
        onImported: async () => setWorkflows(await listComfyWorkflowDefinitions()),
    });

    const legacyDemoChecked = useRef(false);
    useEffect(() => {
        if (legacyDemoChecked.current || !desktop || !profile || status.phase !== "running") return;
        legacyDemoChecked.current = true;
        void upgradeLegacyDemoWorkflows("local", profile.id)
            .then(async (count) => {
                if (!count) return;
                setWorkflows(await listComfyWorkflowDefinitions());
                message.success(t("comfyuiLocal.pack.demoUpgraded"));
            })
            .catch(() => undefined);
    }, [desktop, message, profile, status.phase, t]);

    const running = status.phase === "running";
    const busy = status.phase === "starting" || action !== null;
    const setupMode = !profile || editing;
    const recentLogs = useMemo(() => logs.slice(-80), [logs]);

    const inspectEnvironment = async (selectPython = false) => {
        setDetecting(true);
        setDetection(null);
        try {
            const result = selectPython ? await comfyNativeClient.selectEnvironmentPython() : await comfyNativeClient.selectEnvironment();
            if (!result) return null;
            setDetection(result);
            setSelectedRoot(result.selectedRoot);
            return result;
        } catch (error) {
            message.error(errorMessage(error));
            return null;
        } finally {
            setDetecting(false);
        }
    };

    const chooseRootDirectory = async () => {
        if (!desktop) return;
        await inspectEnvironment();
    };

    const choosePython = async () => {
        if (!selectedRoot) return;
        await inspectEnvironment(true);
    };

    const useEnvironment = async (nextProfile: ComfyEnvironmentProfile, startAfterSave: boolean) => {
        const active = status.phase === "running" || status.phase === "starting";
        const switching = Boolean(profile && profile.id !== nextProfile.id);
        if (switching && active) {
            setAction("stop");
            try {
                setStatus(await comfyNativeClient.stopEnvironment());
            } catch (error) {
                message.error(errorMessage(error));
                return;
            } finally {
                setAction(null);
            }
        }
        setProfile(nextProfile);
        setEditing(false);
        message.success(t("comfyuiLocal.setup.saved"));
        if (startAfterSave && !(active && !switching)) await startEnvironment(nextProfile);
    };

    const saveEnvironment = async () => {
        const nextProfile = detection?.profile;
        if (!nextProfile || !detection.ready) return;
        await useEnvironment(nextProfile, true);
    };

    const connectCloud = async () => {
        const target = cloudUrl.trim();
        if (!target) {
            message.warning(t("comfyuiLocal.cloud.empty"));
            return;
        }
        setConnecting(true);
        try {
            setStatus(await comfyNativeClient.connectRemote(target));
            setCloudOpen(false);
            message.success(t("comfyuiLocal.cloud.connected"));
            await refreshRuntime();
        } catch (error) {
            message.error(errorMessage(error));
        } finally {
            setConnecting(false);
        }
    };

    const startEnvironment = async (target = profile) => {
        if (!target) {
            message.warning(t("comfyuiLocal.setup.needEnvironment"));
            return;
        }
        setAction("start");
        try {
            const result = await comfyNativeClient.startEnvironment(target.id);
            setStatus(result.status);
            message.success(t("comfyuiLocal.runtime.starting"));
        } catch (error) {
            message.error(errorMessage(error));
            await refreshRuntime().catch(() => undefined);
        } finally {
            setAction(null);
        }
    };

    const stopEnvironment = async () => {
        setAction("stop");
        try {
            setStatus(await comfyNativeClient.stopEnvironment());
            message.success(t("comfyuiLocal.runtime.stopped"));
        } catch (error) {
            message.error(errorMessage(error));
        } finally {
            setAction(null);
        }
    };

    const changeEnvironment = async () => {
        if (!desktop || busy) return;
        const result = await inspectEnvironment();
        if (!result) return;
        if (!result.profile || !result.ready) {
            setEditing(true);
            return;
        }
        await useEnvironment(result.profile, true);
    };

    const forgetEnvironment = async () => {
        if (running || status.phase === "starting") return;
        if (profile) await comfyNativeClient.removeEnvironment(profile.id);
        setProfile(null);
        setDetection(null);
        setSelectedRoot("");
        setEditing(false);
    };

    // 本地页只反映本机环境状态。仅在「云端占用且本地没有进程」时归零，
    // 一旦本地进程起来（有 pid），就显示真实的本地状态与进度。
    const localStatus: ComfyEnvironmentStatus = status.remoteBaseUrl && !status.pid ? EMPTY_STATUS : status;

    /** 在系统浏览器中打开本机 ComfyUI 界面。 */
    const openConsole = async () => {
        const port = localStatus.port;
        if (!port) {
            message.warning(t("comfyuiLocal.runtime.consoleUnavailable"));
            return;
        }
        try {
            await invokeDesktop("open_external_url", { url: `http://127.0.0.1:${port}` });
        } catch (error) {
            message.error(errorMessage(error));
        }
    };

    const packInputRef = useRef<HTMLInputElement | null>(null);
    const [packImporting, setPackImporting] = useState(false);

    /** 批量导入工作流包：支持多选 JSON，或单个包含多个工作流的 .mgpack / 数组 JSON。 */
    const importWorkflowPack = async (files: FileList | null) => {
        if (!files?.length || !profile) return;
        setPackImporting(true);
        try {
            const entries: ComfyWorkflowPackEntry[] = [];
            for (const file of Array.from(files)) {
                try {
                    const parsed = parseComfyWorkflowPack(JSON.parse(await file.text()) as unknown);
                    // 单文件仅含一个工作流时，用文件名作为工作流名称。
                    if (parsed.length === 1 && !parsed[0].name) parsed[0].name = comfyWorkflowPackName(file.name);
                    entries.push(...parsed);
                } catch (error) {
                    message.error(`${file.name}：${errorMessage(error)}`);
                }
            }
            if (!entries.length) return;
            const result = await importComfyWorkflowPack(profile.id, entries);
            setWorkflows(await listComfyWorkflowDefinitions());
            if (result.imported.length) message.success(t("comfyuiLocal.pack.imported", { count: result.imported.length }));
            for (const item of result.failed) message.warning(t("comfyuiLocal.pack.failed", { name: item.name, reason: item.reason }));
        } catch (error) {
            message.error(errorMessage(error));
        } finally {
            setPackImporting(false);
            if (packInputRef.current) packInputRef.current.value = "";
        }
    };

    /** 安装内置示例工作流：直接读取随包分发的演示 JSON，省去新用户自己找文件。 */
    /** 安装内置示例工作流：统一走示例清单，确保用的是随包分发的最新版本。 */
    const installDemoWorkflow = async () => {
        setPackImporting(true);
        try {
            await demoImport.installDemo();
        } finally {
            setPackImporting(false);
        }
    };

    const addWorkflowToCanvas = (definition: ComfyWorkflowDefinition) => {
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
        <WorkspacePage icon={Cpu} title={t("comfyuiLocal.title")} actions={<RuntimePill status={localStatus} />}>
            <div className="mx-auto max-w-[1080px]">
                {!desktop ? (
                    <section className="border-y border-amber-500/20 bg-amber-500/[0.04] px-5 py-8 sm:px-8">
                        <div className="flex items-start gap-4">
                            <AlertCircle className="mt-0.5 size-5 shrink-0 text-amber-500" />
                            <div>
                                <h2 className="text-[15px] font-semibold">{t("comfyuiLocal.desktopOnly.title")}</h2>
                                <p className="mt-2 max-w-2xl text-[12px] leading-6 text-stone-500 dark:text-zinc-400">{t("comfyuiLocal.desktopOnly.description")}</p>
                            </div>
                        </div>
                    </section>
                ) : loading ? (
                    <div className="grid min-h-[320px] place-items-center text-stone-400 dark:text-zinc-600">
                        <LoaderCircle className="size-5 animate-spin" />
                    </div>
                ) : setupMode ? (
                    <EnvironmentSetup
                        detection={detection}
                        selectedRoot={selectedRoot}
                        detecting={detecting}
                        onChooseRoot={chooseRootDirectory}
                        onChoosePython={choosePython}
                        onSaveAndStart={() => void saveEnvironment()}
                        onCancel={profile ? () => setEditing(false) : undefined}
                    />
                ) : (
                    <EnvironmentRuntime
                        profile={profile}
                        status={localStatus}
                        logs={recentLogs}
                        busy={busy}
                        onStart={() => void startEnvironment()}
                        onStop={() => void stopEnvironment()}
                        onRefresh={() => void refreshFromButton()}
                        refreshing={refreshing}
                        onOpenConsole={() => void openConsole()}
                        onChangeEnvironment={() => void changeEnvironment()}
                        onConnectCloud={() => setCloudOpen(true)}
                        onForget={() => void forgetEnvironment()}
                        workflows={localWorkflows}
                        onImport={() => setImportOpen(true)}
                        onImportPack={() => packInputRef.current?.click()}
                        onInstallDemo={() => void installDemoWorkflow()}
                        importingPack={packImporting}
                        onAddToCanvas={addWorkflowToCanvas}
                        onDeleteWorkflow={removeWorkflow}
                    />
                )}
            </div>
            <Modal
                open={cloudOpen}
                title={t("comfyuiLocal.cloud.title")}
                okText={t("comfyuiLocal.cloud.connect")}
                cancelText={t("common.cancel")}
                confirmLoading={connecting}
                onOk={() => void connectCloud()}
                onCancel={() => setCloudOpen(false)}
                destroyOnHidden
            >
                <p className="mb-3 text-[12px] leading-6 text-stone-500 dark:text-zinc-400">{t("comfyuiLocal.cloud.description")}</p>
                <Input value={cloudUrl} onChange={(event) => setCloudUrl(event.target.value)} placeholder="https://www.runninghub.cn/proxy/your-api-key" allowClear />
            </Modal>
            <input ref={packInputRef} type="file" accept=".json,.mgpack,application/json" multiple hidden onChange={(event) => void importWorkflowPack(event.target.files)} />
            {profile ? (
                <ComfyWorkflowImportWizard
                    open={importOpen}
                    environment={profile}
                    onClose={() => setImportOpen(false)}
                    onSaved={(definition) => {
                        setWorkflows((current) => [definition, ...current.filter((item) => item.id !== definition.id)]);
                        setImportOpen(false);
                    }}
                />
            ) : null}
        </WorkspacePage>
    );
}

type SetupProps = {
    detection: ComfyEnvironmentDetection | null;
    selectedRoot: string;
    detecting: boolean;
    onChooseRoot: () => void;
    onChoosePython: () => void;
    onSaveAndStart: () => void;
    onCancel?: () => void;
};

function EnvironmentSetup({ detection, selectedRoot, detecting, onChooseRoot, onChoosePython, onSaveAndStart, onCancel }: SetupProps) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    return (
        <section className="py-8 sm:py-12">
            <div className="mb-7 flex items-end justify-between gap-4">
                <div>
                    <h2 className="text-[26px] font-semibold tracking-[-0.035em]">{onCancel ? t("comfyuiLocal.setup.changeTitle") : t("comfyuiLocal.setup.title")}</h2>
                    <p className="mt-2 text-[13px] text-stone-500 dark:text-zinc-500">{t("comfyuiLocal.setup.shortHint")}</p>
                </div>
                {onCancel ? (
                    <Button type="text" onClick={onCancel}>
                        {t("common.cancel")}
                    </Button>
                ) : null}
            </div>

            <button
                type="button"
                onClick={() => navigate("/comfyui-cloud")}
                className="mb-7 flex w-full cursor-pointer items-center gap-4 border border-violet-500/25 bg-violet-500/[0.035] p-5 text-left transition-colors hover:border-violet-500/45 hover:bg-violet-500/[0.06]"
            >
                <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-violet-500/[0.14] text-violet-500">
                    <Cloud className="size-5" strokeWidth={2} />
                </span>
                <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                        <span className="text-[15px] font-semibold text-stone-950 dark:text-zinc-100">{t("comfyuiLocal.setup.cloudTitle")}</span>
                        <span className="rounded-md bg-violet-500/[0.14] px-2 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-300">
                            {t("comfyuiLocal.setup.cloudRecommended")}
                        </span>
                    </span>
                    <span className="mt-1.5 block text-[12px] leading-6 text-stone-500 dark:text-zinc-400">{t("comfyuiLocal.setup.cloudHint")}</span>
                </span>
                <ArrowRight className="size-4 shrink-0 text-violet-500" strokeWidth={2} />
            </button>
            <div className="min-w-0 border-y border-black/[0.08] dark:border-white/[0.08]">
                <div className="py-6">
                    <button
                        type="button"
                        className="group flex min-h-28 w-full cursor-pointer items-center gap-5 border border-dashed border-black/[0.16] px-5 text-left transition hover:border-violet-500/55 hover:bg-violet-500/[0.025] dark:border-white/[0.14] sm:px-6"
                        onClick={onChooseRoot}
                    >
                        <span className="grid size-12 shrink-0 place-items-center bg-black/[0.04] text-stone-500 transition group-hover:text-violet-500 dark:bg-white/[0.05] dark:text-zinc-400">
                            {detecting ? <LoaderCircle className="size-5 animate-spin" /> : <FolderOpen className="size-5" />}
                        </span>
                        <span className="min-w-0">
                            <span className="block truncate text-[15px] font-medium" title={selectedRoot || undefined}>
                                {selectedRoot || t("comfyuiLocal.setup.selectRoot")}
                            </span>
                        </span>
                    </button>

                    {detection ? (
                        <div className="mt-6 border-t border-black/[0.07] pt-6 dark:border-white/[0.07]">
                            <div className="flex items-center justify-between gap-4">
                                <div className="flex items-center gap-2.5 text-[14px] font-medium">
                                    <span className={cn("size-2 rounded-full", detection.ready ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.7)]" : "bg-amber-500")} />
                                    {detection.ready ? t("comfyuiLocal.setup.detected") : t("comfyuiLocal.setup.needsAttention")}
                                </div>
                                {detection.profile ? <span className="text-[11px] text-stone-400 dark:text-zinc-600">{t(`comfyuiLocal.installKind.${detection.profile.installKind}`)}</span> : null}
                            </div>
                            {detection.profile ? (
                                <dl className="mt-5 grid gap-4 sm:grid-cols-2">
                                    <PathDetail label="main.py" value={detection.profile.mainPyPath} />
                                    <PathDetail label="Python" value={detection.profile.pythonPath} />
                                </dl>
                            ) : null}
                            {detection.issues.length ? (
                                <div className="mt-5 border-l-2 border-amber-500/50 bg-amber-500/[0.045] px-4 py-3 text-[12px] leading-6 text-amber-700 dark:text-amber-300/80">
                                    {detection.issues.map((issue) => (
                                        <div key={issue}>{issue}</div>
                                    ))}
                                    <button type="button" className="mt-2 cursor-pointer font-medium text-amber-700 underline decoration-amber-500/40 underline-offset-4 dark:text-amber-300" onClick={onChoosePython}>
                                        {t("comfyuiLocal.setup.selectPython")}
                                    </button>
                                </div>
                            ) : null}
                        </div>
                    ) : null}
                </div>

                <div className="flex justify-end border-t border-black/[0.07] py-5 dark:border-white/[0.07]">
                    <Button type="primary" size="large" onClick={onSaveAndStart} disabled={!detection?.ready} loading={detecting}>
                        {t("comfyuiLocal.setup.saveAndStart")}
                    </Button>
                </div>
            </div>
        </section>
    );
}

type RuntimeProps = {
    profile: ComfyEnvironmentProfile;
    status: ComfyEnvironmentStatus;
    logs: ComfyEnvironmentLogEntry[];
    busy: boolean;
    onStart: () => void;
    onStop: () => void;
    onRefresh: () => void;
    refreshing: boolean;
    onOpenConsole: () => void;
    onChangeEnvironment: () => void;
    onConnectCloud: () => void;
    onForget: () => void;
    workflows: ComfyWorkflowDefinition[];
    onImport: () => void;
    onImportPack: () => void;
    onInstallDemo: () => void;
    importingPack: boolean;
    onAddToCanvas: (definition: ComfyWorkflowDefinition) => void;
    onDeleteWorkflow: (definition: ComfyWorkflowDefinition) => void;
};

function EnvironmentRuntime({ profile, status, logs, busy, onStart, onStop, onRefresh, refreshing, onOpenConsole, onChangeEnvironment, onConnectCloud, onForget, workflows, onImport, onImportPack, onInstallDemo, importingPack, onAddToCanvas, onDeleteWorkflow }: RuntimeProps) {
    const { t } = useTranslation();

    // 启动进度：ComfyUI 不提供进度信息，这里先按日志推断阶段，再在阶段内按时间平滑推进，
    // 避免自定义节点加载很慢时进度条先冲到 90% 让人误以为卡死。
    const [startProgress, setStartProgress] = useState(0);
    const startupStage = useMemo(() => inferComfyStartupStage(logs, status), [logs, status]);
    const stageCeiling = STARTUP_STAGE_CEILING[startupStage];

    useEffect(() => {
        if (status.phase === "starting") {
            setStartProgress((value) => (value > 0 ? value : 6));
            const timer = setInterval(() => {
                setStartProgress((value) => (value >= stageCeiling ? stageCeiling : Math.min(stageCeiling, value + Math.max(1, Math.round((stageCeiling + 3 - value) * 0.07)))));
            }, 350);
            return () => clearInterval(timer);
        }
        if (status.phase === "running") {
            setStartProgress(100);
            const timer = setTimeout(() => setStartProgress(0), 1800);
            return () => clearTimeout(timer);
        }
        setStartProgress(0);
        return undefined;
    }, [status.phase, stageCeiling]);

    // 本机显卡与模型清单只有连上 ComfyUI 才问得出来，未运行时保持空。
    const [device, setDevice] = useState<ComfyDeviceSummary | null>(null);
    const [modelCounts, setModelCounts] = useState<ComfyModelCount[]>([]);

    useEffect(() => {
        if (status.phase !== "running" || refreshing) return undefined;
        let cancelled = false;
        void Promise.all([comfyNativeClient.systemStats(), comfyNativeClient.objectInfo()])
            .then(([stats, objectInfo]) => {
                if (cancelled) return;
                setDevice(summarizeComfyDevice(stats));
                setModelCounts(summarizeComfyModelCounts(objectInfo));
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [status.phase, status.port, refreshing]);

    const modelSummary = modelCounts
        .filter((item) => item.count > 0)
        .map((item) => `${t(`comfyuiLocal.models.${item.key}`)} ${item.count}`)
        .join(" · ");

    const active = status.phase === "running" || status.phase === "starting";
    return (
        <section className="py-7 sm:py-9">
            <div className="flex flex-col justify-between gap-6 border-b border-black/[0.08] pb-7 dark:border-white/[0.08] sm:flex-row sm:items-start">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-3">
                        <h2 className="truncate text-[28px] font-semibold tracking-[-0.04em]">{profile.name}</h2>
                        <span className="text-[12px] text-stone-400 dark:text-zinc-600">{t(`comfyuiLocal.installKind.${profile.installKind}`)}</span>
                    </div>
                    <p className="mt-2 truncate text-[13px] text-stone-400 dark:text-zinc-600" title={profile.rootDirectory}>
                        {profile.rootDirectory}
                    </p>
                    {status.message ? <p className="mt-3 max-w-2xl text-[12px] leading-5 text-amber-600 dark:text-amber-300/80">{status.message}</p> : null}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                    <Button icon={<FolderOpen className="size-4" />} onClick={onChangeEnvironment} disabled={busy}>
                        {t("comfyuiLocal.runtime.change")}
                    </Button>

                    <Button icon={<RefreshCw className="size-3.5" />} onClick={onRefresh} disabled={busy} loading={refreshing}>
                        {t("comfyuiLocal.runtime.refresh")}
                    </Button>

                    <Button icon={<ExternalLink className="size-3.5" />} onClick={onOpenConsole} disabled={!status.port}>

                        {t("comfyuiLocal.runtime.openConsole")}

                    </Button>
                    <Button icon={<Trash2 className="size-3.5" />} danger onClick={onForget} disabled={busy}>
                        {t("comfyuiLocal.runtime.forget")}
                    </Button>
                    {active ? (
                        <Button danger icon={<CircleStop className="size-3.5" />} onClick={onStop} loading={busy}>
                            {status.remoteBaseUrl ? t("comfyuiLocal.runtime.disconnect") : t("comfyuiLocal.runtime.stop")}
                        </Button>
                    ) : (
                        <Button type="primary" icon={<Play className="size-3.5" />} onClick={onStart} loading={busy}>
                            {t("comfyuiLocal.runtime.start")}
                        </Button>
                    )}
                </div>
            </div>

            {startProgress > 0 ? (
                <div className="space-y-2 border-b border-black/[0.08] py-4 dark:border-white/[0.08]">
                    <Progress
                        percent={Math.min(Math.round(startProgress), stageCeiling)}
                        status={status.phase === "running" ? "success" : "active"}
                        strokeColor="#756bff"
                    />
                    {status.phase === "starting" ? <p className="text-[12px] text-stone-500 dark:text-zinc-500">{t(`comfyuiLocal.stage.${startupStage}`)}</p> : null}
                </div>
            ) : null}
            <dl className="grid border-b border-black/[0.08] dark:border-white/[0.08] sm:grid-cols-3">
                <RuntimeDetail label={t("comfyuiLocal.runtime.state")} value={t(`comfyuiLocal.phase.${status.phase}`)} />
                <RuntimeDetail label={t("comfyuiLocal.runtime.port")} value={status.port ? `127.0.0.1:${status.port}` : "—"} />
                <RuntimeDetail label="PID" value={status.pid ? String(status.pid) : "—"} />
            </dl>

            {status.phase === "running" ? (
                <dl className="grid border-b border-black/[0.08] dark:border-white/[0.08] sm:grid-cols-2">
                    <RuntimeDetail label={t("comfyuiLocal.runtime.device")} value={device ? `${device.name} · ${t("comfyuiLocal.runtime.vram", { free: device.vramFreeGb, total: device.vramTotalGb })}` : "—"} />
                    <RuntimeDetail label={t("comfyuiLocal.runtime.models")} value={modelSummary || t("comfyuiLocal.models.empty")} />
                </dl>
            ) : null}

            <details className="group border-b border-black/[0.07] dark:border-white/[0.07]">
                <summary className="flex h-14 cursor-pointer list-none items-center justify-between text-[13px] font-medium">
                    <span className="flex items-center gap-2">
                        <TerminalSquare className="size-4 text-stone-400" />
                        {t("comfyuiLocal.logs.title")}
                        <span className="text-[11px] font-normal tabular-nums text-stone-400 dark:text-zinc-600">{logs.length}</span>
                    </span>
                    <ChevronDown className="size-3.5 text-stone-400 transition group-open:rotate-180" />
                </summary>
                <div className="mb-6 max-h-[320px] overflow-auto bg-[#0b0d10] p-4 font-mono text-[10px] leading-5 text-zinc-400">
                    {logs.length ? (
                        logs.map((entry, index) => (
                            <div key={`${entry.timestamp}-${index}`} className={entry.stream === "stderr" ? "text-amber-300/80" : undefined}>
                                <span className="mr-3 text-zinc-700">{formatLogTime(entry.timestamp)}</span>
                                {entry.message}
                            </div>
                        ))
                    ) : (
                        <div className="text-zinc-600">{t("comfyuiLocal.logs.empty")}</div>
                    )}
                </div>
            </details>

            <section className="py-8">
                <div className="flex flex-wrap items-end justify-between gap-4">
                    <div>
                        <h3 className="text-[20px] font-semibold tracking-[-0.03em]">{t("comfyuiLocal.library.title")}</h3>
                        {workflows.length ? (
                            <p className="mt-1.5 text-[12px] text-stone-400 dark:text-zinc-600">
                                {t("comfyuiLocal.library.availability", {
                                    runnable: workflows.filter((workflow) => workflow.dependencySnapshot.runnable).length,
                                    total: workflows.length,
                                })}
                            </p>
                        ) : null}
                    </div>

                    <div className="flex flex-wrap gap-2">
                        {/* 示例要跑在本机 ComfyUI 上，未启动成功前不提供安装入口。 */}
                        <Button size="large" icon={<Sparkles className="size-4" />} onClick={onInstallDemo} loading={importingPack} disabled={status.phase !== "running"}>
                            {t("comfyuiLocal.pack.installDemo")}
                        </Button>
                        <Button type="primary" size="large" icon={<Plus className="size-4" />} onClick={onImport} disabled={status.phase !== "running"}>
                            {t("comfyuiLocal.library.import")}
                        </Button>
                    </div>
                </div>
                {workflows.length ? (
                    <div className="mt-6 divide-y divide-black/[0.07] border-y border-black/[0.08] dark:divide-white/[0.07] dark:border-white/[0.08]">
                        {workflows.map((workflow) => (
                            <div key={workflow.id} className="grid gap-4 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                                <div className="flex min-w-0 items-start gap-3">
                                    <span className="grid size-10 shrink-0 place-items-center bg-violet-500/[0.08] text-violet-500">
                                        <FileJson className="size-[18px]" />
                                    </span>
                                    <div className="min-w-0">
                                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                                            <span className="truncate text-[14px] font-medium">{workflow.name}</span>
                                            <span className={cn("size-1.5 rounded-full", workflow.dependencySnapshot.runnable ? "bg-emerald-500" : "bg-amber-500")} />
                                        </div>
                                        <p className="mt-1 truncate text-[11px] text-stone-400 dark:text-zinc-600">
                                            {workflow.inputs.length} inputs · {workflow.outputs.length} outputs · {workflow.workflowHash.slice(0, 8)}
                                        </p>
                                        {/* 不可用时必须说清缺什么，否则用户只看到一个黄点却无从下手。 */}
                                        {workflow.dependencySnapshot.runnable ? null : (
                                            <p className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-amber-600 dark:text-amber-500">
                                                {workflow.dependencySnapshot.missingClassTypes?.length ? (
                                                    <span>{t("comfyuiLocal.library.missingNodes", { names: summarizeDependencies(workflow.dependencySnapshot.missingClassTypes) })}</span>
                                                ) : null}
                                                {workflow.dependencySnapshot.missingFiles?.length ? (
                                                    <span>{t("comfyuiLocal.library.missingFiles", { names: summarizeDependencies(workflow.dependencySnapshot.missingFiles) })}</span>
                                                ) : null}
                                            </p>
                                        )}
                                    </div>
                                </div>
                                <div className="flex justify-end gap-1">
                                    <Button type="text" size="small" danger icon={<Trash2 className="size-3.5" />} onClick={() => onDeleteWorkflow(workflow)} aria-label={t("common.delete")} />
                                    {/* 本地工作流要跑在本机 ComfyUI 上，未启动成功前不允许加入画布。 */}
                                    <Tooltip title={status.phase === "running" ? undefined : t("comfyuiLocal.library.startFirst")}>
                                        <Button
                                            size="small"
                                            icon={<ArrowRight className="size-3.5" />}
                                            disabled={status.phase !== "running"}
                                            onClick={() => onAddToCanvas(workflow)}
                                        >
                                            {t("comfyuiLocal.library.addToCanvas")}
                                        </Button>
                                    </Tooltip>
                                </div>
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="mt-6 flex min-h-32 items-center justify-center border-y border-dashed border-black/[0.1] text-center text-[13px] leading-6 text-stone-400 dark:border-white/[0.1] dark:text-zinc-600">
                        {status.phase === "running" ? t("comfyuiLocal.library.empty") : t("comfyuiLocal.library.startFirst")}
                    </div>
                )}
            </section>
        </section>
    );
}

function RuntimePill({ status }: { status: ComfyEnvironmentStatus }) {
    const { t } = useTranslation();
    const tone = status.phase === "running" ? "bg-emerald-500" : status.phase === "starting" ? "animate-pulse bg-violet-500" : status.phase === "failed" ? "bg-red-500" : "bg-stone-300 dark:bg-zinc-700";
    return (
        <div className="flex h-9 items-center gap-2.5 border border-black/[0.08] px-3.5 text-[12px] font-medium text-stone-500 dark:border-white/[0.08] dark:text-zinc-400">
            <span className={cn("size-1.5 rounded-full", tone)} />
            {t(`comfyuiLocal.phase.${status.phase}`)}
        </div>
    );
}

function RuntimeDetail({ label, value }: { label: string; value: string }) {
    return (
        <div className="min-w-0 py-6 sm:border-r sm:border-black/[0.07] sm:px-5 sm:first:pl-0 sm:last:border-r-0 dark:sm:border-white/[0.07]">
            <dt className="text-[10px] uppercase tracking-[0.14em] text-stone-400 dark:text-zinc-600">{label}</dt>
            <dd className="mt-2 truncate text-[16px] font-medium tabular-nums" title={value}>
                {value}
            </dd>
        </div>
    );
}

function PathDetail({ label, value }: { label: string; value: string }) {
    return (
        <div className="min-w-0">
            <dt className="text-[10px] uppercase tracking-[0.12em] text-stone-400 dark:text-zinc-600">{label}</dt>
            <dd className="mt-1.5 truncate text-[12px] text-stone-600 dark:text-zinc-400" title={value}>
                {value}
            </dd>
        </div>
    );
}

function formatLogTime(timestamp: number) {
    return new Date(timestamp).toLocaleTimeString([], { hour12: false });
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}
