import type { ModalProps } from '../../../components/ui/Modal'

/**
 * Wiki / 记忆页嵌在设置中心 Hub（--z-settings-hub）内，
 * 挂到 document.body 的子弹窗必须高于 Hub，否则被设置菜单挡住。
 */
export const WIKI_MODAL_LAYER: NonNullable<ModalProps['layer']> = 'aboveHub'
