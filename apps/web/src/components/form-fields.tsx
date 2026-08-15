import type { Control, FieldPath, FieldValues } from "react-hook-form";
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface NumberFieldProps<T extends FieldValues> {
  control: Control<T>;
  name: FieldPath<T>;
  label: string;
  description?: string;
  min?: number;
  max?: number;
  className?: string;
}

/** Numeric form field: keeps undefined while empty so z.number() reports "请输入X". */
export function NumberField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  min,
  max,
  className,
}: NumberFieldProps<T>) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              type="number"
              min={min}
              max={max}
              value={field.value ?? ""}
              onChange={(e) => {
                const n = e.target.valueAsNumber;
                field.onChange(e.target.value === "" || Number.isNaN(n) ? undefined : n);
              }}
            />
          </FormControl>
          {description ? <FormDescription>{description}</FormDescription> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

export interface SelectFieldProps<T extends FieldValues> {
  control: Control<T>;
  name: FieldPath<T>;
  label: string;
  description?: string;
  placeholder?: string;
  options: { value: string; label: string }[];
  /** Adds an explicit "empty" option that maps back to undefined in form state. */
  allowEmpty?: boolean;
  emptyLabel?: string;
  className?: string;
}

/** Sentinel Select value that maps to undefined in form state. */
export const EMPTY_SELECT_VALUE = "__none__";

const EMPTY_VALUE = EMPTY_SELECT_VALUE;

export function SelectField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  placeholder,
  options,
  allowEmpty,
  emptyLabel = "不指定",
  className,
}: SelectFieldProps<T>) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <FormLabel>{label}</FormLabel>
          <Select
            value={field.value === undefined || field.value === null ? undefined : String(field.value)}
            onValueChange={(v) => field.onChange(v === EMPTY_VALUE ? undefined : v)}
          >
            <FormControl>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={placeholder ?? "请选择"} />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {allowEmpty ? <SelectItem value={EMPTY_VALUE}>{emptyLabel}</SelectItem> : null}
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {description ? <FormDescription>{description}</FormDescription> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
