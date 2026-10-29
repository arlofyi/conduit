import { useStore } from "../store";
import type { PrettierOptions } from "../format/options";
import { Dropdown } from "./Dropdown";
import { SettingRow, SettingsSection } from "./ui";

/** Settings → Formatting: global prettier config for the bundled fallback + the two
 *  save toggles. A project's own .prettierrc overrides these global values. */
export function FormatPrefsPanel() {
  const cfg = useStore((s) => s.formatConfig);
  const setCfg = useStore((s) => s.setFormatConfig);
  const trimOnSave = useStore((s) => s.trimOnSave);
  const toggleTrim = useStore((s) => s.toggleTrimOnSave);
  const formatOnSave = useStore((s) => s.formatOnSave);
  const toggleFormat = useStore((s) => s.toggleFormatOnSave);

  const num = (k: keyof PrettierOptions) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const n = Number(e.target.value);
    if (Number.isFinite(n) && n > 0) setCfg({ [k]: n } as Partial<PrettierOptions>);
  };
  const bool = (k: keyof PrettierOptions) => (on: boolean) =>
    setCfg({ [k]: on } as Partial<PrettierOptions>);

  return (
    <div className="format-prefs">
      <p className="settings-intro">
        On save or via Edit → Format Document, Conduit uses the project's own prettier when
        installed (respecting its config). When a project has no prettier, it falls back to a
        bundled formatter using these global rules — a project's <code>.prettierrc</code>{" "}
        still wins.
      </p>

      <SettingsSection title="On save">
        <SettingRow
          id="format-on-save"
          title="Format document on save"
          checked={formatOnSave}
          onChange={toggleFormat}
        />
        <SettingRow
          id="trim-on-save"
          title="Trim trailing whitespace on save"
          checked={trimOnSave}
          onChange={toggleTrim}
        />
      </SettingsSection>

      <SettingsSection title="Global prettier rules (fallback)">
        <SettingRow
          id="print-width"
          title="Print width"
          trailing={
            <input
              type="number"
              min={20}
              max={200}
              value={cfg.printWidth}
              onChange={num("printWidth")}
              className="ui-input"
            />
          }
        />
        <SettingRow
          id="tab-width"
          title="Tab width"
          trailing={
            <input type="number" min={1} max={8} value={cfg.tabWidth} onChange={num("tabWidth")} className="ui-input" />
          }
        />
        <SettingRow
          id="use-tabs"
          title="Use tabs"
          checked={cfg.useTabs}
          onChange={bool("useTabs")}
        />
        <SettingRow
          id="semicolons"
          title="Semicolons"
          checked={cfg.semi}
          onChange={bool("semi")}
        />
        <SettingRow
          id="single-quote"
          title="Single quotes"
          checked={cfg.singleQuote}
          onChange={bool("singleQuote")}
        />
        <SettingRow
          id="bracket-spacing"
          title="Bracket spacing"
          checked={cfg.bracketSpacing}
          onChange={bool("bracketSpacing")}
        />
      </SettingsSection>

      <SettingsSection title="Trailing commas">
        <SettingRow
          id="trailing-comma"
          title="Trailing commas"
          trailing={
            <Dropdown
              className="dd-settings"
              value={cfg.trailingComma}
              options={[
                { value: "all", label: "All" },
                { value: "es5", label: "ES5" },
                { value: "none", label: "None" },
              ]}
              onChange={(v) => setCfg({ trailingComma: v as PrettierOptions["trailingComma"] })}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="End of line">
        <SettingRow
          id="end-of-line"
          title="End of line"
          trailing={
            <Dropdown
              className="dd-settings"
              value={cfg.endOfLine}
              options={[
                { value: "lf", label: "LF" },
                { value: "crlf", label: "CRLF" },
                { value: "cr", label: "CR" },
                { value: "auto", label: "Auto" },
              ]}
              onChange={(v) => setCfg({ endOfLine: v as PrettierOptions["endOfLine"] })}
            />
          }
        />
      </SettingsSection>
    </div>
  );
}
