// Temporary remote-development worker only. Never deploy a public maintenance route.
export default {
  async fetch(request, env) {
    if (
      !env.SNAPSHOT_SWEEP_TOKEN ||
      env.SNAPSHOT_SWEEP_TOKEN.length < 32 ||
      request.headers.get("authorization") !== `Bearer ${env.SNAPSHOT_SWEEP_TOKEN}`
    )
      return new Response("Forbidden", { status: 403 });
    if (request.method !== "POST") return new Response("Use POST", { status: 405 });
    const { objectId, after = "" } = await request.json();
    if (
      typeof objectId !== "string" ||
      !/^[a-f0-9]{64}$/.test(objectId) ||
      typeof after !== "string" ||
      after.length > 100
    )
      return new Response("Invalid inventory item", { status: 422 });
    const result = await env.TABLE.get(env.TABLE.idFromString(objectId)).reconcilePublicationSnapshots(after);
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  },
};
