# Case Scope

## meta
- case_id: verify-groups-computed-member
- created: 2026-08-17T22:29:37.6933568+08:00
- operator: local
- project_root: C:\Users\29594\Documents\pi-dynamic-workflows-public
- primary_skill: reverse-engineering/SKILL.md
- primary_id: R0
- lead_role: lead
- specialist_roles: []
- hint: 验证提交 2681c7b 中 workflow-script-gate 对 groups[key] 的误报

## auth
- status: granted
- basis: own_system
- evidence_of_auth: cli-flag AuthGranted or AuthStatus=granted
- MUST NOT proceed if status != granted

## in_scope
- assets:
  - C:\Users\29594\Documents\pi-dynamic-workflows-public\src\workflow-script-gate.ts
  - commit:2681c7b
- surfaces: [offline_source_audit, local_node_test]
- activities: [static_analysis, exploit_validate]

## out_of_scope
- assets: []
- activities: [dos, phishing_real_users, unrestricted_exfil, network_access]

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