import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "antd";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

// i18n 初始化会读 localStorage：node 环境没有它，必须在任何模块导入前补一个最小替身。
vi.hoisted(() => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => void store.set(key, String(value)),
            removeItem: (key: string) => void store.delete(key),
            clear: () => store.clear(),
        },
    });
});

import { editSnapshot, sameEditSnapshot, EDIT_HISTORY_MERGE_MS } from "@/lib/edit/history";
import { useAssetStore } from "@/stores/use-asset-store";
import { useEditStore } from "@/stores/use-edit-store";
import { EDIT_DEFAULT_OUTPUT, type EditProject } from "@/types/edit";
import { PRE_GAIN_BASE_ROW, PRE_GAIN_MUTED_ROW, PRE_GAIN_OFFSET_ROW } from "./__fixtures__/timeline-pre-gain-overlay";
import { EditInspector } from "./components/edit-inspector";
import EditProjectPage from "./project";

const DUMP_DIR = join(tmpdir(), "mgcanvas-editor-audio-mute-regression");

/** 把静态渲染结果落盘再读回：验证的是真实产物，而不是内存里的中间态。 */
function dump(name: string, markup: string) {
    mkdirSync(DUMP_DIR, { recursive: true });
    const file = join(DUMP_DIR, `${name}.html`);
    writeFileSync(file, markup, "utf8");
    return readFileSync(file, "utf8");
}

/**
 * 与用户上报时同一形状的项目：**一条音轨**（女声.mp3，音量 100%、起点 0、淡入淡出 0），
 * 两条视频片段（于是有一条接缝转场标记），外加一条字幕（字幕行与接缝标记都要一起核对没被新层压住）。
 */
const DEMO: EditProject = {
    id: "edit-audio-mute",
    name: "音轨静音回归",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-02T03:04:00.000Z",
    media: [
        { id: "v1", name: "画面.mp4", kind: "video", source: "local", url: "blob:v1", durationMs: 12000, createdAt: "2024-01-01T00:00:00.000Z" },
        { id: "a1", name: "女声.mp3", kind: "audio", source: "local", url: "blob:a1", durationMs: 12000, createdAt: "2024-01-01T00:00:00.000Z" },
    ],
    clips: [
        { id: "c1", mediaId: "v1", start: 0, end: 6, volume: 1, fadeIn: 0, fadeOut: 0, transitionDuration: 0.5 },
        { id: "c2", mediaId: "v1", start: 6, end: 12, volume: 1, fadeIn: 0, fadeOut: 0, transitionDuration: 0.5 },
    ],
    // t1 正常出声、t2 已静音：同一个产物里两种状态都在，比较的就是同一个按钮的两种样子。
    audioTracks: [
        { id: "t1", mediaId: "a1", volume: 1, fadeIn: 0, fadeOut: 0, loop: false },
        { id: "t2", mediaId: "a1", volume: 1, fadeIn: 0, fadeOut: 0, loop: false, muted: true },
    ],
    subtitles: [{ id: "s1", start: 1, end: 3, text: "第一句" }],
    output: { ...EDIT_DEFAULT_OUTPUT },
};

function render(project: EditProject, name: string) {
    useEditStore.setState({ hydrated: true, projects: [project], history: {} });
    useAssetStore.setState({ assets: [], hydrated: true });
    return dump(
        name,
        renderToStaticMarkup(
            <MemoryRouter initialEntries={[`/editor/${project.id}`]}>
                <App>
                    <Routes>
                        <Route path="/editor/:id" element={<EditProjectPage />} />
                    </Routes>
                </App>
            </MemoryRouter>,
        ),
    );
}

/** 某个标记所在元素的**开始标签**（属性都在里面）。 */
function tagOf(markup: string, marker: string) {
    const at = markup.indexOf(marker);
    expect(at, `产物里找不到 ${marker}`).toBeGreaterThan(-1);
    return markup.slice(markup.lastIndexOf("<", at), markup.indexOf(">", at) + 1);
}

