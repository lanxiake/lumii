// UI Components - @mtbot/ui
// 统一的 UI 组件库导出

// ========== Basic Components ==========

// Button
export { default as Button } from './Button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './Button';

// Input
export { default as Input } from './Input';
export type { InputProps } from './Input';

// Modal
export { default as Modal } from './Modal';
export type { ModalProps } from './Modal';

// Card
export { default as Card } from './Card';
export type { CardProps } from './Card';

// Select
export { default as Select } from './Select';
export type { SelectProps, SelectOption } from './Select';

// Loading
export { default as Loading } from './Loading';
export type { LoadingProps, LoadingSize } from './Loading';

// Empty
export { default as Empty } from './Empty';
export type { EmptyProps } from './Empty';

// PageHeader
export { PageHeader, type PageHeaderProps } from './PageHeader';

// ErrorBanner
export { ErrorBanner, type ErrorBannerProps } from './ErrorBanner';

// ========== Form Components (NEW) ==========

// Checkbox
export { Checkbox } from './Checkbox/Checkbox';
export type { CheckboxProps } from './Checkbox/Checkbox';

// Switch
export { Switch } from './Switch/Switch';
export type { SwitchProps } from './Switch/Switch';

// ========== Feedback Components (NEW) ==========

// Tooltip
export { Tooltip } from './Tooltip/Tooltip';
export type { TooltipProps, TooltipPlacement, TooltipTrigger } from './Tooltip/Tooltip';

// Toast
export { ToastProvider as ToastContainer } from './Toast/ToastContainer';
export { useToast } from './Toast/useToast';
export type { UseToastReturn } from './Toast/useToast';
export type { ToastType, ToastItem } from './Toast/ToastContext';

// Badge
export { Badge } from './Badge/Badge';
export type { BadgeProps } from './Badge/Badge';

// ========== Data Display Components (NEW) ==========

// Tag
export { Tag } from './Tag/Tag';
export type { TagProps } from './Tag/Tag';
