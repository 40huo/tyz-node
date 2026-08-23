import { toast } from "@heroui/react";
import { IconLock, IconUser } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { api } from "../api";
import { AuthCard, FormShell, fail, IconTextField, SubmitButton } from "../ui";

export default function LoginPage() {
  const navigate = useNavigate();
  const status = useQuery({ queryKey: ["setup-status"], queryFn: api.setupStatus, retry: 1 });
  const [values, setValues] = useState({ username: "", password: "" });
  const [errors, setErrors] = useState<{ username?: string; password?: string }>({});
  const [pending, setPending] = useState(false);

  // Fresh deployment: no admin account yet — route the operator to the wizard.
  if (status.data && !status.data.initialized) {
    return <Navigate to="/setup" replace />;
  }

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const errs: typeof errors = {};
    if (!values.username.trim()) errs.username = "请输入用户名";
    if (!values.password) errs.password = "请输入密码";
    setErrors(errs);
    if (errs.username || errs.password) return;
    try {
      setPending(true);
      await api.login(values.username, values.password);
      toast.success("登录成功");
      navigate("/");
    } catch (error) {
      fail(error);
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthCard description="请输入您的登录凭证">
      <FormShell onSubmit={onSubmit}>
        <IconTextField
          label="用户名"
          icon={<IconUser size={16} stroke={2} />}
          isRequired
          autoComplete="username"
          autoFocus
          value={values.username}
          onChange={(v) => setValues((s) => ({ ...s, username: v }))}
          error={errors.username}
        />
        <IconTextField
          label="密码"
          icon={<IconLock size={16} stroke={2} />}
          reveal
          isRequired
          autoComplete="current-password"
          value={values.password}
          onChange={(v) => setValues((s) => ({ ...s, password: v }))}
          error={errors.password}
        />
        <SubmitButton size="lg" fullWidth isPending={pending}>
          登录
        </SubmitButton>
      </FormShell>
    </AuthCard>
  );
}