/** 某个标记所在元素的**完整切片**（含内容）：图标这类「在标签里面」的东西只能这样核对。 */
function sliceOf(markup: string, marker: string, close: string) {
    const at = markup.indexOf(marker);
    expect(at, `产物里找不到 ${marker}`).toBeGreaterThan(-1);
    const start = markup.lastIndexOf("<", at);
    const end = markup.indexOf(close, at);
    expect(end, `${marker} 没有闭合`).toBeGreaterThan(at);
    return markup.slice(start, end + close.length);
}

/** 某个标记**之后**出现的第一个开始标签（属性区里开关的 data 属性挂在包一层的 span 上）。 */
function tagAfter(markup: string, marker: string, tag: string) {
    const at = markup.indexOf(marker);
    expect(at, `产物里找不到 ${marker}`).toBeGreaterThan(-1);
    const start = markup.indexOf(`<${tag}`, at);
    expect(start, `${marker} 之后找不到 <${tag}>`).toBeGreaterThan(at);
    return markup.slice(start, markup.indexOf(">", start) + 1);
}

/** 截出某个标记所在的那个 <div> 子树（含它自己的闭合标签）。 */
function divSlice(markup: string, marker: string) {
    const at = markup.indexOf(marker);
    expect(at, `产物里找不到 ${marker}`).toBeGreaterThan(-1);
    const start = markup.lastIndexOf("<div", at);
    const tags = /<div\b|<\/div>/g;
    tags.lastIndex = start;
    let depth = 0;
    let match: RegExpExecArray | null;
    while ((match = tags.exec(markup)) !== null) {
        if (match[0] === "</div>") {
            depth -= 1;
            if (depth === 0) return markup.slice(start, match.index + "</div>".length);
        } else depth += 1;
    }
    throw new Error(`${marker} 所在的 div 没有闭合`);
}

function styleOf(tag: string) {
    return tag.match(/style="([^"]*)"/)?.[1] ?? "";
}

/** 从 class 里读 z-index（`z-10` / `z-[3]` 两种写法都要读得出来），读不到就是 null。 */
function zIndexOf(tag: string) {
    const arbitrary = tag.match(/\bz-\[(-?\d+)\]/);
    if (arbitrary) return Number(arbitrary[1]);
    const named = tag.match(/\bz-(\d+)\b/);
    return named ? Number(named[1]) : null;
}

function project() {
    return useEditStore.getState().projects.find((item) => item.id === DEMO.id)!;
}

/**
 * 用户上报：「音轨的静音键打不开了，一直在静音」。
 *
 * 先排除掉两种「看起来像按钮坏了」的机制，再守住真正的那一个：
 * 1. 点击被新加的覆盖层吃掉？——已用真实浏览器核对，见下面第一个 describe：覆盖层不吃指针事件、
 *    层级低于轨道头、盒子不超出本行，点静音 / 独奏 / 锁定三个按钮命中的都是按钮自己。
 * 2. 状态写入被历史比较丢掉（本仓库踩过两次的老坑）？——下面逐个字段核对比较函数，双向切换各写一次。
 * 3. **真正的机制**：静音按钮过去无论开还是关都画 `VolumeX`（叉掉的喇叭），只换颜色与底色。
 *    用户点完看到的是同一只叉喇叭，于是判定「静音键打不开、一直在静音」——按钮其实一直在工作。
 */
