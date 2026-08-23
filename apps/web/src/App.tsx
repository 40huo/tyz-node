import { Button, Drawer, Tooltip, toast } from "@heroui/react";
import { buttonVariants } from "@heroui/styles";
import {
  IconArrowsExchange,
  IconChevronDown,
  IconCreditCard,
  IconGauge,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconLogout,
  IconMenu2,
  IconMoon,
  IconNetwork,
  IconServer,
  IconSettings,
  IconSun,
  IconTargetArrow,
  IconUserCircle,
  IconUsers,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link, type LinkProps, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useCallback, useState } from "react";
import { api, setUnauthorizedHandler } from "./api";
import { meOptions } from "./queries";
import { useTheme } from "./theme";
import { Brand, cn } from "./ui";

// ---- Navigation config（侧栏与顶栏标题的唯一来源） ----

/** 类型化路由目标（LinkProps["to"] 去掉可选性，供 pageTitle/isActive 等按 string 消费）。 */
type RouteTo = NonNullable<LinkProps["to"]>;

interface NavEntry {
  to: RouteTo;
  label: string;
  icon?: ReactNode;
  /** 顶栏标题；缺省用 label。 */
  title?: string;
}

const DASHBOARD_ITEM: NavEntry = { to: "/", label: "控制台", icon: <IconGauge size={18} stroke={2} /> };

const BUSINESS_ITEMS: NavEntry[] = [
  { to: "/nodes", label: "节点", icon: <IconServer size={18} stroke={2} />, title: "节点管理" },
  { to: "/tunnels", label: "隧道", icon: <IconNetwork size={18} stroke={2} />, title: "隧道管理" },
  { to: "/rules", label: "转发规则", icon: <IconArrowsExchange size={18} stroke={2} /> },
  { to: "/endpoints", label: "目标端点", icon: <IconTargetArrow size={18} stroke={2} />, title: "目标端点管理" },
  { to: "/users", label: "用户", icon: <IconUsers size={18} stroke={2} />, title: "用户管理" },
  { to: "/packages", label: "套餐", icon: <IconCreditCard size={18} stroke={2} />, title: "套餐管理" },
];

const SETTINGS_ITEMS: NavEntry[] = [
  { to: "/settings/tls", label: "链路 TLS" },
  { to: "/settings/basic", label: "基础设置" },
  { to: "/settings/notification", label: "通知设置" },
  { to: "/settings/announcement", label: "公告设置" },
  { to: "/settings/site", label: "站点设置" },
  { to: "/settings/audit", label: "操作审计" },
];

const PROFILE_ITEM: NavEntry = { to: "/profile", label: "个人中心", icon: <IconUserCircle size={18} stroke={2} /> };

const ALL_NAV_ENTRIES = [DASHBOARD_ITEM, ...BUSINESS_ITEMS, ...SETTINGS_ITEMS, PROFILE_ITEM];

function pageTitle(pathname: string): string {
  const entry = ALL_NAV_ENTRIES.find((e) => e.to === pathname);
  return entry?.title ?? entry?.label ?? "";
}

const COLLAPSED_KEY = "tyz-sidebar-collapsed";
const SIDEBAR_WIDE = "w-56";
const SIDEBAR_NARROW = "w-[68px]";

// ---- Layout pieces ----

function ThemeToggle({ isDark, onToggle }: { isDark: boolean; onToggle: () => void }) {
  return (
    <Button isIconOnly variant="ghost" size="sm" aria-label="切换主题" onPress={onToggle}>
      {isDark ? <IconSun size={18} stroke={2} /> : <IconMoon size={18} stroke={2} />}
    </Button>
  );
}

/**
 * 导航项链接：真实 <a>（支持中键/新标签打开），直接挂 HeroUI ghost sm 按钮类
 * （.button 的 hover/active/focus 样式同时命中 :hover/:active/:focus-visible 原生
 * 选择器，不依赖 RAC 交互属性）。不用 Button 的 render 换标签——宿主标签与 <a>
 * 不一致时 RAC 每次渲染都会告警 Expected <button>, got <a>。
 */
