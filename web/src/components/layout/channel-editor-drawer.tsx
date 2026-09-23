import { AutoComplete, Button, Drawer, Input, Segmented, Select, Space } from "antd";
import { ListPlus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { GENERIC_MODEL_PROFILES, type GenericModelFamily } from "@/services/api/generic-models";
import { guessCapability, normalizeChannelModels, type ApiCallFormat, type ChannelModel, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";
import { ModelScriptEditor } from "./model-script-editor";
import { ModelSelectModal } from "./model-select-modal";

/**
 * 服务商预设。
 * 多数用户在服务商文档里找不到「Base URL」，这里给出可直接选用的完整地址，
 * 同时带上该服务商的调用协议与确认可用的默认模型，选中即可用，减少填错。
 * 模型只收录能确认存在的名称，不确定的预设留空由用户自己添加；
 * 语音合成的预设按 baseUrl 命中内置脚本，因此协议用 generic。
 */
type ChannelPreset = {
    id: string;
    label: string;
    baseUrl: string;
    apiFormat: ApiCallFormat;
    models?: readonly ChannelModel[];
};

const CHANNEL_PRESETS: readonly ChannelPreset[] = [
    { id: "openai", label: "OpenAI · 文本/图片/视频", baseUrl: "https://api.openai.com/v1", apiFormat: "openai" },
    { id: "deepseek", label: "DeepSeek · 文本", baseUrl: "https://api.deepseek.com", apiFormat: "openai", models: [{ name: "deepseek-chat", capability: "text" }] },
    { id: "kimi", label: "月之暗面 Kimi · 文本", baseUrl: "https://api.moonshot.cn/v1", apiFormat: "openai", models: [{ name: "moonshot-v1-8k", capability: "text" }] },
    // 智谱的文本、图片、语音是同一个 Base URL：下拉里只保留一项并在 label 注明用途。
    // 智谱语音的接口就是 OpenAI 兼容的 /audio/speech（与内置语音脚本同一个地址），协议仍是 openai。
    {
        id: "zhipu",
        label: "智谱 GLM · 文本/图片/语音",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        apiFormat: "openai",
        models: [
            { name: "glm-4.5", capability: "text" },
            { name: "glm-4-flash", capability: "text" },
            { name: "cogview-4", capability: "image" },
            { name: "cogtts", capability: "audio" },
        ],
    },
    { id: "siliconflow", label: "硅基流动 · 文本/图片/视频", baseUrl: "https://api.siliconflow.cn/v1", apiFormat: "openai" },
    {
        id: "ark",
        label: "火山方舟（豆包）· 文本/图片/视频",
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        apiFormat: "ark",
        models: [
            { name: "doubao-seedream-4-0-250828", capability: "image" },
            { name: "doubao-seedance-1-0-pro-250528", capability: "video" },
        ],
    },
    {
        id: "dashscope",
        label: "阿里云百炼（兼容模式）· 文本/图片/视频",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        apiFormat: "openai",
        models: [
            { name: "qwen-plus", capability: "text" },
            { name: "qwen-turbo", capability: "text" },
            { name: "wanx2.1-t2i-turbo", capability: "image" },
        ],
    },
    { id: "hunyuan", label: "腾讯混元 · 文本", baseUrl: "https://api.hunyuan.cloud.tencent.com/v1", apiFormat: "openai" },
    { id: "ollama", label: "Ollama（本地）· 文本", baseUrl: "http://localhost:11434/v1", apiFormat: "openai" },
    { id: "lmstudio", label: "LM Studio（本地）· 文本", baseUrl: "http://localhost:1234/v1", apiFormat: "openai" },
    // 以下 3 项沿用改动前 COMMON_BASE_URLS 的原文，value 与 label 逐字符照抄，不要改写。
    { id: "302ai", label: "302.AI（聚合网关，海外节点）", baseUrl: "https://api.302.ai/v1", apiFormat: "openai" },
    { id: "anthropic", label: "Anthropic Claude", baseUrl: "https://api.anthropic.com/v1", apiFormat: "generic" },
    { id: "runninghub", label: "RunningHub 云端 ComfyUI（末尾接 API Key）", baseUrl: "https://www.runninghub.cn/proxy/", apiFormat: "generic" },
    { id: "ark-speech", label: "火山方舟语音（豆包）· 语音合成", baseUrl: "https://openspeech.bytedance.com", apiFormat: "generic" },
    { id: "dashscope-speech", label: "阿里云百炼语音 · 语音合成", baseUrl: "https://dashscope.aliyuncs.com", apiFormat: "generic", models: [{ name: "qwen-tts", capability: "audio" }] },
    { id: "openai-speech", label: "OpenAI 语音 · 语音合成", baseUrl: "https://api.openai.com", apiFormat: "generic" },
    { id: "minimax-speech", label: "MiniMax 语音 · 语音合成", baseUrl: "https://api.minimax.chat", apiFormat: "generic" },
    { id: "fish-speech", label: "Fish Audio · 语音合成", baseUrl: "https://api.fish.audio", apiFormat: "generic" },
    { id: "gemini", label: "Google Gemini · 文本/图片", baseUrl: "https://generativelanguage.googleapis.com", apiFormat: "gemini" },
];

/**
 * 下拉分组：只决定下拉里的展示分组与顺序，不改预设本身的 id 与 value（baseUrl）。
 * 19 条平铺太长，按用途分成对话 / 语音 / 图像视频 / 本地四组。
 */
const CHANNEL_PRESET_GROUPS: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["对话与通用", ["openai", "deepseek", "kimi", "zhipu", "siliconflow", "ark", "dashscope", "hunyuan", "gemini", "anthropic"]],
    ["语音合成", ["ark-speech", "dashscope-speech", "openai-speech", "minimax-speech", "fish-speech"]],
    ["图像与视频", ["302ai", "runninghub"]],
    ["本地部署", ["ollama", "lmstudio"]],
];

// 下拉项：分组项只多包一层 options，叶子项各自带 presetId（onSelect 靠它精确定位到自己那条预设）。
type ChannelPresetOption = { label: string; presetId?: string; value?: string; options?: ChannelPresetOption[] };

const CHANNEL_PRESET_OPTIONS: ChannelPresetOption[] = CHANNEL_PRESET_GROUPS.map(([groupLabel, ids]) => ({
    label: groupLabel,
    options: CHANNEL_PRESETS.filter((preset) => ids.includes(preset.id)).map((preset) => ({ presetId: preset.id, value: preset.baseUrl, label: `${preset.label} · ${preset.baseUrl}` })),
}));

type ScriptTarget = { name: string; capability: ModelCapability; value: string };

const GENERIC_MODEL_CAPABILITIES: Record<GenericModelFamily, ModelCapability> = {
    image: "image",
    video: "video",
    audio: "audio",
    text: "text",
    transcription: "text",
    music: "audio",
};

const GENERIC_MODEL_BY_ID = new Map(GENERIC_MODEL_PROFILES.map((profile) => [profile.id, profile]));
const GENERIC_MODEL_SELECT_OPTIONS = Array.from(new Set(GENERIC_MODEL_PROFILES.map((profile) => profile.group))).map((group) => ({
    label: group,
    options: GENERIC_MODEL_PROFILES.filter((profile) => profile.group === group).map((profile) => ({ label: profile.label, value: profile.id })),
}));

export function ChannelEditorDrawer({ open, channel, onSave, onClose }: { open: boolean; channel: ModelChannel | null; onSave: (channel: ModelChannel) => void; onClose: () => void }) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState<ModelChannel | null>(channel);
    const [selectOpen, setSelectOpen] = useState(false);
    const [scriptTarget, setScriptTarget] = useState<ScriptTarget | null>(null);
    const apiFormatOptions: Array<{ label: string; value: ApiCallFormat }> = [
        { label: "OpenAI", value: "openai" },
        { label: "Gemini", value: "gemini" },
        { label: t("config.protocols.ark"), value: "ark" },
        { label: t("config.protocols.generic"), value: "generic" },
    ];
    const capabilityOptions: Array<{ label: string; value: ModelCapability }> = ["image", "video", "text", "audio"].map((value) => ({ label: t(`config.channelEditor.capabilities.${value}`), value: value as ModelCapability }));

    useEffect(() => {
        if (open && channel) setDraft(channel);
    }, [open, channel]);

    if (!draft) return null;

    const patch = (value: Partial<ModelChannel>) => setDraft((current) => (current ? { ...current, ...value } : current));
    const setModels = (models: ChannelModel[]) => patch({ models });

    const changeApiFormat = (apiFormat: ApiCallFormat) => patch({ apiFormat });

    const applySelection = (names: string[]) => {
        const map = new Map(draft.models.map((model) => [model.name, model]));
        setModels(
            names.map((name) => {
                const existing = map.get(name);
                if (existing) return existing;
                const profile = draft.apiFormat === "generic" ? GENERIC_MODEL_BY_ID.get(name) : undefined;
                return { name, capability: profile ? GENERIC_MODEL_CAPABILITIES[profile.family] : guessCapability(name) };
            }),
        );
    };

    /** 选中服务商预设：填入 Base URL 并联动调用协议；渠道还没有模型时才用预设模型填空，用户已有的模型与 API Key 都不动。 */
    const applyPreset = (presetId: string) => {
        const preset = CHANNEL_PRESETS.find((item) => item.id === presetId);
        if (!preset) return;
        const presetModels = preset.models || [];
        patch({ baseUrl: preset.baseUrl, apiFormat: preset.apiFormat, ...(presetModels.length && !draft.models.length ? { models: [...presetModels] } : {}) });
    };

    const setCapability = (name: string, capability: ModelCapability) => setModels(draft.models.map((model) => (model.name === name ? { ...model, capability } : model)));
    const setScript = (name: string, script: string) => setModels(draft.models.map((model) => (model.name === name ? { ...model, script: script || undefined } : model)));
    const removeModel = (name: string) => setModels(draft.models.filter((model) => model.name !== name));

    const save = () => {
        onSave({ ...draft, name: draft.name.trim() || t("config.channels.unnamed"), models: normalizeChannelModels(draft.models) });
        onClose();
    };

    return (
        <Drawer
            open={open}
            width={640}
            title={t("config.channelEditor.title")}
            onClose={onClose}
            styles={{ body: { paddingTop: 16 } }}
            // 操作按钮统一放在底部：位置固定、不会被悬浮图标遮挡，也避免与头部重复。
            footer={
                <div className="flex justify-end gap-2">
                    <Button onClick={onClose}>{t("common.cancel")}</Button>
                    <Button type="primary" onClick={save}>
                        {t("common.save")}
                    </Button>
                </div>
            }
        >
            <div className="grid gap-4 md:grid-cols-2">
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.name")}</span>
                    <Input value={draft.name} onChange={(event) => patch({ name: event.target.value })} />
                </label>
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.protocol")}</span>
                    <Select className="w-full" value={draft.apiFormat} options={apiFormatOptions} onChange={changeApiFormat} />
                </label>
                <label className="block md:col-span-2">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.baseUrl")}</span>
                    <AutoComplete
                        className="w-full"
                        value={draft.baseUrl}
                        onChange={(value) => patch({ baseUrl: value })}
                        onSelect={(_value, option) => applyPreset(String(option?.presetId || ""))}
                        placeholder="https://api.example.com/v1，也可从下拉里选常用服务商预设"
                        options={CHANNEL_PRESET_OPTIONS}
                        filterOption={(input, option) =>
                            String(option?.label ?? "").toLowerCase().includes(input.toLowerCase()) || String(option?.value ?? "").toLowerCase().includes(input.toLowerCase())
                        }
                    />
                </label>
                <label className="block md:col-span-2">
                    <span className="mb-1 block text-sm font-medium">API Key</span>
                    <Input.Password value={draft.apiKey} onChange={(event) => patch({ apiKey: event.target.value })} placeholder="sk-..." />
                </label>
            </div>

            <div className="mt-6 mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                    <div className="text-sm font-semibold">{t("config.channelEditor.models")}</div>
                    <div className="mt-0.5 text-xs text-stone-500">{t("config.channelEditor.modelDescription", { count: draft.models.length })}</div>
                </div>
                {draft.apiFormat === "generic" ? (
                    // tags 模式：既能从内置模型目录里选，也能直接输入模型名回车添加（预设填进来的目录外模型名删掉后可以再加回）。
                    <Select
                        mode="tags"
                        allowClear
                        showSearch
                        maxTagCount="responsive"
                        className="w-full sm:w-80"
                        value={draft.models.map((model) => model.name)}
                        options={GENERIC_MODEL_SELECT_OPTIONS}
                        optionFilterProp="label"
                        placeholder={t("config.channelEditor.genericModelPlaceholder")}
                        onChange={applySelection}
                    />
                ) : (
                    <Button type="primary" icon={<ListPlus className="size-4" />} onClick={() => setSelectOpen(true)}>
                        {t("config.channelEditor.selectModels")}
                    </Button>
                )}
            </div>

            {draft.apiFormat === "generic" ? <div className="mb-3 text-xs text-stone-500">{t("config.channelEditor.genericModelDescription")}</div> : null}

            <div className="space-y-2 rounded-lg border border-stone-200 p-2 dark:border-stone-800">
                {draft.models.length ? (
                    draft.models.map((model) => (
                        <div key={model.name} className="flex flex-wrap items-center gap-3 rounded-md px-2 py-1.5 hover:bg-stone-50 dark:hover:bg-stone-900/40">
                            <span className="min-w-0 flex-1 truncate text-sm" title={model.name}>
                                {model.name}
                            </span>
                            <div className="flex shrink-0 items-center gap-2">
                                <Segmented size="small" value={model.capability} options={capabilityOptions} onChange={(value) => setCapability(model.name, value as ModelCapability)} />
                                <Button size="small" type={model.script ? "primary" : "default"} ghost={Boolean(model.script)} onClick={() => setScriptTarget({ name: model.name, capability: model.capability, value: model.script || "" })}>
                                    {t(model.script ? "config.channelEditor.scriptReady" : "config.channelEditor.script")}
                                </Button>
                                <Button size="small" danger type="text" icon={<Trash2 className="size-3.5" />} onClick={() => removeModel(model.name)} />
                            </div>
                        </div>
                    ))
                ) : (
                    <div className="px-2 py-8 text-center text-sm text-stone-500">{t("config.channelEditor.empty")}</div>
                )}
            </div>

            {draft.apiFormat !== "generic" ? <ModelSelectModal open={selectOpen} channel={draft} selectedNames={draft.models.map((model) => model.name)} onConfirm={applySelection} onClose={() => setSelectOpen(false)} /> : null}

            <ModelScriptEditor
                open={Boolean(scriptTarget)}
                capability={scriptTarget?.capability || "text"}
                modelName={scriptTarget?.name || ""}
                value={scriptTarget?.value || ""}
                onSave={(script) => scriptTarget && setScript(scriptTarget.name, script)}
                onClose={() => setScriptTarget(null)}
            />
        </Drawer>
    );
}
