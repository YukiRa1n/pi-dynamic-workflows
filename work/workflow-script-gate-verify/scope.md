# Case Scope

## meta
- case_id: workflow-script-gate-verify
- created: 2026-08-17T22:38:13.9198987+08:00
- operator: local
- project_root: C:\Users\29594\Documents\pi-dynamic-workflows-public
- primary_skill: llm-security/SKILL.md
- primary_id: R14
- lead_role: lead
- specialist_roles: [llm, cae]
- hint: LLM agent security audit of model-authored workflow script static gate; verify constructor/eval escape claim

## auth
- status: granted
- basis: own_system
- evidence_of_auth: cli-flag AuthGranted or AuthStatus=granted
- MUST NOT proceed if status != granted

## in_scope
- assets:
  - C:/Users/29594/Documents/pi-dynamic-workflows-public
- surfaces: [local_typescript, node_vm, static_ast_audit]
- activities: [code_review, audit_reproduction, runtime_trace]

## out_of_scope
- assets: [internet, production_services]
- activities: [dos, phishing_real_users, unrestricted_exfil, external_network_requests]

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