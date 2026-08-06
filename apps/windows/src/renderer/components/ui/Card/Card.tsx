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
  /** 让 children 直接参与 .card 的布局（外层自带 padding / flex 时用） */
  flush?: boolean;
}

const Card: React.FC<CardProps> = ({
  title,
  children,
  header,
  footer,
  hover = false,
  onClick,
  className = '',
  flush = false,
}) => {
  return (
    <div
      className={clsx(
        styles.card,
        hover && styles['card-hover'],
        onClick && styles['card-clickable'],
        flush && styles['card-flush'],
        className,
      )}
      onClick={onClick}
    >
      {(title || header) && (
        <div className={styles['card-header']}>
          {header || (title && <h4 className={styles['card-title']}>{title}</h4>)}
        </div>
      )}
      <div className={styles['card-body']}>{children}</div>
      {footer && <div className={styles['card-footer']}>{footer}</div>}
    </div>
  );
};

export { Card };
export default Card;
