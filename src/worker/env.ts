import type { Document } from "./document";
import type { TableAuthority } from "./table-authority";
import type { WorkspaceEvents } from "./workspace-events";
import type { JobWorkflowParams } from "./jobs";
import type { PasswordCrypto } from "./password-crypto";
import type { PlatformCoordinator } from "./platform-coordinator";

export type { MemberContext } from "../shared/types";

export interface AppBindings {
  DB: D1Database;
  BUCKET: R2Bucket;
  DOCUMENT: DurableObjectNamespace<Document>;
  TABLE: DurableObjectNamespace<TableAuthority>;
  WORKSPACE_EVENTS: DurableObjectNamespace<WorkspaceEvents>;
  PASSWORD_CRYPTO: DurableObjectNamespace<PasswordCrypto>;
  NOTES_WORKFLOW: Workflow<Readonly<JobWorkflowParams>>;
  DELIVERY_QUEUE: Queue;
  API_SOURCE_BURST_LIMIT: RateLimit;
  API_SOURCE_MINUTE_LIMIT: RateLimit;
  API_BURST_LIMIT: RateLimit;
  API_MINUTE_LIMIT: RateLimit;
  CLIENT_TELEMETRY_LIMIT: RateLimit;
  CLIENT_TELEMETRY_PREAUTH_LIMIT: RateLimit;
  OBSERVABILITY: AnalyticsEngineDataset;
  CF_VERSION_METADATA: WorkerVersionMetadata;
  SEND_EMAIL?: SendEmail;
  BROWSER?: BrowserRun;
  EMAIL_FROM?: string;
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  SLACK_SIGNING_SECRET?: string;
  SLACK_TOKEN_ENCRYPTION_KEY?: string;
  WEBHOOK_ENCRYPTION_KEY?: string;
  OPENAI_API_KEY?: string;
  AI_TOKEN_ENCRYPTION_KEY?: string;
  CHATGPT_CONNECTION_ENABLED?: "true" | "false";
  CHATGPT_CLIENT_ID?: string;
  CHATGPT_CLIENT_SECRET?: string;
  CHATGPT_TOKEN_AUTH_METHOD?: "none" | "client_secret_basic";
  CHATGPT_SCOPES?: string;
  ASSETS: Fetcher;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  BOOTSTRAP_TOKEN: string;
  DO_LOCATION_HINT?: DurableObjectLocationHint;
  WORKFLOW_INLINE?: "true";
  EXPANDED_EMBEDS_ENABLED?: "true" | "false";
  EDITOR_BLOCKS_V2_ENABLED?: "true" | "false";
  TABLE_AUTHORITY_ENABLED?: "true" | "false";
  TABLE_BOARD_ENABLED?: "true" | "false";
  TABLE_RELATIONS_ENABLED?: "true" | "false";
  TABLE_CALENDAR_ENABLED?: "true" | "false";
  NOTION_MARKDOWN_WRITES_ENABLED?: "true" | "false";
  OFFLINE_EDITING_ENABLED?: "true" | "false";
  BLOCK_LINKS_ENABLED?: "true" | "false";
  LIVE_DIAGRAM_EMBEDS_ENABLED?: "true" | "false";
  DIFF_DIGESTS_ENABLED?: "true" | "false";
  WORKSPACE_ACTIVITY_ENABLED?: "true" | "false";
  SLACK_CHANNEL_VALIDATION_ENABLED?: "true" | "false";
  SLACK_SHARE_REFRESH_ENABLED?: "true" | "false";
  SLACK_RICH_DIGESTS_ENABLED?: "true" | "false";
  SLACK_DIGEST_DEFAULT_TIMEZONE?: string;
  OBSERVABILITY_PROBE_TOKEN?: string;
  // Optional platform capabilities. Portable installations do not provision paid services.
  PLATFORM_QUEUE?: Queue;
  PLATFORM?: DurableObjectNamespace<PlatformCoordinator>;
  AI?: Ai;
  SEMANTIC_INDEX?: Vectorize;
  SEMANTIC_SEARCH_ENABLED?: "true" | "false";
  SEMANTIC_DAILY_TOKEN_LIMIT?: string;
  SEMANTIC_DAILY_QUERY_LIMIT?: string;
  SEMANTIC_MAX_STORED_CHUNKS?: string;
  D1_READ_REPLICATION_ENABLED?: "true" | "false";
  D1_READ_REPLICATION_ROUTES?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_ENABLED?: "true" | "false";
  AUTH_MODE?: "local" | "access_required";
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  PUBLIC_BASE_URL?: string;
  PUBLICATIONS_BUCKET?: R2Bucket;
  PUBLIC_PUBLISHING_ENABLED?: "true" | "false";
  IMAGES?: ImagesBinding;
  IMAGES_ENABLED?: "true" | "false";
  FORMS_ENABLED?: "true" | "false";
  FORMS_DAILY_LIMIT?: string;
  TABLE_GALLERY_ENABLED?: "true" | "false";
  CF_ZONE_ID?: string;
  CF_ACCOUNT_ID?: string;
  CF_SAAS_API_TOKEN?: string;
  CF_CACHE_PURGE_API_TOKEN?: string;
  CUSTOM_HOSTNAMES_ENABLED?: "true" | "false";
  SAAS_CNAME_TARGET?: string;
  SLACK_ENCRYPTION_KEYS?: { get(): Promise<string> };
  WEBHOOK_ENCRYPTION_KEYS?: { get(): Promise<string> };
  AI_ENCRYPTION_KEYS?: { get(): Promise<string> };
  AUDIT_ENABLED?: "true" | "false";
  AUDIT_BUCKET?: R2Bucket;
  AUDIT_HOT_DAYS?: string;
  AUDIT_ARCHIVE_DAYS?: string;
  BASIN_ENABLED?: "true" | "false";
  AUDIT_PIPELINE?: { send(records: Record<string, unknown>[]): Promise<void> };
  HEATMAP_PIPELINE?: { send(records: Record<string, unknown>[]): Promise<void> };
  HEATMAPS_ENABLED?: "true" | "false";
  HEATMAP_HMAC_KEY?: string;
}

