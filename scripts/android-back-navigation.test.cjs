const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

const source = fs.readFileSync('src/app/app.component.ts', 'utf8');
function method(name) {
  const start = source.indexOf(`  private ${name}(`);
  assert.ok(start >= 0, `Missing AppComponent method: ${name}`);
  const end = source.indexOf('\n  }', start);
  assert.ok(end > start);
  return source.slice(start, end + 4);
}
const navigation = stripTypeScriptTypes(`class BackNavigation {
  ${method('handleAndroidBackButton')}
  ${method('isSidebarOpen')}
}
globalThis.BackNavigation = BackNavigation;`);

function harness({ drawer = false, expanded = true, route = '/archive' } = {}) {
  const events = [];
  const sidebar = { classList: { contains: name => name === 'close' && !expanded } };
  const backdrop = {};
  const context = vm.createContext({
    document: { querySelector(selector) {
      if (selector === '[sideBar]') return sidebar;
      // The PR keeps this element mounted even in desktop/tablet layouts.
      if (selector === '.sidebar-backdrop') return backdrop;
      if (selector === '.sidebar-backdrop.is-open') return drawer && expanded ? backdrop : null;
      return null;
    } },
    window: { history: { back: () => events.push('back') } },
    CapacitorApp: { exitApp: () => events.push('exit') }
  });
  vm.runInContext(navigation, context);
  const app = Object.create(context.BackNavigation.prototype);
  Object.assign(app, {
    closeOpenTooltip: () => false,
    isNoteModalOpen: () => false,
    router: { url: route },
    shared: {
      selectedNoteIds: { value: [] },
      closeSideBarIfOpen: { next() {
        events.push('close-sidebar');
        if (drawer) expanded = false;
      } }
    }
  });
  return { back: canGoBack => app.handleAndroidBackButton({ canGoBack }), events };
}

test('Android Back navigates repeatedly with an expanded tablet sidebar and hidden backdrop', () => {
  const h = harness();
  h.back(true);
  h.back(true);
  assert.deepEqual(h.events, ['back', 'back']);
});

test('Android Back can exit the overview with an expanded tablet sidebar', () => {
  const h = harness({ route: '/' });
  h.back(false);
  assert.deepEqual(h.events, ['exit']);
});

test('Android Back closes an open phone drawer first, then navigates', () => {
  const h = harness({ drawer: true });
  h.back(true);
  assert.deepEqual(h.events, ['close-sidebar']);
  h.back(true);
  assert.deepEqual(h.events, ['close-sidebar', 'back']);
});

test('a closed drawer or collapsed tablet sidebar does not consume Android Back', () => {
  for (const drawer of [true, false]) {
    const h = harness({ drawer, expanded: false });
    h.back(true);
    assert.deepEqual(h.events, ['back']);
  }
});
