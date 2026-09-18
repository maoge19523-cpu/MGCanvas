import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PORT = 17371;
export const CONFIG_DIR = path.join(os.homedir(), ".mgcanvas");
export const CONFIG_FILE = path.join(CONFIG_DIR, "mgcanvas-agent.json");
export const VERSION = readPackageVersion();
export const AGENT_PROMPT = fs.readFileSync(new URL("../agent-instructions.md", import.meta.url), "utf8");
const initializedWorkspaces = new Set<string>();

export type SiteWorkspaceConfig = { workspacePath: string; activeThreadId?: string; pinnedThreadIds?: string[] };

/** 基于 API Key 的 Agent 后端配置（DeepSeek / 豆包等兼容 OpenAI 的接口）。 */
export type ApiBackendSettings = { baseUrl: string; apiKey: string; model: string; label: string; enabled?: boolean };

export type MGCanvasAgentConfig = { url: string; token: string; origins?: string[]; workspace?: SiteWorkspaceConfig; api?: ApiBackendSettings };

/** 读取已保存的 API 后端配置，未配置时返回空值。 */
export function readApiBackendSettings(config: MGCanvasAgentConfig): ApiBackendSettings | null {
    const api = config.api;
    if (!api?.baseUrl || !api?.model) return null;
    return { baseUrl: api.baseUrl, apiKey: api.apiKey || "", model: api.model, label: api.label || "API 后端", enabled: api.enabled !== false };
}

/** 保存 API 后端配置。 */
export function saveApiBackendSettings(config: MGCanvasAgentConfig, patch: Partial<ApiBackendSettings>) {
    config.api = {
        baseUrl: String(patch.baseUrl ?? config.api?.baseUrl ?? "").trim(),
        apiKey: String(patch.apiKey ?? config.api?.apiKey ?? "").trim(),
        model: String(patch.model ?? config.api?.model ?? "").trim(),
        label: String(patch.label ?? config.api?.label ?? "API 后端").trim() || "API 后端",
        enabled: patch.enabled ?? config.api?.enabled ?? true,
    };
    saveConfig(config);
    return config.api;
}

/** 读取本地 MGCanvas Agent 配置，不存在时生成默认配置。 */
export function loadConfig(create = false): MGCanvasAgentConfig {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as MGCanvasAgentConfig;
    } catch {
        const config = { url: `http://127.0.0.1:${Number(process.env.PORT) || DEFAULT_PORT}`, token: crypto.randomBytes(18).toString("hex") };
        if (create) saveConfig(config);
        return config;
    }
}

/** 将 MGCanvas Agent 配置写入用户配置目录。 */
export function saveConfig(config: MGCanvasAgentConfig) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

/** 确保站点级 Codex 工作空间存在并已初始化。 */
export function ensureSiteWorkspace(config: MGCanvasAgentConfig) {
    const current = config.workspace;
    if (current?.workspacePath) {
        const workspacePath = resolveWorkspacePath(current.workspacePath);
        initializeWorkspace(workspacePath);
        return { ...current, workspacePath };
    }
    const workspacePath = path.join(CONFIG_DIR, "codex-workspaces", "site");
    config.workspace = { workspacePath };
    initializeWorkspace(workspacePath);
    saveConfig(config);
    return { workspacePath };
}

/** 更新站点级 Codex 工作空间配置。 */
export function updateSiteWorkspace(config: MGCanvasAgentConfig, patch: Partial<SiteWorkspaceConfig>) {
    const current = ensureSiteWorkspace(config);
    const workspacePath = patch.workspacePath ? resolveWorkspacePath(patch.workspacePath) : current.workspacePath;
    const next = { ...current, ...patch, workspacePath };
    config.workspace = { workspacePath: next.workspacePath, activeThreadId: next.activeThreadId, pinnedThreadIds: next.pinnedThreadIds };
    initializeWorkspace(workspacePath);
    saveConfig(config);
    return config.workspace;
}

/** 创建工作空间目录并写入默认 AGENTS.md。 */
function initializeWorkspace(workspacePath: string) {
    if (initializedWorkspaces.has(workspacePath)) return;
    fs.mkdirSync(workspacePath, { recursive: true });
    const instructionsFile = path.join(workspacePath, "AGENTS.md");
    const current = fs.existsSync(instructionsFile) ? fs.readFileSync(instructionsFile, "utf8") : "";
    if (!current || current.startsWith("# MGCanvas Agent")) fs.writeFileSync(instructionsFile, AGENT_PROMPT);
    initializedWorkspaces.add(workspacePath);
}

/** 将用户输入的工作空间路径解析为绝对路径。 */
function resolveWorkspacePath(value: string) {
    if (value === "~") return os.homedir();
    if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
    return path.resolve(value);
}

/** 从当前包信息中读取 MGCanvas Agent 版本号。 */
function readPackageVersion() {
    try {
        const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
        return pkg.version || "0.0.0";
    } catch {
        return "0.0.0";
    }
}
