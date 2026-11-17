# Search and filters

Use **Filters** beside the search box, or type a filter directly. Combine filters with ordinary text to narrow your results.

| Filter | Finds notes with |
| --- | --- |
| `!image` | Images or an image background |
| `!drawing` | A drawing |
| `!url` | Links |
| `!attachment` | File attachments |
| `!todo` | Checklist items |
| `!label` | Any label |
| `!label:travel` | The Travel label; use lowercase and hyphens for spaces, such as `!label:home-office` |
| `!date 2025` | A creation date in 2025; more examples below |

For example, `holiday !image` finds notes matching “holiday” that contain images, and `budget !date 2025 !todo` finds matching checklist notes created in 2025. Select a label or binder in the sidebar to browse its notes.

## Creation dates

Select **Filters → Date**, then type a date after `!date` in the search bar or click an example below the checkbox. You can also enter `!date` directly:

| Search | Notes created |
| --- | --- |
| `!date 2025` | During 2025 |
| `!date 2025-11` or `!date November 2025` | During November 2025 |
| `!date 2025-11-16` or `!date 16 November 2025` | On that day |
| `!date today` or `!date yesterday` | Today or yesterday |
| `!date Monday` | On the most recent Monday, including today |
| `!date last Monday` | On the most recent Monday before today |
| `!date last week`, `!date last month`, `!date last year` | During that calendar period |
| `!date two years ago` | During the year two years ago |

Combine a date filter with text or other filters, such as `budget !date 2025 !todo`. Dates use your device's local time; calendar weeks start on Monday. Month and weekday names use English, with abbreviations such as `Nov` and `Mon` also supported. A month or month/day without a year uses the current year.

Without `!date`, years, dates and phrases such as `Created on 2025` or `today` are searched as ordinary note text. Date filters use the note's **creation date**, rather than its reminder or last-edited date.
