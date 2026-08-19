import {
  Button,
  Description,
  Drawer,
  EmptyState,
  FieldError,
  Form,
  Heading,
  Input,
  Label,
  ListBox,
  Modal,
  NumberField,
  Paragraph,
  Select,
  Spinner,
  TextArea,
  TextField,
  toast,
} from "@heroui/react";
import { type ComponentProps, type ReactNode, useCallback, useRef, useState } from "react";

export const fail = (error: unknown) => toast.danger(error instanceof Error ? error.message : "操作失败");

export const cn = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

/** Monospace inline text for IDs, addresses, ports. */
export function Mono({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn("font-mono text-xs", className)}>{children}</span>;
}

// ---- Form state ----

/** Object-shaped form state: values + typed setter; `reset` always re-evaluates the latest `initial`. */
export function useFormValues<T extends object>(initial: () => T) {
  const initialRef = useRef(initial);
  initialRef.current = initial;
  const [values, setValues] = useState<T>(initial);
  const set = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
  }, []);
  const reset = useCallback(() => setValues(initialRef.current()), []);
  return { values, set, setValues, reset };
}

export type FormErrors<T> = Partial<Record<keyof T, string>>;

export const hasErrors = (errors: object) => Object.keys(errors).length > 0;

// ---- Field wrappers (label + error/hint in one line) ----

export function TextForm({
  label,
  error,
  hint,
  multiline,
  placeholder,
  inputProps,
  className,
  ...props
}: Omit<ComponentProps<typeof TextField>, "className"> & {
  label: string;
  error?: string;
  hint?: string;
  multiline?: boolean;
  placeholder?: string;
  inputProps?: ComponentProps<typeof Input> & ComponentProps<typeof TextArea>;
  className?: string;
}) {
  const Control = multiline ? TextArea : Input;
  return (
    <TextField {...props} isInvalid={!!error} className={cn("w-full", className)}>
      <Label>{label}</Label>
      <Control {...inputProps} placeholder={placeholder} />
      {error ? <FieldError>{error}</FieldError> : hint ? <Description>{hint}</Description> : null}
    </TextField>
  );
}

export function NumberForm({
  label,
  error,
  hint,
  className,
  ...props
}: Omit<ComponentProps<typeof NumberField>, "className"> & {
  label: string;
  error?: string;
  hint?: string;
  className?: string;
}) {
  return (
    <NumberField {...props} isInvalid={!!error} className={cn("w-full", className)}>
      <Label>{label}</Label>
      <NumberField.Group>
        <NumberField.Input className="w-full" />
      </NumberField.Group>
      {error ? <FieldError>{error}</FieldError> : hint ? <Description>{hint}</Description> : null}
    </NumberField>
  );
}

export interface Option {
  value: string;
  label: string;
}

export function SelectForm({
  label,
  error,
  hint,
  options,
  multiple,
  placeholder,
  className,
  ...props
}: Omit<ComponentProps<typeof Select>, "children" | "placeholder"> & {
  label: string;
  error?: string;
  hint?: string;
  options: Option[];
  multiple?: boolean;
  placeholder?: string;
  className?: string;
}) {
  return (
    <Select
      {...props}
      selectionMode={multiple ? "multiple" : "single"}
      placeholder={placeholder}
      isInvalid={!!error}
      className={cn("w-full", className)}
    >
      <Label>{label}</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      {error ? <FieldError>{error}</FieldError> : hint ? <Description>{hint}</Description> : null}
      <Select.Popover>
        <ListBox selectionMode={multiple ? "multiple" : "single"}>
          {options.map((option) => (
            <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
              {option.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

// ---- Form shell ----

/**
 * 表单外壳：aria 校验模式（不拦截提交）——校验统一由各表单的 onSubmit 自行处理，
 * 否则 native 模式下必填字段会静默阻止提交且无处展示错误。
 */
export function FormShell({ className, ...props }: ComponentProps<typeof Form>) {
  return <Form {...props} validationBehavior="aria" className={cn("flex flex-col gap-4", className)} />;
}

// ---- Dialog shells ----

export function FormModal({
  title,
  isOpen,
  onClose,
  width = "sm:max-w-md",
  children,
}: {
  title: string;
  isOpen: boolean;
  onClose: () => void;
  width?: string;
  children: ReactNode;
}) {
  return (
    // 不包 <Modal> 根：根内部的 DialogTrigger 需要可按压的 trigger 子元素，
    // 纯受控用法下会有 PressResponder 开发告警；子组件的 ModalContext 有空对象默认值。
    <Modal.Backdrop isOpen={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Modal.Container>
        <Modal.Dialog aria-label={title} className={width}>
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading>{title}</Modal.Heading>
          </Modal.Header>
          <Modal.Body>{children}</Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

export function SideDrawer({
  title,
  isOpen,
  onClose,
  width = "w-[min(48rem,100vw)]",
  children,
}: {
  title: string;
  isOpen: boolean;
  onClose: () => void;
  width?: string;
  children: ReactNode;
}) {
  return (
    <Drawer.Backdrop isOpen={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Drawer.Content placement="right" className={width}>
        <Drawer.Dialog aria-label={title}>
          <Drawer.CloseTrigger />
          <Drawer.Header>
            <Drawer.Heading>{title}</Drawer.Heading>
          </Drawer.Header>
          <Drawer.Body>{children}</Drawer.Body>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}

// ---- Page scaffolding ----

/** 列表页头部：标题 + 描述 + 右侧动作区，样式全部走 HeroUI Typography 默认。 */
export function PageHeader({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex flex-col gap-1">
        <Heading level={5}>{title}</Heading>
        <Paragraph color="muted" size="sm">
          {description}
        </Paragraph>
      </div>
      {action}
    </div>
  );
}

/** 列表页骨架：头部 + 内容（表格/加载态），页面不再额外包 Card，让表格保持 HeroUI 默认外观。 */
export function PageShell({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-5">{children}</div>;
}

// ---- Table helpers ----

export function TableLoading() {
  return (
    <div className="flex justify-center py-10">
      <Spinner />
    </div>
  );
}

export function emptyState(text: string) {
  return () => <EmptyState className="py-10 text-center">{text}</EmptyState>;
}

// ---- Buttons ----

/** Row-action button for tables: HeroUI ghost sm 默认外观，danger 仅换色。 */
export function RowButton({
  danger,
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "className"> & { danger?: boolean; className?: string }) {
  return <Button variant="ghost" size="sm" className={cn(danger && "text-danger", className)} {...props} />;
}

export function SubmitButton({
  isPending,
  isDisabled,
  children,
}: {
  isPending?: boolean;
  isDisabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Button type="submit" isPending={isPending} isDisabled={isDisabled}>
      {({ isPending: pending }) => (
        <>
          {pending ? <Spinner size="sm" /> : null}
          {children}
        </>
      )}
    </Button>
  );
}
