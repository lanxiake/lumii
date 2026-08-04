/**
 * Breakpoints Design Tokens
 * 响应式断点设计令牌
 */

export const breakpoints = {
  sm: '640px',
  md: '768px',
  lg: '1024px',
  xl: '1280px',
  '2xl': '1536px',
} as const;

export type Breakpoints = typeof breakpoints;
export type BreakpointKey = keyof typeof breakpoints;

// Numeric values for calculations
export const breakpointValues = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  '2xl': 1536,
} as const;

// Media query helpers
export const mediaQueries = {
  sm: `(min-width: ${breakpoints.sm})`,
  md: `(min-width: ${breakpoints.md})`,
  lg: `(min-width: ${breakpoints.lg})`,
  xl: `(min-width: ${breakpoints.xl})`,
  '2xl': `(min-width: ${breakpoints['2xl']})`,
} as const;

// Helper to check if current viewport is at least a breakpoint
export function isAbove(breakpoint: BreakpointKey, width: number): boolean {
  return width >= breakpointValues[breakpoint];
}

// Helper to check if current viewport is below a breakpoint
export function isBelow(breakpoint: BreakpointKey, width: number): boolean {
  return width < breakpointValues[breakpoint];
}
