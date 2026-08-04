import { Type } from "@sinclair/typebox";

import { NonEmptyString } from "./primitives.js";

// ==================== Pipeline Edge Schema ====================

export const PipelineEdgeSchema = Type.Object(
  {
    fromJobId: NonEmptyString,
    toJobId: NonEmptyString,
    artifact: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

// ==================== Pipeline Schema ====================

export const PipelineSchema = Type.Object(
  {
    id: NonEmptyString,
    userId: NonEmptyString,
    name: NonEmptyString,
    description: Type.Optional(Type.String()),
    enabled: Type.Boolean(),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
);

// ==================== Request Params ====================

export const PipelineListParamsSchema = Type.Object(
  {
    includeDisabled: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const PipelineGetParamsSchema = Type.Object(
  {
    id: NonEmptyString,
  },
  { additionalProperties: false },
);

export const PipelineCreateParamsSchema = Type.Object(
  {
    name: NonEmptyString,
    description: Type.Optional(Type.String()),
    edges: Type.Optional(Type.Array(PipelineEdgeSchema)),
  },
  { additionalProperties: false },
);

export const PipelineUpdateParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    name: Type.Optional(NonEmptyString),
    description: Type.Optional(Type.String()),
    enabled: Type.Optional(Type.Boolean()),
    edges: Type.Optional(Type.Array(PipelineEdgeSchema)),
  },
  { additionalProperties: false },
);

export const PipelineRemoveParamsSchema = Type.Object(
  {
    id: NonEmptyString,
  },
  { additionalProperties: false },
);

// ==================== Type Aliases ====================

export type PipelineListParams = { includeDisabled?: boolean };
export type PipelineGetParams = { id: string };
export type PipelineCreateParams = {
  name: string;
  description?: string;
  edges?: Array<{ fromJobId: string; toJobId: string; artifact?: string }>;
};
export type PipelineUpdateParams = {
  id: string;
  name?: string;
  description?: string | null;
  enabled?: boolean;
  edges?: Array<{ fromJobId: string; toJobId: string; artifact?: string }>;
};
export type PipelineRemoveParams = { id: string };
