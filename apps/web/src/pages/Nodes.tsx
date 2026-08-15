import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NodeWithMeta } from "@tyz/shared";
import { Loader2, Plus } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { CopyButton } from "@/components/copy-button";
import { NumberField } from "@/components/form-fields";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api } from "../api";

const fail = (error: unknown) => toast.error(error instanceof Error ? error.message : "操作失败");

// ---- Node form ----

const nodeFormSchema = z.object({
  name: z.string().min(1, "请输入名称"),
  address: z.string().min(1, "请输入内网地址"),
  display_address: z.string().optional(),
  ports: z.string().regex(/^\d+-\d+$/, "格式如 10000-20000"),
  level: z.number({ invalid_type_error: "请输入级别" }).int().min(0),
  traffic_limit: z.number({ invalid_type_error: "请输入流量上限" }).int().min(0),
  enlarge_scale: z.number({ invalid_type_error: "请输入扩容倍数" }).int().min(1, "最小为 1"),
  is_public: z.boolean(),
  description: z.string().optional(),
});

const CREATE_DEFAULTS = {
  name: "",
  address: "",
  display_address: "",
  ports: "10000-20000",
  level: 0,
  traffic_limit: 0,
  enlarge_scale: 1,
  is_public: false,
  description: "",
};

function NodeDialog({
  node,
  open,
  onOpenChange,
  onCreated,
}: {
  node: NodeWithMeta | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (token: string) => void;
}) {
  const queryClient = useQueryClient();
  const form = useForm<z.infer<typeof nodeFormSchema>>({
    resolver: zodResolver(nodeFormSchema),
    defaultValues: node ?? CREATE_DEFAULTS,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["nodes"] });
  const createMutation = useMutation({
    mutationFn: api.createNode,
    onSuccess: (data) => {
      invalidate();
      onOpenChange(false);
      onCreated(data.token);
    },
    onError: fail,
  });
  const updateMutation = useMutation({
    mutationFn: (values: z.infer<typeof nodeFormSchema>) => api.updateNode(node!.id, values),
    onSuccess: () => {
      invalidate();
      onOpenChange(false);
    },
    onError: fail,
  });

  const onSubmit = (values: z.infer<typeof nodeFormSchema>) => {
    const payload = {
      ...values,
      display_address: values.display_address || undefined,
      description: values.description || undefined,
    };
    if (node === null) {
      createMutation.mutate(payload);
    } else {
      updateMutation.mutate(payload);
    }
  };

  const pending = createMutation.isPending || updateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{node === null ? "新建节点" : `编辑节点 #${node.id}`}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>名称</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="address"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>内网地址</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormDescription>节点间通信地址，如 10.0.0.1</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="display_address"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>对外地址</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormDescription>可选，客户端连接地址</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="ports"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>端口段</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-3 gap-3">
              <NumberField control={form.control} name="level" label="级别" min={0} />
              <NumberField control={form.control} name="traffic_limit" label="流量上限" min={0} />
              <NumberField control={form.control} name="enlarge_scale" label="扩容倍数" min={1} />
            </div>
            <FormField
              control={form.control}
              name="is_public"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between rounded-lg border p-3">
                  <FormLabel>公开节点</FormLabel>
                  <FormControl>
                    <Switch checked={field.value ?? false} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>描述</FormLabel>
                  <FormControl>
                    <Textarea rows={2} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                保存
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ---- Token one-time display ----

function TokenDialog({ token, onClose }: { token: string | null; onClose: () => void }) {
  return (
    <Dialog open={token !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>节点 Token（仅显示一次）</DialogTitle>
          <DialogDescription>请立即保存到节点 agent 的 NODE_TOKEN 环境变量，关闭后无法再次查看。</DialogDescription>
        </DialogHeader>
        <div className="rounded-md bg-muted p-3 font-mono text-sm break-all">{token}</div>
        <DialogFooter>
          <CopyButton text={token ?? ""} />
          <Button onClick={onClose}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Stats sheet ----

const STATS_PAGE_SIZE = 20;

function StatsSheet({ node, onClose }: { node: NodeWithMeta; onClose: () => void }) {
  const [page, setPage] = useState(0);
  const statsQuery = useQuery({
    queryKey: ["node-stats", node.id],
    queryFn: () => api.nodeStats(node.id),
    refetchInterval: 10_000,
  });

  const rows = statsQuery.data?.rows ?? [];
  const pageCount = Math.max(1, Math.ceil(rows.length / STATS_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageRows = rows.slice(currentPage * STATS_PAGE_SIZE, (currentPage + 1) * STATS_PAGE_SIZE);

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>节点统计 #{node.id}</SheetTitle>
          <SheetDescription>{node.name} · 每 10 秒自动刷新</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-auto px-4 pb-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>服务</TableHead>
                <TableHead>连接 (总/当前)</TableHead>
                <TableHead>流量 (入/出)</TableHead>
                <TableHead>错误</TableHead>
                <TableHead>时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {statsQuery.isLoading ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                    加载中…
                  </TableCell>
                </TableRow>
              ) : pageRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                    暂无统计数据
                  </TableCell>
                </TableRow>
              ) : (
                pageRows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-mono text-xs">{row.service}</TableCell>
                    <TableCell>
                      {row.stats.totalConns} / {row.stats.currentConns}
                    </TableCell>
                    <TableCell>
                      {row.stats.inputBytes} / {row.stats.outputBytes} B
                    </TableCell>
                    <TableCell>{row.stats.totalErrs}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.reported_at.replace("T", " ").slice(0, 19)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-center justify-end gap-2 border-t px-4 py-3 text-sm text-muted-foreground">
          <Button variant="outline" size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
            上一页
          </Button>
          <span>
            第 {currentPage + 1} / {pageCount} 页
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={currentPage >= pageCount - 1}
            onClick={() => setPage(currentPage + 1)}
          >
            下一页
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ---- Page ----

const NODE_COLUMNS = 9;

export default function NodesPage() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<NodeWithMeta | null>(null);
  const [creating, setCreating] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [statsNode, setStatsNode] = useState<NodeWithMeta | null>(null);

  const nodesQuery = useQuery({ queryKey: ["nodes"], queryFn: api.listNodes });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["nodes"] });
  const deleteMutation = useMutation({ mutationFn: api.deleteNode, onSuccess: invalidate, onError: fail });
  const recomputeMutation = useMutation({
    mutationFn: api.recomputeNode,
    onSuccess: () => {
      invalidate();
      toast.success("已重新计算配置");
    },
    onError: fail,
  });
  const rotateMutation = useMutation({
    mutationFn: api.rotateNodeToken,
    onSuccess: (data) => setToken(data.token),
    onError: fail,
  });

  const nodes = nodesQuery.data?.nodes ?? [];

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>节点列表</CardTitle>
          <CardDescription>管理 GOST 中继节点及其接入配置</CardDescription>
          <CardAction>
            <Button onClick={() => setCreating(true)}>
              <Plus />
              新建节点
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">ID</TableHead>
                <TableHead>名称</TableHead>
                <TableHead>地址</TableHead>
                <TableHead>对外地址</TableHead>
                <TableHead>端口段</TableHead>
                <TableHead>公开</TableHead>
                <TableHead>配置版本</TableHead>
                <TableHead>Token 尾号</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {nodesQuery.isLoading ? (
                <TableRow>
                  <TableCell colSpan={NODE_COLUMNS} className="h-24 text-center text-muted-foreground">
                    加载中…
                  </TableCell>
                </TableRow>
              ) : nodes.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={NODE_COLUMNS} className="h-24 text-center text-muted-foreground">
                    暂无数据，点击右上角「新建节点」开始
                  </TableCell>
                </TableRow>
              ) : (
                nodes.map((node) => (
                  <TableRow key={node.id}>
                    <TableCell className="font-mono">{node.id}</TableCell>
                    <TableCell className="font-medium">{node.name}</TableCell>
                    <TableCell className="font-mono text-xs">{node.address}</TableCell>
                    <TableCell className="font-mono text-xs">{node.display_address || "-"}</TableCell>
                    <TableCell className="font-mono text-xs">{node.ports}</TableCell>
                    <TableCell>
                      {node.is_public ? (
                        <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" variant="secondary">
                          公开
                        </Badge>
                      ) : (
                        <Badge variant="outline">私有</Badge>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{node.config_version ?? "-"}</TableCell>
                    <TableCell className="font-mono text-xs">****{node.token_hint}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
                        <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setEditing(node)}>
                          编辑
                        </Button>
                        <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setStatsNode(node)}>
                          统计
                        </Button>
                        <Button
                          variant="link"
                          size="sm"
                          className="h-auto p-0"
                          disabled={recomputeMutation.isPending}
                          onClick={() => recomputeMutation.mutate(node.id)}
                        >
                          重算配置
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="link" size="sm" className="h-auto p-0">
                              轮换 Token
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>轮换 Token</AlertDialogTitle>
                              <AlertDialogDescription>轮换后旧 Token 立即失效，确定？</AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>取消</AlertDialogCancel>
                              <AlertDialogAction onClick={() => rotateMutation.mutate(node.id)}>确定</AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="link" size="sm" className="h-auto p-0 text-destructive">
                              删除
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>删除节点</AlertDialogTitle>
                              <AlertDialogDescription>删除节点会级联删除其链路，确定？</AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>取消</AlertDialogCancel>
                              <AlertDialogAction
                                className="bg-destructive text-white hover:bg-destructive/90"
                                onClick={() => deleteMutation.mutate(node.id)}
                              >
                                删除
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <NodeDialog
        key="create"
        node={null}
        open={creating}
        onOpenChange={(o) => !o && setCreating(false)}
        onCreated={setToken}
      />
      <NodeDialog
        key={editing?.id ?? "edit"}
        node={editing}
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        onCreated={setToken}
      />
      <TokenDialog token={token} onClose={() => setToken(null)} />
      {statsNode !== null ? (
        <StatsSheet key={statsNode.id} node={statsNode} onClose={() => setStatsNode(null)} />
      ) : null}
    </div>
  );
}
