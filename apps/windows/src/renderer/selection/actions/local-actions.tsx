/**
 * L1 本地动作：不进模型，瞬时生效。
 *
 * 文件名是 .tsx 而非 .ts：动作自带图标节点（lucide）。
 */
import { Copy, Quote } from 'lucide-react';
import { hasQuoteSink } from '../quote-bridge';
import type { SelectionAction } from './types';
export const localActions: readonly SelectionAction[] = [
    {
        id: 'quote',
        label: '引用',
        icon: <Quote size={14}/>,
        surface: 'both',
        // 引用置首位：它是划词后最高频的动作，也是这个功能真正的价值所在
        barOrder: 0,
        tier: 'local',
        isEnabled: () => hasQuoteSink(),
        disabledReason: '打开对话页后可用',
        run: (ctx, api) => {
            api.appendQuote({ text: ctx.text, title: ctx.source.title, role: ctx.source.role });
            api.close();
        },
    },
    {
        id: 'copy',
        label: '复制',
        icon: <Copy size={14}/>,
        surface: 'both',
        // 0 与 30 之间留给 P1 的翻译(10)、解释(20)
        barOrder: 30,
        tier: 'local',
        run: async (ctx, api) => {
            await api.copy(ctx.text);
            api.close();
        },
    },
];
