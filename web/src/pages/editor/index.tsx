import { App, Empty, Input, Modal } from "antd";
import dayjs from "dayjs";
import { Clapperboard, PencilLine, Play, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { WorkspacePage } from "@/components/layout/workspace-page";
import { useEditState } from "@/stores/use-edit-store";

/** 剪辑台首页：剪辑台自己的项目列表，与画布项目完全独立。 */
export default function EditProjectsPage() {
    const { t } = useTranslation();
    const { modal, message } = App.useApp();
    const navigate = useNavigate();
    const { hydrated, projects, createProject, renameProject, deleteProject } = useEditState();
    const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

    const createAndEnter = () => navigate(`/editor/${createProject(t("editor.untitled"))}`);

    const confirmDelete = (id: string, name: string) => {
        modal.confirm({
            title: t("editor.deleteTitle"),
            content: t("editor.deleteConfirm", { name }),
            okText: t("common.delete"),
            okButtonProps: { danger: true },
            cancelText: t("common.cancel"),
            onOk: () => {
                deleteProject(id);
                message.success(t("editor.deleted"));
            },
        });
    };

    return (
        <WorkspacePage
            icon={Clapperboard}
            title={t("editor.title")}
            description={t("editor.description")}
            meta={hydrated ? String(projects.length) : undefined}
            actions={
                <button type="button" className="td-workspace-action is-primary" disabled={!hydrated} onClick={createAndEnter}>
                    <Plus className="size-3.5" />
                    {t("editor.newProject")}
                </button>
            }
        >
            {!projects.length ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} className="py-20" description={<span className="text-[12px] text-stone-500 dark:text-zinc-500">{t("editor.emptyProjects")}</span>}>
                    <button type="button" className="td-workspace-action is-primary" onClick={createAndEnter}>
                        <Plus className="size-3.5" />
                        {t("editor.newProject")}
                    </button>
                    <p className="mt-3 max-w-md text-[11px] leading-5 text-stone-400 dark:text-zinc-600">{t("editor.emptyProjectsHint")}</p>
                </Empty>
            ) : (
                <ul className="grid gap-x-4 gap-y-5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                    {projects.map((project) => (
                        <li key={project.id} className="group flex min-w-0 flex-col overflow-hidden rounded-[16px] border border-black/[0.08] bg-black/[0.015] transition duration-200 hover:border-black/[0.17] dark:border-white/[0.08] dark:bg-white/[0.025] dark:hover:border-white/[0.17]">
                            <button type="button" className="flex cursor-pointer flex-col items-start gap-1 px-4 pb-3 pt-4 text-left" onClick={() => navigate(`/editor/${project.id}`)}>
                                <span className="line-clamp-1 text-[13px] font-semibold tracking-[-0.01em] text-stone-950 dark:text-zinc-100">{project.name}</span>
                                <span className="text-[10px] text-stone-400 dark:text-zinc-600">
                                    {t("editor.updatedAt", { time: dayjs(project.updatedAt).format("YYYY-MM-DD HH:mm") })}
                                </span>
                                <span className="mt-1 text-[10px] tabular-nums text-stone-400 dark:text-zinc-600">
                                    {t("editor.projectSummary", { media: project.media.length, clips: project.clips.length })}
                                </span>
                            </button>
                            <div className="mt-auto flex min-h-12 items-center gap-1 border-t border-black/[0.06] px-3 dark:border-white/[0.06]">
                                <button type="button" className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-[8px] px-2 text-[11px] text-stone-600 transition-colors hover:bg-black/[0.05] hover:text-stone-950 dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-zinc-100" onClick={() => navigate(`/editor/${project.id}`)}>
                                    <Play className="size-3.5" />
                                    {t("editor.openProject")}
                                </button>
                                <button type="button" className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-[8px] px-2 text-[11px] text-stone-600 transition-colors hover:bg-black/[0.05] hover:text-stone-950 dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-zinc-100" onClick={() => setRenaming({ id: project.id, name: project.name })}>
                                    <PencilLine className="size-3.5" />
                                    {t("editor.rename")}
                                </button>
                                <button type="button" className="ml-auto inline-flex h-7 cursor-pointer items-center gap-1 rounded-[8px] px-2 text-[11px] text-red-500 transition-colors hover:bg-red-500/10 dark:text-red-400" onClick={() => confirmDelete(project.id, project.name)}>
                                    <Trash2 className="size-3.5" />
                                    {t("common.delete")}
                                </button>
                            </div>
                        </li>
                    ))}
                </ul>
            )}

            <Modal
                title={t("editor.renameTitle")}
                open={Boolean(renaming)}
                okText={t("common.save")}
                cancelText={t("common.cancel")}
                onCancel={() => setRenaming(null)}
                onOk={() => {
                    if (renaming) renameProject(renaming.id, renaming.name);
                    setRenaming(null);
                }}
            >
                <Input value={renaming?.name ?? ""} placeholder={t("editor.projectNamePlaceholder")} onChange={(event) => setRenaming((current) => (current ? { ...current, name: event.target.value } : current))} />
            </Modal>
        </WorkspacePage>
    );
}
