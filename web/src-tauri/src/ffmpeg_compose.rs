use std::{
    io::{BufReader, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::media_cache::{sanitize_filename_stem, MediaCacheState};

const EXE_NAMES: [&str; 2] = ["ffmpeg.exe", "ffmpeg"];
#[cfg(windows)]
const AUTO_DIRS: [&str; 4] = [
    "C:\\ffmpeg",
    "C:\\MediaToolkit",
    "E:\\ComfyUI_windows_portable-G313\\ffmpeg-8.0.1-full_build\\bin",
    "H:\\qwen3.8\\tools\\ffmpeg",
];
#[cfg(not(windows))]
const AUTO_DIRS: [&str; 3] = ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeSegment {
    path: String,
    start: Option<f64>,
    end: Option<f64>,
    volume: Option<f64>,
    // 从这一段过渡到下一段：类型（fade / wipeleft / slideup）与持续时间（秒）。
    // 为空表示硬切。
    transition: Option<String>,
    transition_duration: Option<f64>,
    // 这一段要烧进画面的字幕文字，为空表示该段不显示字幕。
    subtitle: Option<String>,
    // 这一段自己的淡入淡出（秒），与接缝上的转场互不影响。
    fade_in: Option<f64>,
    fade_out: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeAudioTrack {
    path: String,
    volume: Option<f64>,
    fade_in: Option<f64>,
    fade_out: Option<f64>,
    // 音轨比成片短时循环补齐（背景音乐常用）；loop 是 Rust 关键字，所以字段另取名再改回 JSON 名。
    #[serde(rename = "loop")]
    looped: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeVideoRequest {
    ffmpeg_path: Option<String>,
    segments: Vec<ComposeSegment>,
    // 附加音轨（配音、背景音乐等），各自音量与淡入淡出，按顺序混进成片。
    #[serde(default)]
    tracks: Vec<ComposeAudioTrack>,
    long_edge: Option<f64>,
    fps: Option<f64>,
    fade_in: Option<f64>,
    fade_out: Option<f64>,
    title: Option<String>,
    // 字幕排版：bottom（底部白字黑描边，默认）或 center（居中大字）。
    subtitle_style: Option<String>,
    // 字幕字号档位：small / medium（默认）/ large。
    subtitle_size: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeVideoResult {
    absolute_path: String,
    filename: String,
    mime_type: String,
    bytes: u64,
    width: u32,
    height: u32,
    duration_ms: u64,
}

struct MediaProbe {
    duration: f64,
    width: u32,
    height: u32,
    has_audio: bool,
}

#[cfg(windows)]
fn configure(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn configure(_command: &mut Command) {}

fn candidate_from_dir(dir: &Path) -> Option<PathBuf> {
    for name in EXE_NAMES {
        let direct = dir.join(name);
        if direct.is_file() {
            return Some(direct);
        }
        let in_bin = dir.join("bin").join(name);
        if in_bin.is_file() {
            return Some(in_bin);
        }
    }
    // 常见解压布局：<dir>\ffmpeg-<version>-full_build\bin\ffmpeg.exe
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let child = entry.path();
        if !child.is_dir() {
            continue;
        }
        for name in EXE_NAMES {
            let nested = child.join("bin").join(name);
            if nested.is_file() {
                return Some(nested);
            }
            let nested = child.join(name);
            if nested.is_file() {
                return Some(nested);
            }
        }
    }
    None
}

/// 读取 FFmpeg 的版本号用于横向比较；解析失败（例如每日构建 N-78313）返回 0，会被排到最后。
fn ffmpeg_version_rank(executable: &Path) -> u32 {
    let Ok(output) = Command::new(executable).arg("-version").output() else {
        return 0;
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let token = text
        .lines()
        .next()
        .and_then(|line| line.split("version").nth(1))
        .map(|rest| rest.trim().split(['-', ' ']).next().unwrap_or("").to_owned())
        .unwrap_or_default();
    let mut parts = token.split('.');
    let major = parts.next().and_then(|value| value.parse::<u32>().ok()).unwrap_or(0);
    let minor = parts.next().and_then(|value| value.parse::<u32>().ok()).unwrap_or(0);
    major * 1000 + minor
}

fn detect_ffmpeg_path(manual: Option<&str>) -> Option<PathBuf> {
    if let Some(value) = manual.map(str::trim).filter(|value| !value.is_empty()) {
        let path = PathBuf::from(value);
        if path.is_file() {
            return Some(path);
        }
        if path.is_dir()
            && let Some(found) = candidate_from_dir(&path)
        {
            return Some(found);
        }
    }
    // 收集全部候选后按版本高低选择：本机可能残留多年前的旧构建，旧版缺少部分滤镜选项会直接导致合成失败。
    let mut candidates: Vec<PathBuf> = Vec::new();
    if Command::new("ffmpeg").arg("-version").output().is_ok() {
        candidates.push(PathBuf::from("ffmpeg"));
    }
    for dir in AUTO_DIRS {
        if let Some(found) = candidate_from_dir(Path::new(dir)) {
            candidates.push(found);
        }
    }
    candidates.sort_by_key(|path| std::cmp::Reverse(ffmpeg_version_rank(path)));
    candidates.into_iter().next()
}

fn run_captured(executable: &Path, arguments: &[&str]) -> Result<std::process::Output, String> {
    let mut command = Command::new(executable);
    command.args(arguments);
    configure(&mut command);
    command
        .output()
        .map_err(|error| format!("无法启动 FFmpeg：{error}"))
}

fn parse_duration(text: &str) -> Option<f64> {
    let start = text.find("Duration: ")? + "Duration: ".len();
    let value = text[start..].split(',').next()?;
    if value.trim() == "N/A" {
        return None;
    }
    let mut total = 0_f64;
    for part in value.split(':') {
        total = total * 60.0 + part.trim().parse::<f64>().ok()?;
    }
    Some(total)
}

fn find_resolution(line: &str) -> Option<(u32, u32)> {
    let bytes = line.as_bytes();
    let mut index = 0_usize;
    while index < bytes.len() {
        if !bytes[index].is_ascii_digit() {
            index += 1;
            continue;
        }
        let width_start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        let width_digits = &line[width_start..index];
        if width_digits.len() < 2
            || width_digits.len() > 5
            || index >= bytes.len()
            || bytes[index] != b'x'
        {
            continue;
        }
        let height_start = index + 1;
        let mut end = height_start;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        let height_digits = &line[height_start..end];
        if (2..=5).contains(&height_digits.len()) {
            if let (Ok(first), Ok(second)) = (width_digits.parse::<u32>(), height_digits.parse::<u32>()) {
                if first >= 16 && second >= 16 {
                    return Some((first, second));
                }
            }
        }
    }
    None
}

fn probe_media(executable: &Path, path: &str) -> Result<MediaProbe, String> {
    let missing = format!("素材文件不存在或已被移动：{path}");
    if !Path::new(path).is_file() {
        return Err(missing);
    }
    let output = run_captured(executable, &["-hide_banner", "-i", path])?;
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if !output.status.success() {
        if stderr.contains("No such file") || stderr.contains("not found") || stderr.contains("Permission denied") {
            return Err(missing);
        }
    }
    let duration = parse_duration(&stderr).ok_or_else(|| format!("无法读取素材时长：{path}"))?;
    let (width, height) = stderr
        .lines()
        .find(|line| line.contains(": Video:"))
        .and_then(find_resolution)
        .ok_or_else(|| format!("无法读取画面尺寸：{path}"))?;
    Ok(MediaProbe {
        duration,
        width,
        height,
        has_audio: stderr.lines().any(|line| line.contains(": Audio:")),
    })
}

fn seconds(value: f64) -> String {
    let text = format!("{:.3}", value);
    let trimmed = text.trim_end_matches('0').trim_end_matches('.');
    trimmed.to_string()
}

fn clamp(value: f64, minimum: f64, maximum: f64) -> f64 {
    value.clamp(minimum, maximum)
}

/// 成片整体淡入淡出的滤镜串；没有任何整体淡入淡出时返回 None。
/// 逐条滤镜之间只能用逗号连接，**末尾绝不能留逗号**：留了就等于给 FFmpeg 一个空滤镜名，
/// 它会直接报 `No such filter: ""` 并拒绝出片，退出码还会变成一个巨大的负数（见 describe_exit_code）。
fn global_fade_chain(video_label: &str, fade_in: f64, fade_out: f64, total: f64) -> Option<String> {
    let mut steps: Vec<String> = Vec::new();
    if fade_in > 0.0 {
        steps.push(format!("fade=t=in:st=0:d={}", seconds(fade_in)));
    }
    if fade_out > 0.0 {
        steps.push(format!("fade=t=out:st={}:d={}", seconds((total - fade_out).max(0.0)), seconds(fade_out)));
    }
    if steps.is_empty() {
        return None;
    }
    Some(format!("[{video_label}]{}[vout]", steps.join(",")))
}

/// 把 FFmpeg 的退出码翻成人能读懂的说明。新版 FFmpeg 会把内部错误码（AVERROR）直接当退出码，
/// 例如滤镜图里出现空滤镜名时是 -1279870712，原样丢给用户只是一串看不懂的数字。
fn describe_exit_code(code: i32) -> String {
    match code as u32 {
        // 滤镜图里有 FFmpeg 不认识的滤镜名（空滤镜名也走这里）：ffmpeg 8.0.1 实测报到这个码。
        0xB3B6_B908 => "滤镜图里有 FFmpeg 不认识的滤镜，常见原因是转场或滤镜名为空".to_owned(),
        // 滤镜选项不受支持（实测未知转场类型报这个码）。
        0xBAA8_BEB0 => "FFmpeg 不支持该滤镜选项，请检查转场类型".to_owned(),
        // Windows 上的进程崩溃码：访问冲突、栈溢出、非法指令。
        0xC000_0005 | 0xC000_0409 | 0xC000_001D => "FFmpeg 进程崩溃".to_owned(),
        other if code < 0 => format!("FFmpeg 内部错误 0x{other:08X}"),
        other => other.to_string(),
    }
}

fn compose_blocking(cache_dir: &Path, request: ComposeVideoRequest) -> Result<ComposeVideoResult, String> {
    let executable = detect_ffmpeg_path(request.ffmpeg_path.as_deref())
        .ok_or_else(|| "未检测到 FFmpeg：请安装 FFmpeg 或加入 PATH，或在设置 → 本地 FFmpeg 中手动指定路径".to_owned())?;
    if request.segments.is_empty() {
        return Err("至少需要 1 个视频片段".to_owned());
    }
    if request.segments.len() > 32 {
        return Err("一次最多合成 32 个片段".to_owned());
    }

    let mut probes = Vec::with_capacity(request.segments.len());
    let mut ranges = Vec::with_capacity(request.segments.len());
    for (index, segment) in request.segments.iter().enumerate() {
        let probe = probe_media(&executable, &segment.path)
            .map_err(|error| format!("第 {} 段：{error}", index + 1))?;
        let start = clamp(segment.start.unwrap_or(0.0), 0.0, probe.duration);
        let raw_end = match segment.end {
            Some(value) if value > 0.0 => clamp(value, 0.0, probe.duration),
            _ => probe.duration,
        };
        if raw_end - start < 0.05 {
            return Err(format!("第 {} 段没有有效的截取范围", index + 1));
        }
        probes.push(probe);
        ranges.push((start, raw_end));
    }

    let long_edge = clamp(request.long_edge.unwrap_or(1080.0), 240.0, 2160.0) as f64;
    let fps = clamp(request.fps.unwrap_or(30.0), 12.0, 60.0);
    let scale = long_edge / (probes[0].width.max(probes[0].height) as f64);
    let to_even = |value: f64| (value.round() as u32 & !1).max(2);
    let out_width = to_even(probes[0].width as f64 * scale);
    let out_height = to_even(probes[0].height as f64 * scale);
    let durations: Vec<f64> = ranges.iter().map(|(start, end)| end - start).collect();
    // 片段之间的转场设在「上一段」上，表示它过渡到下一段；没设就是硬切。
    // 只有真的用上转场时才换滤镜链，其余情况维持已经验证过的 concat 拼片。
    let transitions: Vec<(String, f64)> = request
        .segments
        .iter()
        .enumerate()
        .map(|(index, segment)| {
            if index + 1 >= durations.len() {
                return (String::new(), 0.0);
            }
            let kind = match segment.transition.as_deref() {
                Some("fade") => "fade",
                Some("dissolve") => "dissolve",
                Some("wipeleft") => "wipeleft",
                Some("wiperight") => "wiperight",
                Some("slideleft") => "slideleft",
                Some("slideup") => "slideup",
                Some("circleopen") => "circleopen",
                _ => return (String::new(), 0.0),
            };
            // 转场不能吃掉整段素材：最多取相邻两段中较短者的八成，再限制在 0.1–1.5 秒。
            let limit = clamp(durations[index].min(durations[index + 1]) * 0.8, 0.1, 1.5);
            let wanted = clamp(segment.transition_duration.unwrap_or(0.5), 0.1, 1.5);
            (kind.to_owned(), wanted.min(limit))
        })
        .collect();
    // 每次转场都会让成片比各段之和短一段转场时长，淡出与背景音乐都按这个总时长算。
    let total: f64 = durations.iter().sum::<f64>() - transitions.iter().map(|(_, seconds)| *seconds).sum::<f64>();

    let track_index = request.segments.len() as u32;
    let needs_silence = probes.iter().any(|probe| !probe.has_audio);
    let silence_index = track_index + request.tracks.len() as u32;

    let mut arguments: Vec<String> = vec!["-hide_banner".to_owned(), "-y".to_owned()];
    for segment in &request.segments {
        arguments.push("-i".to_owned());
        arguments.push(segment.path.clone());
    }
    for track in &request.tracks {
        // -stream_loop 是输入选项，必须放在它要作用的那个 -i 之前。
        if track.looped.unwrap_or(false) {
            arguments.extend(["-stream_loop".to_owned(), "-1".to_owned()]);
        }
        arguments.push("-i".to_owned());
        arguments.push(track.path.clone());
    }
    if needs_silence {
        arguments.extend(["-f".to_owned(), "lavfi".to_owned(), "-i".to_owned(), "anullsrc=channel_layout=stereo:sample_rate=44100".to_owned()]);
    }

    let mut filters: Vec<String> = Vec::new();
    let mut concat_inputs = String::new();
    for (index, ((start, end), probe)) in ranges.iter().zip(&probes).enumerate() {
        let duration = end - start;
        // 片段自身的淡入淡出接在缩放之后：此时时间戳已归零，所以 st 直接从 0 与段尾算。
        let segment_fade_in = clamp(request.segments[index].fade_in.unwrap_or(0.0), 0.0, 5.0);
        let segment_fade_out = clamp(request.segments[index].fade_out.unwrap_or(0.0), 0.0, 10.0);
        let mut video_chain = format!(
            "[{index}:v]trim=start={}:end={},setpts=PTS-STARTPTS,fps={},scale={w}:{h}:force_original_aspect_ratio=decrease:flags=bicubic,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1",
            seconds(*start),
            seconds(*end),
            seconds(fps),
            w = out_width,
            h = out_height
        );
        if segment_fade_in > 0.0 {
            video_chain.push_str(&format!(",fade=t=in:st=0:d={}", seconds(segment_fade_in)));
        }
        if segment_fade_out > 0.0 {
            video_chain.push_str(&format!(",fade=t=out:st={}:d={}", seconds((duration - segment_fade_out).max(0.0)), seconds(segment_fade_out)));
        }
        video_chain.push_str(&format!("[v{index}]"));
        filters.push(video_chain);
        if probe.has_audio {
            let volume = clamp(request.segments[index].volume.unwrap_or(1.0), 0.0, 4.0);
            let mut audio_chain = format!(
                "[{index}:a]atrim=start={}:end={},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo,volume={}",
                seconds(*start),
                seconds(*end),
                seconds(volume)
            );
            if segment_fade_in > 0.0 {
                audio_chain.push_str(&format!(",afade=t=in:st=0:d={}", seconds(segment_fade_in)));
            }
            if segment_fade_out > 0.0 {
                audio_chain.push_str(&format!(",afade=t=out:st={}:d={}", seconds((duration - segment_fade_out).max(0.0)), seconds(segment_fade_out)));
            }
            audio_chain.push_str(&format!("[a{index}]"));
            filters.push(audio_chain);
        } else {
            filters.push(format!(
                "[{silence_index}:a]atrim=end={},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo[a{index}]",
                seconds(duration)
            ));
        }
        concat_inputs.push_str(&format!("[v{index}][a{index}]"));
    }
    if transitions.iter().all(|(_, seconds)| *seconds <= 0.0) {
        filters.push(format!("{}concat=n={}:v=1:a=1[cv][ca]", concat_inputs, request.segments.len()));
    } else {
        // 逐对串联：设了转场的接缝用 xfade / acrossfade，没设的仍是 concat。
        let mut video = "v0".to_owned();
        let mut audio = "a0".to_owned();
        let mut elapsed = durations[0];
        for index in 1..durations.len() {
            let (kind, transition) = &transitions[index - 1];
            let next_video = format!("xv{index}");
            let next_audio = format!("xa{index}");
            if *transition > 0.0 && !kind.is_empty() {
                filters.push(format!(
                    "[{video}][v{index}]xfade=transition={kind}:duration={}:offset={}[{next_video}]",
                    seconds(*transition),
                    seconds((elapsed - transition).max(0.0))
                ));
                filters.push(format!("[{audio}][a{index}]acrossfade=d={}[{next_audio}]", seconds(*transition)));
                elapsed = elapsed + durations[index] - transition;
            } else {
                filters.push(format!("[{video}][v{index}]concat=n=2:v=1:a=0[{next_video}]"));
                filters.push(format!("[{audio}][a{index}]concat=n=2:v=0:a=1[{next_audio}]"));
                elapsed += durations[index];
            }
            video = next_video;
            audio = next_audio;
        }
        filters.push(format!("[{video}]null[cv]"));
        filters.push(format!("[{audio}]anull[ca]"));
    }

    // 字幕：按各段在成片时间轴上的位置生成一份 .srt，再用 libass 烧进画面。
    // 时间轴与拼接完全一致——每经过一次转场，后面所有片段的起点都要往前挪一个转场时长，
    // 行尾也要跟着提前，否则两次字幕会在转场处叠着显示。
    let srt_time = |value: f64| {
        let millis = (value.max(0.0) * 1000.0).round() as u64;
        format!("{:02}:{:02}:{:02},{:03}", millis / 3_600_000, millis / 60_000 % 60, millis / 1000 % 60, millis % 1000)
    };
    let subtitle_lines: Vec<(f64, f64, String)> = request
        .segments
        .iter()
        .enumerate()
        .filter_map(|(index, segment)| {
            let text = segment.subtitle.as_deref().map(str::trim).filter(|text| !text.is_empty())?;
            let dropped = transitions[..index].iter().map(|(_, seconds)| *seconds).sum::<f64>();
            let start = (durations[..index].iter().sum::<f64>() - dropped).max(0.0);
            let cut = transitions.get(index).map(|(_, seconds)| *seconds).unwrap_or(0.0);
            let end = (start + durations[index] - cut).max(start + 0.2);
            Some((start, end, text.to_owned()))
        })
        .collect();

    let mut video_label = "cv".to_string();
    if !subtitle_lines.is_empty() {
        let mut srt = String::new();
        for (index, (start, end, text)) in subtitle_lines.iter().enumerate() {
            srt.push_str(&format!("{}\n{} --> {}\n{}\n\n", index + 1, srt_time(*start), srt_time(*end), text));
        }
        let stem = sanitize_filename_stem(request.title.as_deref().unwrap_or("合成视频"));
        let srt_path = cache_dir.join(format!("{stem}-{}.srt", unix_timestamp_millis()));
        std::fs::write(&srt_path, srt).map_err(|error| format!("写入字幕文件失败：{error}"))?;
        // 滤镜里的路径必须写成 C\:/dir/file.srt：反斜杠换成正斜杠，盘符的冒号要转义。
        let escaped = srt_path.to_string_lossy().replace('\\', "/").replace(':', "\\:");
        // 中文字体必须点名，否则 libass 找不到字形会整句渲染成方块。字号按输出高度换算，三档供选。
        let font_divisor = match request.subtitle_size.as_deref() {
            Some("small") => 28.0,
            Some("large") => 17.0,
            _ => 22.0,
        };
        let font_size = (out_height as f64 / font_divisor).round().max(16.0) as i64;
        let margin = (out_height as f64 / 16.0).round().max(8.0) as i64;
        let centered = request.subtitle_style.as_deref() == Some("center");
        filters.push(format!(
            "[cv]subtitles=filename='{escaped}':force_style='FontName=Microsoft YaHei,FontSize={font_size},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,Alignment={},MarginV={}'[vsub]",
            if centered { 5 } else { 2 },
            if centered { 0 } else { margin }
        ));
        video_label = "vsub".to_string();
    }

    let fade_in = clamp(request.fade_in.unwrap_or(0.0), 0.0, 5.0);
    let fade_out = clamp(request.fade_out.unwrap_or(0.0), 0.0, 10.0);
    if let Some(chain) = global_fade_chain(&video_label, fade_in, fade_out, total) {
        filters.push(chain);
        video_label = "vout".to_string();
    }

    let mut audio_label = "ca".to_string();
    if !request.tracks.is_empty() {
        // 每条附加音轨单独整形：音量、裁到成片时长、淡入淡出。
        let mut mix_inputs = "[ca]".to_owned();
        for (index, track) in request.tracks.iter().enumerate() {
            let volume = clamp(track.volume.unwrap_or(1.0), 0.0, 4.0);
            let fade_in = clamp(track.fade_in.unwrap_or(0.0), 0.0, 5.0);
            let fade_out = clamp(track.fade_out.unwrap_or(0.0), 0.0, 10.0);
            let mut chain = format!(
                "[{}:a]aformat=sample_rates=44100:channel_layouts=stereo,volume={volume},atrim=end={},asetpts=PTS-STARTPTS",
                track_index + index as u32,
                seconds(total)
            );
            if fade_in > 0.0 {
                chain.push_str(&format!(",afade=t=in:st=0:d={}", seconds(fade_in)));
            }
            if fade_out > 0.0 {
                chain.push_str(&format!(",afade=t=out:st={}:d={}", seconds((total - fade_out).max(0.0)), seconds(fade_out)));
            }
            chain.push_str(&format!("[mix{index}]"));
            filters.push(chain);
            mix_inputs.push_str(&format!("[mix{index}]"));
        }
        // amix 的 normalize 选项需要 FFmpeg 4.4+，为兼容用户可能存在的旧版本（例如 2016 年的构建），
        // 这里改用通用写法：默认混音会按输入数衰减，随后用 volume 补偿回原音量。
        let inputs = request.tracks.len() + 1;
        filters.push(format!("{mix_inputs}amix=inputs={inputs}:duration=first,volume={inputs}[aout]"));
        audio_label = "aout".to_string();
    }

    let stem = sanitize_filename_stem(request.title.as_deref().unwrap_or("合成视频"));
    let filename = format!("{stem}-{}.mp4", unix_timestamp_millis());
    let output_path = cache_dir.join(&filename);
    let output_text = output_path.to_string_lossy().into_owned();

    arguments.extend([
        "-filter_complex".to_owned(),
        filters.join(";"),
        "-map".to_owned(),
        format!("[{video_label}]"),
        "-map".to_owned(),
        format!("[{audio_label}]"),
        "-c:v".to_owned(),
        "libx264".to_owned(),
        "-preset".to_owned(),
        "veryfast".to_owned(),
        "-crf".to_owned(),
        "20".to_owned(),
        "-pix_fmt".to_owned(),
        "yuv420p".to_owned(),
        "-c:a".to_owned(),
        "aac".to_owned(),
        "-b:a".to_owned(),
        "192k".to_owned(),
        "-ar".to_owned(),
        "44100".to_owned(),
        "-ac".to_owned(),
        "2".to_owned(),
        "-movflags".to_owned(),
        "+faststart".to_owned(),
        output_text.clone(),
    ]);

    let argument_refs: Vec<&str> = arguments.iter().map(String::as_str).collect();
    let result = run_captured(&executable, &argument_refs)?;
    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr).into_owned();
        let tail = stderr
            .lines()
            .rev()
            .filter(|line| !line.trim().is_empty())
            .take(6)
            .collect::<Vec<_>>()
            .join(" | ");
        let _ = std::fs::remove_file(&output_path);
        return Err(format!("FFmpeg 合成失败（{}）：{tail}", describe_exit_code(result.status.code().unwrap_or(-1))));
    }

    let bytes = std::fs::metadata(&output_path).map_err(|error| format!("无法读取合成结果：{error}"))?.len();
    if bytes == 0 {
        let _ = std::fs::remove_file(&output_path);
        return Err("FFmpeg 返回了空文件".to_owned());
    }
    Ok(ComposeVideoResult {
        absolute_path: output_text,
        filename,
        mime_type: "video/mp4".to_owned(),
        bytes,
        width: out_width,
        height: out_height,
        duration_ms: (total * 1000.0).round() as u64,
    })
}

fn unix_timestamp_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[tauri::command]
pub fn detect_ffmpeg(manual_path: Option<String>) -> Option<String> {
    detect_ffmpeg_path(manual_path.as_deref()).map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn compose_video(state: State<'_, MediaCacheState>, request: ComposeVideoRequest) -> Result<ComposeVideoResult, String> {
    let cache_dir = state.cache_dir();
    tauri::async_runtime::spawn_blocking(move || compose_blocking(&cache_dir, request))
        .await
        .map_err(|error| format!("合成任务执行失败：{error}"))?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConcatAudioRequest {
    ffmpeg_path: Option<String>,
    // 按数组顺序拼接，调用方负责给出顺序。
    paths: Vec<String>,
    title: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConcatAudioResult {
    absolute_path: String,
    filename: String,
    mime_type: String,
    bytes: u64,
    duration_ms: u64,
}

fn probe_audio_duration(executable: &Path, path: &str) -> Result<f64, String> {
    let missing = format!("音频文件不存在或已被移动：{path}");
    if !Path::new(path).is_file() {
        return Err(missing);
    }
    let output = run_captured(executable, &["-hide_banner", "-i", path])?;
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if !stderr.contains(": Audio:") {
        return Err(format!("不是可用的音频文件：{path}"));
    }
    parse_duration(&stderr).ok_or_else(|| format!("无法读取音频时长：{path}"))
}

fn concat_audio_blocking(cache_dir: &Path, request: ConcatAudioRequest) -> Result<ConcatAudioResult, String> {
    let executable = detect_ffmpeg_path(request.ffmpeg_path.as_deref())
        .ok_or_else(|| "未检测到 FFmpeg：请安装 FFmpeg 或加入 PATH，或在设置 → 本地 FFmpeg 中手动指定路径".to_owned())?;
    if request.paths.len() < 2 {
        return Err("至少需要 2 个音频才能合并".to_owned());
    }
    if request.paths.len() > 32 {
        return Err("一次最多合并 32 个音频".to_owned());
    }

    let mut total = 0.0;
    for (index, path) in request.paths.iter().enumerate() {
        total += probe_audio_duration(&executable, path).map_err(|error| format!("第 {} 段：{error}", index + 1))?;
    }

    let mut arguments: Vec<String> = vec!["-hide_banner".to_owned(), "-y".to_owned()];
    for path in &request.paths {
        arguments.push("-i".to_owned());
        arguments.push(path.clone());
    }
    // 各段采样率与声道可能不同，先统一再 concat，否则 FFmpeg 会直接报参数不一致。
    let chains: Vec<String> = (0..request.paths.len())
        .map(|index| format!("[{index}:a]aformat=sample_rates=44100:channel_layouts=stereo[a{index}]"))
        .collect();
    let labels = (0..request.paths.len()).map(|index| format!("[a{index}]")).collect::<Vec<String>>().join("");
    arguments.extend([
        "-filter_complex".to_owned(),
        format!("{};{}concat=n={}:v=0:a=1[aout]", chains.join(";"), labels, request.paths.len()),
        "-map".to_owned(),
        "[aout]".to_owned(),
        "-c:a".to_owned(),
        "libmp3lame".to_owned(),
        "-b:a".to_owned(),
        "192k".to_owned(),
        "-ar".to_owned(),
        "44100".to_owned(),
        "-ac".to_owned(),
        "2".to_owned(),
    ]);

    let stem = sanitize_filename_stem(request.title.as_deref().unwrap_or("合并音频"));
    let filename = format!("{stem}-{}.mp3", unix_timestamp_millis());
    let output_path = cache_dir.join(&filename);
    let output_text = output_path.to_string_lossy().into_owned();
    arguments.push(output_text.clone());

    let argument_refs: Vec<&str> = arguments.iter().map(String::as_str).collect();
    let result = run_captured(&executable, &argument_refs)?;
    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr).into_owned();
        let tail = stderr
            .lines()
            .rev()
            .filter(|line| !line.trim().is_empty())
            .take(6)
            .collect::<Vec<_>>()
            .join(" | ");
        let _ = std::fs::remove_file(&output_path);
        return Err(format!("FFmpeg 合并失败（退出码 {}）：{tail}", result.status.code().unwrap_or(-1)));
    }

    let bytes = std::fs::metadata(&output_path).map_err(|error| format!("无法读取合并结果：{error}"))?.len();
    if bytes == 0 {
        let _ = std::fs::remove_file(&output_path);
        return Err("FFmpeg 返回了空文件".to_owned());
    }
    Ok(ConcatAudioResult {
        absolute_path: output_text,
        filename,
        mime_type: "audio/mpeg".to_owned(),
        bytes,
        duration_ms: (total * 1000.0).round() as u64,
    })
}

#[tauri::command]
pub async fn concat_audio(state: State<'_, MediaCacheState>, request: ConcatAudioRequest) -> Result<ConcatAudioResult, String> {
    let cache_dir = state.cache_dir();
    tauri::async_runtime::spawn_blocking(move || concat_audio_blocking(&cache_dir, request))
        .await
        .map_err(|error| format!("合并任务执行失败：{error}"))?
}

// ── 音频波形包络 ────────────────────────────────────────────────────────────────
// 剪辑台时间线要画波形（音画对齐用），峰值必须由本机 FFmpeg 解码后统计：
// 浏览器里解码整段音频会吃掉大量内存与主线程时间，这里统一交给本机进程。

/// 波形解码参数：单声道 8kHz 的 16 位小端 PCM 足够画出包络，
/// 每秒只有 16KB，一小时音频也才 57MB 的读入量，而且是边读边算、不驻留内存。
const WAVEFORM_SAMPLE_RATE: u32 = 8_000;
/// 每个采样点用 16 位有符号归一化，除以 32768 后正好落在 -1..1。
const WAVEFORM_PCM_SCALE: f32 = 32_768.0;
const WAVEFORM_DEFAULT_BUCKETS: usize = 1_024;
const WAVEFORM_MIN_BUCKETS: usize = 64;
const WAVEFORM_MAX_BUCKETS: usize = 8_192;
/// 读管道用的定长缓冲（见 audio_waveform_blocking 的流式读取）。
const WAVEFORM_READ_CHUNK: usize = 64 * 1024;

/// 第 `index` 段的起始样本下标：`floor(index * total / buckets)`。
/// 不能整除时多出来的样本自然分给最后几段，边界只由这个式子决定，整段喂与分块喂结果一致。
fn bucket_start(index: usize, total: usize, buckets: usize) -> usize {
    index * total / buckets
}

/// PCM 字节流 → 峰值包络的累积器：按 `buckets` 段均分样本，逐段记最大 / 最小幅度。
/// 分块读取时 s16 可能被切断，所以留一个 carry 字节等到下一块再配对。
struct PeakAccumulator {
    total: usize,
    buckets: usize,
    samples: usize,
    current: usize,
    carry: Option<u8>,
    peaks: Vec<f32>,
    troughs: Vec<f32>,
}

impl PeakAccumulator {
    fn new(total: usize, buckets: usize) -> Self {
        let buckets = if total == 0 { 0 } else { buckets };
        Self {
            total,
            buckets,
            samples: 0,
            current: 0,
            carry: None,
            // 先放哨兵值，结束后把「这一段的样本还没来过」的段补成 0（静音）。
            peaks: vec![f32::MIN; buckets],
            troughs: vec![f32::MAX; buckets],
        }
    }

    /// 已经吃进来的样本数：用它算真实音频时长（探测出来的时长可能有零点几秒出入）。
    fn samples(&self) -> usize {
        self.samples
    }

    fn push_sample(&mut self, value: i16) {
        if self.buckets == 0 {
            return;
        }
        // 真实样本可能比预估多：多出来的一律并进最后一段，绝不下标越界。
        while self.current + 1 < self.buckets && self.samples >= bucket_start(self.current + 1, self.total, self.buckets) {
            self.current += 1;
        }
        let normalized = f32::from(value) / WAVEFORM_PCM_SCALE;
        if normalized > self.peaks[self.current] {
            self.peaks[self.current] = normalized;
        }
        if normalized < self.troughs[self.current] {
            self.troughs[self.current] = normalized;
        }
        self.samples += 1;
    }

    fn push_bytes(&mut self, bytes: &[u8]) {
        let mut index = 0;
        if let Some(high) = self.carry.take() {
            let Some(&low) = bytes.first() else {
                self.carry = Some(high);
                return;
            };
            self.push_sample(i16::from_le_bytes([high, low]));
            index = 1;
        }
        while index + 1 < bytes.len() {
            self.push_sample(i16::from_le_bytes([bytes[index], bytes[index + 1]]));
            index += 2;
        }
        // 末尾落单的半个样本留到下一块（最后一块落单则丢弃：半个 s16 没有意义）。
        if index < bytes.len() {
            self.carry = Some(bytes[index]);
        }
    }

    fn finish(mut self) -> (Vec<f32>, Vec<f32>) {
        for index in 0..self.buckets {
            if self.peaks[index] == f32::MIN {
                self.peaks[index] = 0.0;
            }
            if self.troughs[index] == f32::MAX {
                self.troughs[index] = 0.0;
            }
        }
        (self.peaks, self.troughs)
    }
}

/// PCM（16 位小端、单声道）字节流 → 峰值包络：均分 `buckets` 段，逐段取最大 / 最小幅度并归一化到 -1..1。
/// 只被单元测试直接调用，生产路径走同一个累积器的流式喂法（见 audio_waveform_blocking）。
#[allow(dead_code)]
fn pcm_envelope(bytes: &[u8], buckets: usize) -> (Vec<f32>, Vec<f32>) {
    let mut accumulator = PeakAccumulator::new(bytes.len() / 2, buckets);
    accumulator.push_bytes(bytes);
    accumulator.finish()
}

/// 把任意长度的峰值包络重采样到正好 `buckets` 段：每段取覆盖范围内的极值，缩放不会削掉尖峰；
/// 源比目标短时按最近点重复（放大只会变粗，不会出现空洞）。空输入返回空。
fn resample_envelope(peaks: &[f32], troughs: &[f32], buckets: usize) -> (Vec<f32>, Vec<f32>) {
    if peaks.is_empty() || buckets == 0 {
        return (Vec::new(), Vec::new());
    }
    if peaks.len() == buckets {
        return (peaks.to_vec(), troughs.to_vec());
    }
    let mut out_peaks = Vec::with_capacity(buckets);
    let mut out_troughs = Vec::with_capacity(buckets);
    for index in 0..buckets {
        let from = bucket_start(index, peaks.len(), buckets);
        let to = bucket_start(index + 1, peaks.len(), buckets).max(from + 1).min(peaks.len());
        let mut peak = f32::MIN;
        let mut trough = f32::MAX;
        for point in from..to {
            peak = peak.max(peaks[point]);
            trough = trough.min(troughs.get(point).copied().unwrap_or(0.0));
        }
        out_peaks.push(if peak == f32::MIN { 0.0 } else { peak });
        out_troughs.push(if trough == f32::MAX { 0.0 } else { trough });
    }
    (out_peaks, out_troughs)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioWaveformRequest {
    ffmpeg_path: Option<String>,
    /// 音频（或带音轨的视频）文件的本地绝对路径。
    path: String,
    /// 目标采样点数：前端按时间线像素列数的档位给，越大越细。
    samples: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioWaveformResult {
    /// 每个采样点的最大幅度，0..1。
    peaks: Vec<f32>,
    /// 每个采样点的最小幅度，-1..0。
    troughs: Vec<f32>,
    /// 真实解码出的音频时长（毫秒）：前端按它把波形铺到时间线上。
    duration_ms: u64,
    /// 解码用的采样率，供排查用。
    sample_rate: u32,
}

fn audio_waveform_blocking(request: AudioWaveformRequest) -> Result<AudioWaveformResult, String> {
    let executable = detect_ffmpeg_path(request.ffmpeg_path.as_deref())
        .ok_or_else(|| "未检测到 FFmpeg：请安装 FFmpeg 或加入 PATH，或在设置 → 本地 FFmpeg 中手动指定路径".to_owned())?;
    // 复用音频探测：文件不存在、没有音频流都在这里给出可读的中文错误，不用另写一套判断。
    let duration = probe_audio_duration(&executable, &request.path)?;
    let buckets = request.samples.unwrap_or(WAVEFORM_DEFAULT_BUCKETS).clamp(WAVEFORM_MIN_BUCKETS, WAVEFORM_MAX_BUCKETS);
    // 先按时长估总样本数来定分桶粒度（管道流没有总长度，无法事后分段）；
    // 真实样本数与估算值有出入时，最后会按真实包络重采样到正好 buckets 段。
    let estimated = ((duration * f64::from(WAVEFORM_SAMPLE_RATE)).round() as usize).max(1);
    let mut accumulator = PeakAccumulator::new(estimated, buckets);

    let rate = WAVEFORM_SAMPLE_RATE.to_string();
    let mut command = Command::new(&executable);
    command.args(["-hide_banner", "-v", "error", "-i", &request.path, "-vn", "-ac", "1", "-ar", rate.as_str(), "-f", "s16le", "pipe:1"]);
    configure(&mut command);
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| format!("无法启动 FFmpeg：{error}"))?;

    // stderr 交给独立线程读干：PCM 数据量大，主线程忙着读 stdout 时没人读 stderr 会把它堵死。
    let stderr_reader = child
        .stderr
        .take()
        .map(|stream| std::thread::spawn(move || {
            let mut text = String::new();
            let _ = BufReader::new(stream).read_to_string(&mut text);
            text
        }));

    // 流式读取：定长缓冲边读边算，绝不把整个音频的 PCM 读进内存。
    if let Some(stdout) = child.stdout.take() {
        let mut reader = BufReader::new(stdout);
        let mut buffer = vec![0_u8; WAVEFORM_READ_CHUNK];
        loop {
            let read = reader.read(&mut buffer).map_err(|error| format!("读取 FFmpeg 解码输出失败：{error}"))?;
            if read == 0 {
                break;
            }
            accumulator.push_bytes(&buffer[..read]);
        }
    }

    let status = child.wait().map_err(|error| format!("FFmpeg 解码进程异常结束：{error}"))?;
    let stderr = stderr_reader.map(|handle| handle.join().unwrap_or_default()).unwrap_or_default();
    if !status.success() {
        let tail = stderr
            .lines()
            .rev()
            .filter(|line| !line.trim().is_empty())
            .take(6)
            .collect::<Vec<_>>()
            .join(" | ");
        return Err(format!("FFmpeg 解码音频失败（{}）：{tail}", describe_exit_code(status.code().unwrap_or(-1))));
    }

    let decoded = accumulator.samples();
    let (peaks, troughs) = accumulator.finish();
    if decoded == 0 || peaks.is_empty() {
        return Err(format!("音频里没有可用的采样数据：{}", request.path));
    }
    let (peaks, troughs) = resample_envelope(&peaks, &troughs, buckets);
    Ok(AudioWaveformResult {
        peaks,
        troughs,
        duration_ms: decoded as u64 * 1000 / u64::from(WAVEFORM_SAMPLE_RATE),
        sample_rate: WAVEFORM_SAMPLE_RATE,
    })
}

#[tauri::command]
pub async fn audio_waveform(request: AudioWaveformRequest) -> Result<AudioWaveformResult, String> {
    tauri::async_runtime::spawn_blocking(move || audio_waveform_blocking(request))
        .await
        .map_err(|error| format!("波形任务执行失败：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 输出标签前不能紧跟逗号：那段空滤镜名会让 FFmpeg 报 `No such filter: ""` 并拒绝出片。
    fn assert_no_empty_filter(chain: &str) {
        assert!(!chain.contains(",["), "输出标签前多了逗号，会产生空滤镜名：{chain}");
        assert!(!chain.contains("[]["), "出现了空滤镜：{chain}");
    }

    #[test]
    fn fade_chain_never_ends_with_a_comma() {
        // 用户报告的那次失败：整体淡入淡出都是 0.5s，成片 25.099s。
        let both = global_fade_chain("cv", 0.5, 0.5, 25.099_002).expect("应当生成淡入淡出滤镜");
        assert_eq!(both, "[cv]fade=t=in:st=0:d=0.5,fade=t=out:st=24.599:d=0.5[vout]");
        assert_no_empty_filter(&both);

        // 只有单边淡入淡出时同样不能留尾逗号。
        let only_in = global_fade_chain("cv", 0.5, 0.0, 10.0).expect("应当生成淡入滤镜");
        assert_eq!(only_in, "[cv]fade=t=in:st=0:d=0.5[vout]");
        assert_no_empty_filter(&only_in);

        let only_out = global_fade_chain("vsub", 0.0, 0.5, 10.0).expect("应当生成淡出滤镜");
        assert_eq!(only_out, "[vsub]fade=t=out:st=9.5:d=0.5[vout]");
        assert_no_empty_filter(&only_out);
    }

    #[test]
    fn fade_chain_is_skipped_without_any_fade() {
        assert!(global_fade_chain("cv", 0.0, 0.0, 10.0).is_none());
    }

    #[test]
    fn exit_code_is_translated_for_users() {
        assert_eq!(describe_exit_code(-1_279_870_712), "滤镜图里有 FFmpeg 不认识的滤镜，常见原因是转场或滤镜名为空");
        assert_eq!(describe_exit_code(-1_163_346_256), "FFmpeg 不支持该滤镜选项，请检查转场类型");
        assert_eq!(describe_exit_code(0xC000_0005_u32 as i32), "FFmpeg 进程崩溃");
        assert_eq!(describe_exit_code(1), "1");
        assert_eq!(describe_exit_code(-12_345), "FFmpeg 内部错误 0xFFFFCFC7");
    }

    // ── 波形峰值包络 ──────────────────────────────────────────────────────────
    // i16 / 32768 的商是二进制有限小数，能被 f32 精确表示，所以这些断言可以直接比相等。

    /// 构造一段 16 位小端、单声道的 PCM 字节流。
    fn pcm(samples: &[i16]) -> Vec<u8> {
        samples.iter().flat_map(|value| value.to_le_bytes()).collect()
    }

    #[test]
    fn envelope_of_empty_input_is_empty() {
        assert_eq!(pcm_envelope(&[], 4), (Vec::new(), Vec::new()));
        // 只有一个字节：凑不出一个 s16 样本，同样按「没有数据」处理。
        assert_eq!(pcm_envelope(&[0x7F], 4), (Vec::new(), Vec::new()));
        // 采样点数给 0 也不该 panic。
        assert_eq!(pcm_envelope(&pcm(&[1, 2]), 0), (Vec::new(), Vec::new()));
    }

    #[test]
    fn envelope_of_single_sample_is_that_sample() {
        let (peaks, troughs) = pcm_envelope(&pcm(&[32_767]), 1);
        assert_eq!(peaks.len(), 1);
        assert_eq!(troughs.len(), 1);
        assert!((peaks[0] - 1.0).abs() < 1e-4, "满幅值应归一化到 1 附近：{}", peaks[0]);
        assert_eq!(peaks[0], troughs[0]);

        let (peaks, troughs) = pcm_envelope(&pcm(&[-32_768]), 1);
        assert_eq!(peaks[0], -1.0);
        assert_eq!(troughs[0], -1.0);

        // 采样点比样本多：空出来的段按静音补 0，长度仍然等于请求的段数。
        let (peaks, troughs) = pcm_envelope(&pcm(&[1_000]), 3);
        assert_eq!(peaks.len(), 3);
        assert_eq!(troughs.len(), 3);
        assert_eq!(peaks.iter().filter(|value| **value != 0.0).count(), 1);
    }

    #[test]
    fn envelope_splits_samples_evenly() {
        // 8 个样本分 4 段：正好每段 2 个。
        let (peaks, troughs) = pcm_envelope(&pcm(&[1_000, 2_000, -3_000, 4_000, 5_000, -6_000, 7_000, 8_000]), 4);
        assert_eq!(peaks, vec![2_000.0 / 32_768.0, 4_000.0 / 32_768.0, 5_000.0 / 32_768.0, 8_000.0 / 32_768.0]);
        assert_eq!(troughs, vec![1_000.0 / 32_768.0, -3_000.0 / 32_768.0, -6_000.0 / 32_768.0, 7_000.0 / 32_768.0]);
    }

    #[test]
    fn envelope_distributes_the_remainder_to_the_last_buckets() {
        // 10 个样本分 3 段：边界是 floor(i*10/3) = 0 / 3 / 6 / 10，所以是 3 + 3 + 4。
        let samples = [100, -200, 300, -400, 500, -600, 700, -800, 900, -1_000];
        let (peaks, troughs) = pcm_envelope(&pcm(&samples), 3);
        assert_eq!(peaks.len(), 3);
        assert_eq!(peaks, vec![300.0 / 32_768.0, 500.0 / 32_768.0, 900.0 / 32_768.0]);
        assert_eq!(troughs, vec![-200.0 / 32_768.0, -600.0 / 32_768.0, -1_000.0 / 32_768.0]);
    }

    #[test]
    fn envelope_of_silence_is_zero() {
        let (peaks, troughs) = pcm_envelope(&pcm(&[0; 8]), 4);
        assert_eq!(peaks, vec![0.0; 4]);
        assert_eq!(troughs, vec![0.0; 4]);
    }

    #[test]
    fn envelope_keeps_full_scale_extremes() {
        // 交替满幅：整流后的包络每一段都应该顶到 ±1。
        let samples: Vec<i16> = (0..16).map(|index| if index % 2 == 0 { 32_767 } else { -32_768 }).collect();
        let (peaks, troughs) = pcm_envelope(&pcm(&samples), 4);
        assert!(peaks.iter().all(|value| (*value - 1.0).abs() < 1e-4), "峰值应全部接近 1：{peaks:?}");
        // -32768 / 32768 正好是 -1.0。
        assert!(troughs.iter().all(|value| *value == -1.0), "谷值应全部是 -1：{troughs:?}");
    }

    #[test]
    fn envelope_is_identical_when_the_stream_is_split_into_chunks() {
        let samples: Vec<i16> = (0..101).map(|index| ((index * 37) % 3_000 - 1_500) as i16).collect();
        let bytes = pcm(&samples);
        let expected = pcm_envelope(&bytes, 8);
        // 分块大小故意取奇数：s16 会被切断，必须靠 carry 字节接回来。
        for chunk in [1_usize, 3, 7, 64, 4_097] {
            let mut accumulator = PeakAccumulator::new(samples.len(), 8);
            for piece in bytes.chunks(chunk) {
                accumulator.push_bytes(piece);
            }
            assert_eq!(accumulator.samples(), samples.len());
            assert_eq!(accumulator.finish(), expected, "分块 {chunk} 字节时结果应与整段喂一致");
        }
        // 末尾落单的半个样本直接丢弃，不影响统计。
        let mut accumulator = PeakAccumulator::new(samples.len(), 8);
        let mut padded = bytes.clone();
        padded.push(0x7F);
        accumulator.push_bytes(&padded);
        assert_eq!(accumulator.finish(), expected);
    }

    #[test]
    fn envelope_is_clamped_to_the_target_bucket_count() {
        // 真实样本比预估多：多出来的一律并进最后一段，不下标越界也不丢样本。
        let mut accumulator = PeakAccumulator::new(2, 4);
        accumulator.push_bytes(&pcm(&[1_000, -2_000, 30_000, -40]));
        let (peaks, troughs) = accumulator.finish();
        assert_eq!(peaks.len(), 4);
        assert_eq!(troughs.len(), 4);
        assert_eq!(peaks[3], 30_000.0 / 32_768.0);
        assert_eq!(troughs[3], -2_000.0 / 32_768.0);
    }

    #[test]
    fn resample_normalizes_the_point_count_without_losing_peaks() {
        let peaks = [0.1, 0.9, 0.2, 0.3];
        let troughs = [-0.1, -0.9, -0.2, -0.3];

        // 降采样：每段取覆盖范围内的极值，尖峰不能被平均掉。
        let (down_peaks, down_troughs) = resample_envelope(&peaks, &troughs, 2);
        assert_eq!(down_peaks, vec![0.9, 0.3]);
        assert_eq!(down_troughs, vec![-0.9, -0.3]);

        // 升采样：按最近点重复，长度必须正好等于目标段数。
        let (up_peaks, up_troughs) = resample_envelope(&peaks, &troughs, 8);
        assert_eq!(up_peaks, vec![0.1, 0.1, 0.9, 0.9, 0.2, 0.2, 0.3, 0.3]);
        assert_eq!(up_troughs, vec![-0.1, -0.1, -0.9, -0.9, -0.2, -0.2, -0.3, -0.3]);

        // 段数一致时原样返回。
        assert_eq!(resample_envelope(&peaks, &troughs, 4), (peaks.to_vec(), troughs.to_vec()));

        // 空输入与 0 段都返回空，不 panic。
        assert_eq!(resample_envelope(&[], &[], 4), (Vec::new(), Vec::new()));
        assert_eq!(resample_envelope(&peaks, &troughs, 0), (Vec::new(), Vec::new()));
    }

    /// 真实解码路径的冒烟测试：造一段「前 2 秒静音 + 后 2 秒满幅 440Hz 正弦」的音频再走完整链路。
    /// 默认忽略（需要本机有 FFmpeg 与临时目录），用 `cargo test --offline --lib -- --ignored` 显式执行。
    #[test]
    #[ignore]
    fn waveform_of_a_generated_tone_keeps_the_silence_boundary() {
        let Some(executable) = detect_ffmpeg_path(None) else {
            return;
        };
        let path = std::env::temp_dir().join(format!("mgcanvas-waveform-{}.wav", std::process::id()));
        let path_text = path.to_string_lossy().into_owned();
        let generated = run_captured(
            &executable,
            &[
                "-hide_banner",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "anullsrc=channel_layout=mono:sample_rate=44100:d=2",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=2:sample_rate=44100",
                // sine 滤镜的默认幅度很小（实测约 1/8 满幅），拉满再拼，响段才是真的满幅。
                "-filter_complex",
                "[1:a]volume=8[amp];[0:a][amp]concat=n=2:v=0:a=1[a]",                "-map",
                "[a]",
                "-c:a",
                "pcm_s16le",
                &path_text,
            ],
        )
        .expect("应当能生成测试音频");
        assert!(generated.status.success(), "生成测试音频失败：{}", String::from_utf8_lossy(&generated.stderr));

        let result = audio_waveform_blocking(AudioWaveformRequest { ffmpeg_path: None, path: path_text, samples: Some(256) }).expect("应当算得出波形");
        let _ = std::fs::remove_file(&path);

        // 4 秒音频 → 正好 256 个采样点，每个点 15.625ms；真实播放时长按解码出的样本数算。
        assert_eq!(result.peaks.len(), 256);
        assert_eq!(result.peaks.len(), result.troughs.len());
        assert!((result.duration_ms as i64 - 4_000).abs() <= 20, "时长应按真实解码样本数算：{}", result.duration_ms);
        assert_eq!(result.sample_rate, WAVEFORM_SAMPLE_RATE);

        // 前 2 秒静音、后 2 秒满幅：分界正好落在第 128 个点上，这就是「波形与时间对齐」的前提。
        assert!(result.peaks[..120].iter().all(|value| *value < 0.02), "静音段不该有幅度：{:?}", &result.peaks[..8]);
        assert!(result.peaks[135..].iter().all(|value| *value > 0.5), "响段应接近满幅：{:?}", &result.peaks[248..]);
        assert!(result.troughs[135..].iter().all(|value| *value < -0.5), "响段的谷值应接近 -1");
        assert!(result.peaks[126] < 0.02, "分界前的点仍是静音：{}", result.peaks[126]);
        assert!(result.peaks[129] > 0.5, "分界后的点已经是满幅正弦：{}", result.peaks[129]);
    }

    // ── 静音 / 独奏导出链路的真实 FFmpeg 冒烟 ──────────────────────────────────────
    // 静音与独奏都在**前端构造请求时**生效：被排除的轨整条不进 request.tracks，
    // 因此 FFmpeg 侧只看到「少了一条输入」，不需要改任何滤镜链。这组测试真的跑一遍 FFmpeg，
    // 验证两件事：① 被排除的轨在成片里确实没有声音；② 整条滤镜链（含上次出过尾逗号事故的
    // 整体淡入淡出）语法成立、真能出片。默认忽略，用 `cargo test --offline --lib -- --ignored` 执行。

    /// 跑一次真实合成：`tracks` 就是前端算完「谁真的出声」之后交给 FFmpeg 的那一份。
    fn compose_smoke(cache: &Path, segment: &str, tracks: &[&str], fade: f64) -> ComposeVideoResult {
        compose_blocking(
            cache,
            ComposeVideoRequest {
                ffmpeg_path: None,
                segments: vec![ComposeSegment {
                    path: segment.to_owned(),
                    start: None,
                    end: None,
                    volume: None,
                    transition: None,
                    transition_duration: None,
                    subtitle: None,
                    fade_in: None,
                    fade_out: None,
                }],
                tracks: tracks
                    .iter()
                    .map(|path| ComposeAudioTrack { path: (*path).to_owned(), volume: None, fade_in: None, fade_out: None, looped: None })
                    .collect(),
                long_edge: Some(320.0),
                fps: Some(30.0),
                // 整体淡入淡出必须开着：它才是上次「尾逗号 ⇒ 空滤镜名 ⇒ 拒绝出片」的那段代码。
                fade_in: Some(fade),
                fade_out: Some(fade),
                title: Some("静音冒烟".to_owned()),
                subtitle_style: None,
                subtitle_size: None,
            },
        )
        .expect("真实合成应当成功（滤镜链语法必须成立）")
    }

    /// 用同一套波形解码读出成片的最大幅度：0 附近表示这条成片没有声音。
    fn peak_of(path: &str) -> f32 {
        audio_waveform_blocking(AudioWaveformRequest { ffmpeg_path: None, path: path.to_owned(), samples: Some(256) })
            .expect("应当能读出成片音频")
            .peaks
            .iter()
            .copied()
            .fold(0.0_f32, f32::max)
    }

    #[test]
    #[ignore]
    fn muted_track_really_is_silent_in_the_final_cut() {
        let Some(executable) = detect_ffmpeg_path(None) else {
            return;
        };
        let dir = std::env::temp_dir().join(format!("mgcanvas-mute-smoke-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("应当能建临时目录");
        let text = |name: &str| dir.join(name).to_string_lossy().into_owned();
        let video = text("segment.mp4");
        let bed = text("bed.wav");
        let music = text("music.wav");

        // 视频段故意**没有音轨**：这样 [ca] 走 anullsrc 静音，成片里剩下的声音只可能来自附加音轨。
        let generated = run_captured(
            &executable,
            &["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", &video],
        )
        .expect("应当能生成测试视频");
        assert!(generated.status.success(), "生成测试视频失败：{}", String::from_utf8_lossy(&generated.stderr));

        // bed = 静音（「留着出声」的那条轨）；music = 满幅 880Hz（「被静音」的那条轨）。
        // sine 的默认幅度只有约 1/8 满幅，这里直接拉到满幅，静音与否的差距才是决定性的。
        let muted_source = "sine=frequency=880:duration=3:sample_rate=44100";
        for (path, source, gain) in [(&bed, "anullsrc=channel_layout=stereo:sample_rate=44100:d=3", "1"), (&music, muted_source, "8")] {
            let made = run_captured(&executable, &["-hide_banner", "-y", "-f", "lavfi", "-i", source, "-filter:a", &format!("volume={gain}"), "-c:a", "pcm_s16le", path.as_str()])
                .expect("应当能生成测试音频");
            assert!(made.status.success(), "生成测试音频失败：{}", String::from_utf8_lossy(&made.stderr));
        }

        // ① 两条轨都在（没人静音）：成片里听得到 music 的声音。
        let both = compose_smoke(&dir, &video, &[&bed, &music], 0.3);
        let both_peak = peak_of(&both.absolute_path);

        // ② music 被静音 ⇒ 前端只把 bed 交给 FFmpeg：成片应当彻底安静。
        let muted = compose_smoke(&dir, &video, &[&bed], 0.3);
        let muted_peak = peak_of(&muted.absolute_path);

        // ③ 全部静音 ⇒ tracks 为空，连混音分支都不进：同样安静，且仍然出片。
        let all_muted = compose_smoke(&dir, &video, &[], 0.3);
        let all_muted_peak = peak_of(&all_muted.absolute_path);

        let _ = std::fs::remove_dir_all(&dir);

        println!("① 两条轨都出声：峰值 {both_peak}，时长 {}ms，{} 字节", both.duration_ms, both.bytes);
        println!("② music 被静音（只把 bed 交给 FFmpeg）：峰值 {muted_peak}，时长 {}ms，{} 字节", muted.duration_ms, muted.bytes);
        println!("③ 全部静音（tracks 为空）：峰值 {all_muted_peak}，时长 {}ms，{} 字节", all_muted.duration_ms, all_muted.bytes);

        assert!((both.duration_ms as i64 - 3_000).abs() <= 400, "成片时长应按片段长度算：{}", both.duration_ms);
        assert!(both_peak > 0.5, "两条轨都出声时成片应当有声音，实测峰值 {both_peak}");
        assert!(muted_peak < 0.02, "静音轨被跳过之后成片应当安静，实测峰值 {muted_peak}");
        assert!(all_muted_peak < 0.02, "全部音轨被排除之后成片应当安静，实测峰值 {all_muted_peak}");
        assert!(both.bytes > 0 && muted.bytes > 0 && all_muted.bytes > 0, "三种情况都必须真的出片");
    }
}

