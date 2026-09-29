#!/usr/bin/env python3
"""Check rendered custom resources against the CRDs rendered alongside them.

Usage: check-crd-versions.py <rendered-dir> <schema-out-dir>

For every CustomResourceDefinition found in <rendered-dir> (the charts that
ship CRDs with `includeCRDs: true`), this:

1. Fails if any rendered resource of that group/kind uses an API version the
   CRD does not *serve*. This is the check that matters: external-secrets
   0.20 stopped serving v1beta1 while every manifest here still used it, and
   nothing in CI noticed. Public schema catalogs keep schemas for unserved
   versions, so kubeconform alone cannot catch this.
2. Writes the openAPIV3Schema of every served version to
   <schema-out-dir>/<group>/<kind>_<version>.json, the layout kubeconform's
   `{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json` template
   expects, so field validation uses exactly the schema that will be
   installed rather than a catalog's copy.

Kinds whose CRDs are not rendered here (Gateway API, NACK, GKE-managed CRDs)
are left to kubeconform's catalog fallback.
"""
import glob
import json
import os
import sys

import yaml


def main() -> int:
    rendered, out = sys.argv[1], sys.argv[2]

    docs = []
    for path in sorted(glob.glob(os.path.join(rendered, "*.yaml"))):
        with open(path) as f:
            docs += [(path, d) for d in yaml.safe_load_all(f) if d]

    served: dict[tuple[str, str], set[str]] = {}
    for _, doc in docs:
        if doc.get("kind") != "CustomResourceDefinition":
            continue
        group = doc["spec"]["group"]
        kind = doc["spec"]["names"]["kind"]
        for version in doc["spec"]["versions"]:
            if not version.get("served"):
                continue
            served.setdefault((group, kind), set()).add(version["name"])
            schema = version.get("schema", {}).get("openAPIV3Schema")
            if schema:
                os.makedirs(os.path.join(out, group), exist_ok=True)
                name = f"{kind.lower()}_{version['name']}.json"
                with open(os.path.join(out, group, name), "w") as f:
                    json.dump(schema, f)

    failures = []
    for path, doc in docs:
        api_version = doc.get("apiVersion", "")
        if "/" not in api_version:
            continue
        group, version = api_version.rsplit("/", 1)
        kind = doc.get("kind")
        versions = served.get((group, kind))
        if versions is not None and version not in versions:
            failures.append(
                f"{os.path.basename(path)}: {kind} "
                f"{doc.get('metadata', {}).get('name')} uses {api_version}, "
                f"but its rendered CRD serves only {sorted(versions)}"
            )

    for failure in failures:
        print(f"FAIL {failure}")
    print(
        f"{len(served)} rendered CRDs; "
        f"{len(failures)} resource(s) on an unserved API version"
    )
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
