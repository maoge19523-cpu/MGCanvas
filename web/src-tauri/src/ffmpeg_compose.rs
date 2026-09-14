use std::{
    path::{Path, PathBuf},
    process::Command,
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
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeMusic {
    path: String,
    volume: Option<f64>,
    fade_out: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeVideoRequest {
    ffmpeg_path: Option<String>,
    segments: Vec<ComposeSegment>,
    music: Option<ComposeMusic>,
    long_edge: Option<f64>,
    fps: Option<f64>,
    fade_in: Option<f64>,
    fade_out: Option<f64>,
    title: Option<String>,
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
    if Command::new("ffmpeg")
        .arg("-version")
        .stderr(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .spawn()
        .is_ok()
    {
        return Some(PathBuf::from("ffmpeg"));
    }
    for dir in AUTO_DIRS {
        if let Some(found) = candidate_from_dir(Path::new(dir)) {
            return Some(found);
        }
    }
    None
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
    let total: f64 = ranges.iter().map(|(start, end)| end - start).sum();

    let music_index = request.segments.len() as u32;
    let needs_silence = probes.iter().any(|probe| !probe.has_audio);
    let silence_index = music_index + u32::from(request.music.is_some());

    let mut arguments: Vec<String> = vec!["-hide_banner".to_owned(), "-y".to_owned()];
    for segment in &request.segments {
        arguments.push("-i".to_owned());
        arguments.push(segment.path.clone());
    }
    if let Some(music) = &request.music {
        arguments.push("-i".to_owned());
        arguments.push(music.path.clone());
    }
    if needs_silence {
        arguments.extend(["-f".to_owned(), "lavfi".to_owned(), "-i".to_owned(), "anullsrc=channel_layout=stereo:sample_rate=44100".to_owned()]);
    }

    let mut filters: Vec<String> = Vec::new();
    let mut concat_inputs = String::new();
    for (index, ((start, end), probe)) in ranges.iter().zip(&probes).enumerate() {
        let duration = end - start;
        filters.push(format!(
            "[{index}:v]trim=start={}:end={},setpts=PTS-STARTPTS,fps={},scale={w}:{h}:force_original_aspect_ratio=decrease:flags=bicubic,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v{index}]",
            seconds(*start),
            seconds(*end),
            seconds(fps),
            w = out_width,
            h = out_height
        ));
        if probe.has_audio {
            let volume = clamp(request.segments[index].volume.unwrap_or(1.0), 0.0, 4.0);
            filters.push(format!(
                "[{index}:a]atrim=start={}:end={},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo,volume={}[a{index}]",
                seconds(*start),
                seconds(*end),
                seconds(volume)
            ));
        } else {
            filters.push(format!(
                "[{silence_index}:a]atrim=end={},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo[a{index}]",
                seconds(duration)
            ));
        }
        concat_inputs.push_str(&format!("[v{index}][a{index}]"));
    }
    filters.push(format!("{}concat=n={}:v=1:a=1[cv][ca]", concat_inputs, request.segments.len()));

    let mut video_label = "cv".to_string();
    let fade_in = clamp(request.fade_in.unwrap_or(0.0), 0.0, 5.0);
    let fade_out = clamp(request.fade_out.unwrap_or(0.0), 0.0, 10.0);
    if fade_in > 0.0 || fade_out > 0.0 {
        let mut chain = format!("[cv]");
        if fade_in > 0.0 {
            chain.push_str(&format!("fade=t=in:st=0:d={},", seconds(fade_in)));
        }
        if fade_out > 0.0 {
            chain.push_str(&format!("fade=t=out:st={}:d={},", seconds((total - fade_out).max(0.0)), seconds(fade_out)));
        }
        chain.push_str("[vout]");
        filters.push(chain);
        video_label = "vout".to_string();
    }

    let mut audio_label = "ca".to_string();
    if let Some(music) = &request.music {
        let volume = clamp(music.volume.unwrap_or(1.0), 0.0, 4.0);
        let fade = clamp(music.fade_out.unwrap_or(0.0), 0.0, 10.0);
        let mut music_filter = format!(
            "[{music_index}:a]aformat=sample_rates=44100:channel_layouts=stereo,volume={volume},atrim=end={},asetpts=PTS-STARTPTS",
            seconds(total)
        );
        if fade > 0.0 {
            music_filter.push_str(&format!(",afade=t=out:st={}:d={}", seconds((total - fade).max(0.0)), seconds(fade)));
        }
        music_filter.push_str("[mx]");
        filters.push(music_filter);
        // amix 的 normalize 选项需要 FFmpeg 4.4+，为兼容用户可能存在的旧版本（例如 2016 年的构建），
        // 这里改用通用写法：默认混音会让各输入衰减一半，随后用 volume 补偿回原音量。
        filters.push("[ca][mx]amix=inputs=2:duration=first,volume=2[aout]".to_owned());
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
        return Err(format!("FFmpeg 合成失败（退出码 {}）：{tail}", result.status.code().unwrap_or(-1)));
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
