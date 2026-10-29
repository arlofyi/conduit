import { useId, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { InfoIcon } from "./Icons";

/**
 * The settings vocabulary. Every Settings page draws its controls from here so a button,
 * a toggle or a scope picker looks and behaves the same on every page. Before this file
 * there were a dozen one-off button classes (`mp-btn`, `route-btn`, `agent-rescan`,
 * `account-remove`, `oc-detect`, ...), three pill-selector styles and bare
 * `<label><input type="checkbox"/> Enabled</label>` rows at browser font size.
 *
 * Rule of thumb: a setting that is ON or OFF is a `Switch` (macOS System Settings
 * convention); a checkbox is for picking items out of a list (the MCP matrix, a
 * multi-select). One-of-N is a `Segmented` control.
 */

type ButtonVariant = "secondary" | "primary" | "ghost" | "danger";

export function Button({
  variant = "secondary",
  size = "sm",
  className = "",
  type = "button",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "sm" | "md";
}) {
  return (
    <button
      type={type}
      className={`ui-btn ui-btn-${variant} ui-btn-${size}${className ? ` ${className}` : ""}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/** A row of buttons, right-aligned by default (form actions), or start-aligned. */
export function ButtonRow({
  children,
  align = "end",
}: {
  children: ReactNode;
  align?: "start" | "end";
}) {
  return <div className={`ui-btn-row ui-btn-row-${align}`}>{children}</div>;
}

/**
 * An on/off switch. A real `<button role="switch">`, so a `<label htmlFor>` pointing at
 * it toggles it (buttons are labelable) and Space/Enter work without extra handlers.
 */
export function Switch({
  checked,
  onChange,
  disabled,
  id,
  label,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  id?: string;
  /** Accessible name when no visible `<label htmlFor>` points at the switch. */
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`ui-switch${checked ? " on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="ui-switch-thumb" />
    </button>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
}

/** One-of-N picker: scope (Global / project), preset, mode. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="ui-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={o.disabled}
          title={o.title}
          className={`ui-seg-item${value === o.value ? " on" : ""}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Small status label: where a value came from, a phase, a state. */
export function Badge({
  tone = "neutral",
  children,
  title,
}: {
  tone?: "neutral" | "accent" | "muted" | "good" | "warn" | "bad";
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`ui-badge ui-badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

/**
 * A titled group of rows. The section is the unit a page is scanned by: heading, one line
 * of what it governs, then its rows inside one quiet surface.
 */
export function SettingsSection({
  title,
  description,
  actions,
  children,
  flush = false,
}: {
  title?: ReactNode;
  description?: ReactNode;
  /** Right side of the heading line (a Reset all, an Add). */
  actions?: ReactNode;
  children: ReactNode;
  /** Render children directly instead of inside the grouped surface. */
  flush?: boolean;
}) {
  return (
    <section className="ui-section">
      {(title || actions) && (
        <div className="ui-section-head">
          {title && <h3 className="ui-section-title">{title}</h3>}
          {actions && <div className="ui-section-actions">{actions}</div>}
        </div>
      )}
      {description && <p className="ui-section-desc">{description}</p>}
      {flush ? children : <div className="ui-section-body">{children}</div>}
    </section>
  );
}

/** Inline notice: an error, a warning, or a neutral note. */
export function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "warn" | "error";
  children: ReactNode;
}) {
  return (
    <div className={`ui-notice ui-notice-${tone}`} role={tone === "error" ? "alert" : undefined}>
      {children}
    </div>
  );
}

/**
 * One settings row: a short scannable title on the control line, the full explanation
 * behind the (i) disclosure. `status` renders ALWAYS-visible follow-on lines (a restart
 * note, a missing dependency, an install path) — state the user must see without
 * clicking; the detail copy is background reading.
 *
 * Controls: `checked`/`onChange` draws a Switch at the row's right edge; `trailing` puts
 * any other compact control there (a number, a dropdown, a Reset); `control` renders
 * full-width under the title for controls too wide for the line (a path picker).
 *
 * The (i) button sits outside the title's <label> on purpose: inside it, expanding the
 * explanation would also flip the switch.
 */
export function SettingRow({
  id,
  title,
  badge,
  detail,
  status,
  checked,
  disabled,
  onChange,
  trailing,
  control,
}: {
  id?: string;
  title: ReactNode;
  badge?: ReactNode;
  detail?: ReactNode;
  status?: ReactNode;
  checked?: boolean;
  disabled?: boolean;
  onChange?: (on: boolean) => void;
  trailing?: ReactNode;
  control?: ReactNode;
}) {
  const auto = useId();
  const base = id ?? auto;
  const [openInfo, setOpenInfo] = useState(false);
  const detailId = `setting-detail-${base}`;
  const switchId = `setting-switch-${base}`;
  return (
    <div className={"setting-row" + (disabled ? " disabled" : "")}>
      <div className="setting-row-head">
        <div className="setting-row-label">
          {onChange ? (
            <label className="setting-row-title" htmlFor={switchId}>
              {title}
            </label>
          ) : (
            <span className="setting-row-title">{title}</span>
          )}
          {badge}
          {detail && (
            <button
              type="button"
              className={"setting-info" + (openInfo ? " on" : "")}
              title={openInfo ? "Hide explanation" : "What does this do?"}
              aria-label={openInfo ? "Hide explanation" : "Show explanation"}
              aria-expanded={openInfo}
              aria-controls={detailId}
              onClick={() => setOpenInfo((v) => !v)}
            >
              <InfoIcon size={13} />
            </button>
          )}
        </div>
        {(trailing || onChange) && (
          <div className="setting-row-trailing">
            {trailing}
            {onChange && (
              <Switch
                id={switchId}
                checked={Boolean(checked)}
                disabled={disabled}
                onChange={onChange}
              />
            )}
          </div>
        )}
      </div>
      {status && <div className="setting-status">{status}</div>}
      {control && <div className="setting-control">{control}</div>}
      {detail && (
        <div id={detailId} className="setting-detail" data-open={openInfo || undefined}>
          <div className="setting-detail-inner">{detail}</div>
        </div>
      )}
    </div>
  );
}
