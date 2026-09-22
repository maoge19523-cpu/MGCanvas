import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { message: string; stack: string };

// 崩溃兜底：未捕获的渲染错误会被 React 整页替换成白底红字，既不友好，
// 压缩后的生产包里也只有一个错误编号、看不到组件栈。这里捕获后把 componentStack
// 同时打到控制台和页面上，便于定位渲染循环这类问题。
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
                <div className="w-full max-w-2xl rounded-2xl border border-stone-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
                    <h1 className="text-base font-medium text-stone-900 dark:text-zinc-100">界面出错了</h1>
                    <p className="mt-2 text-sm text-stone-500 dark:text-zinc-400">这一步的界面没能渲染出来，画布内容与项目文件都不受影响，可以重试或重新加载界面。</p>
                    <p className="mt-4 break-all rounded-lg bg-stone-100 px-3 py-2 text-xs text-stone-700 dark:bg-zinc-800 dark:text-zinc-300">{this.state.message}</p>
                    {this.state.stack ? (
                        <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-stone-100 px-3 py-2 text-[11px] leading-4 text-stone-600 dark:bg-zinc-800 dark:text-zinc-400">{this.state.stack}</pre>
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
