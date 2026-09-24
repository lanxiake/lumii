import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { PetContextMenu, type PetContextMenuProps } from './PetContextMenu';
import type { PetModelConfigDTO } from '../../../shared/pet-mode';
/** 只填 PetContextMenu 用得到的字段，其余照类型补齐（多出来的必填项与用例无关） */
function makeModel(id: string, name: string): PetModelConfigDTO {
    return {
        id,
        name,
        rendererType: 'sprite',
        modelUrl: `lumii-pet://model/${id}`,
        scale: 1,
        idleMotionGroup: 'Idle',
        talkMotionGroup: 'Talk',
        emotionMap: {},
        tapMotions: {},
        defaultExpression: 0,
    };
}
function makeProps(overrides: Partial<PetContextMenuProps> = {}): PetContextMenuProps {
    return {
        x: 100,
        y: 100,
        voiceState: 'idle',
        muted: false,
        voiceReplyEnabled: false,
        models: [makeModel('cat', '猫'), makeModel('dog', '狗')],
        currentModelId: 'cat',
        dockOpen: false,
        onStartVoice: vi.fn(),
        onStopVoice: vi.fn(),
        onToggleMute: vi.fn(),
        onToggleVoiceReply: vi.fn(),
        onChangeModel: vi.fn(),
        onToggleDock: vi.fn(),
        onExit: vi.fn(),
        onClose: vi.fn(),
        ...overrides,
    };
}
describe('PetContextMenu 的点后行为', () => {
    it('点「静音」：切开关，菜单留着', () => {
        const props = makeProps();
        render(<PetContextMenu {...props}/>);
        fireEvent.click(screen.getByRole('button', { name: '静音' }));
        expect(props.onToggleMute).toHaveBeenCalledTimes(1);
        expect(props.onClose).not.toHaveBeenCalled();
    });
    it('点「文字回复朗读」：切开关，菜单留着', () => {
        const props = makeProps();
        render(<PetContextMenu {...props}/>);
        fireEvent.click(screen.getByRole('button', { name: '文字回复朗读' }));
        expect(props.onToggleVoiceReply).toHaveBeenCalledTimes(1);
        expect(props.onClose).not.toHaveBeenCalled();
    });
    it('点「开始语音对话」：起呼，菜单留着（只开麦，不跳窗口）', () => {
        const props = makeProps();
        render(<PetContextMenu {...props}/>);
        fireEvent.click(screen.getByRole('button', { name: /开始语音对话/ }));
        expect(props.onStartVoice).toHaveBeenCalledTimes(1);
        expect(props.onClose).not.toHaveBeenCalled();
    });
    it('点「打开对话」：要跳去看面板，菜单必须关', () => {
        const props = makeProps();
        render(<PetContextMenu {...props}/>);
        fireEvent.click(screen.getByRole('button', { name: /打开对话/ }));
        expect(props.onToggleDock).toHaveBeenCalledTimes(1);
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });
    it('点「关闭宠物模式」：整个宠物都要走了，菜单必须关', () => {
        const props = makeProps();
        render(<PetContextMenu {...props}/>);
        fireEvent.click(screen.getByRole('button', { name: /关闭宠物模式/ }));
        expect(props.onExit).toHaveBeenCalledTimes(1);
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });
    it('点「更换宠物」进二级、选中模型：换模型，菜单留在列表里', () => {
        const props = makeProps();
        render(<PetContextMenu {...props}/>);
        fireEvent.click(screen.getByRole('button', { name: /更换宠物/ }));
        // 二级视图里勾选态跟着 currentModelId 走
        expect(screen.getByRole('button', { name: '猫' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: '狗' }));
        expect(props.onChangeModel).toHaveBeenCalledWith('dog');
        expect(props.onClose).not.toHaveBeenCalled();
    });
});
