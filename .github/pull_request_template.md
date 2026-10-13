## 🔗 Related Issue
Closes #

## 📐 OpenSpec Traceability

<!--
Every PR cites the store change (or spec) it implements. The store is the
liverty-music/specification repository. Get the SHA with:
  git -C <specification-checkout> rev-parse --short HEAD
-->

- OpenSpec-Change: <!-- change id under openspec/changes/, or "none" -->
- OpenSpec-Spec: <!-- spec id under openspec/specs/ when no change applies -->
- Store commit: <!-- specification SHA the implementation was built against -->

## 📝 Summary of Changes
<!-- What resources are being added/modified? -->

## 🌍 Affected Stacks
- [ ] Dev
- [ ] Prod

## 🔮 Pulumi Preview
<!--
Pulumi Cloud posts the preview as a comment on this pull request — NOT in the
GitHub Actions output. Read it there; there is nothing to paste.

It runs for every stack whose trigger `paths` your change touches
(`src/pulumi-cloud/deployment-settings.ts`). If no preview appears and you did
change what the stack deploys, that is a gap in those `paths` — fix it there
rather than pasting a local run, which proves nothing a reviewer can re-check.

Exception: dependency pull requests (`package.json` / `package-lock.json`
only) are deliberately not previewed (design D6). For a Pulumi provider update,
the reviewer runs the `provider-upgrade` skill locally and posts its Upgrade
Summary as a comment.
-->

## 📦 State Changes
<!-- Does this require `pulumi state mv`, `import`, or destructive changes? -->

## ✅ Checklist
- [ ] The Pulumi Cloud preview comment on this PR shows no unintended changes.
- [ ] No unintended destructive changes.
- [ ] Secrets are managed in Pulumi Config.
