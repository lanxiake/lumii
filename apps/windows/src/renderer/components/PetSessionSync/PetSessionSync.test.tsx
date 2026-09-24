import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
const SESSION_KEY = 'local:desktop';
const setSessionThinkingPrefs = vi.fn().mockResolvedValue(undefined);
vi.mock('../../hooks/business/useAgentRuntime/useAgentRuntime', () => ({
    useAgentRuntimeGlobalState: (selector: (s: {
        currentSessionKey: string;
    }) => unknown) => selector({ currentSessionKey: SESSION_KEY }),
    useAgentRuntimeActions: () => ({ setSessionThinkingPrefs }),
}));
// eslint-disable-next-line import/first
import { PetSessionSync } from './PetSessionSync';
const setActiveSessionKey = vi.fn().mockResolvedValue(undefined);
const getFeatureAvailability = vi.fn();
/** Linux 的能力矩阵快照（petMode 因平台屏蔽） */
const LINUX_SNAPSHOT = {
    features: { petMode: { available: false, reason: 'platform-unsupported' as const } },
    messages: {},
};
/** Windows 的能力矩阵快照（全可用） */
const WIN_SNAPSHOT = {
    features: { petMode: { available: true } },
    messages: {},
};
function stubApi(): void {
    ;
    (window as unknown as {
        electronAPI: unknown;
    }).electronAPI = {
        app: { getFeatureAvailability },
        pet: { setActiveSessionKey },
    };
}
beforeEach(() => {
    vi.clearAllMocks();
    getFeatureAvailability.mockResolvedValue(LINUX_SNAPSHOT);
    stubApi();
});
describe('PetSessionSync 的 pet:* 短路', () => {
    it('屏蔽平台上不发 pet IPC，但 thinking 偏好照发', async () => {
        render(<PetSessionSync />);
        await waitFor(() => expect(setSessionThinkingPrefs).toHaveBeenCalledWith(SESSION_KEY, expect.anything()));
        expect(setActiveSessionKey).not.toHaveBeenCalled();
    });
    it('可用平台上照发（会话跟随是宠物窗口的前提，不能一并挡死）', async () => {
        getFeatureAvailability.mockResolvedValue(WIN_SNAPSHOT);
        render(<PetSessionSync />);
        await waitFor(() => expect(setActiveSessionKey).toHaveBeenCalledWith(SESSION_KEY));
    });
    it('矩阵未就绪时不发（isAvailable 此时返回 true，只看 blocked 会漏出去）', async () => {
        getFeatureAvailability.mockReturnValue(new Promise(() => { })); // 永不 resolve
        render(<PetSessionSync />);
        // 等 thinking 偏好发出，确认 effect 确实跑过了（否则这条用例可能只是没渲染）
        await waitFor(() => expect(setSessionThinkingPrefs).toHaveBeenCalled());
        expect(setActiveSessionKey).not.toHaveBeenCalled();
    });
});