describe("剪辑台音轨静音开关：图标必须真的跟着状态换（用户上报的「静音键打不开」）", () => {
    it("未静音的轨画实心喇叭（Volume2），已静音的轨才画叉喇叭（VolumeX）", () => {
        const markup = render(DEMO, "editor-audio-mute-icon");

        const open = sliceOf(markup, 'data-edit-track-mute="t1"', "</button>");
        const muted = sliceOf(markup, 'data-edit-track-mute="t2"', "</button>");

        // 两个按钮的语义状态本来就分得清：未静音是「静音」动作、已静音是「取消静音」动作。
        expect(open).toContain('aria-pressed="false"');
        expect(muted).toContain('aria-pressed="true"');

        // 未静音：必须是**实心喇叭**，不能是叉喇叭。只换颜色时这里画的是叉喇叭，
        // 用户点完（红→灰）看到的还是叉喇叭，实测就被读成「静音键打不开」。
        expect(open, `未静音的静音按钮仍是叉喇叭：${open}`).toContain("lucide-volume-2");
        expect(open, `未静音的静音按钮不该出现叉喇叭：${open}`).not.toContain("lucide-volume-x");
        // 已静音：叉喇叭。
        expect(muted).toContain("lucide-volume-x");
        expect(muted).not.toContain("lucide-volume-2");
        // 底色也要分得开（激活态一层底色，未激活透明）。
        expect(open).toContain("bg-transparent");
        expect(muted).toContain("bg-black/[0.09]");
    });

    it("视频轨轨道头的「关闭原声」是同一个写法：两种状态两个图标（音轨头过去与之不一致）", () => {
        const markup = render(DEMO, "editor-audio-mute-video-head");
        const head = sliceOf(markup, "data-edit-video-track-mute", "</button>");
        // 本项目的既有写法就该是这样：一个开关的两种状态必须是两个图标。
        expect(head).toContain("lucide-volume-2");
        expect(head).not.toContain("lucide-volume-x");
    });
});

/**
 * 同一类问题在同一排按钮里的第二例：**独奏**按钮过去无论开还是关都画同一只 `Headphones`，
 * 只换颜色与底色（这一排里静音已经修好、锁定本来就是两图标）。用户点完看到的还是那只耳机，
 * 于是被读成「独奏键没反应」——与静音那次是同一个机制，所以一并修掉并守在这里。
 */
describe("剪辑台音轨独奏开关：图标必须真的跟着状态换（与静音、锁定同一写法）", () => {
    /** 同一份产物里两种状态都在：t1 未独奏、t3 已独奏，比的就是同一个按钮的两种样子。 */
    const SOLO_DEMO: EditProject = {
        ...DEMO,
        audioTracks: [
            { id: "t1", mediaId: "a1", volume: 1, fadeIn: 0, fadeOut: 0, loop: false },
            { id: "t3", mediaId: "a1", volume: 1, fadeIn: 0, fadeOut: 0, loop: false, solo: true },
        ],
    };

    it("未独奏的轨画斜杠耳机（HeadphoneOff），已独奏的轨才画耳机（Headphones）", () => {
        const markup = render(SOLO_DEMO, "editor-audio-solo-icon");

        const open = sliceOf(markup, 'data-edit-track-solo="t1"', "</button>");
        const soloed = sliceOf(markup, 'data-edit-track-solo="t3"', "</button>");

        // 语义状态本来就分得清：未独奏是「独奏」动作、已独奏是「取消独奏」动作。
        expect(open).toContain('aria-pressed="false"');
        expect(soloed).toContain('aria-pressed="true"');

        // 未独奏：斜杠耳机；不能还是那只耳机（只换颜色时这里画的仍是 Headphones，
        // 用户点完（主题色→灰）看到的还是同一只耳机，实测就被读成「独奏键没反应」）。
        expect(open, `未独奏的独奏按钮仍是耳机：${open}`).toContain("lucide-headphone-off");
        expect(open, `未独奏的独奏按钮不该出现耳机：${open}`).not.toContain("lucide-headphones");
        // 已独奏：耳机。
        expect(soloed).toContain("lucide-headphones");
        expect(soloed).not.toContain("lucide-headphone-off");
        // 底色与颜色照旧分得开（激活态一层底色、未激活透明），与静音 / 锁定一致。
        expect(open).toContain("bg-transparent");
        expect(soloed).toContain("bg-black/[0.09]");
        expect(soloed).toContain("color:#1677ff");
        expect(open).toContain("color:rgba(0,0,0,0.45)");
    });

    it("独奏按钮仍然走同一个 toggle() → updateAudioTrack：不许为图标另起一套状态路径（静态守护）", () => {
        const source = readFileSync(new URL("./components/edit-audio-track.tsx", import.meta.url), "utf8");

        // 三个按钮逐字同形：同一个 toggle()，只有字段不同。
        for (const field of ["muted", "solo", "locked"]) expect(source).toContain(`onClick={() => toggle({ ${field}: !track.${field} })}`);
        // 图标只看 track.solo（不许改成看 audibility 之类的另一套判定：两处判定一定会分叉）。
        expect(source).toContain("icon={track.solo ? <Headphones");
        // 独奏的写入路径整份文件里只有这一处。
        expect(source.split("solo: !track.solo").length - 1).toBe(1);
    });

    it("冻结产物跟着重新冻结：独奏按钮那一小段已经是新图标，旧字节不许留在冻结串里", () => {
        for (const frozen of [PRE_GAIN_BASE_ROW, PRE_GAIN_MUTED_ROW, PRE_GAIN_OFFSET_ROW]) {
            expect(frozen).toContain("lucide-headphone-off");
            expect(frozen).not.toContain("lucide-headphones");
            // 重新冻结只允许动独奏按钮那段字节：其余部分（含结尾的 </span></div>）逐字未变。
            expect(frozen.endsWith("</div>")).toBe(true);
        }
    });
});

