import { Button, Empty, Input } from "antd";
import { ArrowLeft, Clapperboard } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";

import { useEditState } from "@/stores/use-edit-store";
import { EditInspector } from "./components/edit-inspector";
import { EditMediaPanel } from "./components/edit-media-panel";
import { EditStage } from "./components/edit-stage";

/**
 * 独立剪辑台：素材区（左）、预览区（上中）、属性区（右）、时间线（下）。
 * 全程只用剪辑台自己的项目数据，素材既可本地导入、从我的资产选择，也可由画布节点发送过来，
 * 不需要打开任何画布。
 */
export default function EditProjectPage() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { id = "" } = useParams<{ id: string }>();
    const { hydrated, projects, renameProject } = useEditState();
    const project = projects.find((item) => item.id === id);
    const [clipId, setClipId] = useState<string | null>(null);
    const [name, setName] = useState(project?.name ?? "");

    // 项目名用本地草稿编辑，失焦或回车才提交，避免每敲一个字都写一次项目数据。
    useEffect(() => setName(project?.name ?? ""), [project?.id, project?.name]);

    const commitName = () => {
        if (project && name.trim() && name !== project.name) renameProject(project.id, name);
    };

    if (!hydrated) return <div className="h-full bg-background" />;

    if (!project) {
        return (
            <div className="grid h-full place-items-center bg-background text-stone-900 dark:text-zinc-100">
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<span className="text-[12px] text-stone-500 dark:text-zinc-500">{t("editor.projectMissing")}</span>}>
                    <Button type="primary" onClick={() => navigate("/editor")}>
                        {t("editor.backToList")}
                    </Button>
                </Empty>
            </div>
        );
    }

    return (
        <div className="flex h-full min-h-0 flex-col bg-background text-stone-900 dark:text-zinc-100">
            <header className="flex h-12 shrink-0 items-center gap-3 border-b border-black/[0.07] px-3 dark:border-white/[0.07]">
                <Button type="text" size="small" className="!h-8 !w-8 !min-w-8 !p-0" icon={<ArrowLeft className="size-4" />} aria-label={t("editor.backToList")} onClick={() => navigate("/editor")} />
                <span className="grid size-7 shrink-0 place-items-center rounded-[9px] border border-black/[0.08] bg-black/[0.035] text-stone-600 dark:border-white/[0.08] dark:bg-white/[0.045] dark:text-zinc-300">
                    <Clapperboard className="size-3.5" />
                </span>
                <Input
                    variant="borderless"
                    className="max-w-[300px] !px-1 text-[13px] font-medium"
                    value={name}
                    aria-label={t("editor.projectName")}
                    placeholder={t("editor.projectNamePlaceholder")}
                    onChange={(event) => setName(event.target.value)}
                    onBlur={commitName}
                    onPressEnter={commitName}
                />
                <span className="text-[10px] tabular-nums text-stone-400 dark:text-zinc-600">{t("editor.projectSummary", { media: project.media.length, clips: project.clips.length })}</span>
            </header>

            <div className="grid min-h-0 flex-1 grid-cols-[248px_minmax(0,1fr)_304px]">
                <div data-edit-area="media" className="flex min-h-0 flex-col border-r border-black/[0.07] dark:border-white/[0.07]">
                    <EditMediaPanel projectId={project.id} />
                </div>
                <EditStage projectId={project.id} clipId={clipId} hasMedia={project.media.length > 0} onSelectClip={setClipId} />
                <div className="flex min-h-0 flex-col border-l border-black/[0.07] dark:border-white/[0.07]">
                    <EditInspector projectId={project.id} clipId={clipId} />
                </div>
            </div>
        </div>
    );
}
