import React, { ReactNode, useState } from 'react';
import clsx from 'clsx';
import styles from './Avatar.module.css';

export interface AvatarProps {
  src?: string;
  alt?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | number;
  shape?: 'circle' | 'square';
  fallback?: ReactNode;
  bordered?: boolean;
  className?: string;
}

const Avatar: React.FC<AvatarProps> = ({
  src,
  alt = '',
  size = 'md',
  shape = 'circle',
  fallback,
  bordered = false,
  className = '',
}) => {
  const [hasError, setHasError] = useState(false);

  const sizeValue = typeof size === 'number' ? size : undefined;
  const sizeClass = typeof size === 'string' ? styles[`avatar-${size}`] : '';

  const classes = clsx(
    styles.avatar,
    sizeClass,
    styles[`avatar-${shape}`],
    bordered && styles['avatar-bordered'],
    className
  );

  const style: React.CSSProperties = {};
  if (sizeValue) {
    style.width = sizeValue;
    style.height = sizeValue;
  }

  const getFallback = () => {
    if (fallback) return fallback;
    const initials = alt
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
    return <span className={styles['avatar-fallback-text']}>{initials || '?'}</span>;
  };

  const getBackgroundColor = () => {
    const colors = [
      '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
      '#ec4899', '#f43f5e', '#f97316', '#eab308',
    ];
    const index = alt.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % colors.length;
    return colors[index];
  };

  if (!src || hasError) {
    return (
      <div className={classes} style={{ ...style, backgroundColor: getBackgroundColor() }} title={alt}>
        {getFallback()}
      </div>
    );
  }

  return (
    <div className={classes} style={style} title={alt}>
      <img src={src} alt={alt} className={styles['avatar-image']} onError={() => setHasError(true)} />
    </div>
  );
};

export { Avatar };
export default Avatar;
