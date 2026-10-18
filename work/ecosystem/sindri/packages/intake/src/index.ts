export const PACKAGE_NAME = "@sindri/intake";

export {
  openIntake,
  MAX_ATTACHMENT_BYTES,
  MAX_RAW_PAYLOAD_BYTES,
  type CreateManualInput,
  type ImportOptions,
  type Intake,
  type IntakeAttachment,
  type IntakeCommentRecord,
  type IntakePermissions,
  type IntakeRecord,
  type IntakeSource,
  type ManualAttachmentInput,
  type OpenIntakeOptions,
  type StoredSnapshot,
  type SyncState,
} from "./intake.js";
export {
  adfToText,
  ConnectorError,
  JiraConnector,
  LinearConnector,
  LINEAR_GRAPHQL_URL,
  MAX_IMPORTED_COMMENTS,
  MAX_FIELD_CHARS,
  type CommentsResult,
  type Connector,
  type ConnectorKind,
  type IssueComment,
  type IssueRef,
  type IssueSnapshot,
  type JiraConnectorOptions,
  type LinearConnectorOptions,
} from "./connectors.js";
export {
  assertSecretHandle,
  EnvSecretStore,
  execFileRunner,
  FileSecretStore,
  KeychainSecretStore,
  resolveSecret,
  type CommandRunner,
  type EnvSecretStoreOptions,
  type FileSecretStoreOptions,
  type KeychainSecretStoreOptions,
  type SecretHandle,
  type SecretSource,
  type SecretStore,
  type WritableSecretStore,
} from "./secrets.js";
export { MAX_DISPLAY_CHARS, sanitizeForDisplay } from "./sanitize.js";
export { INTAKE_MIGRATIONS } from "./schema.js";
