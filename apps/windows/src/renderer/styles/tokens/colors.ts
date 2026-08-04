/**
 * Colors Design Tokens
 * 颜色设计令牌
 *
 * 基于现有的CSS变量扩展:
 * --color-primary: #6366f1
 * --color-secondary: #64748b
 * --color-success: #22c55e
 * --color-warning: #f59e0b
 * --color-error: #ef4444
 * --bg-primary: #0f172a
 * --bg-secondary: #1e293b
 * --bg-tertiary: #334155
 * --text-primary: #f8fafc
 * --text-secondary: #94a3b8
 */

export const colors = {
  // Primary - Indigo
  primary: {
    50: '#eef2ff',
    100: '#e0e7ff',
    200: '#c7d2fe',
    300: '#a5b4fc',
    400: '#818cf8',
    500: '#6366f1', // 现有 --color-primary
    600: '#4f46e5', // 现有 --color-primary-hover
    700: '#4338ca',
    800: '#3730a3',
    900: '#312e81',
    950: '#1e1b4b',
  },

  // Semantic Colors
  success: {
    light: '#86efac',
    DEFAULT: '#22c55e', // 现有 --color-success
    dark: '#15803d',
  },
  warning: {
    light: '#fde047',
    DEFAULT: '#f59e0b', // 现有 --color-warning
    dark: '#b45309',
  },
  error: {
    light: '#fca5a5',
    DEFAULT: '#ef4444', // 现有 --color-error
    dark: '#b91c1c',
  },
  info: {
    light: '#93c5fd',
    DEFAULT: '#3b82f6',
    dark: '#1d4ed8',
  },

  // Grayscale - Slate
  gray: {
    50: '#f8fafc',
    100: '#f1f5f9',
    200: '#e2e8f0',
    300: '#cbd5e1',
    400: '#94a3b8', // 现有 --text-secondary
    500: '#64748b', // 现有 --color-secondary
    600: '#475569', // 现有 --bg-hover
    700: '#334155', // 现有 --bg-tertiary / --border-color
    800: '#1e293b', // 现有 --bg-secondary
    900: '#0f172a', // 现有 --bg-primary
    950: '#020617',
  },

  // Background Colors
  background: {
    primary: '#0f172a', // 现有 --bg-primary
    secondary: '#1e293b', // 现有 --bg-secondary
    tertiary: '#334155', // 现有 --bg-tertiary
    elevated: '#1e293b', // 现有 --bg-secondary
    overlay: 'rgba(0, 0, 0, 0.5)',
  },

  // Text Colors
  text: {
    primary: '#f8fafc', // 现有 --text-primary
    secondary: '#94a3b8', // 现有 --text-secondary
    tertiary: '#64748b', // 现有 --text-muted
    disabled: '#475569',
    inverse: '#0f172a',
  },

  // Border Colors
  border: {
    DEFAULT: '#334155', // 现有 --border-color
    light: '#475569',
    dark: '#1e293b',
  },
} as const;

export type Colors = typeof colors;

// Legacy color mappings for backward compatibility
export const legacyColors = {
  primary: colors.primary[500],
  primaryHover: colors.primary[600],
  secondary: colors.gray[500],
  success: colors.success.DEFAULT,
  warning: colors.warning.DEFAULT,
  error: colors.error.DEFAULT,
  bgPrimary: colors.background.primary,
  bgSecondary: colors.background.secondary,
  bgTertiary: colors.background.tertiary,
  bgHover: colors.gray[600],
  textPrimary: colors.text.primary,
  textSecondary: colors.text.secondary,
  textMuted: colors.text.tertiary,
  borderColor: colors.border.DEFAULT,
} as const;
