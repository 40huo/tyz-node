import { ArrowLeftRight, LogOut, Moon, Network, Server, Sun, Waypoints } from "lucide-react";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useState } from "react";
import { Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api, setUnauthorizedHandler } from "./api";
import LoginPage from "./pages/Login";
import NodesPage from "./pages/Nodes";
import RulesPage from "./pages/Rules";
import TunnelsPage from "./pages/Tunnels";

const NAV_ITEMS = [
  { to: "/nodes", label: "节点", icon: Server },
  { to: "/tunnels", label: "隧道", icon: Network },
  { to: "/rules", label: "转发规则", icon: ArrowLeftRight },
];

const PAGE_TITLES: Record<string, string> = {
  "/nodes": "节点管理",
  "/tunnels": "隧道管理",
  "/rules": "转发规则",
};

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="切换主题"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
    >
      {mounted && resolvedTheme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}

function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();

  const logout = async () => {
    try {
      await api.logout();
    } finally {
      navigate("/login");
      toast.success("已退出");
    }
  };

  return (
    <div className="min-h-screen bg-muted/40">
      <aside className="fixed inset-y-0 left-0 z-20 flex w-60 flex-col bg-zinc-950 text-zinc-100">
        <div className="flex h-16 items-center gap-2.5 border-b border-white/10 px-5">
          <Waypoints className="size-6 text-emerald-400" />
          <span className="text-base font-semibold tracking-wide">TYZ 控制台</span>
        </div>
        <nav className="flex flex-col gap-1 p-3">
          {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  isActive ? "bg-white/10 text-white" : "text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
                }`
              }
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto px-5 py-4 text-xs text-zinc-600">GOST 隧道管理平台</div>
      </aside>
      <div className="flex min-h-screen flex-col pl-60">
        <header className="sticky top-0 z-10 flex h-16 items-center justify-between border-b bg-background/80 px-6 backdrop-blur">
          <h1 className="text-sm font-medium text-muted-foreground">{PAGE_TITLES[location.pathname] ?? ""}</h1>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <Button variant="ghost" size="sm" onClick={logout}>
              <LogOut className="size-4" />
              退出登录
            </Button>
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();

  const redirectToLogin = useCallback(() => {
    if (!location.pathname.startsWith("/login")) {
      navigate("/login");
    }
  }, [location.pathname, navigate]);
  setUnauthorizedHandler(redirectToLogin);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<AppLayout />}>
        <Route index element={<Navigate to="/nodes" replace />} />
        <Route path="nodes" element={<NodesPage />} />
        <Route path="tunnels" element={<TunnelsPage />} />
        <Route path="rules" element={<RulesPage />} />
      </Route>
    </Routes>
  );
}