function NavButton({
  to,
  label,
  className,
  children,
  onNavigate,
}: {
  to: RouteTo;
  label: string;
  className?: string;
  children: ReactNode;
  onNavigate?: () => void;
}) {
  return (
    <Link
      to={to}
      aria-label={label}
      onClick={onNavigate}
      className={cn(buttonVariants({ variant: "ghost", size: "sm" }), className)}
    >
      {children}
    </Link>
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
        {/* NavButton 是原生 <a>（不消费 RAC 的 focus context），须经 Tooltip.Trigger 桥接 hover；侧栏行全宽 */}
        <Tooltip.Trigger className="block w-full">{button}</Tooltip.Trigger>
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
  const location = useRouterState({ select: (s) => s.location });
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
            <Tooltip.Trigger className="block w-full">
              <NavButton
                to={SETTINGS_ITEMS[0].to}
                label="系统设置"
                onNavigate={onNavigate}
                className={cn(
                  "h-9 w-full justify-center px-0 font-normal",
                  settingsActive && "bg-accent-soft font-medium text-accent-soft-foreground",
                )}
              >
                <IconSettings size={18} stroke={2} />
              </NavButton>
            </Tooltip.Trigger>
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
            <IconSettings size={18} stroke={2} />
            系统设置
            <IconChevronDown
              size={16}
              stroke={2}
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

export function AppLayout() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { theme, toggle } = useTheme();
  const [navOpen, setNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === "1");
  const meQuery = useQuery(meOptions);

  // 401 兜底跳登录（原 App() 内注册迁移至此；布局挂载即生效，login/setup 路径豁免）
  const redirectToLogin = useCallback(() => {
    if (!pathname.startsWith("/login") && !pathname.startsWith("/setup")) {
      navigate({ to: "/login" });
    }
  }, [navigate, pathname]);
  setUnauthorizedHandler(redirectToLogin);

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
      navigate({ to: "/login" });
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
          aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
          className="hidden h-8 text-muted md:inline-flex"
          onPress={toggleCollapsed}
        >
          {collapsed ? (
            <IconLayoutSidebarLeftExpand size={18} stroke={2} />
          ) : (
            <IconLayoutSidebarLeftCollapse size={18} stroke={2} />
          )}
        </Button>
        <Button
          isIconOnly
          variant="ghost"
          size="sm"
          aria-label="打开导航"
          className="md:hidden"
          onPress={() => setNavOpen(true)}
        >
          <IconMenu2 size={18} stroke={2} />
        </Button>
        <span className="md:hidden">
          <Brand />
        </span>
        <h1 className="hidden text-sm font-medium text-muted md:block">{pageTitle(pathname)}</h1>

        <div className="ml-auto flex items-center gap-1">
          <ThemeToggle isDark={theme === "dark"} onToggle={toggle} />
          <Button
            variant="ghost"
            size="sm"
            className="hidden h-8 gap-1.5 px-2 text-muted sm:flex"
            onPress={() => navigate({ to: "/profile" })}
          >
            <IconUserCircle size={16} stroke={2} />
            {meQuery.data?.username ?? "…"}
          </Button>
          <Button
            isIconOnly
            variant="ghost"
            size="sm"
            aria-label="退出登录"
            className="h-8 text-muted"
            onPress={logout}
          >
            <IconLogout size={18} stroke={2} />
          </Button>
        </div>
      </header>

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-30 hidden flex-col overflow-x-hidden border-r border-border px-3 py-4 transition-[width] md:flex",
          collapsed ? SIDEBAR_NARROW : SIDEBAR_WIDE,
        )}
      >
        <div className="flex flex-col gap-6">
          <div className={cn(!collapsed && "px-2")}>
            <Brand collapsed={collapsed} />
          </div>
          <SidebarNav collapsed={collapsed} />
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
        <div className="mx-auto max-w-[1600px] p-4 md:p-6">
          <Outlet />
          <footer className="mt-10 border-t border-border pt-4 pb-2 text-center text-sm text-muted">
            © {new Date().getFullYear()} LaoShan Technology
            {/* GitHub 官方 mark（实心 silhouette，octicons）——tabler 只有描线版 */}
            <a
              href="https://github.com/laoshan-tech/tyz"
              target="_blank"
              rel="noreferrer"
              className="ml-1.5 inline-flex translate-y-[2px] text-muted outline-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" role="img" className="size-4">
                <title>GitHub 仓库</title>
                <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
              </svg>
            </a>
          </footer>
        </div>
      </main>
    </div>
  );
}
