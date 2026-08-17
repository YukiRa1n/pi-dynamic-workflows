# Case Scope

## meta
- case_id: workflow-script-gate-verifier
- created: 2026-08-17T22:29:38.9682576+08:00
- operator: local
- project_root: C:\Users\29594\Documents\pi-dynamic-workflows-public
- primary_skill: reverse-engineering/SKILL.md
- primary_id: R0
- lead_role: lead
- specialist_roles: []
- hint: 验证 workflow script gate plain-object count map false positive

## auth
- status: granted
- basis: own_system
- evidence_of_auth: owner-operated local repository review
- MUST NOT proceed if status != granted

## in_scope
- assets:
  - C:/Users/29594/Documents/pi-dynamic-workflows-public/src/workflow-script-gate.ts
- surfaces: []
- activities: []

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
- ready_for_act: false
- checklist:
  - [x] auth.status = granted
  - [x] in_scope.assets non-empty OR offline sample path set
  - [x] network_profile.mode chosen
  - [ ] out_of_scope reviewed
  - [ ] roles assigned (see skills/ops/role-map.md)

## ops_refs
- skills/ops/scope-contract.md
- skills/ops/evidence-finding-path.md
- skills/ops/role-map.md
- skills/ops/timeline-workitem.md
- skills/ops/IDENTITY.md