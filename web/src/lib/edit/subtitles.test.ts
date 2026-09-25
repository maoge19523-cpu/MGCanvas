import { describe, expect, it } from "vitest";

import { buildEditClips } from "./timeline";
import { decodeSubtitleBytes, parseSubtitleFile, summarizeSubtitleImport } from "./subtitles";
import type { EditClip, EditMedia } from "@/types/edit";

/** 一份最小可用的 SRT：序号 + 时间行 + 一行文本。 */
const srt = (blocks: string) => blocks;

describe("字幕导入：SRT / WebVTT 解析（任何输入都不能抛异常）", () => {
    it("标准 SRT：序号、时间码与文本都读出来", () => {
        const result = parseSubtitleFile(srt("1\n00:00:01,000 --> 00:00:04,000\n第一句\n\n2\n00:00:05,500 --> 00:00:08,000\n第二句\n"));

        expect(result.format).toBe("srt");
        expect(result.issues).toEqual([]);
        expect(result.cues).toEqual([
            { start: 1, end: 4, text: "第一句" },
            { start: 5.5, end: 8, text: "第二句" },
        ]);
    });

    it("带 BOM 的文件照样读：开头那个 \uFEFF 不能把第一行变成不认识的格式", () => {
        const result = parseSubtitleFile(`\uFEFF1\n00:00:01,000 --> 00:00:04,000\n带 BOM\n`);

        expect(result.format).toBe("srt");
        expect(result.cues).toEqual([{ start: 1, end: 4, text: "带 BOM" }]);
    });

    it("CRLF、CR 与 LF 混用时，时间码与文本都不会带出 \r", () => {
        const result = parseSubtitleFile("1\r\n00:00:01,000 --> 00:00:04,000\r\n第一句\r\n\r\n2\n00:00:05,000 --> 00:00:06,000\n第二句\n");

        expect(result.cues).toEqual([
            { start: 1, end: 4, text: "第一句" },
            { start: 5, end: 6, text: "第二句" },
        ]);
    });

    it("序号行缺失也能读：只认时间行，不认「第一行必须是数字」", () => {
        const result = parseSubtitleFile("00:00:01,000 --> 00:00:04,000\n没有序号\n");

        expect(result.issues).toEqual([]);
        expect(result.cues).toEqual([{ start: 1, end: 4, text: "没有序号" }]);
    });

    it("多余空行（块之间两三个空行、行尾带空格）不影响分块", () => {
        const result = parseSubtitleFile("1\n00:00:01,000 --> 00:00:04,000\n第一句\n\n\n   \n2\n00:00:05,000 --> 00:00:06,000\n第二句   \n\n");

        expect(result.cues).toEqual([
            { start: 1, end: 4, text: "第一句" },
            { start: 5, end: 6, text: "第二句" },
        ]);
    });

    it("多行文本原样保留（行内换行不丢），导出时仍是一句多行字幕", () => {
        const result = parseSubtitleFile("1\n00:00:01,000 --> 00:00:04,000\n第一行\n第二行\n");

        expect(result.cues).toEqual([{ start: 1, end: 4, text: "第一行\n第二行" }]);
    });

    it("正文里一行纯数字不会被当成序号吃掉", () => {
        const result = parseSubtitleFile("1\n00:00:01,000 --> 00:00:04,000\n2024\n");

        expect(result.cues).toEqual([{ start: 1, end: 4, text: "2024" }]);
    });

    it("条目之间漏了空行（整份文件就是一个大块）时按时间行切开，不会两条并成一条", () => {
        const result = parseSubtitleFile("1\n00:00:01,000 --> 00:00:02,000\n第一句\n2\n00:00:03,000 --> 00:00:04,000\n第二句\n");

        expect(result.issues).toEqual([]);
        expect(result.cues).toEqual([
            { start: 1, end: 2, text: "第一句" },
            { start: 3, end: 4, text: "第二句" },
        ]);
    });

    it("结束早于开始（倒序）的条目被跳过并计数，不整份拒收", () => {
        const result = parseSubtitleFile("1\n00:00:09,000 --> 00:00:04,000\n倒序\n\n2\n00:00:01,000 --> 00:00:02,000\n正常\n");

        expect(result.cues).toEqual([{ start: 1, end: 2, text: "正常" }]);
        expect(result.issues).toEqual([{ line: 2, reason: "reversedTiming" }]);
    });

    it("零长度（结束等于开始）同样按倒序跳过：不会生成一条永远显示不出来的字幕", () => {
        const result = parseSubtitleFile("1\n00:00:04,000 --> 00:00:04,000\n零长\n");

        expect(result.cues).toEqual([]);
        expect(result.issues).toEqual([{ line: 2, reason: "reversedTiming" }]);
    });

    it("时间码越界：小时超过 99、分秒超过 59 都按十进制折算，不拒绝整条", () => {
        const result = parseSubtitleFile("1\n100:00:00,000 --> 100:00:01,000\n超长片\n\n2\n00:00:75,000 --> 00:01:30,000\n秒越界\n");

        expect(result.issues).toEqual([]);
        expect(result.cues).toEqual([
            { start: 75, end: 90, text: "秒越界" },
            { start: 360000, end: 360001, text: "超长片" },
        ]);
    });

    it("毫秒不足三位按十进制小数读（,4 = 400ms、,45 = 450ms），超过三位截到毫秒", () => {
        const result = parseSubtitleFile("1\n00:00:01,4 --> 00:00:02,45\n一位\n\n2\n00:00:03,4500 --> 00:00:04,000\n四位\n");

        expect(result.cues[0]).toEqual({ start: 1.4, end: 2.45, text: "一位" });
        expect(result.cues[1]).toEqual({ start: 3.45, end: 4, text: "四位" });
    });

    it("空文本条目被跳过：只有序号与时间行、或去掉标记后什么都不剩", () => {
        const result = parseSubtitleFile("1\n00:00:01,000 --> 00:00:04,000\n\n2\n00:00:05,000 --> 00:00:06,000\n<i></i>\n");

        expect(result.cues).toEqual([]);
        expect(result.issues).toEqual([
            { line: 2, reason: "emptyText" },
            { line: 5, reason: "emptyText" },
        ]);
    });

    it("没有时间行的块记成 missingTiming，并给出行号", () => {
        const result = parseSubtitleFile("1\n00:00:01,000 --> 00:00:04,000\n正常\n\n这里是一段没有时间码的说明文字\n");

        expect(result.cues).toHaveLength(1);
        expect(result.issues).toEqual([{ line: 5, reason: "missingTiming" }]);
    });

    it("时间行读不出来时记成 invalidTiming，而不是抛异常", () => {
        const result = parseSubtitleFile("1\n00:00:01 --> 后面\n坏时间\n\n2\nabc --> def\n更坏\n");

        expect(result.cues).toEqual([]);
        expect(result.issues).toEqual([
            { line: 2, reason: "invalidTiming" },
            { line: 6, reason: "invalidTiming" },
        ]);
    });

    it("时间重叠的两条都保留（成片里会同时显示），不合并也不丢", () => {
        const result = parseSubtitleFile("1\n00:00:00,000 --> 00:00:05,000\n长句\n\n2\n00:00:02,000 --> 00:00:03,000\n短句\n");

        expect(result.cues).toHaveLength(2);
        expect(result.issues).toEqual([]);
    });

    it("乱序的两条按起点排好序（同起点保持原顺序）", () => {
        const result = parseSubtitleFile("1\n00:00:05,000 --> 00:00:06,000\n后面的\n\n2\n00:00:01,000 --> 00:00:02,000\n前面的\n");

        expect(result.cues.map((cue) => cue.text)).toEqual(["前面的", "后面的"]);
    });

    it("WebVTT：认出 WEBVTT 头，吃点号时间码与只有 分:秒 的省略写法", () => {
        const result = parseSubtitleFile("WEBVTT\n\n00:01.000 --> 00:03.500\n第一句\n\n00:04.000 --> 00:06.000\n第二句\n");

        expect(result.format).toBe("vtt");
        expect(result.cues).toEqual([
            { start: 1, end: 3.5, text: "第一句" },
            { start: 4, end: 6, text: "第二句" },
        ]);
    });

    it("WebVTT：NOTE / STYLE / REGION 块与文件头都不是字幕条目，也不算「跳过的条目」", () => {
        const text = [
            "WEBVTT - 测试文件",
            "Kind: captions",
            "Language: zh",
            "",
            "NOTE 这一段是给译者看的备注",
            "第二行备注",
            "",
            "STYLE",
            "::cue { color: yellow }",
            "",
            "REGION",
            "id:top width:40%",
            "",
            "00:01.000 --> 00:03.000",
            "唯一一句",
        ].join("\n");
        const result = parseSubtitleFile(text);

        expect(result.format).toBe("vtt");
        expect(result.issues).toEqual([]);
        expect(result.cues).toEqual([{ start: 1, end: 3, text: "唯一一句" }]);
    });

    it("WebVTT：cue id、cue settings 与行内标记都处理掉，文本里不留尖括号", () => {
        const text = "WEBVTT\n\nintro\n00:01.000 --> 00:03.500 align:middle line:90%\n<v Alex>Hello &amp; <b>welcome</b></v>\n\n00:04.000 --> 00:05.000\n<c.yellow>黄色</c>\n";
        const result = parseSubtitleFile(text);

        expect(result.cues).toEqual([
            { start: 1, end: 3.5, text: "Hello & welcome" },
            { start: 4, end: 5, text: "黄色" },
        ]);
    });

    it("WebVTT：文件头后面漏了空行（头与第一条字幕挤在一个块里）也照样读得到", () => {
        const result = parseSubtitleFile("WEBVTT\nKind: captions\n00:01.000 --> 00:03.000\n挤在一起的一句\n");

        expect(result.cues).toEqual([{ start: 1, end: 3, text: "挤在一起的一句" }]);
    });

    it("SRT 里的 HTML 标签与实体同样清掉", () => {
        const result = parseSubtitleFile("1\n00:00:01,000 --> 00:00:04,000\n<font color=\"#fff\">A &lt; B</font> &#39;引号&#39;\n");

        expect(result.cues[0]!.text).toBe("A < B '引号'");
    });

    it("空文件、只有空白、纯乱码、二进制垃圾都不抛异常，只是没有条目", () => {
        for (const input of ["", "   \n\n\n", "\u0000\u0001\u0002", "完全没有时间码的一大段文字", "\n\n\n"]) {
            const result = parseSubtitleFile(input);
            expect(result.cues).toEqual([]);
            expect(Array.isArray(result.issues)).toBe(true);
        }
    });

    it("极长的一行 / 极多条目也不会崩：2000 条照数不误", () => {
        const blocks = Array.from({ length: 2000 }, (_, index) => `${index + 1}\n00:00:${String(index % 60).padStart(2, "0")},000 --> 00:00:${String(index % 60).padStart(2, "0")},500\n第 ${index} 条`).join("\n\n");
        const result = parseSubtitleFile(blocks);

        expect(result.cues).toHaveLength(2000);
        expect(result.issues).toEqual([]);
    });
});