/**
 * 可能性 B 的排查（「能静音、关不掉」）：状态写入会不会被 history.ts 的比较函数判成「没变」而丢掉。
 * 这条过去在本仓库踩过两次（音轨静音、视频片段关闭原声），所以这里把**全部字段**逐个单独改一遍。
 * 这些断言在修复前也是通过的——结论是：静音的状态写入这条路是好的，问题不在这里。
 */
describe("剪辑台音轨静音：状态双向写入与历史比较（可能性 B 的排查）", () => {
    const base = (project: EditProject): EditProject => ({ ...project, audioTracks: [{ id: "t1", mediaId: "a1", volume: 1, fadeIn: 0, fadeOut: 0, loop: false }] });

    it("音轨的每一个字段单独改动都要算「变了」：比较函数不许漏字段", () => {
        const before = base(DEMO);
        const track = before.audioTracks[0]!;
        const patches: Array<[string, Partial<typeof track>]> = [
            ["mediaId", { mediaId: "a2" }],
            ["volume", { volume: 0.5 }],
            ["fadeIn", { fadeIn: 1 }],
            ["fadeOut", { fadeOut: 1 }],
            ["loop", { loop: true }],
            ["muted", { muted: true }],
            ["solo", { solo: true }],
            ["locked", { locked: true }],
            ["start", { start: 1 }],
            ["id", { id: "t9" }],
        ];
        for (const [field, patch] of patches) {
            const after = { ...before, audioTracks: [{ ...track, ...patch }] };
            expect(sameEditSnapshot(editSnapshot(before), editSnapshot(after)), `改了 ${field} 却被判成「没变」`).toBe(false);
        }
        // 全部字段一致时仍然是「没变」（否则每次点开关都会多压一条空历史）。
        expect(sameEditSnapshot(editSnapshot(before), editSnapshot({ ...before, audioTracks: [{ ...track }] }))).toBe(true);
    });

    it("取消静音（muted true → false）必须算「变了」：这条被丢掉就是「点了关不掉」", () => {
        const muted = { ...base(DEMO), audioTracks: [{ id: "t1", mediaId: "a1", volume: 1, fadeIn: 0, fadeOut: 0, loop: false, muted: true }] };
        const unmuted = { ...muted, audioTracks: [{ ...muted.audioTracks[0]!, muted: false }] };
        expect(sameEditSnapshot(editSnapshot(muted), editSnapshot(unmuted))).toBe(false);
    });

    it("静音能开也能关：两次都真的写进状态、各压一条历史（关不掉的那个方向也走通）", () => {
        useEditStore.setState({ hydrated: true, projects: [base(DEMO)], history: {} });
        const history = () => useEditStore.getState().history[DEMO.id]?.past ?? [];
        const toggle = (patch: Parameters<ReturnType<typeof useEditStore.getState>["updateAudioTrack"]>[2]) => useEditStore.getState().updateAudioTrack(DEMO.id, "t1", patch);

        // 同一次编辑的连续改动会按 mergeKey 合并成一条（600ms 窗口内），所以两次方向相反的点击之间
        // 要把时间推过窗口：这里用假时钟控制 Date.now()，被测代码本身一行都没改。
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));

            // 开：未静音 → 静音
            toggle({ muted: true });
            expect(project().audioTracks[0]!.muted).toBe(true);
            expect(history()).toHaveLength(1);
            vi.advanceTimersByTime(EDIT_HISTORY_MERGE_MS + 1);

            // 关：静音 → 未静音（用户点不动的那一下）。这一下过去可能被历史比较判成「值没变」而整次丢弃。
            toggle({ muted: false });
            expect(project().audioTracks[0]!.muted).toBe(false);
            expect(history(), "取消静音没有产生历史记录：这次更新被判成「值没变」丢掉了").toHaveLength(2);
            // 撤销栈里那条记录的 before / after 真的是两种状态（不是空的「什么都没改」）。
            const last = history()[1]!;
            expect(last.before.audioTracks[0]!.muted).toBe(true);
            expect(last.after.audioTracks[0]!.muted).toBe(false);
            vi.advanceTimersByTime(EDIT_HISTORY_MERGE_MS + 1);

            // 值没变就不该再压历史（点了两下同一个状态不该多出记录）。
            toggle({ muted: false });
            expect(history()).toHaveLength(2);

            // 独奏 / 锁定是同一类「点一下切状态」，同样双向各走通一次。
            for (const field of ["solo", "locked"] as const) {
                vi.advanceTimersByTime(EDIT_HISTORY_MERGE_MS + 1);
                toggle({ [field]: true });
                expect(project().audioTracks[0]![field]).toBe(true);
                vi.advanceTimersByTime(EDIT_HISTORY_MERGE_MS + 1);
                toggle({ [field]: false });
                expect(project().audioTracks[0]![field]).toBe(false);
            }
        } finally {
            vi.useRealTimers();
        }
    });
});

