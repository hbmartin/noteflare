import { applyD1Migrations, env } from "cloudflare:test";
import { expect, it } from "vitest";

it("0111 preserves old publications, form intent, and artifacts while retaining conservative access fences", async () => {
  await applyD1Migrations(
    env.DB,
    env.TEST_MIGRATIONS!.filter((migration) => migration.name < "0111"),
  );
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('owner','Owner','upgrade@test.example',1,1)",
    ),
    env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES('workspace','Upgrade',1)"),
    env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES('private','Private',1)"),
    env.DB.prepare(
      "INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at) VALUES('private-page','private','private-general','document','a0','Private','owner',1,1)",
    ),
    env.DB.prepare(
      "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('workspace','owner','owner',1)",
    ),
    env.DB.prepare(
      "INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at) VALUES('root','workspace','workspace-general','table','a0','Root','owner',1,1),('unrelated','workspace','workspace-general','document','a1','Unrelated','owner',1,1)",
    ),
    env.DB.prepare(
      "INSERT INTO publications(id,workspace_id,space_id,url_key,config_json,active,generation,access_generation,active_generation,active_access_generation,manifest_key,needs_build,created_by,created_at,updated_at) VALUES('site','workspace','workspace-general','legacy-key','{}',1,7,3,7,3,'legacy-manifest',0,'owner',1,1)",
    ),
    env.DB.prepare("INSERT INTO publication_roots VALUES('site','root')"),
    env.DB.prepare("INSERT INTO publication_build_entries VALUES('site',7,'root',1,'legacy-page',NULL,NULL,'{}')"),
    env.DB.prepare(
      "INSERT INTO public_forms(id,workspace_id,page_id,url_key,title,fields_json,version,active,created_by,created_at,updated_at) VALUES('disabled','workspace','root','form-key','Intentionally disabled','[]',5,0,'owner',1,1)",
    ),
  ]);
  const before = await env.DB.prepare("UPDATE pages SET indexed_seq=1 WHERE id='private-page'").run();
  const deliveryGeneration = await env.DB.prepare(
    "SELECT generation FROM public_delivery_state WHERE workspace_id='private'",
  ).first("generation");
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
  const after = await env.DB.prepare("UPDATE pages SET indexed_seq=2 WHERE id='private-page'").run();
  expect(before.meta.rows_written).toBeGreaterThan(after.meta.rows_written);
  expect(
    await env.DB.prepare("SELECT generation FROM public_delivery_state WHERE workspace_id='private'").first(
      "generation",
    ),
  ).toBe(deliveryGeneration);
  expect(
    await env.DB.prepare(
      "SELECT generation,access_generation,active_generation,manifest_key,content_version,build_checkpoint_json,dependencies_ready FROM publications WHERE id='site'",
    ).first(),
  ).toEqual({
    generation: 7,
    access_generation: 3,
    active_generation: 7,
    manifest_key: "legacy-manifest",
    content_version: 1,
    build_checkpoint_json: null,
    dependencies_ready: 0,
  });
  expect(await env.DB.prepare("SELECT active,version FROM public_forms WHERE id='disabled'").first()).toEqual({
    active: 0,
    version: 5,
  });
  expect(
    await env.DB.prepare("SELECT r2_key FROM publication_build_entries WHERE publication_id='site'").first("r2_key"),
  ).toBe("legacy-page");
  await env.DB.prepare("UPDATE pages SET archived_at=1 WHERE id='unrelated'").run();
  expect(
    await env.DB.prepare("SELECT access_generation FROM publications WHERE id='site'").first("access_generation"),
  ).toBe(4);
  await env.DB.prepare(
    "INSERT INTO publication_dependencies SELECT id,generation,'page','root' FROM publications WHERE id='site'",
  ).run();
  await env.DB.prepare("UPDATE publications SET dependencies_ready=1 WHERE id='site'").run();
  await env.DB.prepare("UPDATE pages SET archived_at=NULL WHERE id='unrelated'").run();
  expect(
    await env.DB.prepare("SELECT access_generation FROM publications WHERE id='site'").first("access_generation"),
  ).toBe(4);
  await env.DB.prepare("UPDATE pages SET archived_at=2 WHERE id='root'").run();
  expect(
    await env.DB.prepare("SELECT access_generation FROM publications WHERE id='site'").first("access_generation"),
  ).toBe(5);
});
