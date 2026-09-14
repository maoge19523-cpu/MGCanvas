import { useState } from "react";
import { App, Button, Input } from "antd";
import { FolderSearch, Save, Trash2 } from "lucide-react";

import { detectFfmpeg, readFfmpegPath, setFfmpegPath } from "@/services/platform/desktop-ffmpeg";
import { isTauriRuntime } from "@/services/platform/desktop-runtime";

// 桌面端「本地 FFmpeg」设置：留空时按 PATH 与常见安装目录自动探测。
export function DesktopFfmpegSettings() {
    const { message } = App.useApp();
    const [path, setPath] = useState(readFfmpegPath);
    const [checking, setChecking] = useState(false);

    if (!isTauriRuntime()) return null;

    const detect = async () => {
        setChecking(true);
        try {
            const found = await detectFfmpeg(path.trim() || undefined);
            if (found) message.success(`已找到 FFmpeg：${found}`);
            else message.warning("未检测到 FFmpeg，请确认路径或把 ffmpeg.exe 所在目录加入 PATH");
        } catch (error) {
            message.error(`检测失败（${error instanceof Error ? error.message : String(error)}）`);
        } finally {
            setChecking(false);
        }
    };

    const save = () => {
        setFfmpegPath(path);
        message.success(path.trim() ? "已保存 FFmpeg 路径" : "已清空，将使用自动探测");
    };

    return (
        <div className="flex flex-col">
            <p className="mb-3 text-xs leading-5 text-stone-500 dark:text-zinc-500">视频合成节点使用本机 FFmpeg 完成裁剪、拼接与混音。留空则自动探测 PATH 与常见安装目录（C:\ffmpeg、C:\MediaToolkit 等）；也可手动指定 ffmpeg.exe 的完整路径。</p>
            <div className="flex items-center gap-2">
                <Input className="min-w-0 flex-1" placeholder="例如 C:\ffmpeg\bin\ffmpeg.exe（留空自动探测）" value={path} onChange={(event) => setPath(event.target.value)} allowClear />
                <Button icon={<FolderSearch className="size-4" />} loading={checking} onClick={() => void detect()}>
                    检测
                </Button>
                <Button type="primary" icon={<Save className="size-4" />} onClick={save}>
                    保存
                </Button>
                {path ? (
                    <Button danger type="text" icon={<Trash2 className="size-4" />} aria-label="清空" onClick={() => { setPath(""); setFfmpegPath(""); }} />
                ) : null}
            </div>
        </div>
    );
}
