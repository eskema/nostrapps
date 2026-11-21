# Napp sets

Lists of napps: a favorites list per user, and named sets anyone can publish. Each item can carry an action that the napp can open at launch.

## Items

An item is an `a` tag:

```
["a", "<kind>:<pubkey>:<d>", "<relay>", "<action>"]
```

- `<kind>` is `35130` (napp) or `35131` (wasm napp). Other kinds are ignored.
- `<relay>` is a hint and may be empty.
- `<action>` is optional: the napp's default action, inline as `<name> <payload>` (or `<name>` alone), or `$<id>` for a declared one.

A napp appears once per list.

An action several items share is declared once:

```
["action", "<id>", "<name> <payload>"]
```

and each of them carries `$<id>`. A `$<id>` with no matching `action` tag is ignored. Publishers write an action inline when one item has it and declare it when more do.

## Favorites

Kind `10130`, replaceable, a NIP-51 standard list.

- Public items are `a` tags.
- Private items are the same tags as a JSON array, NIP-44 encrypted to the author's own key, in `content`.

Order across the two halves isn't kept. A `$<id>` points into its own half: a private item's action is declared in `content` too.

Clients show each item as public or private and can move it across. Without NIP-44 the private half is not shown and is written back unchanged.

## Sets

Kind `30130`, addressable, public only.

```
["d", "<id>"]
["title", "<name>"]
["description", "<text>"]
["action", "1", "feed npub1…,npub1…"]
["a", "35130:<pubkey>:<d1>", "<relay>", "$1"]
["a", "35130:<pubkey>:<d2>", "<relay>", "$1"]
["a", "35130:<pubkey>:<d3>", "<relay>", "profile npub1…"]
["a", "35130:<pubkey>:<d4>", "<relay>", "home"]
["a", "35131:<pubkey>:<d5>", "<relay>"]
```

Tag order is display order.
