import React, { ReactNode } from 'react';
import clsx from 'clsx';
import styles from './Card.module.css';

export interface CardProps {
  title?: string;
  children: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  hover?: boolean;
  onClick?: () => void;
  className?: string;
  /** 追加到卡片 body 的 class，用于列布局拉伸/滚动等 */
  bodyClassName?: string;
  /** 让 children 直接参与 .card 的布局（外层自带 padding / flex 时用） */
  flush?: boolean;
  /** 允许内容溢出（悬停 tip 等），默认裁剪以配合圆角 */
  overflowVisible?: boolean;
}

/**
 * 通用卡片容器，支持标题、页脚与 body 自定义样式。
 */
const Card: React.FC<CardProps> = ({
  title,
  children,
  header,
  footer,
  hover = false,
  onClick,
  className = '',
  bodyClassName = '',
  flush = false,
  overflowVisible = false,
}) => {
  return (
    <div
      className={clsx(
        styles.card,
        hover && styles['card-hover'],
        onClick && styles['card-clickable'],
        flush && styles['card-flush'],
        overflowVisible && styles['card-overflow-visible'],
        className,
      )}
      onClick={onClick}
    >
      {(title || header) && (
        <div className={styles['card-header']}>
          {header || (title && <h4 className={styles['card-title']}>{title}</h4>)}
        </div>
      )}
      <div className={clsx(styles['card-body'], bodyClassName)}>{children}</div>
      {footer && <div className={styles['card-footer']}>{footer}</div>}
    </div>
  );
};

export { Card };
export default Card;
