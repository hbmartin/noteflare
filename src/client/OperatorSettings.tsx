import { operatorFlags, operatorLimits, type OperatorSettings, type OperatorValue } from "../shared/operator-settings";
import "./OperatorSettings.css";

const labels: Record<string, string> = {
  ...operatorFlags,
  ...Object.fromEntries(Object.entries(operatorLimits).map(([key, [label]]) => [key, label])),
  AUTH_MODE: "Authentication",
};

function SettingValue({ setting }: { setting: OperatorValue }) {
  const { value, source, missing } = setting;
  const display =
    typeof value === "boolean"
      ? value
        ? "Enabled"
        : "Disabled"
      : typeof value === "number"
        ? value.toLocaleString()
        : (value ?? "Unavailable");
  return (
    <>
      {display}
      {source === "default" && " (default)"}
      {missing.length > 0 && <div>Missing configuration: {missing.join(", ")}</div>}
    </>
  );
}

export function OperatorSettingsView({ settings }: { settings: OperatorSettings }) {
  const { application, publicWorker } = settings;
  return (
    <>
      <h3 id="deployment-settings">Current deployment settings</h3>
      <dl className="operator-worker-details">
        <div>
          <dt>Application Worker</dt>
          <dd>{application.origin ?? "Origin unavailable"}</dd>
          <dd>Version {application.version ?? "unavailable"}</dd>
          <dd>Read {new Date(application.observedAt).toLocaleString()}</dd>
        </div>
        <div>
          <dt>Public Worker</dt>
          {publicWorker ? (
            <>
              <dd>{publicWorker.origin ?? "Origin unavailable"}</dd>
              <dd>Version {publicWorker.version ?? "unavailable"}</dd>
              <dd>Read {new Date(publicWorker.observedAt).toLocaleString()}</dd>
            </>
          ) : (
            <dd>Live settings unavailable</dd>
          )}
        </div>
      </dl>
      <section
        className="operator-settings-scroll"
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- allow keyboard scrolling of the named region
        tabIndex={0}
        aria-labelledby="deployment-settings-caption"
      >
        <table className="operator-settings-table">
          <caption id="deployment-settings-caption">Effective settings by Worker</caption>
          <thead>
            <tr>
              <th scope="col">Setting</th>
              <th scope="col">Application</th>
              <th scope="col">Public</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(labels).map(([key, label]) => {
              const appValue = application.values[key];
              const publicValue = publicWorker?.values[key];
              if (!appValue && !publicValue) return null;
              return (
                <tr key={key}>
                  <th scope="row">{label}</th>
                  <td>{appValue ? <SettingValue setting={appValue} /> : "Not applicable"}</td>
                  <td>
                    {publicValue ? (
                      <SettingValue setting={publicValue} />
                    ) : publicWorker ? (
                      "Not applicable"
                    ) : (
                      "Unavailable"
                    )}
                    {appValue && publicValue && appValue.value !== publicValue.value && (
                      <div>Differs from application</div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </>
  );
}
