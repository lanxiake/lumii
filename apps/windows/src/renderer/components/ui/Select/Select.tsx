import React, { forwardRef, SelectHTMLAttributes } from 'react';
import clsx from 'clsx';
import styles from './Select.module.css';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options: SelectOption[];
  label?: string;
  placeholder?: string;
  error?: string;
}

const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ options, label, placeholder, error, disabled, className = '', ...props }, ref) => {
    return (
      <div className={clsx(styles['select-wrapper'], error && styles['select-wrapper-error'], disabled && styles['select-wrapper-disabled'], className)}>
        {label && <label className={styles['select-label']} htmlFor={props.id}>{label}</label>}
        <div className={styles['select-container']}>
          <select ref={ref} className={styles['select-field']} disabled={disabled} {...props}>
            {placeholder && <option value="" disabled>{placeholder}</option>}
            {options.map((option) => (
              <option key={option.value} value={option.value} disabled={option.disabled}>
                {option.label}
              </option>
            ))}
          </select>
          <span className={styles['select-arrow']}>▼</span>
        </div>
        {error && <span className={styles['select-error']}>{error}</span>}
      </div>
    );
  }
);

Select.displayName = 'Select';

export { Select };
export default Select;
