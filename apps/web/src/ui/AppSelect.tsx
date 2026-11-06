import { Label, ListBox, Select } from '@heroui/react';

/** Shared single-value selector for page and plugin controls. */
export function AppSelect({ label, value, options, onChange, placeholder, disabled, className }: {
  label: string;
  value: string;
  options: readonly { id: string; label: string }[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  return <Select className={className ?? 'min-w-0 w-full'} aria-label={label} placeholder={placeholder}
    selectedKey={value || null} onSelectionChange={key => { if (key != null) onChange(String(key)); }} isDisabled={disabled}>
    <Label>{label}</Label>
    <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
    <Select.Popover><ListBox>{options.map(option => <ListBox.Item key={option.id} id={option.id} textValue={option.label}>
      {option.label}<ListBox.ItemIndicator />
    </ListBox.Item>)}</ListBox></Select.Popover>
  </Select>;
}
