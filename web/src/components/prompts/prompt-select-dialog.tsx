import { Search } from "lucide-react";
import { type ChangeEvent, type UIEvent, useEffect, useRef, useState } from "react";
import { App, Empty, Input, Modal, Spin, Tag } from "antd";
import { useTranslation } from "react-i18next";

import { ALL_PROMPTS_OPTION } from "@/services/api/prompts";
import { BUILTIN_STYLE_SOURCE_ID } from "@/services/api/prompt-source-presets";
import { compressStyleCover, saveStyleCover } from "@/services/api/style-covers";
import { cn } from "@/lib/utils";
import { PromptCard } from "./prompt-card";
import { PromptVariableFields } from "./prompt-variable-fields";
import { applyPromptVariables, extractPromptVariables } from "./prompt-variables";
import { usePromptList } from "./use-prompt-list";

export function PromptSelectDialog({ open, onOpenChange, onSelect }: { open: boolean; onOpenChange: (open: boolean) => void; onSelect: (prompt: string) => void }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [keyword, setKeyword] = useState("");
    const [selectedTags, setSelectedTags] = useState<string[]>([]);
    const [selectedCategory, setSelectedCategory] = useState(ALL_PROMPTS_OPTION);
    const { query, items, tags: promptTags, categories: promptCategories } = usePromptList({ keyword, tags: selectedTags, category: selectedCategory, enabled: open });
    const fileRef = useRef<HTMLInputElement>(null);
    // 刚设好的封面先本地覆盖显示，省掉一次整表重新拉取。
    const [coverOverrides, setCoverOverrides] = useState<Record<string, string>>({});
    const pendingStyleId = useRef("");
    // 选中的提示词若带 {{变量}}，先在这里逐个填值，填完再交回调用方。
    const [template, setTemplate] = useState("");
    const [variableValues, setVariableValues] = useState<Record<string, string>>({});
    const toggleTag = (tag: string) => {
        if (tag === ALL_PROMPTS_OPTION) return setSelectedTags([]);
        setSelectedTags((items) => (items.includes(tag) ? items.filter((item) => item !== tag) : [...items, tag]));
    };
    const selectPrompt = (prompt: string) => {
        if (!extractPromptVariables(prompt).length) {
            onSelect(prompt);
            onOpenChange(false);
            return;
        }
        setVariableValues({});
        setTemplate(prompt);
    };

    const applyTemplate = () => {
        onSelect(applyPromptVariables(template, variableValues));
        setTemplate("");
        onOpenChange(false);
    };

    const pickCover = (styleId: string) => {
        pendingStyleId.current = styleId;
        fileRef.current?.click();
    };

    const applyCover = async (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        const styleId = pendingStyleId.current;
        // 同一个文件连续选两次也要能触发，因此读完立刻清空。
        event.target.value = "";
        if (!file || !styleId) return;
        try {
            const cover = await compressStyleCover(file);
            await saveStyleCover(styleId, cover);
            setCoverOverrides((current) => ({ ...current, [styleId]: cover }));
            message.success(t("prompts.coverSaved"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("prompts.coverFailed"));
        }
    };

    useEffect(() => {
        if (query.isError) message.error(query.error instanceof Error ? query.error.message : t("prompts.loadFailed"));
    }, [message, query.error, query.isError, t]);

    const handleListScroll = (event: UIEvent<HTMLDivElement>) => {
        const target = event.currentTarget;
        if (query.hasNextPage && !query.isFetchingNextPage && target.scrollTop + target.clientHeight >= target.scrollHeight - 160) void query.fetchNextPage();
    };

    return (
        <>
            <Modal title={t("prompts.library")} open={open && !template} onCancel={() => onOpenChange(false)} footer={null} width={880} centered>
                <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(event) => void applyCover(event)} />
                <div className="grid h-[62dvh] min-h-0 gap-5 sm:grid-cols-[200px_minmax(0,1fr)]" data-canvas-no-zoom onWheelCapture={(event) => event.stopPropagation()}>
                    <aside className="thin-scrollbar min-h-0 overflow-y-auto border-r border-stone-200 pr-4 dark:border-stone-800">
                        <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-stone-400 dark:text-stone-500">{t("prompts.category")}</div>
                        <div className="flex flex-wrap gap-1.5">
                            {promptCategories.map((category) => (
                                <Tag.CheckableTag key={category} checked={selectedCategory === category} className={cn("prompt-filter-tag", selectedCategory === category && "is-active")} onChange={() => setSelectedCategory(category)}>
                                    {category === ALL_PROMPTS_OPTION ? t("common.all") : category}
                                </Tag.CheckableTag>
                            ))}
                        </div>
                        <div className="mb-2 mt-5 text-xs font-semibold uppercase tracking-widest text-stone-400 dark:text-stone-500">{t("prompts.tags")}</div>
                        <div className="flex flex-wrap gap-1.5">
                            {promptTags.map((tag) => {
                                const active = tag === ALL_PROMPTS_OPTION ? selectedTags.length === 0 : selectedTags.includes(tag);
                                return (
                                    <Tag.CheckableTag key={tag} checked={active} className={cn("prompt-filter-tag", active && "is-active")} onChange={() => toggleTag(tag)}>
                                        {tag === ALL_PROMPTS_OPTION ? t("common.all") : tag}
                                    </Tag.CheckableTag>
                                );
                            })}
                        </div>
                    </aside>
                    <section className="flex min-h-0 min-w-0 flex-col">
                        <Input size="large" prefix={<Search className="size-4 text-stone-400" />} value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder={t("prompts.searchTitle")} />
                        <div className="thin-scrollbar mt-4 min-h-0 flex-1 overflow-y-auto pr-2" data-canvas-no-zoom onScroll={handleListScroll} onWheelCapture={(event) => event.stopPropagation()}>
                            {query.isLoading ? (
                                <div className="flex h-40 items-center justify-center">
                                    <Spin />
                                </div>
                            ) : null}
                            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                                {items.map((item) => {
                                    // 只有内置风格源能设封面：远程提示词源的封面由它自己的数据决定。
                                    const coverUrl = coverOverrides[item.id] || item.coverUrl;
                                    return (
                                        <PromptCard
                                            key={item.id}
                                            item={coverUrl === item.coverUrl ? item : { ...item, coverUrl }}
                                            onOpen={() => selectPrompt(item.prompt)}
                                            onCopy={() => selectPrompt(item.prompt)}
                                            onSetCover={item.sourceId === BUILTIN_STYLE_SOURCE_ID ? () => pickCover(item.id) : undefined}
                                            compact
                                        />
                                    );
                                })}
                            </div>
                            {!query.isLoading && items.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("prompts.empty")} className="py-8" /> : null}
                            {query.isFetchingNextPage ? (
                                <div className="py-4 text-center">
                                    <Spin size="small" />
                                </div>
                            ) : null}
                        </div>
                    </section>
                </div>
            </Modal>
            <Modal title={t("prompts.fillVariables")} open={Boolean(template)} onCancel={() => setTemplate("")} onOk={applyTemplate} okText={t("prompts.use")} cancelText={t("common.cancel")} width={480} centered>
                <PromptVariableFields template={template} values={variableValues} onChange={setVariableValues} />
            </Modal>
        </>
    );
}
