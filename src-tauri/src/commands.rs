use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::influxdb::InfluxClient;

// ──────────────────────────────────────────────
// Shared types
// ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InfluxConfig {
    pub url: String,
    pub token: String,
    pub org: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterCondition {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryParams {
    pub bucket: String,
    pub measurement: String,
    pub filters: Vec<FilterCondition>,
    pub start: String,
    pub stop: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadConfig {
    pub chunk_minutes: u64,
    pub delay_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgressPayload {
    pub total_chunks: u64,
    pub completed_chunks: u64,
    pub total_records: u64,
    pub status: String,
    pub message: String,
}

// ──────────────────────────────────────────────
// App state (for download cancellation)
// ──────────────────────────────────────────────

pub struct AppState {
    pub cancel_flag: Arc<AtomicBool>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            cancel_flag: Arc::new(AtomicBool::new(false)),
        }
    }
}

// ──────────────────────────────────────────────
// Commands
// ──────────────────────────────────────────────

#[tauri::command]
pub async fn test_connection(config: InfluxConfig) -> Result<String, String> {
    InfluxClient::new(&config).test_connection().await
}

#[tauri::command]
pub async fn get_buckets(config: InfluxConfig) -> Result<Vec<String>, String> {
    InfluxClient::new(&config).get_buckets().await
}

#[tauri::command]
pub async fn get_measurements(
    config: InfluxConfig,
    bucket: String,
) -> Result<Vec<String>, String> {
    InfluxClient::new(&config).get_measurements(&bucket).await
}

#[tauri::command]
pub async fn get_tag_keys(
    config: InfluxConfig,
    bucket: String,
    measurement: String,
) -> Result<Vec<String>, String> {
    InfluxClient::new(&config)
        .get_tag_keys(&bucket, &measurement)
        .await
}

#[tauri::command]
pub async fn get_tag_values(
    config: InfluxConfig,
    bucket: String,
    measurement: String,
    tag: String,
    filters: Vec<FilterCondition>,
) -> Result<Vec<String>, String> {
    InfluxClient::new(&config)
        .get_tag_values(&bucket, &measurement, &tag, &filters)
        .await
}

#[tauri::command]
pub async fn preview_query(
    config: InfluxConfig,
    params: QueryParams,
) -> Result<serde_json::Value, String> {
    InfluxClient::new(&config).preview_query(&params).await
}

#[tauri::command]
pub async fn preview_query_debug(
    config: InfluxConfig,
    params: QueryParams,
) -> Result<serde_json::Value, String> {
    let client = InfluxClient::new(&config);
    let mut query = client.build_flux_query(&params);
    query.push_str("\n  |> limit(n: 5)");
    let csv = client.flux_query_raw(&query).await?;

    let head: Vec<&str> = csv.lines().take(30).collect();
    Ok(serde_json::json!({
        "query": query,
        "csv_head": head.join("\n")
    }))
}

#[tauri::command]
pub async fn start_download(
    app: AppHandle,
    config: InfluxConfig,
    params: QueryParams,
    file_path: String,
    download_config: DownloadConfig,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.cancel_flag.store(false, Ordering::SeqCst);
    let cancel_flag = state.cancel_flag.clone();

    let client = InfluxClient::new(&config);
    let chunks = build_time_chunks(&params.start, &params.stop, download_config.chunk_minutes)?;
    let total_chunks = chunks.len() as u64;

    if total_chunks == 0 {
        return Err("时间范围计算失败，请检查开始/结束时间".to_string());
    }

    let file = std::fs::File::create(&file_path)
        .map_err(|e| format!("创建文件失败: {}", e))?;
    let mut writer = std::io::BufWriter::new(file);

    let mut total_records = 0u64;
    let mut header_written = false;

    for (i, (chunk_start, chunk_stop)) in chunks.iter().enumerate() {
        if cancel_flag.load(Ordering::SeqCst) {
            let _ = app.emit(
                "download-progress",
                ProgressPayload {
                    total_chunks,
                    completed_chunks: i as u64,
                    total_records,
                    status: "cancelled".to_string(),
                    message: "下载已取消".to_string(),
                },
            );
            return Ok(());
        }

        let mut chunk_params = params.clone();
        chunk_params.start = chunk_start.clone();
        chunk_params.stop = chunk_stop.clone();

        let csv_text = match client.query_csv(&chunk_params).await {
            Ok(t) => t,
            Err(e) => {
                let _ = app.emit(
                    "download-progress",
                    ProgressPayload {
                        total_chunks,
                        completed_chunks: i as u64,
                        total_records,
                        status: "error".to_string(),
                        message: format!("块 {} 下载失败: {}", i + 1, e),
                    },
                );
                return Err(e);
            }
        };

        let chunk_records =
            write_csv_chunk(&mut writer, &csv_text, &mut header_written)
                .map_err(|e| format!("写文件失败: {}", e))?;
        total_records += chunk_records;

        let _ = app.emit(
            "download-progress",
            ProgressPayload {
                total_chunks,
                completed_chunks: (i + 1) as u64,
                total_records,
                status: "running".to_string(),
                message: format!(
                    "已下载 {}/{} 块，共 {} 条记录",
                    i + 1,
                    total_chunks,
                    total_records
                ),
            },
        );

        if i < chunks.len() - 1 && download_config.delay_ms > 0 {
            tokio::time::sleep(Duration::from_millis(download_config.delay_ms)).await;
        }
    }

    writer
        .flush()
        .map_err(|e| format!("刷新文件缓冲区失败: {}", e))?;

    let _ = app.emit(
        "download-progress",
        ProgressPayload {
            total_chunks,
            completed_chunks: total_chunks,
            total_records,
            status: "completed".to_string(),
            message: format!("下载完成！共 {} 条记录已保存到文件", total_records),
        },
    );

    Ok(())
}

#[tauri::command]
pub async fn cancel_download(state: State<'_, AppState>) -> Result<(), String> {
    state.cancel_flag.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn save_settings(config: InfluxConfig) -> Result<(), String> {
    let dir = dirs::config_dir()
        .ok_or("找不到配置目录")?
        .join("craner-data-inspector");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {}", e))?;
    let json =
        serde_json::to_string_pretty(&config).map_err(|e| format!("序列化失败: {}", e))?;
    std::fs::write(dir.join("settings.json"), json)
        .map_err(|e| format!("写配置文件失败: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn load_settings() -> Result<Option<InfluxConfig>, String> {
    let path = match dirs::config_dir() {
        Some(d) => d.join("craner-data-inspector").join("settings.json"),
        None => return Ok(None),
    };
    if !path.exists() {
        return Ok(None);
    }
    let json =
        std::fs::read_to_string(&path).map_err(|e| format!("读配置文件失败: {}", e))?;
    let config: InfluxConfig =
        serde_json::from_str(&json).map_err(|e| format!("解析配置失败: {}", e))?;
    Ok(Some(config))
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

/// Split a time range into equal-sized chunks of `chunk_minutes` each.
/// Returns a list of (start_rfc3339, stop_rfc3339) pairs.
fn build_time_chunks(
    start: &str,
    stop: &str,
    chunk_minutes: u64,
) -> Result<Vec<(String, String)>, String> {
    let now = Utc::now();

    let start_dt = parse_time(start, now)?;
    let stop_dt = if stop == "now()" || stop.is_empty() {
        now
    } else {
        parse_time(stop, now)?
    };

    if start_dt >= stop_dt {
        return Err("开始时间必须早于结束时间".to_string());
    }

    let chunk_secs = (chunk_minutes as i64) * 60;
    let mut chunks = Vec::new();
    let mut cursor = start_dt;

    while cursor < stop_dt {
        let next = (cursor + chrono::Duration::seconds(chunk_secs)).min(stop_dt);
        chunks.push((cursor.to_rfc3339(), next.to_rfc3339()));
        cursor = next;
    }

    Ok(chunks)
}

fn parse_time(s: &str, now: DateTime<Utc>) -> Result<DateTime<Utc>, String> {
    let s = s.trim();

    // Relative times like "-1h", "-30d", "-15m"
    if let Some(rest) = s.strip_prefix('-') {
        return parse_relative_duration(rest, now);
    }

    // datetime-local format from HTML input: "2024-01-15T10:30"
    if s.len() == 16 && s.contains('T') && !s.ends_with('Z') {
        let with_z = format!("{}:00Z", s);
        return with_z
            .parse::<DateTime<Utc>>()
            .map_err(|e| format!("无效时间 '{}': {}", s, e));
    }

    // Full RFC3339
    s.parse::<DateTime<Utc>>()
        .map_err(|e| format!("无效时间 '{}': {}", s, e))
}

fn parse_relative_duration(s: &str, now: DateTime<Utc>) -> Result<DateTime<Utc>, String> {
    if let Some(n) = s.strip_suffix('h') {
        let hours: i64 = n.parse().map_err(|_| format!("无效相对时间: -{}", s))?;
        Ok(now - chrono::Duration::hours(hours))
    } else if s.ends_with("mo") {
        let n: i64 = s
            .strip_suffix("mo")
            .unwrap()
            .parse()
            .map_err(|_| format!("无效相对时间: -{}", s))?;
        Ok(now - chrono::Duration::days(n * 30))
    } else if let Some(n) = s.strip_suffix('d') {
        let days: i64 = n.parse().map_err(|_| format!("无效相对时间: -{}", s))?;
        Ok(now - chrono::Duration::days(days))
    } else if let Some(n) = s.strip_suffix('w') {
        let weeks: i64 = n.parse().map_err(|_| format!("无效相对时间: -{}", s))?;
        Ok(now - chrono::Duration::weeks(weeks))
    } else if let Some(n) = s.strip_suffix('m') {
        let mins: i64 = n.parse().map_err(|_| format!("无效相对时间: -{}", s))?;
        Ok(now - chrono::Duration::minutes(mins))
    } else {
        Err(format!("不支持的相对时间格式: -{}", s))
    }
}

/// Write a CSV chunk to the writer, skipping repeated headers.
/// Returns the number of data rows written.
fn write_csv_chunk(
    writer: &mut impl Write,
    csv_text: &str,
    header_written: &mut bool,
) -> std::io::Result<u64> {
    // InfluxDB CSV always includes metadata columns like `result` and `table`.
    // We strip those columns (and a possible leading empty column) from the downloaded file.
    let mut cleaned = String::new();
    for line in csv_text.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        cleaned.push_str(t);
        cleaned.push('\n');
    }

    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_reader(cleaned.as_bytes());

    let mut wtr = csv::WriterBuilder::new()
        .has_headers(false)
        .from_writer(writer);

    let mut header_record: Option<csv::StringRecord> = None;
    let mut keep_idxs: Vec<usize> = vec![];
    let mut count = 0u64;

    for rec in rdr.records() {
        let rec = rec?;
        if header_record.is_none() {
            header_record = Some(rec.clone());
            keep_idxs = build_keep_indices(&rec);
            if !*header_written {
                let out: Vec<&str> = keep_idxs
                    .iter()
                    .filter_map(|&i| rec.get(i))
                    .collect();
                wtr.write_record(out)?;
                *header_written = true;
            }
            continue;
        }

        // Repeated header from another table
        if header_record.as_ref() == Some(&rec) {
            keep_idxs = build_keep_indices(&rec);
            continue;
        }

        let out: Vec<&str> = keep_idxs.iter().filter_map(|&i| rec.get(i)).collect();
        if out.iter().all(|v| v.is_empty()) {
            continue;
        }
        wtr.write_record(out)?;
        count += 1;
    }

    wtr.flush()?;
    Ok(count)
}

fn build_keep_indices(header: &csv::StringRecord) -> Vec<usize> {
    let mut keep = Vec::new();
    for (i, name) in header.iter().enumerate() {
        let n = name.trim();
        if n.is_empty() {
            // Influx sometimes prefixes an empty column before "result".
            continue;
        }
        if n == "result" || n == "table" {
            continue;
        }
        keep.push(i);
    }
    keep
}
