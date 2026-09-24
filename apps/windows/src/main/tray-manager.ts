/**
 * TrayManager - 系统托盘管理
 *
 * 管理 Windows 系统托盘图标和菜单。
 * 独立版不依赖 Gateway，托盘仅保留窗口/宠物/设置/退出。
 */
import { Tray, Menu, nativeImage, BrowserWindow } from 'electron';
import { getTrayIconPath } from './asset-paths';
import { getFeatureAvailability } from './platform/feature-probe';
import { getFeatureBlockMessage } from '../shared/feature-availability';
// 日志输出
const log = {
    info: (...args: unknown[]) => console.log('[TrayManager]', ...args),
    error: (...args: unknown[]) => console.error('[TrayManager]', ...args),
};
/**
 * 托盘管理器配置
 */
export interface TrayManagerConfig {
    /** 显示窗口回调 */
    onShowWindow: () => void;
    /** 退出应用回调 */
    onQuit: () => void;
    /** 打开设置窗口回调 */
    onOpenSettings: () => void;
    /** 切换宠物模式回调（打开/关闭由 TrayManager 当前状态决定） */
    onTogglePetMode?: () => void;
    /** 关闭强制穿透（仅宠物模式 + 穿透开启时可用） */
    onDisableForceIgnore?: () => void;
    /** 开始录屏（无预选源时应打开面板） */
    onStartScreenRecord?: () => void;
    /** 停止录屏 */
    onStopScreenRecord?: () => void;
    /** 暂停录屏 */
    onPauseScreenRecord?: () => void;
    /** 继续录屏 */
    onResumeScreenRecord?: () => void;
}
/**
 * 托盘管理器类
 */
