---
on:
  issues:
    types: [opened]
permissions:
  issues: write
  contents: read
  pull-requests: read
safe-outputs:
  add-labels: true
  add-comment: true
engine: copilot
---

You are an autonomous GitHub Agent. On new issue:
- Triage and label it.
- Use AWS OIDC role (`{{ secrets.AWS_ROLE_ARN }}`) if needed for CloudWatch context.
- Comment with analysis and next steps.
