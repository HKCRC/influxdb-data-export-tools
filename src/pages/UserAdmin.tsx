import { useEffect, useState } from "react";
import { PlusIcon, SaveIcon, Trash2Icon, UserPlusIcon, XIcon } from "lucide-react";
import {
  ChildUserInput,
  createUser,
  deleteUser,
  listUsers,
  updateUser,
} from "../api";
import type { AuthUser, QueryPermission } from "../types";

interface PermissionDraft extends QueryPermission {
  id: string;
}

interface FormState {
  id: string | null;
  username: string;
  password: string;
  maxRecordsPerSec: number;
  permissions: PermissionDraft[];
}

const EMPTY_FORM: FormState = {
  id: null,
  username: "",
  password: "",
  maxRecordsPerSec: 3000,
  permissions: [{ id: "1", bucket: "craner", measurement: "craner-data", topic: "" }],
};

let permissionId = 1;

export default function UserAdmin() {
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setUsers(await listUsers());
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const resetForm = () => {
    permissionId += 1;
    setForm({
      ...EMPTY_FORM,
      permissions: [{ id: String(permissionId), bucket: "craner", measurement: "craner-data", topic: "" }],
    });
  };

  const editUser = (user: AuthUser) => {
    setForm({
      id: user.id,
      username: user.username,
      password: "",
      maxRecordsPerSec: user.maxRecordsPerSec,
      permissions: user.permissions.map((permission) => ({
        ...permission,
        topic: permission.topic ?? "",
        id: String(++permissionId),
      })),
    });
  };

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const input: ChildUserInput = {
        username: form.username,
        password: form.password || undefined,
        maxRecordsPerSec: form.maxRecordsPerSec,
        permissions: normalizePermissions(form.permissions),
      };
      if (form.id) {
        await updateUser(form.id, input);
      } else {
        await createUser({ ...input, password: form.password });
      }
      resetForm();
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (user: AuthUser) => {
    if (!window.confirm(`确认删除子用户 ${user.username}？`)) return;
    setError("");
    try {
      await deleteUser(user.id);
      if (form.id === user.id) resetForm();
      await load();
    } catch (err) {
      setError(String(err));
    }
  };

  const updatePermission = (id: string, field: keyof QueryPermission, value: string) => {
    setForm((prev) => ({
      ...prev,
      permissions: prev.permissions.map((permission) =>
        permission.id === id ? { ...permission, [field]: value } : permission,
      ),
    }));
  };

  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="max-w-5xl">
        <div className="flex items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="text-lg font-semibold text-slate-100">用户管理</h1>
            <p className="text-sm text-slate-400">
              管理子用户、查询范围和每秒下载条数上限
            </p>
          </div>
          <button
            onClick={resetForm}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm"
          >
            <UserPlusIcon size={14} />
            新建子用户
          </button>
        </div>

        {error && (
          <div className="mb-4 text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg p-3">
            {error}
          </div>
        )}

        <div className="grid grid-cols-[280px_1fr] gap-4">
          <div className="bg-[#161b27] border border-slate-700/50 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-700/30 text-xs font-semibold text-slate-400 uppercase tracking-wider">
              子用户
            </div>
            <div className="divide-y divide-slate-700/30">
              {loading ? (
                <div className="p-4 text-sm text-slate-500">加载中...</div>
              ) : users.length === 0 ? (
                <div className="p-4 text-sm text-slate-500">暂无子用户</div>
              ) : (
                users.map((user) => (
                  <button
                    key={user.id}
                    onClick={() => editUser(user)}
                    className={`w-full text-left px-4 py-3 hover:bg-slate-800/60 transition-colors ${
                      form.id === user.id ? "bg-blue-500/10" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm text-slate-200">{user.username}</span>
                      <span className="text-xs text-slate-500">
                        {user.maxRecordsPerSec}/s
                      </span>
                    </div>
                    <div className="text-xs text-slate-500 mt-1">
                      {user.permissions.length} 条权限
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="bg-[#161b27] border border-slate-700/50 rounded-xl p-6 space-y-5">
            <div className="grid grid-cols-3 gap-4">
              <Field label="用户名">
                <input
                  value={form.username}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, username: event.target.value }))
                  }
                  className="w-full bg-[#0f1117] border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
                />
              </Field>
              <Field label={form.id ? "新密码（留空不改）" : "密码"}>
                <input
                  type="password"
                  value={form.password}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, password: event.target.value }))
                  }
                  className="w-full bg-[#0f1117] border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
                />
              </Field>
              <Field label="每秒下载条数上限">
                <input
                  type="number"
                  min={100}
                  max={5000}
                  step={100}
                  value={form.maxRecordsPerSec}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      maxRecordsPerSec: Number(event.target.value),
                    }))
                  }
                  className="w-full bg-[#0f1117] border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
                />
              </Field>
            </div>

            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">
                  查询权限
                </h2>
                <button
                  onClick={() =>
                    setForm((prev) => ({
                      ...prev,
                      permissions: [
                        ...prev.permissions,
                        {
                          id: String(++permissionId),
                          bucket: "craner",
                          measurement: "craner-data",
                          topic: "",
                        },
                      ],
                    }))
                  }
                  className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300"
                >
                  <PlusIcon size={13} />
                  添加权限
                </button>
              </div>

              <div className="space-y-2">
                {form.permissions.map((permission) => (
                  <div key={permission.id} className="grid grid-cols-[1fr_1fr_1fr_32px] gap-2">
                    <input
                      value={permission.bucket}
                      onChange={(event) =>
                        updatePermission(permission.id, "bucket", event.target.value)
                      }
                      placeholder="bucket，如 craner"
                      className="bg-[#0f1117] border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
                    />
                    <input
                      value={permission.measurement}
                      onChange={(event) =>
                        updatePermission(permission.id, "measurement", event.target.value)
                      }
                      placeholder="measurement，如 craner-data"
                      className="bg-[#0f1117] border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
                    />
                    <input
                      value={permission.topic ?? ""}
                      onChange={(event) =>
                        updatePermission(permission.id, "topic", event.target.value)
                      }
                      placeholder="topic，留空表示全部"
                      className="bg-[#0f1117] border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
                    />
                    <button
                      onClick={() =>
                        setForm((prev) => ({
                          ...prev,
                          permissions: prev.permissions.filter(
                            (item) => item.id !== permission.id,
                          ),
                        }))
                      }
                      className="flex items-center justify-center text-slate-600 hover:text-red-400"
                      title="删除权限"
                    >
                      <XIcon size={15} />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={save}
                disabled={saving}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium disabled:opacity-50"
              >
                <SaveIcon size={14} />
                {saving ? "保存中..." : form.id ? "保存修改" : "创建子用户"}
              </button>
              {form.id && (
                <button
                  onClick={() => {
                    const current = users.find((user) => user.id === form.id);
                    if (current) void remove(current);
                  }}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-600/80 hover:bg-red-500 text-white text-sm font-medium"
                >
                  <Trash2Icon size={14} />
                  删除
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function normalizePermissions(permissions: PermissionDraft[]): QueryPermission[] {
  return permissions
    .map((permission) => ({
      bucket: permission.bucket.trim(),
      measurement: permission.measurement.trim(),
      topic: permission.topic?.trim() || undefined,
    }))
    .filter((permission) => permission.bucket && permission.measurement);
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