export class TrayManager {
    private tray: Tray | null = null;
    private config: TrayManagerConfig;
    private petModeActive = false;
    private forceIgnoreActive = false;
    private screenRecording = false;
    private screenRecordPaused = false;
    private screenRecordElapsedMs = 0;
    constructor(config: TrayManagerConfig) {
        this.config = config;
        this.createTray();
    }
    /**
     * 创建系统托盘
     */
    private createTray(): void {
        log.info('创建系统托盘');
        // 托盘图标与产品 Logo 一致（tray-icon.png 由 logo.png 生成）
        const iconPath = getTrayIconPath();
        let icon = nativeImage.createFromPath(iconPath);
        if (icon.isEmpty()) {
            log.error('托盘图标加载失败:', iconPath);
        }
        else {
            // 托盘图标尺寸随平台：Windows 约 16px；Linux 的托盘（StatusNotifierItem）
            // 在 GNOME/KDE 上按 22–24px 渲染，给 16px 会被放大成糊的。
            const target = process.platform === 'linux' ? 22 : 16;
            const size = icon.getSize();
            if (size.width > target || size.height > target) {
                icon = icon.resize({ width: target, height: target, quality: 'best' });
            }
        }
        this.tray = new Tray(icon);
        this.tray.setToolTip('灵栖 Lumii');
        // 设置右键菜单
        this.updateContextMenu();
        // 点击托盘图标显示窗口
        this.tray.on('click', () => {
            this.config.onShowWindow();
        });
        // 双击也显示窗口
        this.tray.on('double-click', () => {
            this.config.onShowWindow();
        });
    }
    /**
     * @deprecated 保留兼容；实际路径见 getTrayIconPath
     */
    private getIconPath(): string {
        return getTrayIconPath();
    }
    /**
     * 更新右键菜单
     *
     * 被屏蔽的功能**置灰并给出原因**（D4：屏蔽入口 + 文案说明，禁止静默失败）。
     * 菜单项不隐藏而是 disabled——用户能看到「有这功能但当前用不了」，
     * 比凭空少一项更容易理解。
     */
    private updateContextMenu(): void {
        const elapsedSec = Math.floor(this.screenRecordElapsedMs / 1000);
        const mm = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
        const ss = String(elapsedSec % 60).padStart(2, '0');
        const active = this.screenRecording || this.screenRecordPaused;
        // 能力矩阵（设计 §7）。主进程侧直读，不经 IPC——托盘在 main 里构建。
        // 文案一律走共享表 `getFeatureBlockMessage`：这里是**副本**的话，判定一改
        // 就会出现「矩阵说可用、托盘还写着 Linux 不支持」的自相矛盾。
        const features = getFeatureAvailability();
        const petDisabledReason = features.petMode.available
            ? null
            : getFeatureBlockMessage('petMode', features.petMode.reason ?? 'platform-unsupported');
        const recordDisabledReason = features.screenRecord.available
            ? null
            : getFeatureBlockMessage('screenRecord', features.screenRecord.reason ?? 'platform-unsupported');
        const recordItems = this.config.onStartScreenRecord || this.config.onStopScreenRecord
            ? [
                ...(recordDisabledReason
                    ? [
                        {
                            label: `开始录屏（${recordDisabledReason}）`,
                            enabled: false,
                        },
                        { type: 'separator' as const },
                    ]
                    : active
                        ? [
                            ...(this.screenRecording && this.config.onPauseScreenRecord
                                ? [
                                    {
                                        label: `暂停录屏（${mm}:${ss}）`,
                                        click: () => this.config.onPauseScreenRecord?.(),
                                    },
                                ]
                                : []),
                            ...(this.screenRecordPaused && this.config.onResumeScreenRecord
                                ? [
                                    {
                                        label: `继续录屏（${mm}:${ss}）`,
                                        click: () => this.config.onResumeScreenRecord?.(),
                                    },
                                ]
                                : []),
                            {
                                label: `停止录屏（${mm}:${ss}）`,
                                click: () => this.config.onStopScreenRecord?.(),
                            },
                            { type: 'separator' as const },
                        ]
                        : [
                            {
                                label: '开始录屏',
                                click: () => this.config.onStartScreenRecord?.(),
                            },
                            { type: 'separator' as const },
                        ]),
            ]
            : [];
        const contextMenu = Menu.buildFromTemplate([
            {
                label: '显示窗口',
                click: () => this.config.onShowWindow(),
            },
            { type: 'separator' },
            ...(this.config.onTogglePetMode
                ? petDisabledReason
                    ? [
                        {
                            label: `打开宠物模式（${petDisabledReason}）`,
                            enabled: false,
                        },
                        { type: 'separator' as const },
                    ]
                    : [
                        {
                            label: this.petModeActive ? '关闭宠物模式' : '打开宠物模式',
                            click: () => this.config.onTogglePetMode!(),
                        },
                        ...(this.petModeActive && this.forceIgnoreActive && this.config.onDisableForceIgnore
                            ? [
                                {
                                    label: '退出穿透（恢复点击）',
                                    click: () => this.config.onDisableForceIgnore!(),
                                },
                            ]
                            : []),
                        { type: 'separator' as const },
                    ]
                : []),
            ...recordItems,
            {
                label: '设置',
                click: () => {
                    this.config.onOpenSettings();
                },
            },
            { type: 'separator' },
            {
                label: '退出',
                click: () => this.config.onQuit(),
            },
        ]);
        this.tray?.setContextMenu(contextMenu);
    }
    /**
     * 更新宠物模式状态，刷新托盘菜单文案
     */
    updatePetMode(active: boolean): void {
        this.petModeActive = active;
        if (!active)
            this.forceIgnoreActive = false;
        this.updateContextMenu();
    }
    /** 更新强制穿透状态（托盘显示「退出穿透」入口） */
    updateForceIgnore(active: boolean): void {
        this.forceIgnoreActive = active;
        this.updateContextMenu();
    }
    /**
     * 更新录屏状态（recording / paused 时显示停止与暂停/继续）。
     */
    updateScreenRecordState(isRecording: boolean, elapsedMs = 0, isPaused = false): void {
        this.screenRecording = isRecording;
        this.screenRecordPaused = isPaused;
        this.screenRecordElapsedMs = elapsedMs;
        this.updateContextMenu();
    }
    /**
     * 显示通知（托盘气球，Windows 专用）
     *
     * `displayBalloon` 只在 Windows 上有实现；其它平台调用会抛异常或静默无效。
     * 非 Windows 上走 `desktop-notify`（Electron Notification，Linux 用
     * libnotify / D-Bus），是另一条链路，所以这里直接 no-op。
     */
    showNotification(title: string, body: string): void {
        if (process.platform !== 'win32')
            return;
        if (this.tray) {
            this.tray.displayBalloon({
                title,
                content: body,
                iconType: 'info',
            });
        }
    }
    /**
     * 闪烁任务栏/托盘图标以提醒用户
     *
     * `flashFrame` 在 Linux 的多数桌面环境无效、macOS 上是 Dock 跳动（且需用户设置）。
     * 加守卫避免「调了但没反应」被当成 bug 排查。
     */
    flashWindow(window: BrowserWindow): void {
        if (process.platform !== 'win32')
            return;
        window.flashFrame(true);
    }
    /**
     * 停止闪烁任务栏/托盘图标
     */
    stopFlash(window: BrowserWindow): void {
        if (process.platform !== 'win32')
            return;
        window.flashFrame(false);
    }
    /**
     * 销毁托盘
     */
    destroy(): void {
        log.info('销毁系统托盘');
        this.tray?.destroy();
        this.tray = null;
    }
}
