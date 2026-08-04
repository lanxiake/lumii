import { Type } from "@sinclair/typebox";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "../client-info.js";

/** 会话标签最大长度（原 src/sessions/session-label.ts，vendored 内联）*/
const SESSION_LABEL_MAX_LENGTH = 64;

export const NonEmptyString = Type.String({ minLength: 1 });
export const SessionLabelString = Type.String({
  minLength: 1,
  maxLength: SESSION_LABEL_MAX_LENGTH,
});

export const GatewayClientIdSchema = Type.Union(
  Object.values(GATEWAY_CLIENT_IDS).map((value) => Type.Literal(value)),
);

export const GatewayClientModeSchema = Type.Union(
  Object.values(GATEWAY_CLIENT_MODES).map((value) => Type.Literal(value)),
);
