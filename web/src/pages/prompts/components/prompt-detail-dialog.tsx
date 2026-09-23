import { useRef } from "react";
import { Copy, FileText, FolderPlus, ImagePlus } from "lucide-react";
import { App, Button, Modal, Space, Tag } from "antd";
import { useTranslation } from "react-i18next";

import { formatPromptDate, type Prompt } from "@/services/api/prompts";
import { BUILTIN_STYLE_PROMPTS } from "@/services/api/builtin-prompt-styles";
import { compressStyleCover, saveStyleCover } from "@/services/api/style-covers";

export function PromptDetailDialog({ prompt, onClose, onCopy, onSaveAsset, onCoverSaved }: { prompt: Prompt | null; onClose: () => void; onCopy: (prompt: string) => void; onSaveAsset?: (prompt: Prompt) => void; onCoverSaved?: (cover: string) => void }) {
    const { i18n, t } = useTranslation();
    const { message } = App.useApp();
    const fileRef = useRef<HTMLInputElement>(null);
    // 只有内置风格才谈得上封面：远程提示词源的封面由它自己数据里的图片决定。
    const styleId = prompt ? BUILTIN_STYLE_PROMPTS.find((item) => item.prompt === prompt.prompt)?.id : undefined;

    const applyCover = async (file: File | undefined) => {
        if (!file || !styleId) return;
        try {
            const cover = await compressStyleCover(file);
            await saveStyleCover(styleId, cover);
            onCoverSaved?.(cover);
            message.success(t("prompts.coverSaved"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("prompts.coverFailed"));
        }
    };

    return (
        <Modal title={prompt?.title} open={Boolean(prompt)} onCancel={onClose} footer={null} width={720} centered styles={{ body: { height: "calc(85vh - 55px)", overflow: "hidden" } }}>
            {prompt ? (
                <div className="flex h-full min-h-0 flex-col">
                    <input
                        ref={fileRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(event) => {
                            const file = event.target.files?.[0];
                            // 同一个文件连续选两次也要能触发。
                            event.target.value = "";
                            void applyCover(file);
                        }}
                    />
                    <div className="shrink-0 space-y-3 pb-4">
                        {prompt.coverUrl ? <img src={prompt.coverUrl} alt={prompt.title} className="h-48 w-full rounded-lg object-cover sm:h-56" /> : <div className="grid h-48 w-full place-items-center rounded-lg bg-stone-100 text-stone-400 dark:bg-stone-900 dark:text-stone-600 sm:h-56"><FileText className="size-9" /></div>}
                        {prompt.referenceImageUrls.length > 1 ? <div className="grid grid-cols-6 gap-2">{prompt.referenceImageUrls.filter((url) => url !== prompt.coverUrl).slice(0, 6).map((url) => <img key={url} src={url} alt="" className="aspect-square w-full rounded-md object-cover" loading="lazy" />)}</div> : null}
                    </div>
                    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto border-y border-stone-200 py-4 pr-2 dark:border-stone-800">
                        <div className="flex flex-wrap gap-1.5">
                            {prompt.tags.map((tag) => (
                                <Tag key={tag} className="m-0">
                                    {tag}
                                </Tag>
                            ))}
                        </div>
                        {prompt.description ? <p className="mt-4 text-sm leading-6 text-stone-500 dark:text-stone-400">{prompt.description}</p> : null}
                        {prompt.preview ? <pre className="mt-4 whitespace-pre-wrap rounded-lg bg-stone-100 p-3 text-xs leading-5 text-stone-600 dark:bg-stone-900 dark:text-stone-300">{prompt.preview}</pre> : null}
                        <p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-stone-800 dark:text-stone-300">{prompt.prompt}</p>
                        {prompt.createdAt || prompt.updatedAt ? <div className="mt-4 text-xs text-stone-500 dark:text-stone-400">{prompt.createdAt ? t("common.created", { date: formatPromptDate(prompt.createdAt, i18n.resolvedLanguage) }) : null}{prompt.createdAt && prompt.updatedAt ? " · " : null}{prompt.updatedAt ? t("common.updated", { date: formatPromptDate(prompt.updatedAt, i18n.resolvedLanguage) }) : null}</div> : null}
                    </div>
                    <div className="shrink-0 pt-4">
                        <Space wrap>
                            <Button type="primary" icon={<Copy className="size-4" />} onClick={() => onCopy(prompt.prompt)}>
                                {t("common.copyPrompt")}
                            </Button>
                            {styleId ? (
                                <Button icon={<ImagePlus className="size-4" />} onClick={() => fileRef.current?.click()}>
                                    {prompt.coverUrl ? "换封面" : "设为封面"}
                                </Button>
                            ) : null}
                            {onSaveAsset ? (
                                <Button icon={<FolderPlus className="size-4" />} onClick={() => onSaveAsset(prompt)}>
                                    {t("common.addToAssets")}
                                </Button>
                            ) : null}
                        </Space>
                    </div>
                </div>
            ) : null}
        </Modal>
    );
}
