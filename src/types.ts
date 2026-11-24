import type { RecordVersion } from "./dns";

// ---------------------------------------------------------------- event sources

export type EventSource =
  | { kind: "http"; submitted_at: string }
  | { kind: "recrawl" }
  | { kind: "catalog"; domain: string; catalog_url: string }
  | {
      kind: "atproto";
      did: string;
      handle: string | null;
      uri: string; // at://did/collection/rkey
      cid: string | null;
      /** true when the account's verified domain (handle or did:web) covers the server host. */
      domain_verified: boolean;
    };

// ---------------------------------------------------------------- queue messages

export type WorkMessage =
  | { kind: "probe"; url: string; source: EventSource }
  | { kind: "discover_domain"; domain: string; source: EventSource }
  | {
      kind: "atproto_commit";
      did: string;
      collection: string;
      rkey: string;
      operation: "create" | "update" | "delete";
      cid: string | null;
      record: unknown;
      time_us: number;
    }
  | { kind: "reverify_index"; index_id: string };

export interface DeliverMessage {
  event_id: string;
  index_id: string;
}

// ---------------------------------------------------------------- MCP probe output

export type Era = "modern" | "legacy-streamable-http" | "legacy-sse";

export interface ProviderInfo {
  name: string | null;
  title: string | null;
  description: string | null;
  version: string | null;
  icons: unknown[];
  website_url: string | null;
  documentation_url: string | null;
  privacy_policy_url: string | null;
  terms_of_service_url: string | null;
  support_url: string | null;
  support_email: string | null;
  /** Where each field came from, e.g. { name: "server-card" }. */
  sources: Record<string, string>;
}

export interface AuthInfo {
  required: boolean;
  /** URL of RFC 9728 protected resource metadata, from WWW-Authenticate or well-known. */
  resource_metadata_url: string | null;
  resource_metadata: Record<string, unknown> | null;
  authorization_servers: string[];
  scopes_supported: string[];
}

export interface ServerCardInfo {
  url: string;
  /** HTTPS + same origin as the server URL, no cross-origin redirect (SEP-2127 trust rule). */
  same_origin: boolean;
  via: "server-card-path" | "ai-catalog";
  card: Record<string, unknown>;
}

export interface ProbeResult {
  url: string;
  status: "ok" | "auth_required";
  era: Era | null;
  transport: "streamable-http" | "sse" | null;
  protocol_version: string | null;
  supported_versions: string[];
  server_info: Record<string, unknown> | null;
  capabilities: Record<string, unknown> | null;
  instructions: string | null;
  tools: unknown[] | null;
  prompts: unknown[] | null;
  resources: unknown[] | null;
  resource_templates: unknown[] | null;
  truncated: boolean;
  auth: AuthInfo;
  server_card: ServerCardInfo | null;
  provider: ProviderInfo;
  probed_at: string;
}

// ---------------------------------------------------------------- events delivered to indexes

export type EventType =
  | "mcp.server.updated"
  | "mcp.server.unreachable"
  | "mcp.server.removed"
  | "mcpnow.ping";

export interface McpNowEvent<T extends EventType = EventType> {
  /** Payload format version; matches the index's TXT record `v=` tag. */
  version: RecordVersion;
  id: string;
  type: T;
  time: string;
  /** Monotonic sequence number from /events. Absent on pings. */
  seq?: number;
  source: EventSource | { kind: "mcpnow" };
  data: EventData[T];
}

export interface EventData {
  "mcp.server.updated": ProbeResult & { changed: boolean; previous_status: string | null };
  "mcp.server.unreachable": { url: string; error: string; last_ok_at: string | null };
  "mcp.server.removed": { url: string; reason: "atproto_record_deleted" | "atproto_record_changed" };
  "mcpnow.ping": { index_id: string; message: string };
}

// ---------------------------------------------------------------- D1 rows

export interface IndexRow {
  id: string;
  method: "dns" | "atproto";
  domain: string;
  auth_key: string | null;
  did: string | null;
  rkey: string | null;
  endpoint: string;
  version: RecordVersion;
  status: "active" | "suspended" | "revoked";
  status_reason: string | null;
  created_at: number;
  updated_at: number;
  verified_at: number;
  last_attempt_at: number | null;
  last_success_at: number | null;
  last_error: string | null;
  consecutive_failures: number;
}

export interface ServerRow {
  url: string;
  first_seen_at: number;
  status: "pending" | "ok" | "auth_required" | "unreachable";
  last_submitted_at: number | null;
  last_probed_at: number | null;
  last_ok_at: number | null;
  last_error: string | null;
  info_hash: string | null;
  info: string | null;
}
