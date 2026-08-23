import { Spinner } from "@heroui/react";
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, createRouter, Outlet, redirect } from "@tanstack/react-router";
import { AppLayout } from "./App";
import AuditPage from "./pages/Audit";
import DashboardPage from "./pages/Dashboard";
import EndpointsPage from "./pages/Endpoints";
import LoginPage from "./pages/Login";
import NodesPage from "./pages/Nodes";
import NotFoundPage from "./pages/NotFound";
import PackagesPage from "./pages/Packages";
import ProfilePage from "./pages/Profile";
import RulesPage from "./pages/Rules";
import SettingsPage from "./pages/Settings";
import SetupPage from "./pages/Setup";
import TunnelsPage from "./pages/Tunnels";
import UsersPage from "./pages/Users";
import {
  auditListOptions,
  dashboardSummaryOptions,
  endpointsListOptions,
  meOptions,
  nodesListOptions,
  packagesListOptions,
  rulesListOptions,
  setupStatusOptions,
  tlsStatusOptions,
  tunnelsListOptions,
  usersListOptions,
} from "./queries";
import { queryClient } from "./queryClient";

/**
 * code-based 路由树（无 Vite 插件依赖）。数据加载职责仍在页面组件（useQuery +
 * 骨架屏），路由 loader 只做 fire-and-forget 预取 —— 导航不等数据，配合
 * defaultPreload: "intent" 在侧栏 hover 时提前起网。
 */

interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
});

/** 主布局（pathless）：业务页共享侧栏/顶栏；login 与 setup 独立于布局之外。 */
const appLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: AppLayout,
  notFoundComponent: NotFoundPage,
});

/** 深链接标记：?create=1 直开创建弹窗（列表页以 useState 初始化消费）。 */
function createFlag(input: Record<string, unknown>): "1" | undefined {
  return input.create === "1" ? "1" : undefined;
}

const indexRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/",
  loader: ({ context }) => void context.queryClient.prefetchQuery(dashboardSummaryOptions),
  component: DashboardPage,
});

const nodesRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "nodes",
  validateSearch: (input: Record<string, unknown>): { create?: "1" } => ({ create: createFlag(input) }),
  loader: ({ context }) => void context.queryClient.prefetchQuery(nodesListOptions),
  component: NodesPage,
});

const tunnelsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "tunnels",
  validateSearch: (input: Record<string, unknown>): { create?: "1" } => ({ create: createFlag(input) }),
  loader: ({ context }) => void context.queryClient.prefetchQuery(tunnelsListOptions),
  component: TunnelsPage,
});

const rulesRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "rules",
  validateSearch: (input: Record<string, unknown>): { create?: "1"; status?: string } => ({
    create: createFlag(input),
    status: typeof input.status === "string" ? input.status : undefined,
  }),
  loader: ({ context }) => void context.queryClient.prefetchQuery(rulesListOptions),
  component: RulesPage,
});

const endpointsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "endpoints",
  validateSearch: (input: Record<string, unknown>): { create?: "1" } => ({ create: createFlag(input) }),
  loader: ({ context }) => void context.queryClient.prefetchQuery(endpointsListOptions),
  component: EndpointsPage,
});

const usersRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "users",
  validateSearch: (input: Record<string, unknown>): { create?: "1" } => ({ create: createFlag(input) }),
  loader: ({ context }) => void context.queryClient.prefetchQuery(usersListOptions),
  component: UsersPage,
});

const packagesRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "packages",
  loader: ({ context }) => void context.queryClient.prefetchQuery(packagesListOptions),
  component: PackagesPage,
});

const settingsTlsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "settings/tls",
  loader: ({ context }) => void context.queryClient.prefetchQuery(tlsStatusOptions),
  component: () => <SettingsPage kind="tls" />,
});

const settingsBasicRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "settings/basic",
  component: () => <SettingsPage kind="basic" />,
});

const settingsNotificationRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "settings/notification",
  component: () => <SettingsPage kind="notification" />,
});

const settingsAnnouncementRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "settings/announcement",
  component: () => <SettingsPage kind="announcement" />,
});

const settingsSiteRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "settings/site",
  component: () => <SettingsPage kind="site" />,
});

const settingsAuditRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "settings/audit",
  loader: ({ context }) => void context.queryClient.prefetchQuery(auditListOptions),
  component: AuditPage,
});

/** 旧地址兼容：/audit → /settings/audit（原 <Navigate replace>）。 */
const auditRedirectRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "audit",
  beforeLoad: () => {
    throw redirect({ to: "/settings/audit" });
  },
});

const profileRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "profile",
  loader: ({ context }) => void context.queryClient.prefetchQuery(meOptions),
  component: ProfilePage,
});

/**
 * login/setup 守卫在 beforeLoad 完成（setup-status 为公开小接口）：
 * 未初始化进 /setup、已初始化回 /login，消除页内"表单先闪现再跳转"。
 * 状态查询失败时放行登录/安装页由页面自行的错误态兜底。
 */
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "login",
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData(setupStatusOptions).catch(() => undefined);
    if (status && !status.initialized) throw redirect({ to: "/setup" });
  },
  component: LoginPage,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "setup",
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData(setupStatusOptions).catch(() => undefined);
    if (status?.initialized) throw redirect({ to: "/login" });
  },
  component: SetupPage,
});

const routeTree = rootRoute.addChildren([
  appLayoutRoute.addChildren([
    indexRoute,
    nodesRoute,
    tunnelsRoute,
    rulesRoute,
    endpointsRoute,
    usersRoute,
    packagesRoute,
    settingsTlsRoute,
    settingsBasicRoute,
    settingsNotificationRoute,
    settingsAnnouncementRoute,
    settingsSiteRoute,
    settingsAuditRoute,
    auditRedirectRoute,
    profileRoute,
  ]),
  loginRoute,
  setupRoute,
]);

function RouterPending() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background text-muted">
      <Spinner size="lg" />
    </div>
  );
}

export const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: "intent",
  defaultPreloadStaleTime: 30_000,
  defaultPendingComponent: RouterPending,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
