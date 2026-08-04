import React, { forwardRef, InputHTMLAttributes, ReactNode } from 'react';
import clsx from 'clsx';
import styles from './Input.module.css';

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix'> {
  label?: string;
  error?: string;
  prefix?: ReactNode;
  suffix?: ReactNode;
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      label,
      error,
      prefix,
      suffix,
      disabled,
      className = '',
      ...props
    },
    ref
  ) => {
    return (
      <div className={clsx(styles['input-wrapper'], error && styles['input-wrapper-error'], disabled && styles['input-wrapper-disabled'], className)}>
        {label && (
          <label className={styles['input-label']} htmlFor={props.id}>
            {label}
          </label>
        )}
        <div className={styles['input-container']}>
          {prefix && <span className={styles['input-prefix']}>{prefix}</span>}
          <input
            ref={ref}
            className={styles['input-field']}
            disabled={disabled}
            {...props}
          />
          {suffix && <span className={styles['input-suffix']}>{suffix}</span>}
        </div>
        {error && <span className={styles['input-error']}>{error}</span>}
      </div>
    );
  }
);

Input.displayName = 'Input';

export { Input };
export default Input;
