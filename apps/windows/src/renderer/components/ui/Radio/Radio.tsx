import React, { createContext, forwardRef, useContext, useState } from 'react';
import clsx from 'clsx';
import styles from './Radio.module.css';

interface RadioContextType {
  value?: string;
  onChange?: (value: string) => void;
  name?: string;
}

const RadioContext = createContext<RadioContextType | null>(null);

export interface RadioProps {
  value: string;
  disabled?: boolean;
  children?: React.ReactNode;
  className?: string;
  id?: string;
}

const Radio = forwardRef<HTMLInputElement, RadioProps>(
  ({ value, disabled = false, children, className = '', id, ...props }, ref) => {
    const context = useContext(RadioContext);
    const isInGroup = context !== null;
    const isChecked = isInGroup ? context.value === value : false;
    const name = isInGroup ? context?.name : undefined;

    const handleChange = () => {
      if (disabled) return;
      context?.onChange?.(value);
    };

    return (
      <label
        className={clsx(styles['radio-wrapper'], disabled && styles['radio-disabled'], isChecked && styles['radio-checked'], className)}
        onClick={handleChange}
      >
        <span className={styles['radio-input-wrapper']}>
          <input
            ref={ref}
            type="radio"
            className={styles['radio-input']}
            value={value}
            checked={isChecked}
            disabled={disabled}
            name={name}
            id={id}
            onChange={handleChange}
            {...props}
          />
          <span className={styles['radio-inner']}>
            {isChecked && <span className={styles['radio-dot']} />}
          </span>
        </span>
        {children && <span className={styles['radio-label']}>{children}</span>}
      </label>
    );
  }
);

Radio.displayName = 'Radio';

export interface RadioGroupProps {
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  name?: string;
  children: React.ReactNode;
  className?: string;
  vertical?: boolean;
}

const RadioGroup: React.FC<RadioGroupProps> = ({
  value: valueProp,
  defaultValue,
  onChange,
  name,
  children,
  className = '',
  vertical = false,
}) => {
  const [internalValue, setInternalValue] = useState(defaultValue);
  const isControlled = valueProp !== undefined;
  const value = isControlled ? valueProp : internalValue;

  const handleChange = (newValue: string) => {
    if (!isControlled) setInternalValue(newValue);
    onChange?.(newValue);
  };

  return (
    <RadioContext.Provider value={{ value, onChange: handleChange, name }}>
      <div
        className={clsx(styles['radio-group'], vertical ? styles['radio-group-vertical'] : styles['radio-group-horizontal'], className)}
        role="radiogroup"
      >
        {children}
      </div>
    </RadioContext.Provider>
  );
};

export { Radio, RadioGroup };
export default Radio;
