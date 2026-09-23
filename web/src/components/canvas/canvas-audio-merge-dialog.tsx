import { useEffect, useMemo, useState } from "react";
import { Button, Checkbox, Modal } from "antd";
import { ChevronDown, ChevronUp, Music2 } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { formatDuration } from "@/lib/image-utils";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

// 多角色配音合并：把画布上选中的音频节点按列表顺序拼成一个音频文件。
// 拼接与编码都由本机 FFmpeg 完成，这里只负责选段与顺序。
export function CanvasAudioMergeDialog({ open, nodes, busy, onClose, onMerge }: { open: boolean; nodes: CanvasNodeData[]; busy: boolean; onClose: () => void; onMerge: (sources: CanvasNodeData[]) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const sources = useMemo(() => nodes.filter((node) => node.type === CanvasNodeType.Audio && Boolean(node.metadata?.content)), [nodes]);
    const [order, setOrder] = useState<string[]>([]);
    const [selected, setSelected] = useState<string[]>([]);

    // 每次打开都按画布当前顺序重排并默认全选：多数情况就是把角色的配音全部合并。
    useEffect(() => {
        if (!open) return;
        const ids = sources.map((node) => node.id);
        setOrder(ids);
        setSelected(ids);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const ordered = order.map((id) => sources.find((node) => node.id === id)).filter((node): node is CanvasNodeData => Boolean(node));
    const picked = ordered.filter((node) => selected.includes(node.id));
    const move = (index: number, delta: number) =>
        setOrder((current) => {
            const next = [...current];
            const target = index + delta;
            if (target < 0 || target >= next.length) return current;
            [next[index], next[target]] = [next[target], next[index]];
            return next;
        });

    return (
        <Modal title="合并配音" open={open} onCancel={busy ? undefined : onClose} onOk={() => onMerge(picked)} okText={busy ? "合并中…" : `合并 ${picked.length} 个音频`} cancelText="取消" confirmLoading={busy} okButtonProps={{ disabled: picked.length < 2 }} width={520} centered>
            <div className="thin-scrollbar max-h-[52dvh] min-h-16 overflow-y-auto" data-canvas-no-zoom>
                {ordered.length === 0 ? (
                    <div className="py-4 text-xs" style={{ color: theme.node.faint }}>
                        画布上还没有可合并的音频节点，请先生成或上传配音。
                    </div>
                ) : null}
                {ordered.map((node, index) => (
                    <div key={node.id} className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5">
                        <Checkbox checked={selected.includes(node.id)} onChange={(event) => setSelected((current) => (event.target.checked ? [...current, node.id] : current.filter((id) => id !== node.id)))} />
                        <span className="w-4 shrink-0 text-center text-[10px] tabular-nums" style={{ color: theme.node.faint }}>
                            {index + 1}
                        </span>
                        <Music2 className="size-3.5 shrink-0 opacity-50" />
                        <span className="min-w-0 flex-1 truncate text-xs" style={{ color: theme.node.text }} title={node.title}>
                            {node.title || "未命名"}
                        </span>
                        <span className="shrink-0 text-[10px] tabular-nums" style={{ color: theme.node.faint }}>
                            {formatDuration(node.metadata?.durationMs || 0)}
                        </span>
                        <Button size="small" type="text" disabled={index === 0 || busy} icon={<ChevronUp className="size-3.5" />} aria-label="上移" onClick={() => move(index, -1)} />
                        <Button size="small" type="text" disabled={index === ordered.length - 1 || busy} icon={<ChevronDown className="size-3.5" />} aria-label="下移" onClick={() => move(index, 1)} />
                    </div>
                ))}
            </div>
            <p className="mt-2 text-[11px] leading-5" style={{ color: theme.node.faint }}>
                按上面顺序依次拼接选中的音频，合并结果会生成一个新的音频节点；未勾选的音频不参与合并。
            </p>
        </Modal>
    );
}
