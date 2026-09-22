import { Component, type ErrorInfo, type ReactNode } from "react";

// 崩溃取证：生产包没有 DevTools，React 开发版的完整报错（例如 getSnapshot 未缓存、
// Maximum update depth exceeded 这类渲染循环提示）只会打到控制台，用户根本看不到。
// 这里把 console 的报错与警告留在环形缓冲里，崩溃页直接把它们显示出来，截图即可定位。
const captured: string[] = [];
const MAX_CAPTURED = 30;
let patched = false;

function describe(item: unknown) {
    if (item instanceof Error) return `${item.name}: ${item.message}`;
    if (typeof item === "string") return item;
    try {
        return JSON.stringify(item);
    } catch {
        return String(item);
    }
}

function captureConsole() {
    if (patched) return;
    patched = true;
    for (const level of ["error", "warn"] as const) {
        const original = console[level].bind(console);
        console[level] = (...args: unknown[]) => {
            try {
                captured.push(`${level === "error" ? "[错误]" : "[警告]"} ${args.map(describe).join(" ")}`.slice(0, 2000));
                if (captured.length > MAX_CAPTURED) captured.shift();
            } catch {
                // 取证失败不影响正常输出
            }
            original(...args);
        };
    }
}

captureConsole();

type Props = { children: ReactNode };
type State = { message: string; stack: string };

export class AppErrorBoundary extends Component<Props, State> {
    state: State = { message: "", stack: "" };

    static getDerivedStateFromError(error: unknown): Partial<State> {
        return { message: error instanceof Error ? error.message : String(error) };
    }

    componentDidCatch(error: unknown, info: ErrorInfo) {
        const stack = info.componentStack || "";
        this.setState({ stack });
        console.error("[mgcanvas] 渲染崩溃：", error);
        console.error("[mgcanvas] 组件栈：", stack);
    }

    render() {
        if (!this.state.message) return this.props.children;
        return (
            <div className="flex min-h-screen items-center justify-center bg-stone-50 p-8 dark:bg-zinc-950">
                <div className="w-full max-w-3xl rounded-2xl border border-stone-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
                    <h1 className="text-base font-medium text-stone-900 dark:text-zinc-100">界面出错了</h1>
                    <p className="mt-2 text-sm text-stone-500 dark:text-zinc-400">这一步的界面没能渲染出来，画布内容与项目文件都不受影响，可以重试或重新加载界面。</p>
                    <p className="mt-4 break-all rounded-lg bg-stone-100 px-3 py-2 text-xs text-stone-700 dark:bg-zinc-800 dark:text-zinc-300">{this.state.message}</p>
                    {captured.length ? (
                        <>
                            <div className="mt-4 text-xs font-medium text-stone-500 dark:text-zinc-400">崩溃前的控制台输出（最近 {captured.length} 条）</div>
                            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-4 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">{captured.join("\n")}</pre>
                        </>
                    ) : null}
                    {this.state.stack ? (
                        <>
                            <div className="mt-4 text-xs font-medium text-stone-500 dark:text-zinc-400">组件栈（最上面的是最内层组件）</div>
                            <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-stone-100 px-3 py-2 text-[11px] leading-4 text-stone-600 dark:bg-zinc-800 dark:text-zinc-400">{this.state.stack}</pre>
                        </>
                    ) : null}
                    <div className="mt-5 flex gap-3">
                        <button
                            type="button"
                            className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
                            onClick={() => this.setState({ message: "", stack: "" })}
                        >
                            重试
                        </button>
                        <button
                            type="button"
                            className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
                            onClick={() => window.location.reload()}
                        >
                            重新加载界面
                        </button>
                    </div>
                </div>
            </div>
        );
    }
}
