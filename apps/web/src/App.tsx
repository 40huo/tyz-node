import { Button, Drawer, Tooltip, toast } from "@heroui/react";
import {
  IconArrowsExchange,
  IconChevronDown,
  IconChevronsLeft,
  IconChevronsRight,
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
import { type ComponentProps, type ReactNode, useCallback, useState } from "react";
import { Link, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { api, setUnauthorizedHandler } from "./api";
import AuditPage from "./pages/Audit";
import DashboardPage from "./pages/Dashboard";
import LoginPage from "./pages/Login";
import NodesPage from "./pages/Nodes";
import NotFoundPage from "./pages/NotFound";
import PackagesPage from "./pages/Packages";
import ProfilePage from "./pages/Profile";
import RulesPage from "./pages/Rules";
import SettingsPage from "./pages/Settings";
import TunnelsPage from "./pages/Tunnels";
import UsersPage from "./pages/Users";
import { useTheme } from "./theme";
import { cn } from "./ui";

// ---- Navigation config（侧栏与顶栏标题的唯一来源） ----

interface NavEntry {
  to: string;
  label: string;
  icon?: ReactNode;
  /** 顶栏标题；缺省用 label。 */
  title?: string;
}

const DASHBOARD_ITEM: NavEntry = { to: "/", label: "控制台", icon: <IconGauge size={18} stroke={1.7} /> };

const BUSINESS_ITEMS: NavEntry[] = [
  { to: "/nodes", label: "节点", icon: <IconServer size={18} stroke={1.7} />, title: "节点管理" },
  { to: "/tunnels", label: "隧道", icon: <IconNetwork size={18} stroke={1.7} />, title: "隧道管理" },
  { to: "/rules", label: "转发规则", icon: <IconArrowsExchange size={18} stroke={1.7} /> },
  { to: "/users", label: "用户", icon: <IconUsers size={18} stroke={1.7} />, title: "用户管理" },
  { to: "/packages", label: "套餐", icon: <IconCreditCard size={18} stroke={1.7} />, title: "套餐管理" },
];

const SETTINGS_ITEMS: NavEntry[] = [
  { to: "/settings/tls", label: "链路 TLS" },
  { to: "/settings/basic", label: "基础设置" },
  { to: "/settings/notification", label: "通知设置" },
  { to: "/settings/announcement", label: "公告设置" },
  { to: "/settings/site", label: "站点设置" },
  { to: "/settings/audit", label: "操作审计" },
];

const PROFILE_ITEM: NavEntry = { to: "/profile", label: "个人中心", icon: <IconUserCircle size={18} stroke={1.7} /> };

const ALL_NAV_ENTRIES = [DASHBOARD_ITEM, ...BUSINESS_ITEMS, ...SETTINGS_ITEMS, PROFILE_ITEM];

function pageTitle(pathname: string): string {
  const entry = ALL_NAV_ENTRIES.find((e) => e.to === pathname);
  return entry?.title ?? entry?.label ?? "";
}

const COLLAPSED_KEY = "tyz-sidebar-collapsed";
const SIDEBAR_WIDE = "w-56";
const SIDEBAR_NARROW = "w-[68px]";

// ---- Layout pieces ----

function Brand({ collapsed }: { collapsed?: boolean }) {
  return (
    <div className={cn("flex items-center gap-2.5", collapsed && "justify-center")}>
      <div className="flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-accent text-sm font-bold text-accent-foreground">
        T
      </div>
      {!collapsed && <span className="font-semibold">TYZ 控制台</span>}
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

/**
 * 导航项按钮：HeroUI Button 的样式与按压交互落在 react-router Link 上（真实 <a>，
 * 支持中键/新标签打开）。RAC 的 render props 按 <button> 类型化，事件处理器落到
 * <a> 上类型不兼容——运行时安全，在这里收窄一次。
 */
function NavButton({
  to,
  label,
  className,
  children,
  onNavigate,
}: {
  to: string;
  label: string;
  className?: string;
  children: ReactNode;
  onNavigate?: () => void;
}) {
  return (
    <Button
      render={(props) => (
        <Link {...(props as ComponentProps<typeof Link>)} to={to} aria-label={label}>
          {children}
        </Link>
      )}
      variant="ghost"
      size="sm"
      className={className}
      onPress={onNavigate}
    />
  );
}

function NavItem({
  entry,
  active,
  collapsed,
  small,
  onNavigate,
}: {
  entry: NavEntry;
  active: boolean;
  collapsed?: boolean;
  small?: boolean;
  onNavigate?: () => void;
}) {
  const button = (
    <NavButton
      to={entry.to}
      label={entry.label}
      onNavigate={onNavigate}
      className={cn(
        "w-full gap-2.5 font-normal",
        collapsed ? "h-9 justify-center px-0" : small ? "h-8 justify-start pl-8" : "h-9 justify-start",
        active && "bg-accent-soft font-medium text-accent-soft-foreground",
      )}
    >
      {entry.icon}
      {!collapsed && <span className={cn("truncate", small && "text-sm")}>{entry.label}</span>}
    </NavButton>
  );
  if (collapsed && !small) {
    return (
      <Tooltip delay={0}>
        {button}
        <Tooltip.Content placement="right">
          <p>{entry.label}</p>
        </Tooltip.Content>
      </Tooltip>
    );
  }
  return button;
}

function GroupLabel({ children, collapsed }: { children: string; collapsed?: boolean }) {
  if (collapsed) return <div className="mx-auto h-px w-6 bg-border" aria-hidden />;
  return <p className="px-3 pb-1 text-[11px] font-medium tracking-wide text-muted">{children}</p>;
}

function SidebarNav({ collapsed, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  const location = useLocation();
  const settingsActive = location.pathname.startsWith("/settings");
  const [settingsOpen, setSettingsOpen] = useState(settingsActive);
  const open = settingsOpen || settingsActive;
  const isActive = (to: string) => (to === "/" ? location.pathname === "/" : location.pathname.startsWith(to));

  return (
    <nav className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <GroupLabel collapsed={collapsed}>概览</GroupLabel>
        <NavItem
          entry={DASHBOARD_ITEM}
          active={isActive(DASHBOARD_ITEM.to)}
          collapsed={collapsed}
          onNavigate={onNavigate}
        />
      </div>

      <div className="flex flex-col gap-1">
        <GroupLabel collapsed={collapsed}>隧道业务</GroupLabel>
        {BUSINESS_ITEMS.map((entry) => (
          <NavItem
            key={entry.to}
            entry={entry}
            active={isActive(entry.to)}
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
        ))}
      </div>

      <div className="flex flex-col gap-1">
        <GroupLabel collapsed={collapsed}>系统</GroupLabel>
        {collapsed ? (
          <Tooltip delay={0}>
            <NavButton
              to={SETTINGS_ITEMS[0].to}
              label="系统设置"
              onNavigate={onNavigate}
              className={cn(
                "h-9 w-full justify-center px-0 font-normal",
                settingsActive && "bg-accent-soft font-medium text-accent-soft-foreground",
              )}
            >
              <IconSettings size={18} stroke={1.7} />
            </NavButton>
            <Tooltip.Content placement="right">
              <p>系统设置</p>
            </Tooltip.Content>
          </Tooltip>
        ) : (
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
            <IconChevronDown
              size={16}
              stroke={1.7}
              className={cn("ml-auto transition-transform", open && "rotate-180")}
            />
          </Button>
        )}
        {open && !collapsed && (
          <div className="flex flex-col gap-0.5">
            {SETTINGS_ITEMS.map((entry) => (
              <NavItem
                key={entry.to}
                entry={entry}
                small
                active={location.pathname === entry.to}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        )}
        <NavItem
          entry={PROFILE_ITEM}
          active={isActive(PROFILE_ITEM.to)}
          collapsed={collapsed}
          onNavigate={onNavigate}
        />
      </div>
    </nav>
  );
}

function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { theme, toggle } = useTheme();
  const [navOpen, setNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === "1");
  const meQuery = useQuery({ queryKey: ["me"], queryFn: api.me });

  const toggleCollapsed = useCallback(() => {
    setCollapsed((v) => {
      localStorage.setItem(COLLAPSED_KEY, v ? "0" : "1");
      return !v;
    });
  }, []);

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
      {/* 键盘用户跳过侧栏直达主内容（聚焦前视觉隐藏） */}
      <a
        href="#main-content"
        className="sr-only rounded-md bg-surface px-3 py-2 text-sm shadow-lg focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50"
      >
        跳到主内容
      </a>
      <header
        className={cn(
          "sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-border bg-background px-4 transition-[margin]",
          collapsed ? "md:ml-[68px]" : "md:ml-56",
        )}
      >
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
        <h1 className="hidden text-sm font-medium text-muted md:block">{pageTitle(location.pathname)}</h1>

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

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-30 hidden flex-col justify-between overflow-x-hidden border-r border-border px-3 py-4 transition-[width] md:flex",
          collapsed ? SIDEBAR_NARROW : SIDEBAR_WIDE,
        )}
      >
        <div className="flex flex-col gap-6">
          <div className={cn(!collapsed && "px-2")}>
            <Brand collapsed={collapsed} />
          </div>
          <SidebarNav collapsed={collapsed} />
        </div>
        <div className={cn("flex items-center gap-2 pb-1", collapsed ? "justify-center" : "justify-between px-3")}>
          {!collapsed && <p className="text-xs text-muted">GOST 隧道管理平台</p>}
          <Button
            isIconOnly
            variant="ghost"
            size="sm"
            aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
            onPress={toggleCollapsed}
          >
            {collapsed ? <IconChevronsRight size={16} stroke={1.7} /> : <IconChevronsLeft size={16} stroke={1.7} />}
          </Button>
        </div>
      </aside>

      <Drawer.Backdrop isOpen={navOpen} onOpenChange={setNavOpen}>
        {/* 宽度设在 Dialog 面板上（Content 是全屏定位容器），内联 style 覆盖默认宽 */}
        <Drawer.Content placement="left">
          <Drawer.Dialog aria-label="导航菜单" style={{ width: "15rem" }}>
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

      <main
        id="main-content"
        tabIndex={-1}
        className={cn("transition-[padding] outline-none", collapsed ? "md:pl-[68px]" : "md:pl-56")}
      >
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
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
