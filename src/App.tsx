import { useState, useEffect } from "react";
import { DatabaseIcon, LogOutIcon, SettingsIcon, UsersIcon } from "lucide-react";
import Dashboard from "./pages/Dashboard";
import Login from "./pages/Login";
import Settings from "./pages/Settings";
import UserAdmin from "./pages/UserAdmin";
import { AuthUser, InfluxConfig, DEFAULT_CONFIG } from "./types";
import { getCurrentUser, getInfluxConfigStatus, logout } from "./api";

type Page = "dashboard" | "settings" | "users";

export default function App() {
  const [page, setPage] = useState<Page>("dashboard");
  const [config, setConfig] = useState<InfluxConfig>(DEFAULT_CONFIG);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [serverConfigReady, setServerConfigReady] = useState(false);

  useEffect(() => {
    const raw = localStorage.getItem("influx_config");
    if (!raw) return;
    try {
      setConfig(JSON.parse(raw) as InfluxConfig);
    } catch {
      localStorage.removeItem("influx_config");
    }
  }, []);

  useEffect(() => {
    getCurrentUser()
      .then(async (currentUser) => {
        setUser(currentUser);
        setServerConfigReady(await getInfluxConfigStatus().catch(() => false));
      })
      .catch(() => setUser(null))
      .finally(() => setCheckingSession(false));
  }, []);

  const handleSaveConfig = async (newConfig: InfluxConfig) => {
    localStorage.setItem("influx_config", JSON.stringify(newConfig));
    setConfig(newConfig);
  };

  const handleLogin = async (nextUser: AuthUser) => {
    setUser(nextUser);
    setServerConfigReady(await getInfluxConfigStatus().catch(() => false));
  };

  const handleLogout = async () => {
    await logout().catch(() => undefined);
    setUser(null);
    setServerConfigReady(false);
    setPage("dashboard");
  };

  if (checkingSession) {
    return (
      <div className="h-screen bg-[#0f1117] text-slate-500 flex items-center justify-center text-sm">
        加载中...
      </div>
    );
  }

  if (!user) {
    return <Login onLogin={(nextUser) => void handleLogin(nextUser)} />;
  }

  return (
    <div className="flex h-screen bg-[#0f1117] text-slate-200 overflow-hidden">
      {/* Sidebar */}
      <aside className="w-14 flex flex-col items-center py-4 gap-2 bg-[#161b27] border-r border-slate-700/50">
        <div className="w-8 h-8 mb-3 flex items-center justify-center">
          <svg
            viewBox="0 0 1024 1024"
            version="1.1"
            xmlns="http://www.w3.org/2000/svg"
            p-id="2001"
            width="256"
            height="256"
          >
            <path
              d="M533.12 498.24a77.866667 77.866667 0 0 0 52.074667-73.749333c0-6.08-0.746667-11.776-1.898667-17.493334l195.392-124.288-245.546667 424.981334v-209.450667z m-101.866667-90.837333c-1.152 5.696-1.92 11.392-1.92 17.493333a78.613333 78.613333 0 0 0 52.096 73.728v227.690667L219.136 272.448l212.117333 134.954667z m123.925334-44.096a78.997333 78.997333 0 0 0-48.277334-16.725334c-18.261333 0-34.986667 6.08-48.277333 16.725334l-205.653333-131.157334h508.608l-206.4 131.157334zM850.901333 128a78.613333 78.613333 0 0 0-73.728 52.074667H237.013333A77.866667 77.866667 0 0 0 163.264 128 78.037333 78.037333 0 0 0 85.333333 205.930667a78.037333 78.037333 0 0 0 77.930667 77.930666h2.282667l277.482666 480.853334a77.290667 77.290667 0 0 0-14.442666 45.226666 78.037333 78.037333 0 0 0 77.930666 77.930667 78.037333 78.037333 0 0 0 77.930667-77.930667c0-20.138667-7.978667-38.762667-20.544-52.458666l273.706667-474.389334c3.797333 0.768 7.978667 1.130667 12.16 1.130667a78.037333 78.037333 0 0 0 77.930666-77.909333C927.701333 163.349333 893.866667 128 850.901333 128z"
              fill="#583ACA"
              p-id="2002"
            ></path>
          </svg>
        </div>
        <NavButton
          icon={<DatabaseIcon size={18} />}
          label="查询"
          active={page === "dashboard"}
          onClick={() => setPage("dashboard")}
        />
        {user.role === "admin" && (
          <>
            <NavButton
              icon={<UsersIcon size={18} />}
              label="用户"
              active={page === "users"}
              onClick={() => setPage("users")}
            />
            <NavButton
              icon={<SettingsIcon size={18} />}
              label="设置"
              active={page === "settings"}
              onClick={() => setPage("settings")}
            />
          </>
        )}
        <div className="flex-1" />
        <NavButton
          icon={<LogOutIcon size={18} />}
          label={`退出 ${user.username}`}
          active={false}
          onClick={handleLogout}
        />
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-hidden">
        {page !== "settings" && page !== "users" ? (
          <Dashboard
            config={config}
            user={user}
            serverConfigReady={serverConfigReady}
            onNeedSettings={() => setPage("settings")}
          />
        ) : page === "users" && user.role === "admin" ? (
          <UserAdmin />
        ) : user.role === "admin" ? (
          <Settings config={config} onSave={handleSaveConfig} />
        ) : (
          <Dashboard
            config={config}
            user={user}
            serverConfigReady={serverConfigReady}
            onNeedSettings={() => undefined}
          />
        )}
      </main>
    </div>
  );
}

function NavButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${
        active
          ? "bg-blue-500/20 text-blue-400"
          : "text-slate-500 hover:text-slate-300 hover:bg-slate-700/50"
      }`}
    >
      {icon}
    </button>
  );
}