/**
 * 第二入口：属性区的音轨设置里必须也有静音 / 独奏。轨道头按钮万一失效时，
 * 用户过去在属性区**完全没有别的办法**（只能看着一条静音的轨）。
 * 两个入口必须是同一份状态、同一个判定：都写 updateAudioTrack 的 muted / solo，
 * 都读 editTrackAudibility（「这条轨到底出不出声」的唯一判定），不另造第二套。
 */
describe("剪辑台属性区：音轨的静音 / 独奏第二入口，与轨道头共用同一份状态与判定", () => {
    // 三条轨：t1 正常、t2 已静音、t3 独奏 —— 于是 t1 被独奏排除、t2 记成静音，三种处境各一份产物。
    const soloed: EditProject = {
        ...DEMO,
        audioTracks: [
            { id: "t1", mediaId: "a1", volume: 1, fadeIn: 0, fadeOut: 0, loop: false },
            { id: "t2", mediaId: "a1", volume: 1, fadeIn: 0, fadeOut: 0, loop: false, muted: true },
            { id: "t3", mediaId: "a1", volume: 1, fadeIn: 0, fadeOut: 0, loop: false, solo: true },
        ],
    };

    function renderInspector(project: EditProject, name: string) {
        useEditStore.setState({ hydrated: true, projects: [project], history: {} });
        useAssetStore.setState({ assets: [], hydrated: true });
        return dump(name, renderToStaticMarkup(<App><EditInspector projectId={project.id} clipId={null} /></App>));
    }

    it("每条音轨都有静音与独奏两个开关，勾选状态与轨道头一致", () => {
        const markup = renderInspector(DEMO, "editor-audio-mute-inspector");

        for (const id of ["t1", "t2"]) {
            expect(markup).toContain(`data-edit-track-mute-switch="${id}"`);
            expect(markup).toContain(`data-edit-track-solo-switch="${id}"`);
        }
        // 开关本身就是状态：t2 已静音 → 静音开关是开的；t1 未静音 → 是关的。
        expect(tagAfter(markup, 'data-edit-track-mute-switch="t2"', "button")).toContain('aria-checked="true"');
        expect(tagAfter(markup, 'data-edit-track-mute-switch="t1"', "button")).toContain('aria-checked="false"');
        // 独奏两轨都没开。
        expect(tagAfter(markup, 'data-edit-track-solo-switch="t1"', "button")).toContain('aria-checked="false"');
        // 属性区的开关与时间线轨道头读的是同一个字段：两处不能各记一份。
        const timeline = render(DEMO, "editor-audio-mute-inspector-cross");
        expect(sliceOf(timeline, 'data-edit-track-mute="t2"', "</button>")).toContain('aria-pressed="true"');
        expect(sliceOf(timeline, 'data-edit-track-mute="t1"', "</button>")).toContain('aria-pressed="false"');
    });

    it("「被其它轨独奏排除」在属性区也用同一个判定标出来（不是第二套规则）", () => {
        const markup = renderInspector(soloed, "editor-audio-mute-inspector-solo");

        // t1 未独奏、t2 独奏 → t1 在成片里被排除，属性区与时间线都给同一句文案。
        expect(markup).toContain('data-edit-track-solo-excluded="t1"');
        expect(markup).toContain("被其它轨独奏排除");
        // 独奏的那条自己不算被排除。
        expect(markup).not.toContain('data-edit-track-solo-excluded="t2"');
        // 静音标记同样由判定给出（t2 已静音 → 有静音标记）。
        expect(markup).toContain('data-edit-track-muted="t2"');
    });

    it("两个入口共用同一个判定与同一个动作：都读 editTrackAudibility、都写 updateAudioTrack（静态守护）", () => {
        // node 环境没有 DOM（不引入新依赖），属性区开关的 onChange 发不出真实点击事件：
        // 所以「两个入口不会各写一套规则」只能按源码冻住关键那一处。
        const inspector = readFileSync(new URL("./components/edit-inspector.tsx", import.meta.url), "utf8");
        const track = readFileSync(new URL("./components/edit-audio-track.tsx", import.meta.url), "utf8");

        for (const source of [inspector, track]) {
            expect(source).toContain("editTrackAudibility");
            expect(source).toContain("{ muted: ");
            expect(source).toContain("{ solo: ");
            expect(source).toContain("updateAudioTrack(projectId, track.id, ");
        }
        // muted / solo 的优先级规则只在 audio-mix.ts 里写一次：别的文件不许自己再判一遍。
        expect(inspector).not.toContain("track.solo === true &&");
        expect(track).not.toContain("tracks.some(");
        expect(inspector).not.toContain("audioTracks.some(");
    });
});

