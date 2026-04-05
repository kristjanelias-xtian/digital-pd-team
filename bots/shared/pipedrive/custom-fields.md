# Custom Fields

## Why field keys are 40-character hashes

Pipedrive generates custom field keys as system hashes (e.g., `c4edaffd98369398ebaac0348cdb3f86f5a8eb26`). They are not human-readable and they are not stable across accounts — different Pipedrive instances will have different hashes for the same field name.

**Never hardcode a custom field key in a helper or a skill.** Always discover it at runtime.

## Discovering custom fields

Use the field metadata endpoints:

```
pd GET /dealFields
pd GET /personFields
pd GET /organizationFields
pd GET /productFields
```

Each response includes an array where each field has:
- `key` — the 40-character hash (use this when writing to the record)
- `name` — human-readable label (e.g. "System Size (kW)")
- `field_type` — varchar, text, enum, set, date, monetary, etc.
- `options` — for enum/set fields, a list of `{id, label}` pairs

## Using enum fields

When writing to an enum or set field, use the option **ID** (integer), not the label text. Example:

```python
# Discover the field
fields = pd.get("/dealFields")
roof_field = next(f for f in fields["data"] if f["name"] == "Roof Type")
key = roof_field["key"]
# Find the option ID for "Metal"
metal_id = next(o["id"] for o in roof_field["options"] if o["label"] == "Metal")
# Write it
pd.put(f"/deals/{deal_id}", {key: metal_id})
```

## Worked example: setting System Size

Goal: set the "System Size (kW)" field to 12 on deal 49.

```python
import json, subprocess

# 1. Discover the field
out = subprocess.run(["pd", "GET", "/dealFields"], capture_output=True, text=True)
fields = json.loads(out.stdout)["data"]
key = next(f["key"] for f in fields if f["name"] == "System Size (kW)")

# 2. Write it
body = json.dumps({key: 12})
subprocess.run(["pd", "PUT", f"/deals/49", body])
```

## When in doubt

Run the discovery endpoint, read the response, and use the exact `key` and `options.id` values. Never guess. Never copy hashes between instances.
