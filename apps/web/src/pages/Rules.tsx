import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type CreateRuleInput, limiterConfigSchema, type RelayRule, RelayRuleStatus, type Tunnel } from "@tyz/shared";
import { Loader2, Plus } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { EMPTY_SELECT_VALUE, NumberField, SelectField } from "@/components/form-fields";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api } from "../api";

const fail = (error: unknown) => toast.error(error instanceof Error ? error.message : "操作失败");

const STATUS_BADGES: Record<string, string> = {
  created: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400",
  paused: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  running: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  error: "bg-red-500/15 text-red-600 dark:text-red-400",
};

const limitTextSchema = z.string().superRefine((value, ctx) => {
  if (!value.trim()) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "不是合法的 JSON" });
    return;
  }
  const result = limiterConfigSchema.safeParse(parsed);
  if (!result.success) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `限速配置无效: ${result.error.issues[0]?.message ?? ""}` });
  }
});

const ruleFormSchema = z.object({
  name: z.string().min(1, "请输入名称"),
  listen_port: z
    .number({ invalid_type_error: "请输入监听端口" })
    .int("端口需为整数")
    .min(1, "端口范围 1-65535")
    .max(65535, "端口范围 1-65535"),
  targets: z.string().min(1, "请输入目标地址"),
  /** Select 值：EMPTY_SELECT_VALUE 表示不部署，否则为隧道 id 字符串 */
  tunnel_id: z.string(),
  status: z.nativeEnum(RelayRuleStatus),
  limitText: limitTextSchema,
  description: z.string().optional(),
});

