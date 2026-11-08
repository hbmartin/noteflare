import { applyD1Migrations, env, reset } from "cloudflare:test";
import { expect, it } from "vitest";

it("0112 retires old continuations once and keeps active output and cleanup intent", async () => {
  await reset();
  await applyD1Migrations(
    env.DB,
    env.TEST_MIGRATIONS!.filter((migration) => migration.name < "0112"),
  );
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('owner','Owner','upgrade12@test.example',1,1)",
    ),
    env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES('workspace','Upgrade',1)"),
    env.DB.prepare(
      "INSERT INTO publications(id,workspace_id,space_id,url_key,config_json,active,generation,access_generation,active_generation,active_access_generation,manifest_key,needs_build,build_content_version,content_version,build_checkpoint_json,created_by,created_at,updated_at) VALUES('site','workspace','workspace-general','legacy-key','{}',1,8,3,7,3,'active-manifest',1,2,4,'{\"offset\":2,\"tableCursor\":\"legacy\"}','owner',1,1)",
    ),
  ]);
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
  const expected = {
    generation: 9,
    access_generation: 3,
    active_generation: 7,
    manifest_key: "active-manifest",
    needs_build: 1,
    content_version: 4,
    build_content_version: null,
    build_checkpoint_json: null,
  };
  const current = () =>
    env.DB.prepare(
      "SELECT generation,access_generation,active_generation,manifest_key,needs_build,content_version,build_content_version,build_checkpoint_json FROM publications WHERE id='site'",
    ).first();
  expect(await current()).toEqual(expected);
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
  expect(await current()).toEqual(expected);
  await env.DB.prepare(
    "INSERT INTO publication_table_snapshots(handle,object_id,page_id,publication_id,generation,access_generation,created_at,next_attempt_at) VALUES('handle','object','deleted-page','site',8,3,1,0)",
  ).run();
  await env.DB.prepare("DELETE FROM publications WHERE id='site'").run();
  expect(await env.DB.prepare("SELECT handle FROM publication_table_snapshots").first("handle")).toBe("handle");
});

it("0111 preserves old publications, form intent, and artifacts while retaining conservative access fences", async () => {
  await reset();
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

it("0113 preserves healthy captures and manifests while new generations atomically acquire work", async () => {
  await reset();
  await applyD1Migrations(
    env.DB,
    env.TEST_MIGRATIONS!.filter((m) => m.name < "0113"),
  );
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('owner','Owner','upgrade13@test.example',1,1)",
    ),
    env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES('workspace','Upgrade',1)"),
    env.DB.prepare(
      "INSERT INTO publications(id,workspace_id,space_id,url_key,config_json,active,generation,access_generation,active_generation,active_access_generation,manifest_key,needs_build,build_content_version,content_version,build_checkpoint_json,created_by,created_at,updated_at) VALUES('site','workspace','workspace-general','key','{}',1,8,3,7,3,'active',1,4,5,'{\"version\":2,\"offset\":2}', 'owner',1,1)",
    ),
  ]);
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
  expect(
    await env.DB.prepare(
      "SELECT generation,access_generation,active_generation,manifest_key,build_checkpoint_json FROM publications WHERE id='site'",
    ).first(),
  ).toEqual({
    generation: 8,
    access_generation: 3,
    active_generation: 7,
    manifest_key: "active",
    build_checkpoint_json: '{"version":2,"offset":2}',
  });
  await env.DB.prepare(
    "UPDATE publications SET build_error='old',build_failure_checkpoint_json=build_checkpoint_json,build_failure_json='{\"kind\":\"content\"}' WHERE id='site'",
  ).run();
  await env.DB.prepare(
    "UPDATE publications SET generation=generation+1,build_checkpoint_json=NULL WHERE id='site'",
  ).run();
  expect(
    await env.DB.prepare("SELECT generation,build_error,build_failure_json FROM publications WHERE id='site'").first(),
  ).toEqual({ generation: 9, build_error: null, build_failure_json: null });
  expect(
    await env.DB.prepare("SELECT generation,payload_json FROM platform_jobs WHERE job_key='site'").first(),
  ).toEqual({ generation: "9", payload_json: '{"publicationId":"site","generation":9}' });
});

it("0114 preserves healthy captures, manifests, leases and cleanup intent while budgeting state recovery", async () => {
  await reset();
  await applyD1Migrations(
    env.DB,
    env.TEST_MIGRATIONS!.filter((migration) => migration.name < "0114"),
  );
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('owner114','Owner','upgrade114@test.example',1,1)",
    ),
    env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES('workspace114','Upgrade',1)"),
    env.DB.prepare(
      "INSERT INTO publications(id,workspace_id,space_id,url_key,config_json,active,generation,access_generation,active_generation,active_access_generation,manifest_key,needs_build,build_content_version,content_version,build_checkpoint_json,created_by,created_at,updated_at) VALUES('site114','workspace114','workspace114-general','key114','{}',1,8,3,7,3,'private/active',1,4,5,'{\"version\":2,\"offset\":2}','owner114',1,1)",
    ),
    env.DB.prepare(
      "INSERT INTO publication_table_snapshots(handle,object_id,page_id,publication_id,generation,access_generation,created_at,next_attempt_at) VALUES('handle114','object','page','site114',8,3,1,60000)",
    ),
    env.DB.prepare("UPDATE platform_jobs SET lease_token='held',lease_until=9999999999999 WHERE job_key='site114'"),
  ]);
  const before = await env.DB.prepare("SELECT * FROM publications WHERE id='site114'").first();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
  expect(await env.DB.prepare("SELECT * FROM publications WHERE id='site114'").first()).toEqual({
    ...before,
    build_state_recovery_count: 0,
  });
  expect(
    await env.DB.prepare(
      "SELECT generation,lease_token,lease_until FROM platform_jobs WHERE job_key='site114'",
    ).first(),
  ).toEqual({ generation: "8", lease_token: "held", lease_until: 9999999999999 });
  expect(
    await env.DB.prepare("SELECT next_attempt_at FROM publication_table_snapshots WHERE handle='handle114'").first(
      "next_attempt_at",
    ),
  ).toBe(60000);
  await env.DB.prepare("UPDATE publications SET build_state_recovery_count=1 WHERE id='site114'").run();
  await expect(
    env.DB.prepare("UPDATE publications SET build_state_recovery_count=2 WHERE id='site114'").run(),
  ).rejects.toThrow("CHECK constraint");
  await env.DB.prepare(
    "UPDATE publications SET build_checkpoint_json='{\"version\":2,\"offset\":3}',generation=generation+1 WHERE id='site114'",
  ).run();
  expect(
    await env.DB.prepare("SELECT build_state_recovery_count FROM publications WHERE id='site114'").first(
      "build_state_recovery_count",
    ),
  ).toBe(1);
  await env.DB.prepare("UPDATE publications SET access_generation=access_generation+1 WHERE id='site114'").run();
  expect(
    await env.DB.prepare("SELECT build_state_recovery_count FROM publications WHERE id='site114'").first(
      "build_state_recovery_count",
    ),
  ).toBe(0);
});
