import { QueryClient } from "@tanstack/react-query";

/**
 * 全局唯一 QueryClient：QueryClientProvider 与路由 loader 预取共用同一实例。
 * staleTime 30s —— 回访页面缓存直出、后台静默刷新；所有写路径走 invalidateQueries，
 * 列表新鲜度不受影响。
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 },
  },
});
