# Case Scope

## meta
- case_id: workflow-script-gate-verification
- created: 2026-08-17T22:27:26.0391487+08:00
- operator: local
- project_root: C:\Users\29594\Documents\pi-dynamic-workflows-public
- primary_skill: code-audit/SKILL.md
- primary_id: R26
- lead_role: lead
- specialist_roles: [cae]
- hint: 验证 workflow script gate 对官方示例的 computed-member-access 误报

## auth
- status: granted
- basis: own_system
- evidence_of_auth: cli-flag AuthGranted or AuthStatus=granted
- MUST NOT proceed if status != granted

## in_scope
- assets:
  - C:/Users/29594/Documents/pi-dynamic-workflows-public
- surfaces: [source-code, JavaScript/TypeScript static audit]
- activities: [offline-reproduction, PR-diff-review, false-positive-validation, remediation-assessment]

## out_of_scope
- assets: []
- activities: [network-scanning, dos, phishing_real_users, unrestricted_exfil]

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