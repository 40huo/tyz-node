import {
  Button,
  Chip,
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
  Pagination,
  Paragraph,
  SearchField,
  Select,
  Skeleton,
  Spinner,
  TextArea,
  TextField,
  toast,
} from "@heroui/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
      {/* Group 默认按 40px|1fr|40px 给步进按钮预留轨道；不渲染按钮时输入框会落进 40px 首轨被截成 ~1 个字符， */}
      {/* 塌缩为单列让输入框占满整行（工具类在 utilities 层，可覆盖 components 层的组件样式） */}
      <NumberField.Group className="[grid-template-columns:1fr]">
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
  width = "min(48rem, 100vw)",
  children,
}: {
  title: string;
  isOpen: boolean;
  onClose: () => void;
  /** CSS width，作用于右侧抽屉面板本体。 */
  width?: string;
  children: ReactNode;
}) {
  return (
    <Drawer.Backdrop isOpen={isOpen} onOpenChange={(open) => !open && onClose()}>
      {/* Content 是全屏 fixed 定位容器（inset:0），宽度必须设在 Dialog 面板上；
          且 HeroUI 用 `.drawer__dialog[data-placement=right]` 媒体查询定默认宽（属性
          选择器特异性高于工具类），所以用内联 style 覆盖而不是 className。 */}
      <Drawer.Content placement="right">
        <Drawer.Dialog aria-label={title} style={{ width }}>
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

const SKELETON_ROW_IDS = Array.from({ length: 12 }, (_, i) => i + 1);

/** 表格加载态：骨架行占位（替代居中 Spinner，避免加载完成后布局跳动）。纯视觉占位。 */
export function TableLoading({ rows = 6 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2.5 py-2">
      {SKELETON_ROW_IDS.slice(0, rows).map((n) => (
        <Skeleton key={n} className="h-9 w-full rounded-md" />
      ))}
    </div>
  );
}

/** 查询失败态：区分于空态，提供重试入口。 */
export function TableError({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border py-10">
      <p className="text-sm text-muted">加载失败，请稍后重试</p>
      {onRetry !== undefined && (
        <Button size="sm" variant="tertiary" onPress={onRetry}>
          重试
        </Button>
      )}
    </div>
  );
}

/** 客户端分页（列表行数有限，直接数字页码）。 */
export function Pager({
  page,
  pageCount,
  onChange,
}: {
  page: number;
  pageCount: number;
  onChange: (page: number) => void;
}) {
  if (pageCount <= 1) return null;
  return (
    <Pagination size="sm" className="mt-3 justify-center">
      <Pagination.Content>
        <Pagination.Item>
          <Pagination.Previous isDisabled={page === 1} onPress={() => onChange(page - 1)}>
            <Pagination.PreviousIcon />
          </Pagination.Previous>
        </Pagination.Item>
        {Array.from({ length: pageCount }, (_, i) => i + 1).map((p) => (
          <Pagination.Item key={p}>
            <Pagination.Link isActive={p === page} onPress={() => onChange(p)}>
              {p}
            </Pagination.Link>
          </Pagination.Item>
        ))}
        <Pagination.Item>
          <Pagination.Next isDisabled={page === pageCount} onPress={() => onChange(page + 1)}>
            <Pagination.NextIcon />
          </Pagination.Next>
        </Pagination.Item>
      </Pagination.Content>
    </Pagination>
  );
}

export function emptyState(text: string) {
  return () => <EmptyState className="py-10 text-center">{text}</EmptyState>;
}

// ---- Status / toolbar ----

export type ChipTone = ComponentProps<typeof Chip>["color"];

/** 全站统一的状态 Chip：文案与色值由 labels.ts 的映射提供。 */
export function StatusChip({
  tone = "default",
  icon,
  title,
  className,
  children,
}: {
  tone?: ChipTone;
  icon?: ReactNode;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Chip color={tone} variant="soft" size="sm" className={className} title={title}>
      <Chip.Label className="flex items-center gap-1">
        {icon}
        {children}
      </Chip.Label>
    </Chip>
  );
}

/** 列表页搜索框。 */
export function SearchInput({
  value,
  onChange,
  placeholder = "搜索",
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <SearchField aria-label={placeholder} value={value} onChange={onChange} className={cn("w-full sm:w-60", className)}>
      <SearchField.Group>
        <SearchField.SearchIcon />
        <SearchField.Input placeholder={placeholder} />
        <SearchField.ClearButton />
      </SearchField.Group>
    </SearchField>
  );
}

/** 状态筛选 chip 组：value 为当前选中项（含“全部”哨兵值）。 */
export function FilterChips<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {options.map((option) => (
        <Button
          key={option.value}
          variant="ghost"
          size="sm"
          className={cn(
            "h-8 rounded-full px-3 font-normal",
            option.value === value && "bg-accent-soft font-medium text-accent-soft-foreground",
          )}
          onPress={() => onChange(option.value)}
        >
          {option.label}
          {option.count !== undefined && <span className="text-xs opacity-70">{option.count}</span>}
        </Button>
      ))}
    </div>
  );
}

/** 列表页工具栏：搜索 + 筛选 chip 的水平容器。 */
export function ListToolbar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

// ---- CRUD helpers ----

/**
 * 表单弹窗的 create/update 统一 mutation：成功后失效缓存并关闭弹窗。
 * Node 的 onCreated 用于承接 create 返回的一次性令牌。
 */
export function useCrudMutation<TInput, TCreateResult = unknown>(options: {
  invalidateKeys: unknown[][];
  create: (input: TInput) => Promise<TCreateResult>;
  update: (id: number, input: TInput) => Promise<unknown>;
  onCreated?: (result: TCreateResult) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const settle = () => {
    for (const key of options.invalidateKeys) queryClient.invalidateQueries({ queryKey: key });
    options.onClose();
  };
  const createMutation = useMutation({
    mutationFn: options.create,
    onSuccess: (result) => {
      settle();
      options.onCreated?.(result);
    },
    onError: fail,
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, input }: { id: number; input: TInput }) => options.update(id, input),
    onSuccess: settle,
    onError: fail,
  });
  const save = (id: number | null, input: TInput) => {
    if (id === null) createMutation.mutate(input);
    else updateMutation.mutate({ id, input });
  };
  return { save, isPending: createMutation.isPending || updateMutation.isPending };
}

/** 表单底部按钮行：取消 + 提交（各表单弹窗统一）。 */
export function FormFooter({
  onCancel,
  isPending,
  label = "保存",
}: {
  onCancel: () => void;
  isPending: boolean;
  label?: string;
}) {
  return (
    <div className="flex justify-end gap-2">
      <Button variant="tertiary" onPress={onCancel}>
        取消
      </Button>
      <SubmitButton isPending={isPending}>{label}</SubmitButton>
    </div>
  );
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
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "className" | "children"> & {
  isPending?: boolean;
  isDisabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Button type="submit" isPending={isPending} isDisabled={isDisabled} className={className} {...props}>
      {({ isPending: pending }) => (
        <>
          {pending ? <Spinner size="sm" /> : null}
          {children}
        </>
      )}
    </Button>
  );
}
