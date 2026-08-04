// CSS Modules 类型声明（独立文件，不含 import/export，确保全局生效）
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

// 普通 CSS 文件的副作用导入声明（如 import 'xxx.css'）
declare module '*.css' {
  const content: Record<string, string>
  export default content
}

// 图片/图标资源
declare module '*.ico' {
  const src: string
  export default src
}

declare module '*.png' {
  const src: string
  export default src
}

declare module '*.svg' {
  const src: string
  export default src
}
