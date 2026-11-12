# Help translate Kept

Want to help make Kept available in your language? Translations, corrections, and reviews from fluent speakers are welcome. You can start with just a few messages—you don't need to be a developer or build the apps.

This repository holds the text for Kept's web interface, the shared in-app interface, and the Android and iOS screens.

## Getting started

If someone has already started your language, you can help fill in missing translations or improve the wording. Look for a file named after your language, such as `fr.json` for French or `pt-BR.json` for Brazilian Portuguese, in this folder. Each language has one file covering all parts of Kept.

If your language hasn't been started, you can add it yourself using the steps below. No issue or prior approval is needed.

Use [en.json](en.json) as the English reference. Each language file has three sections:

| Section | Where the text appears |
| --- | --- |
| `shared` | The web interface and the shared in-app interface on Android and iOS |
| `android` | Android-specific screens, including setup and widgets |
| `ios` | iOS-specific screens, including setup, widgets, and sign-in |

Translate each message once where it appears in [en.json](en.json). Wording used with the same meaning across the apps, such as Save and Cancel, has one entry that supplies all of them. Some Android and iOS messages are shared too, so a phrase used on iOS may have its entry in the `android` section. You can focus on whichever messages you know best.

Identical English words can have different meanings, so keep separate entries when they are listed separately. You don't need to copy translations between sections or edit [reuse.json](reuse.json); it connects reused messages to the apps automatically.

Each section uses labels on the left, with the translated text on the right. For example, if translating in French:

```json
{
  "shared": {
    "common.cancel": "Annuler",
    "common.save": "Enregistrer"
  },
  "android": {},
  "ios": {}
}
```

Only change the text on the right. Keep the labels, quotation marks, commas, and braces in place. Leave an unfinished translation as `""` rather than copying the English text into it; this makes the remaining work easier to find.

You can edit an existing file directly on GitHub using its pencil button, then follow GitHub's prompts to propose your changes in a pull request. To start a new language, follow the steps below.

## Adding a new language on GitHub

You can do this entirely in your browser. If you prefer the command line, there are [optional tools below](#optional-command-line-tools) prepare the files for you.

1. **Make your own copy of the repository.** Click **Fork** at the top of the Kept repository on GitHub. Make your changes in that fork so you can submit them together.
2. **Choose a language code.** For example, use `fr` for French, `de` for German, or `pt-BR` for Brazilian Portuguese.
3. **Create one translation file.** Open [en.json](en.json) and copy its contents. In the `translations` folder in your fork, choose **Add file → Create new file**, name it after your language (for example, `fr.json`), and paste the contents. Keep the three sections: `shared`, `android`, and `ios`.
4. **Translate the text.** Keep the labels on the left unchanged. Replace the English text on the right with your translations, or `""` for messages you haven't translated yet. Save the file in your fork. You can leave any section unfinished.
5. **Add your language to the list.** Edit [languages.json](languages.json) in your fork. Add an entry inside the existing `languages` list, keeping the other entries unchanged. Put a comma between entries. For French, the new entry is:

   ```json
   {
     "code": "fr",
     "name": "French",
     "nativeName": "Français",
     "direction": "ltr"
   }
   ```

   Replace the code and names with your language's details. `name` is its English name; `nativeName` is the name its speakers use. Use `"rtl"` for a right-to-left language, or `"ltr"` for left-to-right. Keep `sourceLanguage` as `"en"`.
6. **Submit your changes together.** Open a pull request from your fork to Kept with your translation file and the updated language list. You can submit a partial translation and continue it later.

## Writing a good translation

- **Use natural wording.** Aim for what someone would expect to read in an app in your language, rather than translating word for word. Keep similar buttons and actions consistent.
- **Keep placeholders unchanged.** Text such as `{{name}}`, `{{count}}`, or `{{value0}}` is filled in by the app. Keep its spelling and double braces, but move it wherever it belongs in your sentence. For example, `Hello {{name}}` could become `Bonjour {{name}}`.
- **Translate singular and plural forms.** Related messages ending in `.one` and `.other` provide different forms, such as `{{count}} item` and `{{count}} items`. Some languages need additional forms, such as `.two`, `.few`, or `.many`. The optional setup command prepares these for you; if creating files by hand, add the forms your language needs alongside the existing ones. Translate each form naturally and keep `{{count}}`. A standalone label ending in `.other` is not necessarily a plural message—use the English text as your guide.
- **Use plain text.** Links, styling, and formatting are supplied by the app; don't add HTML or Markdown to translations.
- **Keep names and technical details intact.** Product names, server addresses, file extensions, and placeholders for prices should stay as written.
- **Preserve the meaning of warnings.** Be especially careful with messages about permissions, payments, backups, and deleting data. Don't remove important details just to shorten a message.
- **Flag anything unclear.** Ask about unfamiliar wording in your issue or pull request instead of guessing. A screenshot or a description of where the message appears is helpful.

Short, clear wording helps on phone screens, but clarity comes first. Right-to-left languages are welcome too; mention the writing direction when starting a language.

## Sending your contribution

You can submit the web, Android, and iOS translations in one pull request. Partial translations are welcome and can ship—you don't have to translate everything yourself. Translate what you can and leave the rest blank; people can use the translated messages now while the remaining text appears in English. If you can also review someone else's translation, that's useful too.

In your pull request, mention:

- The language and any regional variant.
- Which sections you translated or reviewed.
- Any wording you were unsure about.

Please read [the contribution guidelines](../CONTRIBUTING.md), including the contributor agreement, before submitting.

## Optional command-line tools

You don't need these tools to help translate. However, if you already use the command line, you can prepare your language file from the repository root with Node 24 installed:

```sh
npm ci
npm run translations:init -- fr --name French --native-name Français
```

Replace the language code and names with yours. Add `--rtl` for a right-to-left language. This creates one file with blank translations in all three sections, without overwriting an existing language, and adds it to the language list. Translate what you can, then submit your pull request.

To check for formatting mistakes or changed placeholders:

```sh
npm run translations:check
```

Missing translations are reported as warnings; partial translations pass this check. For an optional check for 100% completeness across all sections:

```sh
npm run translations:check -- --complete fr
```

You don't need to run app builds or change application code.
