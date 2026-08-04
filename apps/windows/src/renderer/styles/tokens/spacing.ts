/**
 * Spacing Design Tokens
 * 间距设计令牌
 *
 * 基于4px单位的间距系统
 * 与现有变量映射:
 * --spacing-xs: 4px -> spacing[1]
 * --spacing-sm: 8px -> spacing[2]
 * --spacing-md: 16px -> spacing[4]
 * --spacing-lg: 24px -> spacing[6]
 */

export const spacing = {
  0: '0px',
  0.5: '2px',
  1: '4px', // --spacing-xs
  1.5: '6px',
  2: '8px', // --spacing-sm
  2.5: '10px',
  3: '12px',
  3.5: '14px',
  4: '16px', // --spacing-md
  5: '20px',
  6: '24px', // --spacing-lg
  7: '28px',
  8: '32px',
  9: '36px',
  10: '40px',
  11: '44px',
  12: '48px',
  14: '56px',
  16: '64px',
  20: '80px',
  24: '96px',
  28: '112px',
  32: '128px',
  36: '144px',
  40: '160px',
  44: '176px',
  48: '192px',
  52: '208px',
  56: '224px',
  60: '240px',
  64: '256px',
  72: '288px',
  80: '320px',
  96: '384px',
} as const;

export type Spacing = typeof spacing;

// Legacy spacing mappings for backward compatibility
export const legacySpacing = {
  xs: spacing[1], // 4px
  sm: spacing[2], // 8px
  md: spacing[4], // 16px
  lg: spacing[6], // 24px
} as const;

// Helper type for spacing keys
export type SpacingKey = keyof typeof spacing;

// Helper function to get spacing value
export function getSpacing(key: SpacingKey): string {
  return spacing[key];
}
