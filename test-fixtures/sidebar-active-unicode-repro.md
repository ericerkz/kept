# Sidebar selection highlighting: Unicode and encoded route segments

## Reproduction (current behavior)

The active navigation highlight appears for a simple ASCII Binder name like `Auta`, but it is missing for Binder names such as `Dům a zahrada`. The selected content opens correctly; only the sidebar's active state is wrong.

The sidebar currently checks `router.url === '/binder/' + binder.name` and analogously for Labels. `router.url` contains URL-encoded path segments while displayed names are decoded, so the string comparison can fail for accented letters, spaces, and other special characters.

## Expected behavior

- Highlight the active Binder or Label regardless of diacritics or spaces in its name.
- Highlight exactly the selected item, not similarly prefixed names.
- Keep existing navigation, styling, collapsed/mobile behavior, and non-Binder menu items unchanged.

## Regression cases

| Section | Name | Expectation |
| --- | --- | --- |
| Binder | `Auta` | Active highlight |
| Binder | `Dům a zahrada` | Active highlight |
| Binder | `České poznámky` | Active highlight |
| Label | `Úkoly doma` | Active highlight |
| Label | `Běžné` | Active highlight |
| Both | Non-selected item | No active highlight |

The implementation is pending; this document records the reproducible bug and expected behavior for the draft PR.