export interface Env extends AppBindings {}

declare global {
  namespace Cloudflare {
    interface Env extends Omit<
      AppBindings,
      | "BROWSER"
      | "CHATGPT_CONNECTION_ENABLED"
      | "EXPANDED_EMBEDS_ENABLED"
      | "EDITOR_BLOCKS_V2_ENABLED"
      | "TABLE_AUTHORITY_ENABLED"
      | "TABLE_BOARD_ENABLED"
      | "TABLE_RELATIONS_ENABLED"
      | "TABLE_CALENDAR_ENABLED"
      | "NOTION_MARKDOWN_WRITES_ENABLED"
      | "OFFLINE_EDITING_ENABLED"
      | "BLOCK_LINKS_ENABLED"
      | "LIVE_DIAGRAM_EMBEDS_ENABLED"
      | "DIFF_DIGESTS_ENABLED"
      | "WORKSPACE_ACTIVITY_ENABLED"
      | "SLACK_CHANNEL_VALIDATION_ENABLED"
      | "SLACK_SHARE_REFRESH_ENABLED"
      | "SLACK_RICH_DIGESTS_ENABLED"
      | "SLACK_DIGEST_DEFAULT_TIMEZONE"
      | "PLATFORM"
      | "AUTH_MODE"
      | "SEMANTIC_SEARCH_ENABLED"
      | "SEMANTIC_MAX_STORED_CHUNKS"
      | "SEMANTIC_DAILY_TOKEN_LIMIT"
      | "D1_READ_REPLICATION_ENABLED"
      | "D1_READ_REPLICATION_ROUTES"
      | "PUBLIC_PUBLISHING_ENABLED"
      | "IMAGES_ENABLED"
      | "FORMS_ENABLED"
      | "FORMS_DAILY_LIMIT"
      | "TABLE_GALLERY_ENABLED"
      | "TURNSTILE_ENABLED"
      | "CUSTOM_HOSTNAMES_ENABLED"
      | "AUDIT_ENABLED"
      | "AUDIT_HOT_DAYS"
      | "AUDIT_ARCHIVE_DAYS"
      | "BASIN_ENABLED"
      | "HEATMAPS_ENABLED"
    > {}
  }
}
