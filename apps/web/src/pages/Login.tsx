import { Card, toast } from "@heroui/react";
import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { FormShell, fail, SubmitButton, TextForm } from "../ui";

export default function LoginPage() {
  const navigate = useNavigate();
  const [values, setValues] = useState({ username: "", password: "" });
  const [errors, setErrors] = useState<{ username?: string; password?: string }>({});
  const [pending, setPending] = useState(false);

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
    <div className="flex min-h-dvh items-center justify-center bg-background p-4 text-foreground">
      <Card className="w-full max-w-sm p-2">
        <Card.Header className="pb-2">
          <Card.Title>TYZ 控制台</Card.Title>
          <Card.Description>登录以管理 GOST 隧道节点</Card.Description>
        </Card.Header>
        <Card.Content>
          <FormShell onSubmit={onSubmit}>
            <TextForm
              label="用户名"
              isRequired
              autoComplete="username"
              autoFocus
              value={values.username}
              onChange={(v) => setValues((s) => ({ ...s, username: v }))}
              error={errors.username}
            />
            <TextForm
              label="密码"
              isRequired
              type="password"
              autoComplete="current-password"
              value={values.password}
              onChange={(v) => setValues((s) => ({ ...s, password: v }))}
              error={errors.password}
            />
            <SubmitButton size="lg" fullWidth isPending={pending}>
              登录
            </SubmitButton>
          </FormShell>
        </Card.Content>
      </Card>
    </div>
  );
}
