import { useState } from "react";
import type { CollaborativeColumn } from "../shared/table-protocol";
import { FORM_TYPES, type FormField } from "../shared/public-forms";
import { api, json, apiErrorMessage } from "./api";
type FormSettings = {
  id?: string;
  version?: number;
  url_key?: string;
  title: string;
  description: string;
  success_message: string;
  fields: FormField[];
  active: number;
  expires_at: number | null;
};
export function FormsControl({
  pageId,
  title,
  columns,
}: {
  pageId: string;
  title: string;
  columns: CollaborativeColumn[];
}) {
  const [open, setOpen] = useState(false),
    [forms, setForms] = useState<FormSettings[]>([]),
    [draft, setDraft] = useState<FormSettings | null>(null),
    [error, setError] = useState(""),
    [url, setUrl] = useState(""),
    [busy, setBusy] = useState(false);
  const supported = columns.filter(
    (column) => FORM_TYPES.includes(column.type as (typeof FORM_TYPES)[number]) && !column.conversion,
  );
  const fresh = (): FormSettings => ({
    title,
    description: "",
    success_message: "Thank you. Your response was received.",
    fields: [],
    active: 0,
    expires_at: null,
  });
  async function load() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ forms: FormSettings[] }>(`/api/pages/${pageId}/forms`);
      setForms(result.forms);
      setDraft(result.forms[0] ?? fresh());
      setOpen(true);
    } catch (cause) {
      setError(apiErrorMessage(cause, "Forms are not available."));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ id: string; version: number; url: string }>(`/api/pages/${pageId}/forms`, {
        method: "PUT",
        body: json({
          ...draft,
          fields: draft.fields.map(({ columnId, label, description, required }) => ({
            columnId,
            label,
            description,
            required,
          })),
          active: !!draft.active,
          expiresAt: draft.expires_at,
          successMessage: draft.success_message,
        }),
      });
      setDraft({ ...draft, id: result.id, version: result.version });
      setUrl(result.url);
      const refreshed = await api<{ forms: FormSettings[] }>(`/api/pages/${pageId}/forms`);
      setForms(refreshed.forms);
    } catch (cause) {
      setError(apiErrorMessage(cause, "The form could not be saved."));
    } finally {
      setBusy(false);
    }
  }
  function field(index: number, patch: Partial<FormField>) {
    if (draft)
      setDraft({ ...draft, fields: draft.fields.map((value, i) => (i === index ? { ...value, ...patch } : value)) });
  }
  return (
    <div className="forms-control">
      <button disabled={busy} onClick={() => (open ? setOpen(false) : void load())}>
        Forms
      </button>
      {error && <p role="alert">{error}</p>}
      {open && draft && (
        <section aria-label="Form builder">
          <h3>Public form</h3>
          <p>
            Responses add rows to this table. Supported fields only; schema changes close the form until you save it
            again.
          </p>
          <label>
            Form
            <select
              value={draft.id ?? ""}
              onChange={(event) => {
                setDraft(forms.find((form) => form.id === event.target.value) ?? fresh());
                setUrl("");
              }}
            >
              <option value="">New form</option>
              {forms.map((form) => (
                <option key={form.id} value={form.id}>
                  {form.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Title
            <input
              value={draft.title}
              maxLength={200}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>
          <label>
            Description
            <textarea
              value={draft.description}
              maxLength={4000}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </label>
          {draft.fields.map((item, index) => (
            <fieldset key={item.columnId}>
              <legend>{columns.find((column) => column.id === item.columnId)?.name ?? "Removed property"}</legend>
              <label>
                Label
                <input value={item.label} maxLength={200} onChange={(e) => field(index, { label: e.target.value })} />
              </label>
              <label>
                Help text
                <input
                  value={item.description}
                  maxLength={1000}
                  onChange={(e) => field(index, { description: e.target.value })}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={item.required}
                  onChange={(e) => field(index, { required: e.target.checked })}
                />
                Required
              </label>
              <button
                disabled={index === 0}
                onClick={() => {
                  const fields = [...draft.fields];
                  [fields[index - 1], fields[index]] = [fields[index]!, fields[index - 1]!];
                  setDraft({ ...draft, fields });
                }}
              >
                Move up
              </button>
              <button onClick={() => setDraft({ ...draft, fields: draft.fields.filter((_, i) => i !== index) })}>
                Remove field
              </button>
            </fieldset>
          ))}
          <label>
            Add field
            <select
              value=""
              disabled={draft.fields.length >= 50}
              onChange={(event) => {
                const column = supported.find((candidate) => candidate.id === event.target.value);
                if (column)
                  setDraft({
                    ...draft,
                    fields: [
                      ...draft.fields,
                      {
                        columnId: column.id,
                        label: column.name,
                        description: "",
                        required: false,
                        type: column.type,
                        generation: column.generation ?? 1,
                        options: column.options.map(({ id, label }) => ({ id, label })),
                      },
                    ],
                  });
              }}
            >
              <option value="">Choose a property</option>
              {supported
                .filter((column) => !draft.fields.some((item) => item.columnId === column.id))
                .map((column) => (
                  <option key={column.id} value={column.id}>
                    {column.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Success message
            <textarea
              value={draft.success_message}
              maxLength={1000}
              onChange={(event) => setDraft({ ...draft, success_message: event.target.value })}
            />
          </label>
          <label>
            Expiry
            <input
              type="datetime-local"
              value={
                draft.expires_at
                  ? new Date(draft.expires_at - new Date(draft.expires_at).getTimezoneOffset() * 60000)
                      .toISOString()
                      .slice(0, 16)
                  : ""
              }
              onChange={(event) =>
                setDraft({ ...draft, expires_at: event.target.value ? new Date(event.target.value).getTime() : null })
              }
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={!!draft.active}
              onChange={(event) => setDraft({ ...draft, active: Number(event.target.checked) })}
            />
            Accept responses
          </label>
          <button disabled={busy || !draft.fields.length} onClick={() => void save()}>
            Save form
          </button>
          {url && (
            <p>
              <a href={url} target="_blank" rel="noreferrer">
                Open form
              </a>
              <input aria-label="Public form URL" value={url} readOnly />
            </p>
          )}
        </section>
      )}
    </div>
  );
}
