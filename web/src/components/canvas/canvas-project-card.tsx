import { ArrowUpRight, Check, Download, Pencil, Trash2, X } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Input, Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";

import { CanvasProjectCover } from "./canvas-project-cover";

export function CanvasProjectCard({ project, index = 0 }: { project: CanvasProject; index?: number }) {
    const { i18n, t } = useTranslation();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const renameProject = useCanvasStore((state) => state.renameProject);
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const editingId = useCanvasUiStore((state) => state.editingProjectId);
    const editingTitle = useCanvasUiStore((state) => state.editingProjectTitle);
    const startEditing = useCanvasUiStore((state) => state.startEditingProject);
    const setEditingTitle = useCanvasUiStore((state) => state.setEditingProjectTitle);
    const stopEditing = useCanvasUiStore((state) => state.stopEditingProject);
    const toggleSelected = useCanvasUiStore((state) => state.toggleSelectedProjectId);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const editing = editingId === project.id;
    const selected = selectedIds.includes(project.id);
    const open = () => navigate(`/canvas/${project.id}${searchParams.toString() ? `?${searchParams.toString()}` : ""}`);
    const saveTitle = () => {
        renameProject(project.id, editingTitle);
        stopEditing();
    };
    const updatedAt = new Date(project.updatedAt);
    const updatedLabel = Number.isNaN(updatedAt.getTime())
        ? t("canvas.project.updatedUnknown")
        : t("canvas.project.updated", {
              date: updatedAt.toLocaleString(i18n.resolvedLanguage, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }),
          });

    return (
        <article data-canvas-project-card={project.id} className={`td-home-project-card group relative min-w-0 ${selected ? "is-selected" : ""}`}>
            <div className="td-home-project-preview-shell relative aspect-[16/9] overflow-hidden rounded-[16px] border border-black/[0.09] bg-[#e8e6e0] transition-colors duration-200 dark:border-white/[0.09] dark:bg-[#0d0e0f]">
                <div className="td-home-project-visual absolute inset-0 transition-transform duration-300 ease-out">
                    <CanvasProjectCover project={project} />
                </div>
                <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/22 via-transparent to-transparent opacity-50 dark:from-black/45" />
                <button
                    type="button"
                    className="absolute inset-0 z-10 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#8e85ff]"
                    onClick={open}
                    aria-label={t("canvas.start.openProject", { name: project.title })}
                />

                <span className="pointer-events-none absolute bottom-3 left-3 z-20 rounded-full bg-stone-950/70 px-1.5 py-0.5 text-[9px] font-semibold tabular-nums tracking-[0.16em] text-white/90 backdrop-blur-md">{String(index + 1).padStart(2, "0")}</span>

                <label
                    className={`absolute left-3 top-3 z-30 grid size-7 cursor-pointer place-items-center rounded-[9px] border backdrop-blur-xl transition ${selected ? "border-[#8178ff] bg-[#756bff] text-white opacity-100" : "border-white/15 bg-black/45 text-transparent opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"}`}
                    title={t("canvas.project.select", { name: project.title })}
                >
                    <input type="checkbox" checked={selected} onChange={(event) => toggleSelected(project.id, event.target.checked)} className="sr-only" aria-label={t("canvas.project.select", { name: project.title })} />
                    <Check className="size-3.5" strokeWidth={2.4} />
                </label>

                {/* 操作条默认常显：悬停才出现会让用户不知道有这些功能；底色固定为半透明深色 + 模糊，保证在亮色/深色/花哨封面上都读得清。 */}
                <div className="td-home-project-actions absolute right-3 top-3 z-30 flex items-center gap-0.5 rounded-[10px] border border-white/15 bg-stone-950/75 p-1 shadow-lg backdrop-blur-xl transition-colors duration-200 group-hover:bg-stone-950/85">
                    {editing ? (
                        <>
                            <ProjectAction action="save" icon={<Check className="size-3.5" />} label={t("canvas.project.saveName")} onClick={saveTitle} />
                            <ProjectAction action="cancel" icon={<X className="size-3.5" />} label={t("canvas.project.cancelRename")} onClick={stopEditing} />
                        </>
                    ) : (
                        <>
                            <ProjectAction action="export" icon={<Download className="size-3.5" />} label={t("canvas.project.export")} onClick={() => void exportCanvasProjects([project], project.title || t("canvas.title"))} />
                            <ProjectAction action="rename" icon={<Pencil className="size-3.5" />} label={t("canvas.project.rename")} onClick={() => startEditing(project.id, project.title)} />
                            <ProjectAction action="delete" danger icon={<Trash2 className="size-3.5" />} label={t("canvas.project.delete")} onClick={() => setDeleteIds([project.id])} />
                        </>
                    )}
                </div>

                <span
                    className="pointer-events-none absolute bottom-3 right-3 z-20 grid size-8 translate-x-1 place-items-center rounded-[10px] bg-white text-[#101113] opacity-0 shadow-lg transition duration-200 group-hover:translate-x-0 group-hover:opacity-100 group-focus-within:translate-x-0 group-focus-within:opacity-100"
                    aria-hidden="true"
                >
                    <ArrowUpRight className="size-4" />
                </span>
            </div>

            <div className="pt-3.5">
                <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                        {editing ? (
                            <Input
                                className="min-w-0"
                                value={editingTitle}
                                onChange={(event) => setEditingTitle(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") saveTitle();
                                    if (event.key === "Escape") stopEditing();
                                }}
                                autoFocus
                            />
                        ) : (
                            <button type="button" className="block min-w-0 max-w-full cursor-pointer text-left outline-none focus-visible:underline" onClick={open} title={project.title}>
                                <h2 className="truncate text-[14px] font-semibold tracking-[-0.01em] text-stone-900 dark:text-zinc-100">{project.title}</h2>
                            </button>
                        )}
                        <p className="mt-1.5 text-[10px] text-stone-500 dark:text-zinc-500">{t("canvas.project.stats", { nodes: project.nodes.length, connections: project.connections.length })}</p>
                    </div>
                    <p className="shrink-0 pt-0.5 text-[9px] text-stone-400 dark:text-zinc-600">{updatedLabel}</p>
                </div>
            </div>
        </article>
    );
}

function ProjectAction({ action, icon, label, danger = false, onClick }: { action: string; icon: React.ReactNode; label: string; danger?: boolean; onClick: () => void }) {
    return (
        <Tooltip title={label} placement="bottom">
            <button
                type="button"
                data-canvas-project-action={action}
                className={`td-home-project-action grid size-7 cursor-pointer place-items-center rounded-[7px] outline-none transition focus-visible:ring-2 focus-visible:ring-[#a59eff] ${
                    danger
                        ? "text-red-300 hover:bg-red-500/25 hover:text-red-200 focus-visible:bg-red-500/25 focus-visible:text-red-200"
                        : "text-white/85 hover:bg-white/15 hover:text-white focus-visible:bg-white/15 focus-visible:text-white"
                }`}
                onClick={onClick}
                aria-label={label}
            >
                {icon}
            </button>
        </Tooltip>
    );
}
