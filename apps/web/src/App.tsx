import { Button, Drawer, toast } from "@heroui/react";
import {
  IconArrowsExchange,
  IconChevronDown,
  IconCreditCard,
  IconGauge,
  IconLogout,
  IconMenu2,
  IconMoon,
  IconNetwork,
  IconServer,
  IconSettings,
  IconSun,
  IconUserCircle,
  IconUsers,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { api, setUnauthorizedHandler } from "./api";
import AuditPage from "./pages/Audit";
import DashboardPage from "./pages/Dashboard";
import LoginPage from "./pages/Login";
import NodesPage from "./pages/Nodes";
import PackagesPage from "./pages/Packages";
import ProfilePage from "./pages/Profile";
import RulesPage from "./pages/Rules";
import SettingsPage from "./pages/Settings";
import TunnelsPage from "./pages/Tunnels";
import UsersPage from "./pages/Users";
import { useTheme } from "./theme";
import { cn } from "./ui";

const NAV_ITEMS = [
  { to: "/", label: "控制台", icon: <IconGauge size={18} stroke={1.7} /> },
  { to: "/nodes", label: "节点", icon: <IconServer size={18} stroke={1.7} /> },
  { to: "/tunnels", label: "隧道", icon: <IconNetwork size={18} stroke={1.7} /> },
  { to: "/rules", label: "转发规则", icon: <IconArrowsExchange size={18} stroke={1.7} /> },
  { to: "/users", label: "用户", icon: <IconUsers size={18} stroke={1.7} /> },
  { to: "/packages", label: "套餐", icon: <IconCreditCard size={18} stroke={1.7} /> },
];

const SETTINGS_ITEMS = [
  { to: "/settings/tls", label: "链路 TLS" },
  { to: "/settings/basic", label: "基础设置" },
  { to: "/settings/notification", label: "通知设置" },
  { to: "/settings/announcement", label: "公告设置" },
  { to: "/settings/site", label: "站点设置" },
  { to: "/settings/audit", label: "操作审计" },
];

const PROFILE_ITEM = { to: "/profile", label: "个人中心", icon: <IconUserCircle size={18} stroke={1.7} /> };

const PAGE_TITLES: Record<string, string> = {
  "/": "控制台",
  "/nodes": "节点管理",
  "/tunnels": "隧道管理",
  "/rules": "转发规则",
  "/users": "用户管理",
  "/packages": "套餐管理",
  "/settings/tls": "链路 TLS",
  "/settings/basic": "基础设置",
  "/settings/notification": "通知设置",
  "/settings/announcement": "公告设置",
  "/settings/site": "站点设置",
  "/settings/audit": "操作审计",
  "/profile": "个人中心",
};

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-accent text-sm font-bold text-accent-foreground">
        T
      </div>
      <span className="font-semibold">TYZ 控制台</span>
    </div>
  );
}

function ThemeToggle({ isDark, onToggle }: { isDark: boolean; onToggle: () => void }) {
  return (
    <Button isIconOnly variant="ghost" size="sm" aria-label="切换主题" onPress={onToggle}>
      {isDark ? <IconSun size={18} stroke={1.7} /> : <IconMoon size={18} stroke={1.7} />}
    </Button>
  );
}

function NavLink({
  to,
  label,
  icon,
  active,
  small,
  onNavigate,
}: {
  to: string;
  label: string;
  icon?: React.ReactNode;
  active: boolean;
  small?: boolean;
  onNavigate?: () => void;
}) {
  const navigate = useNavigate();
  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn(
        "w-full justify-start gap-2.5 font-normal",
        small ? "h-8 pl-8" : "h-9",
        active && "bg-accent-soft font-medium text-accent-soft-foreground",
      )}
      onPress={() => {
        navigate(to);
        onNavigate?.();
      }}
    >
      {icon}
      {label}
    </Button>
  );
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const location = useLocation();
  const settingsActive = location.pathname.startsWith("/settings");
  const [settingsOpen, setSettingsOpen] = useState(settingsActive);
  const open = settingsOpen || settingsActive;

  return (
    <nav className="flex flex-col gap-1">
      {NAV_ITEMS.map(({ to, label, icon }) => (
        <NavLink
          key={to}
          to={to}
          label={label}
          icon={icon}
          active={to === "/" ? location.pathname === "/" : location.pathname.startsWith(to)}
          onNavigate={onNavigate}
        />
      ))}

      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        className={cn(
          "h-9 w-full justify-start gap-2.5 font-normal",
          settingsActive && "bg-accent-soft font-medium text-accent-soft-foreground",
        )}
        onPress={() => setSettingsOpen((v) => !v)}
      >
        <IconSettings size={18} stroke={1.7} />
        系统设置
        <IconChevronDown size={16} stroke={1.7} className={cn("ml-auto transition-transform", open && "rotate-180")} />
      </Button>
      {open && (
        <div className="flex flex-col gap-0.5">
          {SETTINGS_ITEMS.map(({ to, label }) => (
            <NavLink key={to} to={to} label={label} small active={location.pathname === to} onNavigate={onNavigate} />
          ))}
        </div>
      )}

      <NavLink
        to={PROFILE_ITEM.to}
        label={PROFILE_ITEM.label}
        icon={PROFILE_ITEM.icon}
        active={location.pathname.startsWith("/profile")}
        onNavigate={onNavigate}
      />
    </nav>
  );
}

