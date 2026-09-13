import {
    genericNativeNodeKind,
    createGenericNativePayload,
    parseGenericNativePayload,
    writeGenericNativePrompt,
} from "@/components/canvas/generic-native-generation";
import type { CanvasNodeData, CanvasNodeMetadata, CanvasNodeTypeId } from "@/types/canvas";

export const LAST_USED_NODE_CONFIG_KEY = "mgcanvas:last-used-node-config:v1";

type LastUsedNodeConfigMap = Partial<Record<"image" | "video" | "audio" | "text", CanvasNodeMetadata>>;

type PreferenceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const CONFIG_FIELDS: ReadonlyArray<keyof CanvasNodeMetadata> = [
    "genericOperation",
    "genericPayload",
    "model",
    "generationMode",
    "generationType",
    "size",
    "quality",
    "background",
    "count",
    "seconds",
    "vquality",
    "generateAudio",
    "watermark",
    "audioVoice",
    "audioFormat",
    "audioSpeed",
    "audioInstructions",
    "reasoningEffort",
];

export function rememberLastUsedNodeConfig(node: CanvasNodeData, storage = browserStorage()) {
    const kind = genericNativeNodeKind(node.type);
    if (!kind || !storage || node.metadata?.sourceOrigin === "upload") return;
    const config = extractReusableNodeConfig(node.metadata);
    if (!Object.keys(config).length) return;
    const current = readPreferenceMap(storage);
    storage.setItem(LAST_USED_NODE_CONFIG_KEY, JSON.stringify({ ...current, [kind]: config }));
}

export function readLastUsedNodeConfig(type: CanvasNodeTypeId, storage = browserStorage()): CanvasNodeMetadata | undefined {
    const kind = genericNativeNodeKind(type);
    if (!kind || !storage) return undefined;
    const config = readPreferenceMap(storage)[kind];
    return config ? { ...config } : undefined;
}

export function extractReusableNodeConfig(metadata?: CanvasNodeMetadata): CanvasNodeMetadata {
    if (!metadata) return {};
    const config: CanvasNodeMetadata = {};
    for (const field of CONFIG_FIELDS) {
        const value = metadata[field];
        if (value !== undefined) Object.assign(config, { [field]: value });
    }

    const operationId = config.genericOperation;
    const payload = parseGenericNativePayload(config.genericPayload);
    if (operationId && payload) {
        const reusablePayload = createGenericNativePayload(operationId, payload);
        writeGenericNativePrompt(operationId, reusablePayload, "");
        config.genericPayload = JSON.stringify(reusablePayload, null, 2);
        config.prompt = undefined;
    }
    return config;
}

function readPreferenceMap(storage: PreferenceStorage): LastUsedNodeConfigMap {
    try {
        const parsed = JSON.parse(storage.getItem(LAST_USED_NODE_CONFIG_KEY) || "{}") as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as LastUsedNodeConfigMap) : {};
    } catch {
        storage.removeItem(LAST_USED_NODE_CONFIG_KEY);
        return {};
    }
}

function browserStorage(): PreferenceStorage | null {
    return typeof window === "undefined" ? null : window.localStorage;
}
