import type { Static } from "@sinclair/typebox";

import type {
  AgentEventSchema,
  AgentIdentityParamsSchema,
  AgentIdentityResultSchema,
  AgentWaitParamsSchema,
  PollParamsSchema,
  WakeParamsSchema,
} from "./agent.js";
import type {
  AgentSummarySchema,
  AgentsListParamsSchema,
  AgentsListResultSchema,
  ModelChoiceSchema,
  ModelsListParamsSchema,
  ModelsListResultSchema,
  SkillsBinsParamsSchema,
  SkillsBinsResultSchema,
  SkillsInstallParamsSchema,
  SkillsStatusParamsSchema,
  SkillsUpdateParamsSchema,
} from "./agents-models-skills.js";
import type {
  ChannelsLogoutParamsSchema,
  ChannelsStatusParamsSchema,
  ChannelsStatusResultSchema,
  TalkModeParamsSchema,
  WebLoginStartParamsSchema,
  WebLoginWaitParamsSchema,
} from "./channels.js";
import type {
  ConfigApplyParamsSchema,
  ConfigGetParamsSchema,
  ConfigPatchParamsSchema,
  ConfigSchemaParamsSchema,
  ConfigSchemaResponseSchema,
  ConfigSetParamsSchema,
  ConfigSourcesParamsSchema,
  UpdateRunParamsSchema,
} from "./config.js";
import type {
  ExecApprovalsGetParamsSchema,
  ExecApprovalsNodeGetParamsSchema,
  ExecApprovalsNodeSetParamsSchema,
  ExecApprovalsSetParamsSchema,
  ExecApprovalsSnapshotSchema,
  ExecApprovalRequestParamsSchema,
  ExecApprovalResolveParamsSchema,
} from "./exec-approvals.js";
import type {
  ConnectParamsSchema,
  ErrorShapeSchema,
  EventFrameSchema,
  GatewayFrameSchema,
  HelloOkSchema,
  RequestFrameSchema,
  ResponseFrameSchema,
  ShutdownEventSchema,
  TickEventSchema,
} from "./frames.js";
import type {
  ChatAbortParamsSchema,
  ChatEventSchema,
  ChatInjectParamsSchema,
  LogsTailParamsSchema,
  LogsTailResultSchema,
} from "./logs-chat.js";
import type {
  RfsDeleteParamsSchema,
  RfsEnsureDirParamsSchema,
  RfsReadChunkParamsSchema,
  RfsReaddirParamsSchema,
  RfsStatParamsSchema,
  RfsWriteChunkParamsSchema,
} from "./rfs.js";
import type {
  SessionsCompactParamsSchema,
  SessionsDeleteParamsSchema,
  SessionsListParamsSchema,
  SessionsPatchParamsSchema,
  SessionsPreviewParamsSchema,
  SessionsResetParamsSchema,
  SessionsResolveParamsSchema,
} from "./sessions.js";
import type { PresenceEntrySchema, SnapshotSchema, StateVersionSchema } from "./snapshot.js";
import type {
  WizardCancelParamsSchema,
  WizardNextParamsSchema,
  WizardNextResultSchema,
  WizardStartParamsSchema,
  WizardStartResultSchema,
  WizardStatusParamsSchema,
  WizardStatusResultSchema,
  WizardStepSchema,
} from "./wizard.js";

