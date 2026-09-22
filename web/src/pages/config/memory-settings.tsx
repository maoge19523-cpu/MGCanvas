import { Button, Input, Switch, message } from "antd";
import { LoaderCircle, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { clearAgentMemory, fetchAgentMemory, saveAgentMemory, type AgentMemoryEntry, type AgentMemoryLimits } from "@/services/api/canvas-agent";
import { useAgentStore } from "@/stores/use-agent-store";

/** 工作区级本地记忆：只存本机、可开关、可编辑、可清空，读写的都是本地文件。 */
export function MemorySettings() {
    const { t } = useTranslation();
    const connected = useAgentStore((state) => state.connected);
    const url = useAgentStore((state) => state.url);
    const token = useAgentStore((state) => state.token);
    const endpoint = url.trim().replace(/\/$/, "");
    const [enabled, setEnabled] = useState(true);
    const [entries, setEntries] = useState<AgentMemoryEntry[]>([]);
    const [limits, setLimits] = useState<AgentMemoryLimits | null>(null);
    const [draft, setDraft] = useState("");
    const [busy, setBusy] = useState(false);
    const [loaded, setLoaded] = useState(false);

    const usedBytes = entries.reduce((total, entry) => total + new TextEncoder().encode(entry.text).length, 0);

    const persist = async (next: { enabled: boolean; entries: AgentMemoryEntry[] }) => {
        if (!connected) return;
        setBusy(true);
        try {
            const response = await saveAgentMemory(endpoint, token, next);
            setEnabled(response.data?.enabled !== false);
            setEntries(response.data?.entries || []);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("agent.skillManager.memoryFailed"));
        } finally {
            setBusy(false);
        }
    };

    useEffect(() => {
        if (!connected) {
            setLoaded(false);
            return;
        }
        let cancelled = false;
        setBusy(true);
        fetchAgentMemory(endpoint, token)
            .then((response) => {
                if (cancelled || !response.data) return;
                setEnabled(response.data.enabled !== false);
                setEntries(response.data.entries || []);
                setLimits(response.data.limits || null);
                setLoaded(true);
            })
            .catch((error) => {
                if (!cancelled) message.error(error instanceof Error ? error.message : t("agent.skillManager.memoryFailed"));
            })
            .finally(() => {
                if (!cancelled) setBusy(false);
            });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connected, endpoint, token]);

    const addEntry = () => {
        const text = draft.trim();
        if (!text) return;
        const now = new Date().toISOString();
        const next = [...entries, { id: `${Date.now().toString(36)}`, text, createdAt: now, updatedAt: now }];
        setDraft("");
        void persist({ enabled, entries: next });
    };

    const updateEntry = (id: string, text: string) => {
        setEntries((current) => current.map((entry) => (entry.id === id ? { ...entry, text, updatedAt: new Date().toISOString() } : entry)));
    };

    const removeEntry = (id: string) => {
        void persist({ enabled, entries: entries.filter((entry) => entry.id !== id) });
    };

    const clearAll = () => {
        setBusy(true);
        clearAgentMemory(endpoint, token)
            .then((response) => {
                setEnabled(response.data?.enabled !== false);
                setEntries(response.data?.entries || []);
            })
            .catch((error) => message.error(error instanceof Error ? error.message : t("agent.skillManager.memoryFailed")))
            .finally(() => setBusy(false));
    };

    return (
        <div>
            <div className="flex items-center justify-between gap-4">
                <div>
                    <h3 className="text-[15px] font-semibold text-stone-900 dark:text-zinc-100">{t("agent.skillManager.memory")}</h3>
                    <p className="mt-2 text-[11px] leading-5 text-stone-500 dark:text-zinc-500">{t("agent.skillManager.memoryDescription")}</p>
                </div>
                <label className="inline-flex shrink-0 items-center gap-2 text-[11px] text-stone-500 dark:text-zinc-500">
                    <Switch size="small" checked={enabled} loading={busy} disabled={!connected || !loaded} onChange={(checked) => void persist({ enabled: checked, entries })} />
                    {t("agent.skillManager.memoryEnabled")}
                </label>
            </div>

            {!connected ? (
                <p className="mt-4 text-[11px] text-stone-400 dark:text-zinc-600">{t("agent.skillManager.connectToView")}</p>
            ) : (
                <>
                    <div className="mt-4 flex gap-2">
                        <Input className="min-w-0 flex-1" allowClear disabled={busy} value={draft} onChange={(event) => setDraft(event.target.value)} onPressEnter={addEntry} placeholder={t("agent.skillManager.memoryPlaceholder")} />
                        <Button size="small" className="!h-8 shrink-0" disabled={busy || !draft.trim()} icon={<Plus className="size-3.5" />} onClick={addEntry}>{t("agent.skillManager.memoryAdd")}</Button>
                    </div>
                    <div className="mt-3 divide-y border-t border-black/[0.07] dark:border-white/[0.07]">
                        {entries.length ? entries.map((entry) => (
                            <div key={entry.id} className="flex items-center gap-2 py-2">
                                <Input variant="borderless" className="min-w-0 flex-1" disabled={busy} value={entry.text} onChange={(event) => updateEntry(entry.id, event.target.value)} onBlur={() => void persist({ enabled, entries })} />
                                <Button danger type="text" size="small" aria-label={t("agent.skillManager.deleteFile")} disabled={busy} icon={<Trash2 className="size-3.5" />} onClick={() => removeEntry(entry.id)} />
                            </div>
                        )) : (
                            <div className="py-6 text-center text-[11px] text-stone-400 dark:text-zinc-600">{busy && !loaded ? <LoaderCircle className="mx-auto size-4 animate-spin" /> : t("agent.skillManager.memoryEmpty")}</div>
                        )}
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-4 text-[11px] text-stone-400 dark:text-zinc-600">
                        <span className={`tabular-nums ${entries.length >= (limits?.entries ?? 50) * 0.8 || usedBytes >= (limits?.totalBytes ?? 32768) * 0.8 ? "text-amber-600 dark:text-amber-500" : ""}`}>
                            {t("agent.skillManager.memoryUsage", {
                                count: entries.length,
                                max: limits?.entries ?? 50,
                                size: (usedBytes / 1024).toFixed(1),
                                limit: Math.round((limits?.totalBytes ?? 32768) / 1024),
                            })}
                        </span>
                        {entries.length ? (
                            <Button danger type="text" size="small" disabled={busy} onClick={clearAll}>{t("agent.skillManager.memoryClear")}</Button>
                        ) : null}
                    </div>
                </>
            )}
        </div>
    );
}
