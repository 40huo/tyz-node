import { Card, toast } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { api } from "../api";
import { FormShell, fail, Mono, SubmitButton, TextForm } from "../ui";

const USERNAME_RE = /^[A-Za-z0-9_-]{3,32}$/;

interface SetupValues {
  username: string;
  password: string;
  confirm: string;
}

/** First-run wizard: create the admin account straight after deployment. */
export default function SetupPage() {
  const navigate = useNavigate();
  const status = useQuery({ queryKey: ["setup-status"], queryFn: api.setupStatus, retry: 1 });
  const [values, setValues] = useState<SetupValues>({ username: "", password: "", confirm: "" });
  const [errors, setErrors] = useState<{ username?: string; password?: string; confirm?: string }>({});
  const [pending, setPending] = useState(false);

  if (status.data?.initialized) {
    return <Navigate to="/login" replace />;
  }

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const errs: typeof errors = {};
    if (!USERNAME_RE.test(values.username)) errs.username = "用户名需 3-32 位字母/数字/下划线/连字符";
    if (values.password.length < 8) errs.password = "密码至少 8 位";
    if (values.confirm !== values.password) errs.confirm = "两次输入的密码不一致";
    setErrors(errs);
    if (errs.username || errs.password || errs.confirm) return;
    try {
      setPending(true);
      await api.initSetup({ username: values.username, password: values.password });
      toast.success("管理员账号已创建");
      navigate("/");
    } catch (error) {
      fail(error);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="login-backdrop flex min-h-dvh items-center justify-center bg-background p-4 text-foreground">
      <div className="flex w-full max-w-sm flex-col gap-5">
        <div className="flex items-center justify-center gap-2.5">
          <div className="flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-accent text-sm font-bold text-accent-foreground">
            T
          </div>
          <span className="text-lg font-semibold">TYZ 控制台</span>
        </div>
        <Card className="p-2">
          <Card.Header className="pb-2">
            <Card.Title>初始化</Card.Title>
            <Card.Description>首次部署：创建管理员账号完成初始化</Card.Description>
          </Card.Header>
          <Card.Content>
            {status.isError ? (
              <p className="py-4 text-center text-sm text-muted">无法获取初始化状态，请刷新重试</p>
            ) : status.data && !status.data.schema_ready ? (
              <div className="flex flex-col gap-2 py-2 text-sm text-muted">
                <p>数据库表尚未创建（迁移未执行）。</p>
                <p>
                  请确认部署命令已配置为 <Mono>bun run deploy:server</Mono>（含自动迁移）并重新部署，然后刷新此页。
                </p>
              </div>
            ) : (
              <FormShell onSubmit={onSubmit}>
                <TextForm
                  label="管理员用户名"
                  isRequired
                  autoFocus
                  autoComplete="username"
                  hint="3-32 位字母/数字/下划线/连字符"
                  value={values.username}
                  onChange={(v) => setValues((s) => ({ ...s, username: v }))}
                  error={errors.username}
                />
                <TextForm
                  label="密码"
                  isRequired
                  type="password"
                  autoComplete="new-password"
                  hint="至少 8 位"
                  value={values.password}
                  onChange={(v) => setValues((s) => ({ ...s, password: v }))}
                  error={errors.password}
                />
                <TextForm
                  label="确认密码"
                  isRequired
                  type="password"
                  autoComplete="new-password"
                  value={values.confirm}
                  onChange={(v) => setValues((s) => ({ ...s, confirm: v }))}
                  error={errors.confirm}
                />
                <SubmitButton size="lg" fullWidth isPending={pending}>
                  创建账号并进入
                </SubmitButton>
              </FormShell>
            )}
          </Card.Content>
        </Card>
      </div>
    </div>
  );
}
