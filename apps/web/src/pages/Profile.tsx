import { Card, Chip, Skeleton, toast } from "@heroui/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "../api";
import { type FormErrors, FormShell, fail, hasErrors, PageHeader, PageShell, SubmitButton, TextForm } from "../ui";

/** 信息网格单元：label 在上、value 在下，宽卡片下两列排布比左右对齐的行更耐看。 */
function InfoCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted">{label}</span>
      <span className="text-sm">{value}</span>
    </div>
  );
}

interface PasswordFormValues {
  old_password: string;
  new_password: string;
  confirm: string;
}

const emptyPasswordValues = (): PasswordFormValues => ({ old_password: "", new_password: "", confirm: "" });

function PasswordCard() {
  const [values, setValues] = useState<PasswordFormValues>(emptyPasswordValues);
  const [errors, setErrors] = useState<FormErrors<PasswordFormValues>>({});
  const set = <K extends keyof PasswordFormValues>(key: K, value: PasswordFormValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  const mutation = useMutation({
    mutationFn: (input: { old_password: string; new_password: string }) => api.changePassword(input),
    onSuccess: () => {
      setValues(emptyPasswordValues());
      toast.success("密码已更新");
    },
    onError: (error) => {
      // 旧密码校验失败是唯一预期的业务错误，回显到字段上而不是全局 toast
      if (error instanceof Error && error.message.includes("当前密码不正确")) {
        setErrors((e) => ({ ...e, old_password: error.message }));
      } else {
        fail(error);
      }
    },
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const errs: FormErrors<PasswordFormValues> = {};
    if (!values.old_password) errs.old_password = "请输入当前密码";
    if (values.new_password.length < 8) errs.new_password = "新密码至少 8 位";
    if (values.confirm !== values.new_password) errs.confirm = "两次输入的新密码不一致";
    setErrors(errs);
    if (hasErrors(errs)) return;
    mutation.mutate({ old_password: values.old_password, new_password: values.new_password });
  };

  return (
    <Card className="h-fit">
      <Card.Header className="pb-2">
        <Card.Title>修改密码</Card.Title>
        <Card.Description>修改后当前会话保持登录；其他已登录会话不受影响</Card.Description>
      </Card.Header>
      <Card.Content>
        <FormShell onSubmit={onSubmit}>
          <TextForm
            label="当前密码"
            isRequired
            value={values.old_password}
            onChange={(v) => set("old_password", v)}
            error={errors.old_password}
            inputProps={{ type: "password", autoComplete: "current-password" }}
          />
          <TextForm
            label="新密码"
            isRequired
            hint="至少 8 位"
            value={values.new_password}
            onChange={(v) => set("new_password", v)}
            error={errors.new_password}
            inputProps={{ type: "password", autoComplete: "new-password" }}
          />
          <TextForm
            label="确认新密码"
            isRequired
            value={values.confirm}
            onChange={(v) => set("confirm", v)}
            error={errors.confirm}
            inputProps={{ type: "password", autoComplete: "new-password" }}
          />
          <div className="flex justify-end">
            <SubmitButton isPending={mutation.isPending}>更新密码</SubmitButton>
          </div>
        </FormShell>
      </Card.Content>
    </Card>
  );
}

export default function ProfilePage() {
  const meQuery = useQuery({ queryKey: ["me"], queryFn: api.me });
  const username = meQuery.data?.username;

  return (
    <PageShell>
      <PageHeader title="个人中心" description="账户信息与安全设置" />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <Card.Content className="flex flex-col gap-5">
            <div className="flex items-center gap-4">
              <div className="flex size-14 shrink-0 items-center justify-center rounded-lg bg-accent text-xl font-bold text-accent-foreground">
                {username ? username.charAt(0).toUpperCase() : "…"}
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                {meQuery.isLoading ? (
                  <Skeleton className="h-7 w-40 rounded-md" />
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="truncate text-lg font-semibold">{username ?? "-"}</span>
                    <Chip color="accent" variant="soft" size="sm">
                      <Chip.Label>管理员</Chip.Label>
                    </Chip>
                  </div>
                )}
                <p className="text-sm text-muted">由初始化向导创建的数据库账户，具备全部管理权限</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-8 gap-y-4 border-t border-border pt-4">
              <InfoCell label="用户名" value={username ?? "-"} />
              <InfoCell label="角色" value="管理员（role=admin）" />
              <InfoCell label="认证方式" value="账号密码（密码仅存服务端哈希）" />
              <InfoCell label="会话有效期" value="7 天（HttpOnly Cookie，退出即失效）" />
            </div>
          </Card.Content>
        </Card>

        <PasswordCard />
      </div>
    </PageShell>
  );
}
