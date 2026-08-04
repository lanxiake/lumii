import React, { forwardRef, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import styles from './Checkbox.module.css';

export interface CheckboxProps {
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  indeterminate?: boolean;
  children?: React.ReactNode;
  className?: string;
  id?: string;
}

const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  (
    {
      checked: checkedProp,
      defaultChecked = false,
      onChange,
      disabled = false,
      indeterminate = false,
      children,
      className = '',
      id,
      ...props
    },
    ref
  ) => {
    const [internalChecked, setInternalChecked] = useState(defaultChecked);
    const inputRef = useRef<HTMLInputElement>(null);

    const isControlled = checkedProp !== undefined;
    const checked = isControlled ? checkedProp : internalChecked;

    useEffect(() => {
      if (inputRef.current) {
        inputRef.current.indeterminate = indeterminate;
      }
    }, [indeterminate]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newChecked = e.target.checked;
      if (!isControlled) setInternalChecked(newChecked);
      onChange?.(newChecked);
    };

    const handleClick = (e: React.MouseEvent<HTMLLabelElement>) => {
      e.preventDefault(); // 阻止 label 默认行为触发 input change，避免双重触发
      if (disabled) return;
      const newChecked = !checked;
      if (!isControlled) setInternalChecked(newChecked);
      onChange?.(newChecked);
    };

    return (
      <label
        className={clsx(
          styles['checkbox-wrapper'],
          disabled && styles['checkbox-disabled'],
          checked && styles['checkbox-checked'],
          indeterminate && styles['checkbox-indeterminate'],
          className
        )}
        onClick={handleClick}
      >
        <span className={styles['checkbox-input-wrapper']}>
          <input
            ref={(node) => {
              (inputRef as React.MutableRefObject<HTMLInputElement | null>).current = node;
              if (typeof ref === 'function') ref(node);
              else if (ref) (ref as React.MutableRefObject<HTMLInputElement | null>).current = node;
            }}
            type="checkbox"
            className={styles['checkbox-input']}
            checked={checked}
            onChange={handleChange}
            disabled={disabled}
            id={id}
            {...props}
          />
          <span className={styles['checkbox-inner']}>
            {indeterminate ? (
              <span className={styles['checkbox-indeterminate-icon']}>-</span>
            ) : checked ? (
              <svg className={styles['checkbox-check-icon']} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : null}
          </span>
        </span>
        {children && <span className={styles['checkbox-label']}>{children}</span>}
      </label>
    );
  }
);

Checkbox.displayName = 'Checkbox';

export { Checkbox };
export default Checkbox;
