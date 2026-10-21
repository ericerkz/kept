import { NoteI } from '../interfaces/notes';
import { LabelI } from '../interfaces/labels';
import { bgColors, bgImages } from '../interfaces/tooltip';

// Shared starter content for server accounts and new device libraries.
export function createDemoNotes(label: LabelI): NoteI[] {
  return [
    {
      noteTitle: 'Saved Links 🔗',
      noteBody: 'You can save links in Kept and they\'ll automatically generate a full preview for you! Check out the project here: https://github.com/ericerkz/kept',
      bgColor: bgColors.sky,
      pinned: true, archived: false, trashed: false, isCbox: false, labels: [],
      isDemo: true
    },
    {
      noteTitle: 'My Cozy Day Plan (Checklist!) ☁️',
      noteBody: 'Look! You can make sweet little checklists to keep track of your day. Just like this one! ✨',
      isCbox: true,
      checkBoxes: [
        { data: 'Sip some Oat milk latte ☕', done: true, id: 1 },
        { data: 'Watch newest season of Aggretusko 🤘', done: true, id: 2 },
        { data: 'Migrate off Google Keep', done: false, id: 3 }
      ],
      bgColor: bgColors.creamsicle,
      pinned: false, archived: false, trashed: false, labels: [],
      isDemo: true
    },
    {
      noteTitle: 'Everything in its place! 🎀',
      noteBody: 'Keep things tidy and sweet with labels. This one is for your most special thoughts! ✨',
      bgColor: bgColors.lavender,
      labels: [{ ...label, added: true }],
      pinned: false, archived: false, trashed: false, isCbox: false,
      isDemo: true
    },
    {
      noteTitle: 'Doodle Corner (Canvas Note!) 🖍️',
      noteBody: 'Click the paint icon to start your first masterpiece. You can even draw lists like this one! ✨',
      bgColor: bgColors.mint,
      images: [{
        id: 'drawing', // Using the reserved 'drawing' ID to trigger canvas-note behavior
        dataUrl: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAwIiBoZWlnaHQ9IjQwMCIgdmlld0JveD0iMCAwIDQwMCA0MDAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CiAgPGcgc3Ryb2tlPSIjMjAyMTI0IiBzdHJva2Utd2lkdGg9IjQiIGZpbGw9Im5vbmUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+CiAgICA8IS0tIEJyZWFkIC0tPgogICAgPGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMCwgMCkiPgogICAgICA8cGF0aCBkPSJNIDUwIDYwIGMgMCAyMCAwIDQwIDUgNjAgbSAtNSAtNjAgYyAyMCAwIDMwIDUgMzAgMjAgYyAwIDEwIC0xMCAxNSAtMzAgMTUgYyAyMCAwIDM1IDUgMzUgMjUgYyAwIDE1IC0xNSAyMCAtMzUgMjAiIC8+CiAgICAgIDxwYXRoIGQ9Ik0gOTUgOTAgbCAwIDMwIG0gMCAtMjAgYyAxMCAtMTAgMjAgLTUgMjAgNSIgLz4KICAgICAgPHBhdGggZD0iTSAxMjUgMTEwIGwgMzAgMCBjIDAgLTIwIC0zMCAtMjAgLTMwIDAgYyAwIDIwIDMwIDIwIDMwIDEwIiAvPgogICAgICA8cGF0aCBkPSJNIDE2NSAxMTAgYyAwIC0yMCAzMCAtMjAgMzAgMCBsIDAgMjAgbSAwIC0yMCBjIC0zMCAwIC0zMCAyMCAwIDIwIiAvPgogICAgICA8cGF0aCBkPSJNIDIyNSA2MCBsIDAgNjAgYyAwIDE1IC0yMCAxNSAtMjAgMCBjIDAgLTE1IDIwIC0xNSAyMCAwIiAvPgogICAgICA8cGF0aCBkPSJNIDQwIDEwNSBjIDQwIC01LCAxMjAgNSwgMjAwIDAiIHN0cm9rZS13aWR0aD0iMyIgb3BhY2l0eT0iMC43IiAvPgogICAgPC9nPgogICAgPCEtLSBFZ2dzIC0tPgogICAgPGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMCwgMTAwKSI+CiAgICAgIDxwYXRoIGQ9Ik0gNTAgMTEwIGwgMzAgMCBjIDAgLTIwIC0zMCAtMjAgLTMwIDAgYyAwIDIwIDMwIDIwIDMwIDEwIiAvPgogICAgICA8cGF0aCBkPSJNIDk1IDExMCBjIDAgMTUgLTIwIDE1IC0yMCAwIGMgMCAtMTUgMjAgLTE1IDIwIDAgbCAwIDIwIGMgMCAxMCAtMjAgMTAgLTIwIDAiIC8+CiAgICAgIDxwYXRoIGQ9Ik0gMTMwIDExMCBjIDAgMTUgLTIwIDE1IC0yMCAwIGMgMCAtMTUgMjAgLTE1IDIwIDAgbCAwIDIwIGMgMCAxNSAtMzAgMTUgLTMwIDAiIC8+CiAgICAgIDxwYXRoIGQ9Ik0gMTY1IDExMCBjIDAgMTAgMzAgMTAgMzAgMjAgYyAwIDEwIC0zMCAxMCAtMzAgMjAiIC8+CiAgICAgIDxwYXRoIGQ9Ik0gNDAgMTIwIGMgNDAgNSwgMTAwIC01LCAxNjAgMyIgc3Ryb2tlLXdpZHRoPSIzIiBvcGFjaXR5PSIwLjciIC8+CiAgICA8L2c+CiAgICA8IS0tIEhlYXJ0IChSaWdodCBTaWRlLCBUaWx0ZWQgLSBGaXhlZCBQYXRoKSAtLT4KICAgIDxwYXRoIGQ9Ik0zMzQsMTAzIGMtOCwtMTYgLTMyLC0xNiAtMzIsMCBjMCwxNiAxNiwzMiAzMiw0OCBjMTYsLTE2IDMyLC0zMiAzMiwtNDggYzAsLTE2IC0yNCwtMTYgLTMyLDAiIGZpbGw9IiNmOGJiZDAiIHN0cm9rZT0iI2YwNjI5MiIgc3Ryb2tlLXdpZHRoPSIyLjUiIC8+CiAgPC9nPgo8L3N2Zz4=',
        name: 'Handwritten List|bg:rules',
        placement: 'top'
      }],
      pinned: false, archived: false, trashed: false, isCbox: false, labels: [],
      isDemo: true
    },
    {
      noteTitle: 'Our Icon (In-Situ Images!) ✨',
      noteBody: 'This card shows how you can add beautiful images directly to your notes. <div class="inline-note-image-wrap" contenteditable="false"><img class="inline-note-image" src="/assets/images/keep2x.png" alt="logo"></div> It\'s the perfect way to save your favorite memories right in the middle of your text! 🥰',
      bgColor: bgColors.cornflower,
      pinned: false, archived: false, trashed: false, isCbox: false, labels: [],
      isDemo: true
    },
    {
      noteTitle: 'A Little Nudge... ⏰',
      noteBody: 'Set a reminder and we\'ll handle the whole "remembering-things" stuff - with push notifications across all devices. If you have a preferred calendar for that stuff, you can set them up to sync to that, too.<br><br>Bonus: this card uses a background image — try the palette icon in the toolbar to set your own.',
      bgColor: bgColors.flamingo,
      bgImage: `url(${bgImages.romantic})`,
      pinned: false, archived: false, trashed: false, isCbox: false, labels: [],
      isDemo: true
    },
    {
      noteTitle: 'Files Welcome 📎',
      noteBody: 'Need to keep a PDF, doc, or zip alongside your notes? Drop in any file up to 25 MB with the paperclip icon. Files download with their original names — perfect for receipts, manuals, or that ZIP you keep losing track of. 📂',
      bgColor: bgColors.peach,
      pinned: false, archived: false, trashed: false, isCbox: false, labels: [],
      isDemo: true
    }
  ].map(note => ({ bgImage: '', checkBoxes: [], images: [], ...note })) as NoteI[];
}

export const demoWelcomeText =
  'Welcome to Kept!\n' +
  '================\n\n' +
  'This little file is here to show off how attachments work.\n' +
  'You can drop in PDFs, Office docs, ZIPs, plain text, and more —\n' +
  'up to 25 MB each. Files keep their original names on download,\n' +
  'so receipts, manuals, and anything else you want to keep next\n' +
  'to a note are just a click away.\n\n' +
  '— Kept ✨\n';
