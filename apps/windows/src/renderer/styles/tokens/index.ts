/**
 * Design Tokens Index
 * 设计令牌统一导出
 *
 * Usage:
 * import { colors, spacing, typography } from '@/styles/tokens';
 * import { tokens } from '@/styles/tokens';
 */

// Import all tokens
import { colors, legacyColors } from './colors';
import { spacing, legacySpacing, getSpacing } from './spacing';
import { typography, legacyTypography } from './typography';
import { shadows } from './shadows';
import { radius, legacyRadius } from './radius';
import { transitions, transitionPresets } from './transitions';
import { zIndex, getZIndex } from './z-index';
import { breakpoints, breakpointValues, mediaQueries, isAbove, isBelow } from './breakpoints';

// Re-export types
export type { Colors } from './colors';
export type { Spacing, SpacingKey } from './spacing';
export type { Typography, FontSizeKey, FontWeightKey } from './typography';
export type { Shadows, ShadowKey } from './shadows';
export type { Radius, RadiusKey } from './radius';
export type { Transitions } from './transitions';
export type { ZIndex, ZIndexKey } from './z-index';
export type { Breakpoints, BreakpointKey } from './breakpoints';

// Re-export values
export { colors, legacyColors };
export { spacing, legacySpacing, getSpacing };
export { typography, legacyTypography };
export { shadows };
export { radius, legacyRadius };
export { transitions, transitionPresets };
export { zIndex, getZIndex };
export { breakpoints, breakpointValues, mediaQueries, isAbove, isBelow };

// Unified tokens object
export const tokens = {
  colors,
  spacing,
  typography,
  shadows,
  radius,
  transitions,
  zIndex,
  breakpoints,
} as const;

export type Tokens = typeof tokens;

// Legacy tokens for backward compatibility
export const legacyTokens = {
  colors: legacyColors,
  spacing: legacySpacing,
  typography: legacyTypography,
  radius: legacyRadius,
} as const;
