/**
 * Transitions Design Tokens
 * 过渡动画设计令牌
 */

export const transitions = {
  duration: {
    fast: '100ms',
    normal: '200ms',
    slow: '300ms',
    slower: '500ms',
  },
  easing: {
    default: 'cubic-bezier(0.4, 0, 0.2, 1)',
    in: 'cubic-bezier(0.4, 0, 1, 1)',
    out: 'cubic-bezier(0, 0, 0.2, 1)',
    bounce: 'cubic-bezier(0.68, -0.55, 0.265, 1.55)',
  },
} as const;

export type Transitions = typeof transitions;

// Pre-built transition combinations
export const transitionPresets = {
  fast: `${transitions.duration.fast} ${transitions.easing.default}`,
  normal: `${transitions.duration.normal} ${transitions.easing.default}`,
  slow: `${transitions.duration.slow} ${transitions.easing.default}`,
  bounce: `${transitions.duration.normal} ${transitions.easing.bounce}`,
} as const;
