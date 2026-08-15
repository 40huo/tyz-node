import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type Chain, ChainType, type NodeWithMeta, Transport, type Tunnel } from "@tyz/shared";
import { Loader2, Plus } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { NumberField, SelectField } from "@/components/form-fields";
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
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api } from "../api";

const fail = (error: unknown) => toast.error(error instanceof Error ? error.message : "操作失败");

// ---- Tunnel form ----

const tunnelFormSchema = z.object({
  name: z.string().min(1, "请输入名称"),
  ingress_display_address: z.string().optional(),
  description: z.string().optional(),
});

function TunnelDialog({
  tunnel,
  open,
  onOpenChange,
}: {
  tunnel: Tunnel | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const form = useForm<z.infer<typeof tunnelFormSchema>>({
    resolver: zodResolver(tunnelFormSchema),
    defaultValues: tunnel ?? { name: "", ingress_display_address: "", description: "" },
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["tunnels"] });
  const createMutation = useMutation({
    mutationFn: api.createTunnel,
    onSuccess: () => {
      invalidate();
      onOpenChange(false);
    },
    onError: fail,
  });
  const updateMutation = useMutation({
    mutationFn: (values: z.infer<typeof tunnelFormSchema>) => api.updateTunnel(tunnel!.id, values),
    onSuccess: () => {
      invalidate();
      onOpenChange(false);
    },
    onError: fail,
  });

  const onSubmit = (values: z.infer<typeof tunnelFormSchema>) => {
    const payload = {
      ...values,
      ingress_display_address: values.ingress_display_address || undefined,
      description: values.description || undefined,
    };
    if (tunnel === null) {
      createMutation.mutate(payload);
    } else {
      updateMutation.mutate(payload);
    }
  };

  const pending = createMutation.isPending || updateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{tunnel === null ? "新建隧道" : `编辑隧道 #${tunnel.id}`}</DialogTitle>
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
              name="ingress_display_address"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>入口地址</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormDescription>可选，如 entry.example.com:80</FormDescription>
                  <FormMessage />
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

// ---- Chain form ----

const CHAIN_TYPE_OPTIONS = [
  { value: ChainType.IN, label: "入口 (in)" },
  { value: ChainType.CHAIN, label: "中继 (chain)" },
  { value: ChainType.OUT, label: "出口 (out)" },
];

const chainFormSchema = z.object({
  node_id: z.number({ invalid_type_error: "请选择节点" }).int().positive(),
  chain_type: z.nativeEnum(ChainType, { invalid_type_error: "请选择类型" }),
  transport: z.nativeEnum(Transport, { invalid_type_error: "请选择传输方式" }),
  index: z.number({ invalid_type_error: "请输入顺序" }).int().min(0),
  port: z.number({ invalid_type_error: "请输入端口" }).int().min(0).max(65535),
  strategy: z.string().min(1, "请输入策略"),
});

const CHAIN_CREATE_DEFAULTS = {
  node_id: undefined,
  chain_type: ChainType.CHAIN,
  transport: Transport.RAW,
  index: 0,
  port: 0,
  strategy: "round",
};

function ChainDialog({
  tunnelId,
  chain,
  nodes,
  open,
  onOpenChange,
}: {
  tunnelId: number;
  chain: Chain | null;
  nodes: NodeWithMeta[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const form = useForm<z.infer<typeof chainFormSchema>>({
    resolver: zodResolver(chainFormSchema),
    defaultValues: chain ?? CHAIN_CREATE_DEFAULTS,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["chains", tunnelId] });
  const createMutation = useMutation({
    mutationFn: (values: z.infer<typeof chainFormSchema>) => api.createChain({ ...values, tunnel_id: tunnelId }),
    onSuccess: () => {
      invalidate();
      onOpenChange(false);
    },
    onError: fail,
  });
  const updateMutation = useMutation({
    mutationFn: (values: z.infer<typeof chainFormSchema>) => api.updateChain(chain!.id, values),
    onSuccess: () => {
      invalidate();
      onOpenChange(false);
    },
    onError: fail,
  });

  const onSubmit = (values: z.infer<typeof chainFormSchema>) => {
    if (chain === null) {
      createMutation.mutate(values);
    } else {
      updateMutation.mutate(values);
    }
  };

  const pending = createMutation.isPending || updateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{chain === null ? "添加链路" : `编辑链路 #${chain.id}`}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-4">
            <FormField
              control={form.control}
              name="node_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>节点</FormLabel>
                  <Select
                    value={field.value === undefined ? undefined : String(field.value)}
                    onValueChange={(v) => field.onChange(Number(v))}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="请选择节点" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {nodes.map((n) => (
                        <SelectItem key={n.id} value={String(n.id)}>
                          {n.name} (#{n.id})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <SelectField control={form.control} name="chain_type" label="类型" options={CHAIN_TYPE_OPTIONS} />
            <SelectField
              control={form.control}
              name="transport"
              label="传输"
              options={Object.values(Transport).map((v) => ({ value: v, label: v }))}
            />
            <div className="grid grid-cols-2 gap-3">
              <NumberField control={form.control} name="index" label="顺序" min={0} />
              <NumberField
                control={form.control}
                name="port"
                label="端口"
                min={0}
                max={65535}
                description="0 = 自动分配"
              />
            </div>
            <FormField
              control={form.control}
              name="strategy"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>负载策略</FormLabel>
                  <FormControl>
                    <Input {...field} />
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

const CHAIN_TYPE_BADGES: Record<string, string> = {
  [ChainType.IN]: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  [ChainType.CHAIN]: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  [ChainType.OUT]: "bg-red-500/15 text-red-600 dark:text-red-400",
};

const CHAIN_TYPE_LABELS: Record<string, string> = {
  [ChainType.IN]: "入口",
  [ChainType.CHAIN]: "中继",
  [ChainType.OUT]: "出口",
};

const CHAIN_COLUMNS = 7;

function ChainsSheet({ tunnel, nodes, onClose }: { tunnel: Tunnel; nodes: NodeWithMeta[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Chain | null>(null);
  const [creating, setCreating] = useState(false);

  const chainsQuery = useQuery({
    queryKey: ["chains", tunnel.id],
    queryFn: () => api.tunnelChains(tunnel.id),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["chains", tunnel.id] });
  const deleteMutation = useMutation({ mutationFn: api.deleteChain, onSuccess: invalidate, onError: fail });

  const chains = chainsQuery.data?.chains ?? [];

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>链路管理：{tunnel.name}</SheetTitle>
          <SheetDescription>按「顺序」从小到大排列组成完整转发链路</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-auto px-4 pb-4">
          <div className="mb-3 flex justify-end">
            <Button onClick={() => setCreating(true)}>
              <Plus />
              添加链路
            </Button>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">顺序</TableHead>
                <TableHead>节点</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>传输</TableHead>
                <TableHead>端口</TableHead>
                <TableHead>策略</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {chainsQuery.isLoading ? (
                <TableRow>
                  <TableCell colSpan={CHAIN_COLUMNS} className="h-24 text-center text-muted-foreground">
                    加载中…
                  </TableCell>
                </TableRow>
              ) : chains.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={CHAIN_COLUMNS} className="h-24 text-center text-muted-foreground">
                    暂无链路
                  </TableCell>
                </TableRow>
              ) : (
                chains.map((chain) => (
                  <TableRow key={chain.id}>
                    <TableCell className="font-mono">{chain.index}</TableCell>
                    <TableCell className="font-medium">
                      {nodes.find((n) => n.id === chain.node_id)?.name ?? "?"}{" "}
                      <span className="text-muted-foreground">#{chain.node_id}</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className={CHAIN_TYPE_BADGES[chain.chain_type] ?? ""}>
                        {CHAIN_TYPE_LABELS[chain.chain_type] ?? chain.chain_type}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{chain.transport}</TableCell>
                    <TableCell className="font-mono">{chain.port === 0 ? "自动" : chain.port}</TableCell>
                    <TableCell>{chain.strategy || "-"}</TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-3">
                        <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setEditing(chain)}>
                          编辑
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="link" size="sm" className="h-auto p-0 text-destructive">
                              删除
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>删除链路</AlertDialogTitle>
                              <AlertDialogDescription>确定删除该链路？</AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>取消</AlertDialogCancel>
                              <AlertDialogAction
                                className="bg-destructive text-white hover:bg-destructive/90"
                                onClick={() => deleteMutation.mutate(chain.id)}
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
        </div>
      </SheetContent>

      <ChainDialog
        key={`chain-create-${tunnel.id}`}
        tunnelId={tunnel.id}
        chain={null}
        nodes={nodes}
        open={creating}
        onOpenChange={(o) => !o && setCreating(false)}
      />
      <ChainDialog
        key={`chain-edit-${editing?.id ?? "edit"}`}
        tunnelId={tunnel.id}
        chain={editing}
        nodes={nodes}
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
      />
    </Sheet>
  );
}

// ---- Page ----

const TUNNEL_COLUMNS = 5;

export default function TunnelsPage() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Tunnel | null>(null);
  const [creating, setCreating] = useState(false);
  const [chainsOf, setChainsOf] = useState<Tunnel | null>(null);

  const tunnelsQuery = useQuery({ queryKey: ["tunnels"], queryFn: api.listTunnels });
  const nodesQuery = useQuery({ queryKey: ["nodes"], queryFn: api.listNodes });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["tunnels"] });
  const deleteMutation = useMutation({ mutationFn: api.deleteTunnel, onSuccess: invalidate, onError: fail });

  const tunnels = tunnelsQuery.data?.tunnels ?? [];

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>隧道列表</CardTitle>
          <CardDescription>隧道由一组有序链路组成，串联入口、中继与出口节点</CardDescription>
          <CardAction>
            <Button onClick={() => setCreating(true)}>
              <Plus />
              新建隧道
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">ID</TableHead>
                <TableHead>名称</TableHead>
                <TableHead>入口地址</TableHead>
                <TableHead>描述</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tunnelsQuery.isLoading ? (
                <TableRow>
                  <TableCell colSpan={TUNNEL_COLUMNS} className="h-24 text-center text-muted-foreground">
                    加载中…
                  </TableCell>
                </TableRow>
              ) : tunnels.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={TUNNEL_COLUMNS} className="h-24 text-center text-muted-foreground">
                    暂无数据，点击右上角「新建隧道」开始
                  </TableCell>
                </TableRow>
              ) : (
                tunnels.map((tunnel) => (
                  <TableRow key={tunnel.id}>
                    <TableCell className="font-mono">{tunnel.id}</TableCell>
                    <TableCell className="font-medium">{tunnel.name}</TableCell>
                    <TableCell className="font-mono text-xs">{tunnel.ingress_display_address || "-"}</TableCell>
                    <TableCell className="text-muted-foreground">{tunnel.description || "-"}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
                        <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setChainsOf(tunnel)}>
                          链路管理
                        </Button>
                        <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setEditing(tunnel)}>
                          编辑
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="link" size="sm" className="h-auto p-0 text-destructive">
                              删除
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>删除隧道</AlertDialogTitle>
                              <AlertDialogDescription>删除隧道会级联删除其链路，确定？</AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>取消</AlertDialogCancel>
                              <AlertDialogAction
                                className="bg-destructive text-white hover:bg-destructive/90"
                                onClick={() => deleteMutation.mutate(tunnel.id)}
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

      <TunnelDialog key="create" tunnel={null} open={creating} onOpenChange={(o) => !o && setCreating(false)} />
      <TunnelDialog
        key={editing?.id ?? "edit"}
        tunnel={editing}
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
      />
      {chainsOf !== null ? (
        <ChainsSheet
          key={chainsOf.id}
          tunnel={chainsOf}
          nodes={nodesQuery.data?.nodes ?? []}
          onClose={() => setChainsOf(null)}
        />
      ) : null}
    </div>
  );
}
