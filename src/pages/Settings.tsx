import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { InfluxConfig } from "../types";
import { CheckCircleIcon, XCircleIcon, WifiIcon, SaveIcon } from "lucide-react";

interface Props {
  config: InfluxConfig;
  onSave: (config: InfluxConfig) => Promise<void>;
}

export default function Settings({ config, onSave }: Props) {
  const [form, setForm] = useState<InfluxConfig>({ ...config });
  const [testStatus, setTestStatus] = useState<
    "idle" | "testing" | "ok" | "err"
  >("idle");
  const [testMessage, setTestMessage] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved">("idle");

  const update = (k: keyof InfluxConfig, v: string) =>
    setForm((prev) => ({ ...prev, [k]: v }));

  const handleTest = async () => {
    setTestStatus("testing");
    setTestMessage("");
    try {
      const msg = await invoke<string>("test_connection", { config: form });
      setTestStatus("ok");
      setTestMessage(msg);
    } catch (e) {
      setTestStatus("err");
      setTestMessage(String(e));
    }
  };

  const handleSave = async () => {
    await onSave(form);
    setSaveStatus("saved");
    setTimeout(() => setSaveStatus("idle"), 2000);
  };

  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="max-w-xl">
        <h1 className="text-lg font-semibold text-slate-100 mb-1">设置</h1>
        <p className="text-sm text-slate-400 mb-6">配置 InfluxDB 连接参数</p>

        <div className="bg-[#161b27] border border-slate-700/50 rounded-xl p-6 space-y-5">
          <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">
            InfluxDB 连接
          </h2>

          <Field label="URL" hint="例如 http://192.168.1.100:8086">
            <Input
              type="url"
              value={form.url}
              onChange={(v) => update("url", v)}
              placeholder="http://localhost:8086"
            />
          </Field>

          <Field label="Token" hint="InfluxDB API Token（具有读权限）">
            <Input
              type="password"
              value={form.token}
              onChange={(v) => update("token", v)}
              placeholder="your-api-token"
            />
          </Field>

          <Field label="Organization" hint="InfluxDB 组织名称">
            <Input
              type="text"
              value={form.org}
              onChange={(v) => update("org", v)}
              placeholder="my-org"
            />
          </Field>

          {/* Test result banner */}
          {testStatus !== "idle" && testStatus !== "testing" && (
            <div
              className={`flex items-start gap-2 p-3 rounded-lg text-sm ${
                testStatus === "ok"
                  ? "bg-emerald-500/10 border border-emerald-500/30 text-emerald-300"
                  : "bg-red-500/10 border border-red-500/30 text-red-300"
              }`}
            >
              {testStatus === "ok" ? (
                <CheckCircleIcon size={16} className="mt-0.5 shrink-0" />
              ) : (
                <XCircleIcon size={16} className="mt-0.5 shrink-0" />
              )}
              <span className="break-all">{testMessage}</span>
            </div>
          )}

          <div className="flex gap-3 pt-1">
            <button
              onClick={handleTest}
              disabled={testStatus === "testing"}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm font-medium disabled:opacity-50 transition-colors"
            >
              <WifiIcon size={14} />
              {testStatus === "testing" ? "测试中..." : "测试连接"}
            </button>
            <button
              onClick={handleSave}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors"
            >
              <SaveIcon size={14} />
              {saveStatus === "saved" ? "已保存 ✓" : "保存"}
            </button>
          </div>
        </div>

        <div className="mt-6 bg-[#161b27] border border-slate-700/50 rounded-xl p-6 space-y-3">
          <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">
            关于
          </h2>
          <p className="text-sm text-slate-400">InfluxDB 数据查询工具 v0.1.0</p>
          <p className="text-xs text-slate-500">
            支持 InfluxDB v2.x / Flux 查询语言
          </p>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-300 mb-1">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-slate-500 mt-1">{hint}</p>}
    </div>
  );
}

function Input({
  type,
  value,
  onChange,
  placeholder,
}: {
  type: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full bg-[#0f1117] border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors"
    />
  );
}
