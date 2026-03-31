import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { message } from "@tauri-apps/plugin-dialog";
import {
  PlusIcon,
  XIcon,
  DownloadIcon,
  StopCircleIcon,
  RefreshCwIcon,
  TableIcon,
  ChevronDownIcon,
  AlertCircleIcon,
} from "lucide-react";
import {
  InfluxConfig,
  FilterCondition,
  QueryParams,
  DownloadConfig,
  ProgressPayload,
  PreviewResult,
  PreviewDebugResult,
  TimeRange,
  RELATIVE_OPTIONS,
  DEFAULT_DOWNLOAD_CONFIG,
} from "../types";

interface Props {
  config: InfluxConfig;
  onNeedSettings: () => void;
}

let filterIdCounter = 0;

export default function Dashboard({ config, onNeedSettings }: Props) {
  const [buckets, setBuckets] = useState<string[]>([]);
  const [selectedBucket, setSelectedBucket] = useState("");
  const [measurements, setMeasurements] = useState<string[]>([]);
  const [selectedMeasurement, setSelectedMeasurement] = useState("");
  const [tagKeys, setTagKeys] = useState<string[]>([]);
  const [filters, setFilters] = useState<FilterCondition[]>([]);
  const [tagValuesCache, setTagValuesCache] = useState<
    Record<string, string[]>
  >({});
  const [timeRange, setTimeRange] = useState<TimeRange>({
    mode: "relative",
    relative: "-1h",
    start: "",
    stop: "",
  });
  const [previewData, setPreviewData] = useState<PreviewResult | null>(null);
  const [previewDebug, setPreviewDebug] = useState<PreviewDebugResult | null>(
    null,
  );
  const [showPreview, setShowPreview] = useState(false);
  const [downloadConfig, setDownloadConfig] = useState<DownloadConfig>(
    DEFAULT_DOWNLOAD_CONFIG,
  );
  const [progress, setProgress] = useState<ProgressPayload | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const unlistenRef = useRef<UnlistenFn | null>(null);

  const configValid = config.url && config.token && config.org;

  const setLoadingKey = (key: string, val: boolean) =>
    setLoading((prev) => ({ ...prev, [key]: val }));

  // Load buckets when config changes
  useEffect(() => {
    if (!configValid) return;
    setLoadingKey("buckets", true);
    setError("");
    invoke<string[]>("get_buckets", { config })
      .then((b) => {
        setBuckets(b);
        setSelectedBucket("");
        setSelectedMeasurement("");
        setFilters([]);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoadingKey("buckets", false));
  }, [config.url, config.token, config.org]);

  // Load measurements when bucket changes
  useEffect(() => {
    if (!selectedBucket) return;
    setLoadingKey("measurements", true);
    setSelectedMeasurement("");
    setFilters([]);
    setTagKeys([]);
    invoke<string[]>("get_measurements", { config, bucket: selectedBucket })
      .then(setMeasurements)
      .catch((e) => setError(String(e)))
      .finally(() => setLoadingKey("measurements", false));
  }, [selectedBucket]);

  // Load tag keys when measurement changes
  useEffect(() => {
    if (!selectedBucket || !selectedMeasurement) return;
    setLoadingKey("tagkeys", true);
    setFilters([]);
    setTagValuesCache({});
    invoke<string[]>("get_tag_keys", {
      config,
      bucket: selectedBucket,
      measurement: selectedMeasurement,
    })
      .then(setTagKeys)
      .catch((e) => setError(String(e)))
      .finally(() => setLoadingKey("tagkeys", false));
  }, [selectedMeasurement]);

  const loadTagValues = useCallback(
    async (
      tagKey: string,
      existingFilters: FilterCondition[],
      cacheKey: string,
    ) => {
      if (tagValuesCache[cacheKey]) return;
      try {
        const vals = await invoke<string[]>("get_tag_values", {
          config,
          bucket: selectedBucket,
          measurement: selectedMeasurement,
          tag: tagKey,
          filters: existingFilters
            .filter((f) => f.key && f.value)
            .map((f) => ({ key: f.key, value: f.value })),
        });
        setTagValuesCache((prev) => ({ ...prev, [cacheKey]: vals }));
      } catch (e) {
        setError(String(e));
      }
    },
    [config, selectedBucket, selectedMeasurement, tagValuesCache],
  );

  const addFilter = () => {
    const id = String(++filterIdCounter);
    setFilters((prev) => [...prev, { id, key: "", value: "" }]);
  };

  const removeFilter = (id: string) => {
    setFilters((prev) => prev.filter((f) => f.id !== id));
  };

  const updateFilter = (id: string, field: "key" | "value", val: string) => {
    setFilters((prev) =>
      prev.map((f) => {
        if (f.id !== id) return f;
        if (field === "key") return { ...f, key: val, value: "" };
        return { ...f, [field]: val };
      }),
    );
    if (field === "key" && val) {
      const idx = filters.findIndex((f) => f.id === id);
      const prevFilters = filters.slice(0, idx);
      const cacheKey = `${val}__${prevFilters.map((f) => `${f.key}=${f.value}`).join("&")}`;
      loadTagValues(val, prevFilters, cacheKey);
    }
  };

  const buildQueryParams = (): QueryParams => {
    const start =
      timeRange.mode === "relative" ? timeRange.relative : timeRange.start;
    const stop =
      timeRange.mode === "relative" ? "now()" : timeRange.stop || "now()";
    return {
      bucket: selectedBucket,
      measurement: selectedMeasurement,
      filters: filters
        .filter((f) => f.key && f.value)
        .map((f) => ({ key: f.key, value: f.value })),
      start,
      stop,
    };
  };

  const handlePreview = async () => {
    if (!selectedBucket || !selectedMeasurement) return;
    setLoadingKey("preview", true);
    setError("");
    setShowPreview(true);
    setPreviewDebug(null);
    try {
      const result = await invoke<PreviewResult>("preview_query", {
        config,
        params: buildQueryParams(),
      });
      setPreviewData(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingKey("preview", false);
    }
  };

  // const handlePreviewDebug = async () => {
  //   if (!selectedBucket || !selectedMeasurement) return;
  //   setLoadingKey("previewDebug", true);
  //   setError("");
  //   setShowPreview(true);
  //   try {
  //     const result = await invoke<PreviewDebugResult>("preview_query_debug", {
  //       config,
  //       params: buildQueryParams(),
  //     });
  //     setPreviewDebug(result);
  //   } catch (e) {
  //     setError(String(e));
  //   } finally {
  //     setLoadingKey("previewDebug", false);
  //   }
  // };

  const handleDownload = async () => {
    if (!selectedBucket || !selectedMeasurement) return;
    const ext = downloadConfig.format === "xlsx_by_day" ? "xlsx" : "csv";
    const filePath = await save({
      defaultPath: `data_${Date.now()}.${ext}`,
      filters:
        downloadConfig.format === "xlsx_by_day"
          ? [{ name: "Excel 文件", extensions: ["xlsx"] }]
          : [{ name: "CSV 文件", extensions: ["csv"] }],
    });
    if (!filePath) return;

    setIsDownloading(true);
    setProgress(null);
    setError("");

    // Set up progress listener
    unlistenRef.current = await listen<ProgressPayload>(
      "download-progress",
      (event) => {
        setProgress(event.payload);
        if (
          event.payload.status === "completed" ||
          event.payload.status === "cancelled" ||
          event.payload.status === "error"
        ) {
          setIsDownloading(false);
          const title =
            event.payload.status === "completed"
              ? "下载完成"
              : event.payload.status === "cancelled"
                ? "已终止"
                : "下载失败";
          void message(event.payload.message, { title, kind: "info" });
        }
      },
    );

    try {
      await invoke("start_download", {
        config,
        params: buildQueryParams(),
        filePath,
        downloadConfig,
      });
    } catch (e) {
      setError(String(e));
      setIsDownloading(false);
    } finally {
      unlistenRef.current?.();
      unlistenRef.current = null;
    }
  };

  const handleCancel = async () => {
    await invoke("cancel_download");
  };

  const canQuery = configValid && selectedBucket && selectedMeasurement;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-slate-700/50 shrink-0">
        <h1 className="text-base font-semibold text-slate-100">数据查询</h1>
        {!configValid && (
          <button
            onClick={onNeedSettings}
            className="flex items-center gap-1.5 text-xs text-amber-400 hover:text-amber-300 bg-amber-400/10 border border-amber-400/20 px-2.5 py-1 rounded-lg"
          >
            <AlertCircleIcon size={12} />
            请先配置 InfluxDB 连接
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Query Builder Card */}
        <div className="m-4 bg-[#161b27] border border-slate-700/50 rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-700/30 flex items-center gap-2">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Query Builder
            </span>
          </div>

          <div className="p-5 space-y-3">
            {/* FROM row */}
            <div className="flex items-center gap-3">
              <span className="w-28 text-xs font-semibold text-slate-400 uppercase tracking-wider shrink-0">
                FROM
              </span>
              <div className="relative">
                <SelectBox
                  value={selectedBucket}
                  options={buckets}
                  placeholder="选择 bucket..."
                  loading={loading["buckets"]}
                  onChange={setSelectedBucket}
                />
              </div>
              {selectedBucket && (
                <button
                  onClick={() => {
                    setLoadingKey("buckets", true);
                    invoke<string[]>("get_buckets", { config })
                      .then(setBuckets)
                      .catch((e) => setError(String(e)))
                      .finally(() => setLoadingKey("buckets", false));
                  }}
                  className="text-slate-500 hover:text-slate-300 transition-colors"
                  title="刷新"
                >
                  <RefreshCwIcon size={13} />
                </button>
              )}
            </div>

            {/* FILTER _measurement row */}
            <div className="flex items-center gap-3">
              <span className="w-28 text-xs font-semibold text-slate-400 uppercase tracking-wider shrink-0">
                FILTER
              </span>
              <span className="text-xs text-slate-500">_measurement ==</span>
              <SelectBox
                value={selectedMeasurement}
                options={measurements}
                placeholder="选择 measurement..."
                loading={loading["measurements"]}
                onChange={setSelectedMeasurement}
                disabled={!selectedBucket}
              />
            </div>

            {/* Dynamic tag filters */}
            {filters.map((filter, idx) => {
              const cacheKey = filter.key
                ? `${filter.key}__${filters
                    .slice(0, idx)
                    .filter((f) => f.key && f.value)
                    .map((f) => `${f.key}=${f.value}`)
                    .join("&")}`
                : "";
              const tagValues = tagValuesCache[cacheKey] || [];

              return (
                <div key={filter.id} className="flex items-center gap-3">
                  <span className="w-28 text-xs font-semibold text-blue-400/70 uppercase tracking-wider shrink-0">
                    AND
                  </span>
                  <SelectBox
                    value={filter.key}
                    options={tagKeys.filter(
                      (k) =>
                        k === filter.key ||
                        !filters.some((f) => f.id !== filter.id && f.key === k),
                    )}
                    placeholder="选择 tag..."
                    loading={loading["tagkeys"]}
                    onChange={(v) => updateFilter(filter.id, "key", v)}
                    disabled={!selectedMeasurement}
                  />
                  <span className="text-xs text-slate-500">==</span>
                  <SelectBox
                    value={filter.value}
                    options={tagValues}
                    placeholder="选择值..."
                    loading={false}
                    onChange={(v) => updateFilter(filter.id, "value", v)}
                    disabled={!filter.key}
                  />
                  <button
                    onClick={() => removeFilter(filter.id)}
                    className="text-slate-600 hover:text-red-400 transition-colors shrink-0"
                  >
                    <XIcon size={14} />
                  </button>
                </div>
              );
            })}

            {/* Add filter button */}
            {selectedMeasurement && tagKeys.length > 0 && (
              <div className="flex items-center gap-3">
                <span className="w-28" />
                <button
                  onClick={addFilter}
                  className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                >
                  <PlusIcon size={13} />
                  添加过滤条件
                </button>
              </div>
            )}

            {/* Time range */}
            <div className="flex items-center gap-3 pt-1">
              <span className="w-28 text-xs font-semibold text-slate-400 uppercase tracking-wider shrink-0">
                TIME RANGE
              </span>
              <div className="flex items-center gap-2 flex-wrap">
                <div className="flex rounded-lg overflow-hidden border border-slate-600">
                  <button
                    onClick={() =>
                      setTimeRange((t) => ({ ...t, mode: "relative" }))
                    }
                    className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                      timeRange.mode === "relative"
                        ? "bg-blue-600 text-white"
                        : "text-slate-400 hover:text-slate-300 bg-transparent"
                    }`}
                  >
                    相对时间
                  </button>
                  <button
                    onClick={() =>
                      setTimeRange((t) => ({ ...t, mode: "absolute" }))
                    }
                    className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                      timeRange.mode === "absolute"
                        ? "bg-blue-600 text-white"
                        : "text-slate-400 hover:text-slate-300 bg-transparent"
                    }`}
                  >
                    绝对时间
                  </button>
                </div>

                {timeRange.mode === "relative" ? (
                  <select
                    value={timeRange.relative}
                    onChange={(e) =>
                      setTimeRange((t) => ({ ...t, relative: e.target.value }))
                    }
                    className="bg-[#0f1117] border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
                  >
                    {RELATIVE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="flex items-center gap-2">
                    <input
                      type="datetime-local"
                      value={timeRange.start}
                      onChange={(e) =>
                        setTimeRange((t) => ({ ...t, start: e.target.value }))
                      }
                      className="bg-[#0f1117] border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
                    />
                    <span className="text-slate-500 text-xs">至</span>
                    <input
                      type="datetime-local"
                      value={timeRange.stop}
                      onChange={(e) =>
                        setTimeRange((t) => ({ ...t, stop: e.target.value }))
                      }
                      className="bg-[#0f1117] border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Action buttons */}
        <div className="mx-4 flex items-center gap-3">
          <button
            onClick={handlePreview}
            disabled={!canQuery || !!loading["preview"]}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <TableIcon size={14} />
            {loading["preview"] ? "加载中..." : "预览数据 (前100条)"}
          </button>

          {/* <button
            onClick={handlePreviewDebug}
            disabled={!canQuery || !!loading["previewDebug"]}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title="显示实际发送的 Flux + 原始 CSV 前几行"
          >
            <span className="text-xs font-mono">Debug</span>
          </button> */}

          {!isDownloading ? (
            <button
              onClick={handleDownload}
              disabled={!canQuery}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <DownloadIcon size={14} />
              开始下载
            </button>
          ) : (
            <button
              onClick={handleCancel}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-600/80 hover:bg-red-500 text-white text-sm font-medium transition-colors"
            >
              <StopCircleIcon size={14} />
              终止任务
            </button>
          )}
        </div>

        {/* Error message */}
        {error && (
          <div className="mx-4 mt-3 flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
            <AlertCircleIcon size={15} className="mt-0.5 shrink-0" />
            <span className="break-all">{error}</span>
          </div>
        )}

        {/* Download config & progress */}
        <div className="m-4 bg-[#161b27] border border-slate-700/50 rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-700/30">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              下载配置
            </span>
          </div>
          <div className="p-5">
            <div className="flex items-center gap-6 flex-wrap">
              <label className="flex items-center gap-2 text-sm text-slate-300">
                导出格式
                <select
                  value={downloadConfig.format}
                  onChange={(e) =>
                    setDownloadConfig((c) => ({
                      ...c,
                      format: e.target.value as DownloadConfig["format"],
                    }))
                  }
                  disabled={isDownloading}
                  className="bg-[#0f1117] border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <option value="csv">CSV（单表）</option>
                  <option value="xlsx_by_day">XLSX（按天分 Sheet）</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-300">
                每秒下载条数上限
                <input
                  type="number"
                  min={100}
                  max={5000}
                  step={100}
                  value={downloadConfig.records_per_sec}
                  onChange={(e) =>
                    setDownloadConfig((c) => ({
                      ...c,
                      records_per_sec: Number(e.target.value),
                    }))
                  }
                  disabled={isDownloading}
                  className="w-24 bg-[#0f1117] border border-slate-600 rounded-lg px-2 py-1 text-sm text-slate-200 text-right focus:outline-none focus:border-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
                />
                <span className="text-slate-500">条/秒</span>
              </label>
              <p className="text-xs text-slate-500">
                建议：默认 3000；生产环境通常 2000~5000 更稳（我已限制最大 5000）
              </p>
            </div>

            {/* Progress bar */}
            {progress && (
              <div className="mt-4 space-y-2">
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>
                    {progress.status === "completed" && "✅ "}
                    {progress.status === "cancelled" && "⛔ "}
                    {progress.status === "error" && "❌ "}
                    {progress.message}
                  </span>
                  <span className="font-mono">
                    {progress.percent.toFixed(1)}% ·{" "}
                    {progress.completed_chunks}/{progress.total_chunks} 块 ·{" "}
                    {progress.total_records.toLocaleString()} 条
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span>
                    预计剩余：
                    {progress.eta_seconds == null
                      ? "--"
                      : formatDuration(progress.eta_seconds)}
                  </span>
                  <span>当前状态：{progress.status}</span>
                </div>
                <div className="w-full bg-slate-700/60 rounded-full h-2 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${
                      progress.status === "completed"
                        ? "bg-emerald-500"
                        : progress.status === "cancelled"
                          ? "bg-amber-500"
                          : progress.status === "error"
                            ? "bg-red-500"
                            : "bg-blue-500"
                    }`}
                    style={{
                      width: `${Math.min(100, Math.max(0, progress.percent))}%`,
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Preview table */}
        {showPreview && (
          <div className="mx-4 mb-4 bg-[#161b27] border border-slate-700/50 rounded-xl overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-700/30 flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                数据预览
                {previewData && (
                  <span className="ml-2 text-slate-500 normal-case font-normal">
                    ({previewData.rows.length} 条)
                  </span>
                )}
              </span>
              <button
                onClick={() => setShowPreview(false)}
                className="text-slate-600 hover:text-slate-400"
              >
                <XIcon size={14} />
              </button>
            </div>
            {loading["preview"] ? (
              <div className="p-8 text-center text-slate-500 text-sm">
                加载中...
              </div>
            ) : previewData && previewData.rows.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-700/30">
                      {previewData.columns.map((col) => (
                        <th
                          key={col}
                          className="px-3 py-2 text-left font-semibold text-slate-400 whitespace-nowrap bg-slate-800/40"
                        >
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewData.rows.map((row, i) => (
                      <tr
                        key={i}
                        className="border-b border-slate-700/20 hover:bg-slate-800/30"
                      >
                        {row.map((cell, j) => (
                          <td
                            key={j}
                            className="px-3 py-1.5 text-slate-300 whitespace-nowrap font-mono"
                          >
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="p-8 text-center text-slate-500 text-sm">
                该条件下无数据
              </div>
            )}

            {previewDebug && (
              <div className="border-t border-slate-700/30 p-4 space-y-3">
                <div>
                  <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                    Debug: Flux Query
                  </div>
                  <pre className="text-xs font-mono whitespace-pre-wrap bg-[#0f1117] border border-slate-700/50 rounded-lg p-3 text-slate-200 overflow-auto max-h-64">
                    {previewDebug.query}
                  </pre>
                </div>
                <div>
                  <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                    Debug: CSV Head (first ~30 lines)
                  </div>
                  <pre className="text-xs font-mono whitespace-pre-wrap bg-[#0f1117] border border-slate-700/50 rounded-lg p-3 text-slate-200 overflow-auto max-h-64">
                    {previewDebug.csv_head}
                  </pre>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface SelectBoxProps {
  value: string;
  options: string[];
  placeholder: string;
  loading: boolean;
  onChange: (v: string) => void;
  disabled?: boolean;
}

function SelectBox({
  value,
  options,
  placeholder,
  loading,
  onChange,
  disabled,
}: SelectBoxProps) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || loading}
        className="appearance-none min-w-[180px] bg-[#0f1117] border border-slate-600 rounded-lg pl-3 pr-8 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
      >
        <option value="">{loading ? "加载中..." : placeholder}</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
      <ChevronDownIcon
        size={12}
        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none"
      />
    </div>
  );
}

function formatDuration(totalSeconds: number) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s`;
  return `${m}m ${String(sec).padStart(2, "0")}s`;
}