describe("字幕导入：字节 → 文本（中文编码兜底）", () => {
    const bytes = (...values: number[]) => Uint8Array.from(values);
    const ascii = (text: string) => Array.from(text).map((char) => char.charCodeAt(0));

    it("UTF-8 直接读出来", () => {
        const utf8 = new TextEncoder().encode("1\n00:00:01,000 --> 00:00:04,000\n字幕\n");

        expect(decodeSubtitleBytes(utf8)).toContain("字幕");
    });

    it("GBK / GB18030 的中文 SRT（国内很常见）按 GB18030 兜底读出，不变成乱码", () => {
        // 「字幕」的 GBK 是 D7 D6 C4 BB，这一串不是合法 UTF-8，必须走兜底编码。
        const gbk = bytes(...ascii("1\n00:00:01,000 --> 00:00:04,000\n"), 0xd7, 0xd6, 0xc4, 0xbb, 0x0a);

        expect(decodeSubtitleBytes(gbk)).toContain("字幕");
        expect(parseSubtitleFile(decodeSubtitleBytes(gbk)).cues).toEqual([{ start: 1, end: 4, text: "字幕" }]);
    });

    it("带 BOM 的 UTF-16LE 按 BOM 认编码，不会读成夹 \u0000 的乱码", () => {
        const source = "1\n00:00:01,000 --> 00:00:04,000\n字幕\n";
        const le = Uint8Array.from([0xff, 0xfe, ...Array.from(source).flatMap((char) => {
            const code = char.codePointAt(0)!;
            return [code & 0xff, code >> 8];
        })]);
        const decoded = decodeSubtitleBytes(le);

        expect(decoded).not.toContain("\u0000");
        expect(parseSubtitleFile(decoded).cues).toEqual([{ start: 1, end: 4, text: "字幕" }]);
    });

    it("任何字节串都返回字符串，不抛异常", () => {
        expect(typeof decodeSubtitleBytes(bytes(0x00, 0xff, 0xfe, 0x80, 0x13))).toBe("string");
        expect(decodeSubtitleBytes(bytes())).toBe("");
    });
});

