import { queryOptions } from "@tanstack/react-query";
import { api } from "./api";

/**
 * 页面主查询的共享 queryOptions：路由 loader 预取与组件 useQuery 共用同一份
 * key/fn，避免两处漂移。带 refetchInterval 的查询（仪表盘轮询、节点健康）由
 * 页面在使用处展开覆盖，不进这里 —— 预取不该启动轮询。
 */

/** setup-status 的时效是守卫依据（初始化完成后必须立刻反映），不受全局 staleTime 缓冲。 */
export const setupStatusOptions = queryOptions({
  queryKey: ["setup-status"],
  queryFn: api.setupStatus,
  staleTime: 0,
  retry: 1,
});

export const meOptions = queryOptions({ queryKey: ["me"], queryFn: api.me });
export const nodesListOptions = queryOptions({ queryKey: ["nodes"], queryFn: api.listNodes });
export const tunnelsListOptions = queryOptions({ queryKey: ["tunnels"], queryFn: api.listTunnels });
export const rulesListOptions = queryOptions({ queryKey: ["rules"], queryFn: api.listRules });
export const endpointsListOptions = queryOptions({ queryKey: ["endpoints"], queryFn: api.listEndpoints });
export const usersListOptions = queryOptions({ queryKey: ["users"], queryFn: api.listUsers });
export const packagesListOptions = queryOptions({ queryKey: ["packages"], queryFn: api.listPackages });
export const auditListOptions = queryOptions({ queryKey: ["audit"], queryFn: () => api.listAudit(200) });
export const tlsStatusOptions = queryOptions({ queryKey: ["tls-status"], queryFn: api.tlsStatus });
export const dashboardSummaryOptions = queryOptions({
  queryKey: ["dashboard-summary"],
  queryFn: api.dashboardSummary,
});
