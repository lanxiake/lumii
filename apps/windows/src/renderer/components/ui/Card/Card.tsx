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
}

const Card: React.FC<CardProps> = ({
  title,
  children,
  header,
  footer,
  hover = false,
  onClick,
  className = '',
}) => {
  return (
    <div className={clsx(styles.card, hover && styles['card-hover'], onClick && styles['card-clickable'], className)} onClick={onClick}>
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