function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { theme, toggle } = useTheme();
  const [navOpen, setNavOpen] = useState(false);
  const meQuery = useQuery({ queryKey: ["me"], queryFn: api.me });

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      navigate("/login");
      toast("已退出");
    }
  }, [navigate]);

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-border bg-background px-4 md:ml-56">
        <Button
          isIconOnly
          variant="ghost"
          size="sm"
          aria-label="打开导航"
          className="md:hidden"
          onPress={() => setNavOpen(true)}
        >
          <IconMenu2 size={18} stroke={1.7} />
        </Button>
        <span className="md:hidden">
          <Brand />
        </span>
        <h1 className="hidden text-sm font-medium text-muted md:block">{PAGE_TITLES[location.pathname] ?? ""}</h1>

        <div className="ml-auto flex items-center gap-1">
          <ThemeToggle isDark={theme === "dark"} onToggle={toggle} />
          <Button
            variant="ghost"
            size="sm"
            className="hidden h-8 gap-1.5 px-2 text-muted sm:flex"
            onPress={() => navigate("/profile")}
          >
            <IconUserCircle size={16} stroke={1.7} />
            {meQuery.data?.username ?? "…"}
          </Button>
          <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2 text-muted" onPress={logout}>
            <IconLogout size={16} stroke={1.7} />
            <span className="hidden sm:inline">退出登录</span>
          </Button>
        </div>
      </header>

      <aside className="fixed inset-y-0 left-0 z-30 hidden w-56 flex-col justify-between overflow-y-auto border-r border-border px-3 py-4 md:flex">
        <div className="flex flex-col gap-6">
          <div className="px-2">
            <Brand />
          </div>
          <SidebarNav />
        </div>
        <p className="px-3 pb-1 text-xs text-muted">GOST 隧道管理平台</p>
      </aside>

      <Drawer.Backdrop isOpen={navOpen} onOpenChange={setNavOpen}>
        <Drawer.Content placement="left" className="w-60">
          <Drawer.Dialog aria-label="导航菜单">
            <Drawer.CloseTrigger />
            <Drawer.Header>
              <Drawer.Heading>
                <Brand />
              </Drawer.Heading>
            </Drawer.Header>
            <Drawer.Body>
              <SidebarNav onNavigate={() => setNavOpen(false)} />
            </Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>

      <main className="md:pl-56">
        <div className="mx-auto max-w-[1200px] p-4 md:p-6">
          <Outlet />
        </div>
      </main>
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
        <Route index element={<DashboardPage />} />
        <Route path="nodes" element={<NodesPage />} />
        <Route path="tunnels" element={<TunnelsPage />} />
        <Route path="rules" element={<RulesPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="packages" element={<PackagesPage />} />
        <Route path="settings/tls" element={<SettingsPage kind="tls" />} />
        <Route path="settings/basic" element={<SettingsPage kind="basic" />} />
        <Route path="settings/notification" element={<SettingsPage kind="notification" />} />
        <Route path="settings/announcement" element={<SettingsPage kind="announcement" />} />
        <Route path="settings/site" element={<SettingsPage kind="site" />} />
        <Route path="settings/audit" element={<AuditPage />} />
        <Route path="audit" element={<Navigate to="/settings/audit" replace />} />
        <Route path="profile" element={<ProfilePage />} />
      </Route>
    </Routes>
  );
}
