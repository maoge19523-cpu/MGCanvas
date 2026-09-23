import { useCallback, useEffect, useState } from "react";
import { Button } from "antd";
import { History, RefreshCw, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";

import { clearComfyRunRecords, deleteComfyRunRecord, listComfyRunRecords, type ComfyRunRecord } from "./run-history";

/**
 * ComfyUI 运行历史。
 *
 * 每次运行的成败、耗时与输出在这里留痕：之前的成败只挂在画布节点上一次性的运行状态上，
 * 切走或重跑后旧记录就没了，失败原因也无处回看。这里读的是本地持久化的记录，
 * 所以重启客户端后仍然能看到。
 */
export function ComfyRunHistorySection() {
    const [records, setRecords] = useState<ComfyRunRecord[]>([]);
    const [loading, setLoading] = useState(true);

    const reload = useCallback(async () => {
        setLoading(true);
        try {
            setRecords(await listComfyRunRecords());
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void reload();
    }, [reload]);

    const removeOne = async (id: string) => {
        await deleteComfyRunRecord(id);
        await reload();
    };

    const clearAll = async () => {
        await clearComfyRunRecords();
        await reload();
    };

    return (
        <section className="py-8">
            <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <h3 className="text-[20px] font-semibold tracking-[-0.03em]">运行历史</h3>
                    <p className="mt-1.5 text-[12px] text-stone-400 dark:text-zinc-600">
                        {records.length ? `最近 ${records.length} 次运行，最多保留 50 条` : "运行过工作流后，这里会留下成败、耗时与输出"}
                    </p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button size="large" icon={<RefreshCw className="size-4" />} onClick={() => void reload()} loading={loading}>
                        刷新
                    </Button>
                    {records.length ? (
                        <Button size="large" danger icon={<Trash2 className="size-4" />} onClick={() => void clearAll()}>
                            清空
                        </Button>
                    ) : null}
                </div>
            </div>

            {records.length ? (
                <div className="mt-6 divide-y divide-black/[0.07] border-y border-black/[0.08] dark:divide-white/[0.07] dark:border-white/[0.08]">
                    {records.map((record) => (
                        <div key={record.id} className="grid gap-4 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                            <div className="flex min-w-0 items-start gap-3">
                                <span
                                    className={cn(
                                        "grid size-10 shrink-0 place-items-center",
                                        record.phase === "succeeded" ? "bg-emerald-500/[0.08] text-emerald-500" : record.phase === "failed" ? "bg-red-500/[0.08] text-red-500" : "bg-stone-500/[0.08] text-stone-400 dark:text-zinc-500",
                                    )}
                                >
                                    <History className="size-[18px]" />
                                </span>
                                <div className="min-w-0">
                                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                                        <span className="truncate text-[14px] font-medium">{record.workflowName}</span>
                                        <span
                                            className={cn(
                                                "size-1.5 rounded-full",
                                                record.phase === "succeeded" ? "bg-emerald-500" : record.phase === "failed" ? "bg-red-500" : "bg-stone-400 dark:bg-zinc-600",
                                            )}
                                        />
                                        <span className="text-[11px] text-stone-400 dark:text-zinc-600">
                                            {record.phase === "succeeded" ? "成功" : record.phase === "failed" ? "失败" : "已取消"}
                                        </span>
                                    </div>
                                    <p className="mt-1 truncate text-[11px] text-stone-400 dark:text-zinc-600">
                                        {formatTime(record.startedAt)} · 用时 {formatDuration(record.completedAt - record.startedAt)}
                                        {record.promptId ? ` · ${record.promptId.slice(0, 8)}` : ""}
                                    </p>
                                    {record.errorDetails ? (
                                        <p className="mt-1.5 line-clamp-3 text-[11px] leading-5 text-red-600 dark:text-red-400">{record.errorDetails}</p>
                                    ) : null}
                                    {record.outputs.length ? (
                                        <div className="mt-2 flex flex-wrap items-center gap-2">
                                            {record.outputs.slice(0, 6).map((output) => (
                                                <span key={`${output.outputId}:${output.itemIndex}`} className="flex items-center gap-1.5">
                                                    {output.mimeType?.startsWith("image/") && output.content ? (
                                                        <img src={output.content} alt={output.label} className="size-10 rounded object-cover" />
                                                    ) : (
                                                        <span className="rounded border border-black/[0.08] px-1.5 py-0.5 text-[10px] text-stone-500 dark:border-white/[0.08] dark:text-zinc-400">
                                                            {output.label}
                                                        </span>
                                                    )}
                                                    {output.filename ? <span className="max-w-40 truncate text-[10px] text-stone-400 dark:text-zinc-600">{output.filename}</span> : null}
                                                </span>
                                            ))}
                                            {record.outputs.length > 6 ? <span className="text-[10px] text-stone-400 dark:text-zinc-600">+{record.outputs.length - 6}</span> : null}
                                        </div>
                                    ) : null}
                                </div>
                            </div>
                            <div className="flex justify-end gap-1">
                                <Button type="text" size="small" danger icon={<Trash2 className="size-3.5" />} onClick={() => void removeOne(record.id)} aria-label="删除这条记录" />
                            </div>
                        </div>
                    ))}
                </div>
            ) : (
                <div className="mt-6 flex min-h-32 items-center justify-center border-y border-dashed border-black/[0.1] text-center text-[13px] leading-6 text-stone-400 dark:border-white/[0.1] dark:text-zinc-600">
                    还没有运行记录。在画布上运行 ComfyUI 工作流节点后，这里会列出每一次成败。
                </div>
            )}
        </section>
    );
}

function formatTime(value: number) {
    const date = new Date(value);
    const pad = (input: number) => String(input).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDuration(ms: number) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return `${seconds} 秒`;
    return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
