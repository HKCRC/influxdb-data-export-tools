import { FormEvent, useState } from "react";
import { DatabaseIcon, LogInIcon } from "lucide-react";
import { login } from "../api";
import type { AuthUser } from "../types";

interface Props {
  onLogin: (user: AuthUser) => void;
}

export default function Login({ onLogin }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      onLogin(await login(username, password));
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-screen bg-[#0f1117] text-slate-200 flex items-center justify-center p-6">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm bg-[#161b27] border border-slate-700/50 rounded-xl p-6 space-y-5"
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-blue-500/15 text-blue-400 flex items-center justify-center">
            <DatabaseIcon size={20} />
          </div>
          <div>
            <h1 className="text-base font-semibold text-slate-100">
              Craner Data Inspector
            </h1>
            <p className="text-xs text-slate-500">请登录后继续</p>
          </div>
        </div>

        <div className="space-y-3">
          <Field label="用户名">
            <input
              autoFocus
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className="w-full bg-[#0f1117] border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
            />
          </Field>
          <Field label="密码">
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full bg-[#0f1117] border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
            />
          </Field>
        </div>

        {error && (
          <div className="text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg p-3">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !username || !password}
          className="w-full flex items-center justify-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <LogInIcon size={15} />
          {loading ? "登录中..." : "登录"}
        </button>
      </form>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-slate-300 mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}
