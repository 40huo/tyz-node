import {
  Button,
  Card,
  Chip,
  Description,
  Drawer,
  EmptyState,
  FieldError,
  Form,
  Heading,
  Input,
  InputGroup,
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
  Tooltip,
  toast,
} from "@heroui/react";
import { IconEye, IconEyeOff } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ComponentProps, type ReactNode, useCallback, useRef, useState } from "react";

export const fail = (error: unknown) => toast.danger(error instanceof Error ? error.message : "操作失败");

export const cn = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

/** 数据值（ID/地址/端口/流量/时间戳）：正常字体；tabular-nums 让表格数字等宽，刷新时不抖动。 */
export function DataText({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn("text-xs tabular-nums", className)}>{children}</span>;
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
    // secondary（灰底填充）：表单都在 Modal/Card 的白色 surface 上，主题的 field 又是白底透明边，
    // primary 会完全融进背景；放在 spread 前允许个别场景覆盖回 primary
    <TextField variant="secondary" {...props} isInvalid={!!error} className={cn("w-full", className)}>
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
  placeholder,
  suffix,
  className,
  ...props
}: Omit<ComponentProps<typeof NumberField>, "className"> & {
  label: string;
  error?: string;
  hint?: string;
  placeholder?: string;
  /** 单位后缀（如 "Mb/s"）：渲染在输入框右侧的静态文本，locale 无关。 */
  suffix?: string;
  className?: string;
}) {
  return (
    // formatOptions 放在 spread 前：默认关掉千分位分组（端口/字节等输入值不该出现 16,900），调用方仍可覆盖；
    // variant=secondary 同 TextForm 的说明
    <NumberField
      formatOptions={{ useGrouping: false }}
      variant="secondary"
      {...props}
      isInvalid={!!error}
      className={cn("w-full", className)}
    >
      <Label>{label}</Label>
      {/* Group 默认按 40px|1fr|40px 给步进按钮预留轨道；不渲染按钮时输入框会落进 40px 首轨被截成 ~1 个字符， */}
      {/* 塌缩为单列让输入框占满整行（工具类在 utilities 层，可覆盖 components 层的组件样式） */}
      <NumberField.Group className={cn("[grid-template-columns:1fr]", suffix && "[grid-template-columns:1fr_auto]")}>
        <NumberField.Input placeholder={placeholder} className="w-full" />
        {suffix ? (
          <span className="text-muted select-none pr-2 text-sm" aria-hidden>
            {suffix}
          </span>
        ) : null}
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
      variant="secondary"
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

// ---- Brand（顶栏/抽屉/登录卡片共用） ----

/** 品牌 mark：双箭头转发符号，与 favicon 同款；颜色跟随 accent 主题 token。 */
export function BrandMark() {
  return (
    <div className="flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
      <svg
        viewBox="0 0 32 32"
        className="size-[17px]"
        fill="none"
        stroke="currentColor"
        strokeWidth={3.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        role="img"
      >
        <title>TYZ</title>
        <path d="M11 10l6 6-6 6M19 10l6 6-6 6" />
      </svg>
    </div>
  );
}

export function Brand({ collapsed }: { collapsed?: boolean }) {
  return (
    <div className={cn("flex items-center gap-2.5", collapsed && "justify-center")}>
      <BrandMark />
      {!collapsed && <span className="font-semibold">TYZ 控制台</span>}
    </div>
  );
}

// ---- Auth pages (login / setup) ----

/** 登录/初始化页外壳：网格背景 + 居中高亮卡片（overlay 级投影），站点品牌在卡片内。 */
export function AuthCard({ description, children }: { description: string; children: ReactNode }) {
  return (
    <div className="login-backdrop flex min-h-dvh items-center justify-center bg-background p-4 text-foreground">
      <Card className="w-full max-w-sm gap-5 p-8 shadow-overlay">
        <Card.Header className="items-center gap-3 text-center">
          <Brand />
          <Card.Description>{description}</Card.Description>
        </Card.Header>
        <Card.Content>{children}</Card.Content>
      </Card>
    </div>
  );
}

/**
 * 带左侧图标的认证输入框（登录/初始化页专用）：`reveal` 为密码框附加右侧
 * 眼睛按钮切换明文。视觉走 InputGroup（prefix/suffix 插槽），主题边框/焦点态
 * 由 group 承载。
 */
export function IconTextField({
  label,
  icon,
  reveal = false,
  error,
  hint,
  placeholder,
  inputProps,
  className,
  ...props
}: Omit<ComponentProps<typeof TextField>, "className" | "children"> & {
  label: string;
  icon: ReactNode;
  reveal?: boolean;
  error?: string;
  hint?: string;
  placeholder?: string;
  inputProps?: ComponentProps<typeof InputGroup.Input>;
  className?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <TextField variant="secondary" {...props} isInvalid={!!error} className={cn("w-full", className)}>
      <Label>{label}</Label>
      <InputGroup variant="secondary">
        <InputGroup.Prefix>{icon}</InputGroup.Prefix>
        <InputGroup.Input
          {...inputProps}
          type={reveal ? (show ? "text" : "password") : inputProps?.type}
          placeholder={placeholder}
        />
        {reveal && (
          <InputGroup.Suffix className="px-1">
            <Button
              isIconOnly
              variant="ghost"
              size="sm"
              className="size-7 text-muted"
              aria-label={show ? "隐藏密码" : "显示密码"}
              onPress={() => setShow((v) => !v)}
            >
              {show ? <IconEyeOff size={16} stroke={2} /> : <IconEye size={16} stroke={2} />}
            </Button>
          </InputGroup.Suffix>
        )}
      </InputGroup>
      {error ? <FieldError>{error}</FieldError> : hint ? <Description>{hint}</Description> : null}
    </TextField>
  );
}

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

/** 表格加载态：顶部 spin 加载提示 + 骨架行占位（骨架保持布局稳定，避免加载完成后跳动）。 */
export function TableLoading({ rows = 6 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2.5 py-2">
      <div className="flex items-center justify-center gap-2 py-1 text-sm text-muted">
        <Spinner size="sm" />
        加载中…
      </div>
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

/**
 * 全站统一的状态 Chip：文案与色值由 labels.ts 的映射提供。
 * 传 `title` 时以 HeroUI Tooltip 呈现悬停说明（原生 title 是系统样式、延迟高且不可换行，不用）。
 */
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
  const chip = (
    <Chip color={tone} variant="soft" size="sm" className={className}>
      <Chip.Label className="flex items-center gap-1">
        {icon}
        {children}
      </Chip.Label>
    </Chip>
  );
  if (title === undefined) return chip;
  return (
    <Tooltip delay={0}>
      {/* RAC 的 TooltipTrigger 把 hover 处理器放在 FocusableProvider context 里，只有消费
          context 的组件（Button、Tooltip.Trigger）能收到；Chip 不消费，必须经 Tooltip.Trigger 桥接 */}
      <Tooltip.Trigger>{chip}</Tooltip.Trigger>
      <Tooltip.Content>
        <p>{title}</p>
      </Tooltip.Content>
    </Tooltip>
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

/**
 * 列表筛选下拉：无可见 Label（aria-label 提供），选项自带“全部”哨兵值；
 * variant 与 SearchField 一样走默认 primary（工具栏在页面底色上，primary 是标准描边形态）。
 */
export function FilterSelect<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  /** 无障碍标签（aria-label）。 */
  label: string;
  className?: string;
}) {
  return (
    <Select
      aria-label={label}
      value={value}
      onChange={(key) => {
        if (key !== null) onChange(key as T);
      }}
      className={cn("w-40 shrink-0", className)}
    >
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox selectionMode="single">
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

/** 工具栏文字按钮：图标 + 文案（重置/刷新），tertiary 灰底与搜索框同行；`spinning` 让图标持续旋转（刷新随请求状态）。 */
export function ToolbarButton({
  icon,
  spinning = false,
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "children" | "className"> & {
  icon: ReactNode;
  spinning?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Button variant="tertiary" className={cn("shrink-0", className)} {...props}>
      {spinning ? <span className="inline-flex animate-spin">{icon}</span> : icon}
      {children}
    </Button>
  );
}

/** 列表页工具栏：靠左依次为 搜索 → 筛选 → 重置 → 刷新，右侧 `action` 放新建入口（全站约定；窄屏自动换行）。 */
export function ListToolbar({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      {action !== undefined && <div className="ml-auto shrink-0">{action}</div>}
    </div>
  );
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

const ICON_ACTION_TONES = {
  default: { variant: "tertiary", className: "" },
  success: { variant: "tertiary", className: "text-success" },
  warning: { variant: "tertiary", className: "text-warning" },
  danger: { variant: "danger-soft", className: "" },
} as const;

/**
 * 表格行内图标动作：带底色圆圈（tertiary 灰底 / danger-soft 红底）+ 悬停提示说明用途
 * （HeroUI Button 直接就是合法的 Tooltip trigger）。主题 radius 是 small 档，
 * icon-only 默认是圆角方块，rounded-full 才是官网示例的圆圈形态。
 */
export function IconAction({
  label,
  icon,
  tone = "default",
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "children" | "className"> & {
  label: string;
  icon: ReactNode;
  tone?: keyof typeof ICON_ACTION_TONES;
  className?: string;
}) {
  const conf = ICON_ACTION_TONES[tone];
  return (
    <Tooltip delay={0}>
      <Button
        isIconOnly
        variant={conf.variant}
        size="sm"
        aria-label={label}
        className={cn("rounded-full", conf.className, className)}
        {...props}
      >
        {icon}
      </Button>
      <Tooltip.Content>
        <p>{label}</p>
      </Tooltip.Content>
    </Tooltip>
  );
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