function RuleDialog({
  rule,
  tunnels,
  open,
  onOpenChange,
}: {
  rule: RelayRule | null;
  tunnels: Tunnel[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const form = useForm<z.infer<typeof ruleFormSchema>>({
    resolver: zodResolver(ruleFormSchema),
    defaultValues: rule
      ? {
          name: rule.name,
          listen_port: rule.listen_port,
          targets: rule.targets,
          tunnel_id: rule.tunnel_id === undefined ? EMPTY_SELECT_VALUE : String(rule.tunnel_id),
          status: rule.status,
          limitText: rule.limit ? JSON.stringify(rule.limit, null, 2) : "",
          description: rule.description ?? "",
        }
      : {
          name: "",
          listen_port: undefined,
          targets: "",
          tunnel_id: EMPTY_SELECT_VALUE,
          status: RelayRuleStatus.CREATED,
          limitText: "",
          description: "",
        },
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["rules"] });
  const createMutation = useMutation({
    mutationFn: (input: CreateRuleInput) => api.createRule(input),
    onSuccess: () => {
      invalidate();
      onOpenChange(false);
    },
    onError: fail,
  });
  const updateMutation = useMutation({
    mutationFn: (values: { id: number; input: CreateRuleInput }) => api.updateRule(values.id, values.input),
    onSuccess: () => {
      invalidate();
      onOpenChange(false);
    },
    onError: fail,
  });

  const onSubmit = (values: z.infer<typeof ruleFormSchema>) => {
    const { limitText, tunnel_id, ...rest } = values;
    const input = {
      ...rest,
      description: rest.description || undefined,
      tunnel_id: tunnel_id === EMPTY_SELECT_VALUE ? undefined : Number(tunnel_id),
      limit: limitText.trim() === "" ? null : (JSON.parse(limitText) as CreateRuleInput["limit"]),
    } satisfies CreateRuleInput;
    if (rule === null) {
      createMutation.mutate(input);
    } else {
      updateMutation.mutate({ id: rule.id, input });
    }
  };

  const pending = createMutation.isPending || updateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{rule === null ? "新建规则" : `编辑规则 #${rule.id}`}</DialogTitle>
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
            <div className="grid grid-cols-2 gap-3">
              <NumberField control={form.control} name="listen_port" label="监听端口" min={1} max={65535} />
              <SelectField
                control={form.control}
                name="status"
                label="状态"
                options={Object.values(RelayRuleStatus).map((v) => ({ value: v, label: v }))}
              />
            </div>
            <FormField
              control={form.control}
              name="targets"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>目标地址</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormDescription>如 example.com:80</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <SelectField
              control={form.control}
              name="tunnel_id"
              label="所属隧道"
              allowEmpty
              emptyLabel="不指定"
              description="不选则仅本节点直连转发"
              options={tunnels.map((t) => ({ value: String(t.id), label: `${t.name} (#${t.id})` }))}
            />
            <FormField
              control={form.control}
              name="limitText"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>限速配置 (JSON)</FormLabel>
                  <FormControl>
                    <Textarea rows={4} className="font-mono text-xs" {...field} />
                  </FormControl>
                  <FormDescription>
                    JSON 对象，如 {"{"}"traffic": {"{"}"service_in": 1048576{"}"}
                    {"}"}；留空表示不限速
                  </FormDescription>
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

// ---- Page ----

const RULE_COLUMNS = 8;

export default function RulesPage() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<RelayRule | null>(null);
  const [creating, setCreating] = useState(false);

  const rulesQuery = useQuery({ queryKey: ["rules"], queryFn: api.listRules });
  const tunnelsQuery = useQuery({ queryKey: ["tunnels"], queryFn: api.listTunnels });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["rules"] });
  const deleteMutation = useMutation({ mutationFn: api.deleteRule, onSuccess: invalidate, onError: fail });

  const tunnels = tunnelsQuery.data?.tunnels ?? [];
  const rules = rulesQuery.data?.rules ?? [];

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>转发规则列表</CardTitle>
          <CardDescription>定义入口节点的监听端口与转发目标</CardDescription>
          <CardAction>
            <Button onClick={() => setCreating(true)}>
              <Plus />
              新建规则
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">ID</TableHead>
                <TableHead>名称</TableHead>
                <TableHead>监听端口</TableHead>
                <TableHead>目标</TableHead>
                <TableHead>隧道</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>限速</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rulesQuery.isLoading ? (
                <TableRow>
                  <TableCell colSpan={RULE_COLUMNS} className="h-24 text-center text-muted-foreground">
                    加载中…
                  </TableCell>
                </TableRow>
              ) : rules.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={RULE_COLUMNS} className="h-24 text-center text-muted-foreground">
                    暂无数据，点击右上角「新建规则」开始
                  </TableCell>
                </TableRow>
              ) : (
                rules.map((rule) => (
                  <TableRow key={rule.id}>
                    <TableCell className="font-mono">{rule.id}</TableCell>
                    <TableCell className="font-medium">{rule.name}</TableCell>
                    <TableCell className="font-mono">{rule.listen_port}</TableCell>
                    <TableCell className="font-mono text-xs">{rule.targets}</TableCell>
                    <TableCell>
                      {rule.tunnel_id ? (
                        <>
                          {tunnels.find((t) => t.id === rule.tunnel_id)?.name ?? "?"}{" "}
                          <span className="text-muted-foreground">#{rule.tunnel_id}</span>
                        </>
                      ) : (
                        "-"
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className={STATUS_BADGES[rule.status] ?? ""}>
                        {rule.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{rule.limit ? "已配置" : "-"}</TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-3">
                        <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setEditing(rule)}>
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
                              <AlertDialogTitle>删除规则</AlertDialogTitle>
                              <AlertDialogDescription>确定删除该规则？</AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>取消</AlertDialogCancel>
                              <AlertDialogAction
                                className="bg-destructive text-white hover:bg-destructive/90"
                                onClick={() => deleteMutation.mutate(rule.id)}
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

      <RuleDialog
        key="create"
        rule={null}
        tunnels={tunnels}
        open={creating}
        onOpenChange={(o) => !o && setCreating(false)}
      />
      <RuleDialog
        key={editing?.id ?? "edit"}
        rule={editing}
        tunnels={tunnels}
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
      />
    </div>
  );
}
