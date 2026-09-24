import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { PetControlDock, type PetControlDockProps } from './PetControlDock';
function makeProps(overrides: Partial<PetControlDockProps> = {}): PetControlDockProps {
    return {
        voiceState: 'idle',
        partialTranscript: '',
        messages: [],
        muted: false,
        voiceReplyEnabled: false,
        idleMotionEnabled: true,
        modelLoaded: true,
        models: [],
        currentModelId: 'demo_cartoon_cat',
        onStartVoice: vi.fn(),
        onStopVoice: vi.fn(),
        onToggleMute: vi.fn(),
        onToggleVoiceReply: vi.fn(),
        onChangeModel: vi.fn(),
        onClose: vi.fn(),
        onSendText: vi.fn(),
        autoMuteMicWhileSpeaking: true,
        vadThreshold: 0.5,
        energyGateMultiplier: 1,
        onChangeVoiceSetting: vi.fn(),
        ...overrides,
    };
}
describe('PetControlDock — 气质标签', () => {
    it('传入标签时渲染在标题栏里', () => {
        render(<PetControlDock {...makeProps({ personalityLabel: '好奇，但有点怕生' })}/>);
        expect(screen.getByText(/好奇，但有点怕生/)).toBeInTheDocument();
    });
    it('标签与「虚拟人」同处一行——它是身份说明，不是一条独立消息', () => {
        render(<PetControlDock {...makeProps({ personalityLabel: '很黏人' })}/>);
        const label = screen.getByText(/很黏人/);
        const row = label.closest('span')?.parentElement;
        expect(row?.textContent).toContain('虚拟人');
    });
    it('未传 / 传 null 时不渲染任何标签文案（不凭空编一个脾气）', () => {
        const { container: a } = render(<PetControlDock {...makeProps()}/>);
        expect(a.textContent).not.toMatch(/脾气|null|undefined/);
        const { container: b } = render(<PetControlDock {...makeProps({ personalityLabel: null })}/>);
        expect(b.textContent).not.toMatch(/脾气|null|undefined/);
    });
    it('标签里不出现数字——§3.6 禁止把五维数值展示给用户', () => {
        render(<PetControlDock {...makeProps({ personalityLabel: '心思敏感，但比较随性' })}/>);
        const label = screen.getByText(/心思敏感/);
        expect(label.textContent).not.toMatch(/[0-9]/);
    });
});
