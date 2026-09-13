import { App, Button, Empty, Modal, Popconfirm, Tag, theme } from "antd";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { createModelChannel, useConfigStore, type ApiCallFormat, type ModelChannel } from "@/stores/use-config-store";
import { ChannelEditorDrawer } from "./channel-editor-drawer";

function protocolLabel(apiFormat: ApiCallFormat, t: (key: string) => string) {
    if (apiFormat === "openai") return "OpenAI";
    if (apiFormat === "gemini") return "Gemini";
    return t(`config.protocols.${apiFormat}`);
}

export function ChannelPanel() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const { token } = theme.useToken();
    const channels = useConfigStore((state) => state.config.channels);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const [editing, setEditing] = useState<ModelChannel | null>(null);
    const [drawerOpen, setDrawerOpen] = useState(false);

    const openEditor = (channel: ModelChannel | null) => {
        setEditing(channel || createModelChannel());
        setDrawerOpen(true);
    };

    const saveChannel = (next: ModelChannel) => {
        const exists = channels.some((channel) => channel.id === next.id);
        updateConfig("channels", exists ? channels.map((channel) => (channel.id === next.id ? next : channel)) : [...channels, next]);
        message.success(t("config.saved"));
    };

    const removeChannel = (id: string) => {
        if (channels.length <= 1) {
            message.warning(t("config.channels.keepOne"));
            return;
        }
        updateConfig("channels", channels.filter((channel) => channel.id !== id));
    };

    return (
        <div className="flex flex-col">
            <p className="mb-3 text-xs leading-5 text-stone-500 dark:text-zinc-500">{t("config.channels.description")}</p>
            <div className="mb-3 flex justify-end">
                <Button type="primary" icon={<Plus className="size-4" />} onClick={() => openEditor(null)}>
                    {t("config.channels.add")}
                </Button>
            </div>
            {channels.length === 0 ? (
                <Empty description={t("config.channels.add")} />
            ) : (
                <div className="flex flex-col gap-2">
                    {channels.map((channel) => {
                        const missingUrl = !channel.baseUrl.trim();
                        return (
                            <div
                                key={channel.id}
                                className="flex items-center gap-3 rounded-[14px] border p-4"
                                style={{ background: token.colorFillAlter, borderColor: missingUrl ? token.colorWarningBorder : token.colorBorder }}
                            >
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                        <span className="truncate text-sm font-semibold" style={{ color: token.colorText }}>
                                            {channel.name}
                                        </span>
                                        <Tag className="!m-0">{protocolLabel(channel.apiFormat, t)}</Tag>
                                    </div>
                                    <div className="mt-1 truncate text-xs text-stone-500 dark:text-zinc-500">
                                        {missingUrl ? t("config.channels.missingUrl") : channel.baseUrl}
                                        <span className="mx-2 opacity-40">|</span>
                                        {t("config.channels.modelCount", { count: channel.models.length })}
                                    </div>
                                </div>
                                <Button type="text" size="small" icon={<Pencil className="size-4" />} onClick={() => openEditor(channel)}>
                                    {t("config.channelEditor.title")}
                                </Button>
                                <Popconfirm title={t("common.delete")} onConfirm={() => removeChannel(channel.id)}>
                                    <Button danger type="text" size="small" icon={<Trash2 className="size-4" />} />
                                </Popconfirm>
                            </div>
                        );
                    })}
                </div>
            )}
            <ChannelEditorDrawer open={drawerOpen} channel={editing} onSave={saveChannel} onClose={() => setDrawerOpen(false)} />
        </div>
    );
}

export function AppConfigModal() {
    const { t } = useTranslation();
    const isConfigOpen = useConfigStore((state) => state.isConfigOpen);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);

    return (
        <Modal
            title={
                <div>
                    <div className="text-lg font-semibold">{t("config.title")}</div>
                    <div className="mt-1 text-xs font-normal text-stone-500">{t("config.modalDescription")}</div>
                </div>
            }
            open={isConfigOpen}
            width={620}
            centered
            destroyOnHidden
            onCancel={() => setConfigDialogOpen(false)}
            footer={null}
        >
            <ChannelPanel />
        </Modal>
    );
}
