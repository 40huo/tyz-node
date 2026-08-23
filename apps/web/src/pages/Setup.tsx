import { toast } from "@heroui/react";
import { IconLock, IconLockCheck, IconUser } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { api } from "../api";
import { AuthCard, DataText, FormShell, fail, IconTextField, SubmitButton } from "../ui";

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
    <AuthCard description="首次部署：请设置管理员账号完成初始化">
      {status.isError ? (
        <p className="py-4 text-center text-sm text-muted">无法获取初始化状态，请刷新重试</p>
      ) : status.data && !status.data.schema_ready ? (
        <div className="flex flex-col gap-2 py-2 text-sm text-muted">
          <p>数据库表尚未创建（迁移未执行）。</p>
          <p>
            请确认部署命令已配置为 <DataText>bun run deploy:server</DataText>
            （含自动迁移）并重新部署，然后刷新此页。
          </p>
        </div>
      ) : (
        <FormShell onSubmit={onSubmit}>
          <IconTextField
            label="管理员用户名"
            icon={<IconUser size={16} stroke={2} />}
            isRequired
            autoFocus
            autoComplete="username"
            hint="3-32 位字母/数字/下划线/连字符"
            value={values.username}
            onChange={(v) => setValues((s) => ({ ...s, username: v }))}
            error={errors.username}
          />
          <IconTextField
            label="密码"
            icon={<IconLock size={16} stroke={2} />}
            reveal
            isRequired
            autoComplete="new-password"
            hint="至少 8 位"
            value={values.password}
            onChange={(v) => setValues((s) => ({ ...s, password: v }))}
            error={errors.password}
          />
          <IconTextField
            label="确认密码"
            icon={<IconLockCheck size={16} stroke={2} />}
            reveal
            isRequired
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
    </AuthCard>
  );
}
