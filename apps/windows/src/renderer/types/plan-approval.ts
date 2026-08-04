export interface PlanApprovalStep {
  order: number
  agentName: string
  description: string
  parallel?: boolean
}

export interface PlanApprovalPlan {
  summary: string
  steps: PlanApprovalStep[]
}

export interface PlanApprovalRequest {
  requestId: string
  sessionKey: string
  plan: PlanApprovalPlan
}

export type PlanApprovalDecision = 'approved' | 'rejected'

export interface SubAgentStatusEvent {
  sessionKey: string
  taskId: string
  agentName: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  summary?: string
}
