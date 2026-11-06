import type { Env } from "./env";
import { requireMember, requireOwner } from "./auth";
import { pageForMember } from "./page-access";
import { queryTable, tableRegistry } from "./table-service";
import { tableActorSignature, type TableActor } from "./table-authority";
import { formFields, type FormField } from "../shared/public-forms";
import { assertSameOrigin, HttpError } from "./http";
import { sha256Hex, uuidFromHash } from "../shared/import-integrity";
import { verifyTurnstile } from "./turnstile";
import { escapePublic as esc, publicHtml, publicJson, PUBLIC_STYLE } from "./public-utils";
export type PublicForm = {
  id: string;
  workspace_id: string;
  page_id: string;
  url_key: string;
  title: string;
  description: string;
  success_message: string;
  fields_json: string;
  version: number;
  active: number;
  expires_at: number | null;
};
function requireFormChallenge(env: Env) {
  if (env.TURNSTILE_ENABLED !== "true" || !env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET_KEY)
    throw new HttpError(503, "form_challenge_unavailable", "Forms require configured human verification.");
}
export async function liveForm(env: Env, key: string): Promise<PublicForm | null> {
  if (env.FORMS_ENABLED !== "true") return null;
  requireFormChallenge(env);
  return env.DB.prepare(`SELECT f.* FROM public_forms f JOIN pages p ON p.id=f.page_id JOIN table_authority a ON a.page_id=p.id
    WHERE f.url_key=? AND f.active=1 AND (f.expires_at IS NULL OR f.expires_at>?) AND p.archived_at IS NULL AND p.import_job_id IS NULL AND p.is_task_list=0 AND a.state='do'`)
    .bind(key, Date.now())
    .first<PublicForm>();
}
export async function formsSettingsResponse(request: Request, env: Env, pageId: string): Promise<Response> {
  const member = await requireMember(request, env);
  requireOwner(member);
  await pageForMember(env, member, pageId);
  if (env.FORMS_ENABLED !== "true") throw new HttpError(404, "forms_disabled", "Forms are unavailable.");
  if (request.method === "GET")
    return Response.json({
      forms: (
        await env.DB.prepare("SELECT * FROM public_forms WHERE page_id=? AND workspace_id=? ORDER BY created_at")
          .bind(pageId, member.workspace.id)
          .all<PublicForm>()
      ).results.map((form) => ({ ...form, fields: JSON.parse(form.fields_json), fields_json: undefined })),
    });
  assertSameOrigin(request, env.BETTER_AUTH_URL);
  const input = await publicJson(request, 128 * 1024);
  if (input.active === true) requireFormChallenge(env);
  const page = await pageForMember(env, member, pageId);
  if (page.kind !== "table" || page.is_task_list)
    throw new HttpError(422, "form_table_required", "Choose an ordinary collaborative table.");
  if (input.active === true && (await tableRegistry(env, pageId))?.state !== "do")
    throw new HttpError(
      409,
      "form_table_migration_required",
      "Migrate this table to the collaborative authority before publishing a form.",
    );
  const table = await queryTable(env, member, pageId, "limit=1");
  let fields: FormField[];
  try {
    fields = formFields(input.fields, table.columns);
  } catch (error) {
    throw new HttpError(422, "form_invalid", error instanceof Error ? error.message : "Invalid form.");
  }
  const existing =
    typeof input.id === "string"
      ? await env.DB.prepare("SELECT * FROM public_forms WHERE id=? AND page_id=? AND workspace_id=?")
          .bind(input.id, pageId, member.workspace.id)
          .first<PublicForm>()
      : null;
  if (input.id && !existing) throw new HttpError(404, "form_not_found", "Form not found.");
  if (existing && input.version !== existing.version)
    throw new HttpError(409, "form_changed", "Reload the form settings.");
  const title = String(input.title ?? "")
    .trim()
    .slice(0, 200);
  if (!title) throw new HttpError(422, "form_title_required", "Enter a title.");
  const expires = input.expiresAt === null || input.expiresAt === undefined ? null : Number(input.expiresAt);
  if (expires !== null && (!Number.isSafeInteger(expires) || (input.active === true && expires <= Date.now())))
    throw new HttpError(422, "form_expiry_invalid", "Choose a future expiry.");
  if (
    !(await env.DB.prepare("SELECT user_id FROM service_identities WHERE workspace_id=?")
      .bind(member.workspace.id)
      .first())
  ) {
    const principal = uuidFromHash(await sha256Hex(`form-principal:${member.workspace.id}`)),
      created = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,'Public form',?,0,?,?)",
      ).bind(principal, `public-form+${principal}@service.invalid`, created, created),
      env.DB.prepare(
        "INSERT OR IGNORE INTO service_identities(user_id,workspace_id,kind) VALUES(?,?,'public_form')",
      ).bind(principal, member.workspace.id),
    ]);
  }
  const id = existing?.id ?? crypto.randomUUID(),
    key = existing?.url_key ?? crypto.randomUUID(),
    now = Date.now();
  const result = existing
    ? await env.DB.prepare(
        `UPDATE public_forms SET title=?,description=?,success_message=?,fields_json=?,active=?,expires_at=?,version=version+1,updated_at=? WHERE id=? AND version=?`,
      )
        .bind(
          title,
          String(input.description ?? "").slice(0, 4000),
          String(input.successMessage ?? "Thank you. Your response was received.").slice(0, 1000),
          JSON.stringify(fields),
          Number(input.active === true),
          expires,
          now,
          id,
          existing.version,
        )
        .run()
    : await env.DB.prepare(
        `INSERT INTO public_forms(id,workspace_id,page_id,url_key,title,description,success_message,fields_json,active,expires_at,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
        .bind(
          id,
          member.workspace.id,
          pageId,
          key,
          title,
          String(input.description ?? "").slice(0, 4000),
          String(input.successMessage ?? "Thank you. Your response was received.").slice(0, 1000),
          JSON.stringify(fields),
          Number(input.active === true),
          expires,
          member.user.id,
          now,
          now,
        )
        .run();
  if (!result.meta.changes) throw new HttpError(409, "form_changed", "Reload the form settings.");
  return Response.json({
    id,
    key,
    version: (existing?.version ?? 0) + 1,
    url: `${env.PUBLIC_BASE_URL ?? new URL(request.url).origin}/forms/${key}`,
  });
}
export async function submitPublicForm(request: Request, env: Env, key: string): Promise<Response> {
  const form = await liveForm(env, key);
  if (!form) throw new HttpError(404, "form_unavailable", "This form is unavailable.");
  assertSameOrigin(request, new URL(request.url).origin);
  const input = await publicJson(request);
  if (typeof input.submissionId !== "string" || !/^[a-zA-Z0-9_-]{16,100}$/.test(input.submissionId))
    throw new HttpError(422, "submission_id_required", "A submission ID is required.");
  const source = await sha256Hex(
      `${env.BETTER_AUTH_SECRET}:form:${form.id}:${request.headers.get("cf-connecting-ip") ?? "unknown"}`,
    ),
    minute = Math.floor(Date.now() / 60000);
  const attempt = await env.DB.prepare(`INSERT INTO public_form_attempts(form_id,source,window,count) VALUES(?,?,?,1)
    ON CONFLICT(form_id,source) DO UPDATE SET window=excluded.window,count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END
    WHERE window<>excluded.window OR count<10 RETURNING count`)
    .bind(form.id, source, minute)
    .first();
  if (!attempt) throw new HttpError(429, "form_rate_limited", "Too many form attempts. Try again shortly.");
  await verifyTurnstile(request, env, "form-submit", input.turnstileToken, new URL(request.url).hostname);
  const registry = await tableRegistry(env, form.page_id);
  if (!registry || registry.state !== "do")
    throw new HttpError(503, "form_unavailable", "This form is temporarily unavailable.");
  const actor: TableActor = {
    pageId: form.page_id,
    workspaceId: form.workspace_id,
    userId: `form:${form.id}`,
    generation: registry.generation,
    expiresAt: Date.now() + 30000,
    form: { id: form.id, version: form.version, source },
  };
  const response = await env.TABLE.getByName(form.page_id).fetch(
    new Request("https://table.internal/form-submissions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-table-actor": JSON.stringify(actor),
        "x-table-signature": await tableActorSignature(env.BETTER_AUTH_SECRET, actor),
      },
      body: JSON.stringify({ submissionId: input.submissionId, values: input.values }),
    }),
  );
  if (!response.ok)
    return new Response(response.body, {
      status: response.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  return Response.json({ accepted: true, message: form.success_message }, { headers: { "cache-control": "no-store" } });
}
export function formDocument(env: Env, form: PublicForm): Response {
  const fields = JSON.parse(form.fields_json) as FormField[];
  const controls = fields
    .map((field) => {
      const common = `name="${esc(field.columnId)}" ${field.required ? "required" : ""}`;
      const control = ["select", "status", "multi_select"].includes(field.type)
        ? `<select ${common} ${field.type === "multi_select" ? "multiple" : ""}><option value=""></option>${field.options.map((option) => `<option value="${esc(option.id)}">${esc(option.label)}</option>`).join("")}</select>`
        : field.type === "text"
          ? `<textarea ${common} maxlength="10000"></textarea>`
          : `<input ${common} type="${field.type === "checkbox" ? "checkbox" : field.type === "number" ? "number" : field.type === "date" ? "date" : "url"}" ${field.type === "number" ? 'step="any"' : ""}>`;
      return `<label>${esc(field.label)}${control}<small>${esc(field.description)}</small></label>`;
    })
    .join("");
  return publicHtml(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex,nofollow"><title>${esc(form.title)}</title><style>${PUBLIC_STYLE}</style></head><body><h1>${esc(form.title)}</h1><p>${esc(form.description)}</p><form id="public-form" data-fields="${esc(JSON.stringify(fields.map(({ columnId, type }) => ({ columnId, type }))))}">${controls}<div class="cf-turnstile" data-sitekey="${esc(env.TURNSTILE_SITE_KEY)}" data-action="form-submit"></div><button>Submit</button><p role="status" id="status"></p></form><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script><script src="/public-form.js" defer></script></body></html>`,
    200,
    true,
  );
}
export const FORM_SCRIPT = `const f=document.getElementById('public-form');let submissionId=crypto.randomUUID();f.addEventListener('submit',async e=>{e.preventDefault();const data=new FormData(f),values={};for(const field of JSON.parse(f.dataset.fields)){const value=data.get(field.columnId);values[field.columnId]=field.type==='checkbox'?data.has(field.columnId):field.type==='number'?(value===''?null:Number(value)):field.type==='multi_select'?data.getAll(field.columnId).filter(Boolean):value;}const status=document.getElementById('status');f.querySelector('button').disabled=true;try{const r=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({submissionId,values,turnstileToken:data.get('cf-turnstile-response')})});const result=await r.json();if(!r.ok)throw Error(result.error?.message||result.message||'Submission failed.');status.textContent=result.message;f.reset();submissionId=crypto.randomUUID();}catch(error){status.textContent=error.message;}finally{f.querySelector('button').disabled=false;window.turnstile?.reset();}});`;

export async function cleanupPublicForms(env: Env) {
  await env.DB.prepare(
    "DELETE FROM public_form_attempts WHERE rowid IN (SELECT rowid FROM public_form_attempts WHERE window<? LIMIT 500)",
  )
    .bind(Math.floor(Date.now() / 60000) - 1440)
    .run();
}