export type ConnectParams = Static<typeof ConnectParamsSchema>;
export type HelloOk = Static<typeof HelloOkSchema>;
export type RequestFrame = Static<typeof RequestFrameSchema>;
export type ResponseFrame = Static<typeof ResponseFrameSchema>;
export type EventFrame = Static<typeof EventFrameSchema>;
export type GatewayFrame = Static<typeof GatewayFrameSchema>;
export type Snapshot = Static<typeof SnapshotSchema>;
export type PresenceEntry = Static<typeof PresenceEntrySchema>;
export type ErrorShape = Static<typeof ErrorShapeSchema>;
export type StateVersion = Static<typeof StateVersionSchema>;
export type AgentEvent = Static<typeof AgentEventSchema>;
export type AgentIdentityParams = Static<typeof AgentIdentityParamsSchema>;
export type AgentIdentityResult = Static<typeof AgentIdentityResultSchema>;
export type PollParams = Static<typeof PollParamsSchema>;
export type AgentWaitParams = Static<typeof AgentWaitParamsSchema>;
export type WakeParams = Static<typeof WakeParamsSchema>;
export type RfsStatParams = Static<typeof RfsStatParamsSchema>;
export type RfsReaddirParams = Static<typeof RfsReaddirParamsSchema>;
export type RfsReadChunkParams = Static<typeof RfsReadChunkParamsSchema>;
export type RfsWriteChunkParams = Static<typeof RfsWriteChunkParamsSchema>;
export type RfsDeleteParams = Static<typeof RfsDeleteParamsSchema>;
export type RfsEnsureDirParams = Static<typeof RfsEnsureDirParamsSchema>;
export type SessionsListParams = Static<typeof SessionsListParamsSchema>;
export type SessionsPreviewParams = Static<typeof SessionsPreviewParamsSchema>;
export type SessionsResolveParams = Static<typeof SessionsResolveParamsSchema>;
export type SessionsPatchParams = Static<typeof SessionsPatchParamsSchema>;
export type SessionsResetParams = Static<typeof SessionsResetParamsSchema>;
export type SessionsDeleteParams = Static<typeof SessionsDeleteParamsSchema>;
export type SessionsCompactParams = Static<typeof SessionsCompactParamsSchema>;
export type ConfigGetParams = Static<typeof ConfigGetParamsSchema>;
export type ConfigSetParams = Static<typeof ConfigSetParamsSchema>;
export type ConfigApplyParams = Static<typeof ConfigApplyParamsSchema>;
export type ConfigPatchParams = Static<typeof ConfigPatchParamsSchema>;
export type ConfigSchemaParams = Static<typeof ConfigSchemaParamsSchema>;
export type ConfigSchemaResponse = Static<typeof ConfigSchemaResponseSchema>;
export type ConfigSourcesParams = Static<typeof ConfigSourcesParamsSchema>;
export type WizardStartParams = Static<typeof WizardStartParamsSchema>;
export type WizardNextParams = Static<typeof WizardNextParamsSchema>;
export type WizardCancelParams = Static<typeof WizardCancelParamsSchema>;
export type WizardStatusParams = Static<typeof WizardStatusParamsSchema>;
export type WizardStep = Static<typeof WizardStepSchema>;
export type WizardNextResult = Static<typeof WizardNextResultSchema>;
export type WizardStartResult = Static<typeof WizardStartResultSchema>;
export type WizardStatusResult = Static<typeof WizardStatusResultSchema>;
export type TalkModeParams = Static<typeof TalkModeParamsSchema>;
export type ChannelsStatusParams = Static<typeof ChannelsStatusParamsSchema>;
export type ChannelsStatusResult = Static<typeof ChannelsStatusResultSchema>;
export type ChannelsLogoutParams = Static<typeof ChannelsLogoutParamsSchema>;
export type WebLoginStartParams = Static<typeof WebLoginStartParamsSchema>;
export type WebLoginWaitParams = Static<typeof WebLoginWaitParamsSchema>;
export type AgentSummary = Static<typeof AgentSummarySchema>;
export type AgentsListParams = Static<typeof AgentsListParamsSchema>;
export type AgentsListResult = Static<typeof AgentsListResultSchema>;
export type ModelChoice = Static<typeof ModelChoiceSchema>;
export type ModelsListParams = Static<typeof ModelsListParamsSchema>;
export type ModelsListResult = Static<typeof ModelsListResultSchema>;
export type SkillsStatusParams = Static<typeof SkillsStatusParamsSchema>;
export type SkillsBinsParams = Static<typeof SkillsBinsParamsSchema>;
export type SkillsBinsResult = Static<typeof SkillsBinsResultSchema>;
export type SkillsInstallParams = Static<typeof SkillsInstallParamsSchema>;
export type SkillsUpdateParams = Static<typeof SkillsUpdateParamsSchema>;
export type LogsTailParams = Static<typeof LogsTailParamsSchema>;
export type LogsTailResult = Static<typeof LogsTailResultSchema>;
export type ExecApprovalsGetParams = Static<typeof ExecApprovalsGetParamsSchema>;
export type ExecApprovalsSetParams = Static<typeof ExecApprovalsSetParamsSchema>;
export type ExecApprovalsNodeGetParams = Static<typeof ExecApprovalsNodeGetParamsSchema>;
export type ExecApprovalsNodeSetParams = Static<typeof ExecApprovalsNodeSetParamsSchema>;
export type ExecApprovalsSnapshot = Static<typeof ExecApprovalsSnapshotSchema>;
export type ExecApprovalRequestParams = Static<typeof ExecApprovalRequestParamsSchema>;
export type ExecApprovalResolveParams = Static<typeof ExecApprovalResolveParamsSchema>;
export type ChatAbortParams = Static<typeof ChatAbortParamsSchema>;
export type ChatInjectParams = Static<typeof ChatInjectParamsSchema>;
export type ChatEvent = Static<typeof ChatEventSchema>;
export type UpdateRunParams = Static<typeof UpdateRunParamsSchema>;
export type TickEvent = Static<typeof TickEventSchema>;
export type ShutdownEvent = Static<typeof ShutdownEventSchema>;