describe("字幕导入：映射到成片时间轴之后会发生什么", () => {
    const media: EditMedia[] = [{ id: "m1", name: "a.mp4", kind: "video", source: "local", durationMs: 6000, createdAt: "2024-01-01T00:00:00.000Z" }];
    const clip = (id: string, end: number, transition?: string, transitionDuration = 0.5): EditClip => ({ id, mediaId: "m1", start: 0, end, volume: 1, fadeIn: 0, fadeOut: 0, transition, transitionDuration });
    // 两段：4s + 3s = 成片 7s，接缝正好在 4.0s。
    const views = buildEditClips(media, [clip("c1", 4), clip("c2", 3)]);
    // 带 1s 转场：成片 6s，接缝被转场吃掉 1s，落在 3.0s（与 Rust 的 offset 口径一致）。
    const crossed = buildEditClips(media, [clip("c1", 4, "fade", 1), clip("c2", 3)]);
    const cue = (start: number, end: number, text = "x") => ({ start, end, text });

    it("成片内、不跨接缝的条目：全部算作成片内可见", () => {
        const summary = summarizeSubtitleImport([cue(1, 2), cue(5, 6)], views);

        expect(summary).toEqual({ inside: 2, beyondEnd: 0, truncated: 0, crossingSeams: 0, overlapping: 0 });
    });

    it("正好落在片段边界上的条目不算跨接缝（边界属于前一段的末尾）", () => {
        expect(summarizeSubtitleImport([cue(2, 4)], views).crossingSeams).toBe(0);
        expect(summarizeSubtitleImport([cue(4, 5)], views).crossingSeams).toBe(0);
        expect(summarizeSubtitleImport([cue(5, 6)], crossed).crossingSeams).toBe(0);
    });

    it("跨片段的条目照常保留，只是被算出来告诉用户（独立字幕轨按绝对时间显示）", () => {
        const summary = summarizeSubtitleImport([cue(3, 5)], views);

        expect(summary.crossingSeams).toBe(1);
        expect(summary.inside).toBe(1);
    });

    it("接缝位置跟着转场前移：转场 1s 时 4.0s 不再是接缝，3.0s 才是（成片也缩短到 6s）", () => {
        expect(summarizeSubtitleImport([cue(2, 4)], crossed).crossingSeams).toBe(1);
        expect(summarizeSubtitleImport([cue(2.9, 3.1)], crossed).crossingSeams).toBe(1);
        // 起点在接缝之后的条目不算跨接缝；起点正好压在接缝上也不算（边界归前一段末尾）。
        expect(summarizeSubtitleImport([cue(3.5, 4.5)], crossed).crossingSeams).toBe(0);
        expect(summarizeSubtitleImport([cue(3, 4)], crossed).crossingSeams).toBe(0);
        // 转场吃掉 1s 之后，5.5s 起步的条目成片里只剩半条，6.5s 起步的完全在成片之外。
        expect(summarizeSubtitleImport([cue(5.5, 6.5)], crossed)).toMatchObject({ inside: 1, truncated: 1, beyondEnd: 0 });
        expect(summarizeSubtitleImport([cue(6.5, 7)], crossed)).toMatchObject({ inside: 0, truncated: 0, beyondEnd: 1 });
    });

    it("落在成片末尾之后的条目算作「导出里不会出现」，不静默丢掉也不假装成功", () => {
        const summary = summarizeSubtitleImport([cue(1, 2), cue(9, 10)], views);

        expect(summary.inside).toBe(1);
        expect(summary.beyondEnd).toBe(1);
    });

    it("起点在成片内、结尾超出成片末尾的条目算作只显示前半段", () => {
        const summary = summarizeSubtitleImport([cue(6, 9)], views);

        expect(summary).toEqual({ inside: 1, beyondEnd: 0, truncated: 1, crossingSeams: 0, overlapping: 0 });
    });

    it("时间线还是空的：一条都落不进成片，全部如实报成 beyondEnd", () => {
        const summary = summarizeSubtitleImport([cue(0, 1), cue(2, 3)], []);

        expect(summary).toEqual({ inside: 0, beyondEnd: 2, truncated: 0, crossingSeams: 0, overlapping: 0 });
    });

    it("重叠条目被数出来（成片里会同时出现两行）", () => {
        expect(summarizeSubtitleImport([cue(1, 5), cue(2, 3), cue(5, 6)], views).overlapping).toBe(1);
    });
});
