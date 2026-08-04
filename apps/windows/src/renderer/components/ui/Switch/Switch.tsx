import React, { forwardRef, useState } from 'react';
import clsx from 'clsx';
import styles from './Switch.module.css';

export interface SwitchProps {
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg';
  checkedText?: string;
  uncheckedText?: string;
  className?: string;
  id?: string;
}

const Switch = forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked: checkedProp, defaultChecked = false, onChange, disabled = false, size = 'md', checkedText, uncheckedText, className = '', id, ...props }, ref) => {
    const [internalChecked, setInternalChecked] = useState(defaultChecked);
    const isControlled = checkedProp !== undefined;
    const checked = isControlled ? checkedProp : internalChecked;

    const handleClick = () => {
      if (disabled) return;
      const newChecked = !checked;
      if (!isControlled) setInternalChecked(newChecked);
      onChange?.(newChecked);
    };

    return (
      <button
        ref={ref}
        type="button"
        role="switch"
        aria-checked={checked}
        className={clsx(styles.switch, styles[`switch-${size}`], checked && styles['switch-checked'], disabled && styles['switch-disabled'], className)}
        onClick={handleClick}
        disabled={disabled}
        id={id}
        {...props}
      >
        <span className={styles['switch-handle']}>
          {(checkedText || uncheckedText) && (
            <span className={styles['switch-text']}>{checked ? checkedText : uncheckedText}</span>
          )}
        </span>
      </button>
    );
  }
);

Switch.displayName = 'Switch';

export { Switch };
export default Switch;