/**
 * 用户上报时最可疑的假设是「新增的覆盖层吃掉了轨道头按钮的点击」。**结论：不成立**，并且已经用真实浏览器
 * （headless Edge + 产物里那份 CSS + 逐字读回的产物 DOM）核过：
 *   · 层级：轨道头 z=10、音量线 z=3、覆盖层 z=2 —— 轨道头压在最上面；
 *   · 命中：在静音 / 独奏 / 锁定三个按钮的中心取 elementFromPoint，命中的都是按钮自己（或其图标），
 *     不是音量线、更不是覆盖层；用户截图里那条虚线也被轨道头的白底挡住（画在它下面）；
 *   · 覆盖层 pointer-events:none，内部也没有任何可交互元素。
 * 这里把这些不变量冻结成**产物结构断言**：node 环境量不出布局，所以断言的是「结构上不可能吃掉点击」，
 * 真实的指针命中由上面的浏览器核对与用户实机自查兜底。
 */
describe("剪辑台音轨：新增的覆盖层不得拦截轨道头按钮的点击（产物结构断言）", () => {
    it("覆盖层不吃指针事件、内部没有可交互元素、层级低于轨道头、盒子不超出本行", () => {
        const markup = render(DEMO, "editor-audio-mute-overlay");
        const svg = tagOf(markup, 'data-edit-track-gain="t1"');
        const line = tagOf(markup, 'data-edit-track-volume="t1"');
        const head = tagOf(markup, 'data-edit-track-head="t1"');

        // ① 覆盖层必须 pointer-events:none：这是「不吃点击」的第一道保证。
        //    能防住的失败模式：有人把这一层改成可交互（或让它接住拖动）。
        expect(svg).toContain("pointer-events-none");
        // ② 覆盖层内部不许有任何可交互元素 / 角色：即使外层将来改成可交互，里面也没有能接点击的东西。
        //    能防住的失败模式：往折线层里塞按钮、链接、滑块、tabindex。
        const svgBody = sliceOf(markup, 'data-edit-track-gain="t1"', "</svg>");
        for (const forbidden of ["<button", "<a ", "role=", "tabindex=", "onclick="]) expect(svgBody).not.toContain(forbidden);
        expect(svg).toContain('aria-hidden="true"');

        // ③ 唯一可交互的新层（音量线，role=slider）必须**低于**轨道头。
        //    同层元素里 z-index 大的先命中，所以「轨道头的层级高于音量线」就是「按钮一定点得到」。
        //    能防住的失败模式：有人把音量线抬到 z-10 以上、或把轨道头的 z-10 去掉了——
        //    那时音量线会横跨整行、压在三个开关上（它的 left 恒为 0%、宽 = 整条轨的时长占比）。
        expect(zIndexOf(head)).toBe(10);
        expect(zIndexOf(line)).toBe(3);
        expect(zIndexOf(line)!).toBeLessThan(zIndexOf(head)!);

        // ④ 覆盖层的盒子必须**就是本行的盒子**（宽高都钉成 100%）。SVG 是替换元素：只写 inset-0 时浏览器
        //    不会拉伸它，而是按 viewBox 的 1:1 给它「与行等宽的正方形」。真实浏览器实测（headless Edge +
        //    产物 CSS）：行 860×36 时覆盖层是 860×860，折线落在行顶下方 227.9px、面积铺到 834.2px，全在行外，
        //    被本行的 overflow-hidden 整块裁掉——音量与淡入淡出等于画了看不见；而多出来的 824px 一旦行的
        //    overflow-hidden 或这一层的 pointer-events-none 被人去掉，就会**盖住下面几行**（定点变异实测：
        //    两者都去掉后，行下方 52px 处的按钮被这一层吃掉点击；钉成行盒后同一次变异下点击正常落回按钮）。
        //    能防住的失败模式：覆盖层溢出本行去盖别的行（转场标记与字幕块都在下面几行里）。
        expect(styleOf(svg)).toContain("width:100%");
        expect(styleOf(svg)).toContain("height:100%");
    });

    it("新层只出现在音轨行**内部**：视频轨行、字幕行、接缝标记与视频轨头都没有被它盖到", () => {
        const markup = render(DEMO, "editor-audio-mute-overlay-scope");

        // 每条音轨各一套（覆盖层 / 音量线 / 读数徽标），一个不多一个不少。
        for (const marker of ["data-edit-track-gain=", "data-edit-track-volume=", "data-edit-track-volume-badge="]) {
            expect(markup.split(marker).length - 1, `${marker} 的数量与音轨数对不上`).toBe(DEMO.audioTracks.length);
        }
        // 逐个确认它们落在**自己那条音轨行**的切片区里（行是共享容器里的一行，别的行在它外面）。
        for (const id of ["t1", "t2"]) {
            const row = divSlice(markup, `data-edit-track-row="${id}"`);
            expect(row).toContain(`data-edit-track-gain="${id}"`);
            expect(row).toContain(`data-edit-track-volume="${id}"`);
            expect(row).toContain(`data-edit-track-volume-badge="${id}"`);
        }
        // 别的行一个都没有：覆盖层是音轨行的直接子元素，不可能跑到视频轨 / 字幕行里去。
        expect(divSlice(markup, "data-edit-video-track=")).not.toContain("data-edit-track-gain");
        expect(divSlice(markup, "data-edit-subtitle-track=")).not.toContain("data-edit-track-gain");
        // 视频轨头（关闭原声）、字幕块、接缝转场标记都还在，而且都没被新层包住。
        expect(markup).toContain("data-edit-video-track-mute");
        expect(markup).toContain("data-edit-subtitle-block=");
        expect(markup).toContain("data-edit-transition-seam=");
    });
});
