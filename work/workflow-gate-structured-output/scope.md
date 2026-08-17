# Case Scope

## meta
- case_id: workflow-gate-structured-output
- created: 2026-08-17T22:26:28.0791166+08:00
- operator: local
- project_root: C:\Users\29594\Documents\pi-dynamic-workflows-public
- primary_skill: reverse-engineering/SKILL.md
- primary_id: R0
- lead_role: lead
- specialist_roles: [cre, cae]
- hint: 验证 structured-output.js 的 computed member access 误报

## auth
- status: granted
- basis: own_system
- evidence_of_auth: cli-flag AuthGranted or AuthStatus=granted
- MUST NOT proceed if status != granted

## in_scope
- assets:
  - src/workflow-script-gate.ts
  - skills/workflow-authoring/examples/structured-output.js
  - src/workflow.ts
- surfaces: [source, local-runtime]
- activities: [static-analysis, offline-reproduction]

## out_of_scope
- assets: []
- activities: [dos, phishing_real_users, unrestricted_exfil]

## network_profile
- mode: offline
- notes: |
    offline | lab_only | authorized_target_only | unrestricted_lab
    Change mode only after auth.status = granted.

## deliverables
- report: true
- field_journal: true
- diagrams: true
- timeline: true

## constraints
- timebox: {}
- stealth: low
- data_handling: anonymize

## signoff
- ready_for_act: true
- checklist:
  - [x] auth.status = granted
  - [x] in_scope.assets non-empty OR offline sample path set
  - [x] network_profile.mode chosen
  - [x] out_of_scope reviewed
  - [x] roles assigned (see skills/ops/role-map.md)

## ops_refs
- skills/ops/scope-contract.md
- skills/ops/evidence-finding-path.md
- skills/ops/role-map.md
- skills/ops/timeline-workitem.md
- skills/ops/IDENTITY.md