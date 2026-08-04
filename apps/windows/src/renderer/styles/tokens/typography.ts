/**
 * Typography Design Tokens
 * 字体设计令牌
 *
 * 扩展现有字体系统:
 * --font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif
 * --font-size-sm: 12px
 * --font-size-md: 14px
 * --font-size-lg: 16px
 */

export const typography = {
  fontFamily: {
    sans: ["'Segoe UI'", "'Microsoft YaHei'", 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Roboto', 'sans-serif'].join(', '),
    mono: ["'JetBrains Mono'", "'Fira Code'", 'Consolas', 'Monaco', 'monospace'].join(', '),
  },

  fontSize: {
    xs: ['12px', { lineHeight: '16px' }], // --font-size-sm
    sm: ['14px', { lineHeight: '20px' }], // --font-size-md
    base: ['16px', { lineHeight: '24px' }], // --font-size-lg
    lg: ['18px', { lineHeight: '28px' }],
    xl: ['20px', { lineHeight: '28px' }],
    '2xl': ['24px', { lineHeight: '32px' }],
    '3xl': ['30px', { lineHeight: '36px' }],
    '4xl': ['36px', { lineHeight: '40px' }],
    '5xl': ['48px', { lineHeight: '48px' }],
  },

  fontWeight: {
    thin: '100',
    extralight: '200',
    light: '300',
    normal: '400',
    medium: '500',
    semibold: '600',
    bold: '700',
    extrabold: '800',
    black: '900',
  },

  lineHeight: {
    none: '1',
    tight: '1.25',
    snug: '1.375',
    normal: '1.5',
    relaxed: '1.625',
    loose: '2',
  },

  letterSpacing: {
    tighter: '-0.05em',
    tight: '-0.025em',
    normal: '0em',
    wide: '0.025em',
    wider: '0.05em',
    widest: '0.1em',
  },
} as const;

export type Typography = typeof typography;

// Legacy typography mappings for backward compatibility
export const legacyTypography = {
  fontFamily: typography.fontFamily.sans,
  fontSizeSm: typography.fontSize.xs[0], // 12px
  fontSizeMd: typography.fontSize.sm[0], // 14px
  fontSizeLg: typography.fontSize.base[0], // 16px
} as const;

// Helper types
export type FontSizeKey = keyof typeof typography.fontSize;
export type FontWeightKey = keyof typeof typography.fontWeight;
