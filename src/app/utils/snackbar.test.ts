// node --test src/app/utils/snackbar.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Snackbar, installSnackbar } from './snackbar.ts';

// Just enough DOM for the snackbar. Writing innerHTML fails the test, so any
// regression back to HTML parsing of caller text is caught.
class FakeElement {
  tagName: string;
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  style: Record<string, string> = {};
  className = '';
  textContent = '';
  attributes: Record<string, string> = {};
  listeners: Record<string, ((event: any) => void)[]> = {};
  constructor(tagName: string) { this.tagName = tagName; }
  set innerHTML(_value: string) { throw new Error('innerHTML must not be used'); }
  appendChild(child: FakeElement) { child.parentElement = this; this.children.push(child); return child; }
  removeChild(child: FakeElement) { this.children = this.children.filter(c => c !== child); child.parentElement = null; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener(type: string, fn: (event: any) => void) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type: string, event: any = {}) { for (const fn of this.listeners[type] || []) fn(event); }
}

function useDom() {
  const body = new FakeElement('body');
  (globalThis as any).document = { body, createElement: (tag: string) => new FakeElement(tag) };
  (globalThis as any).getComputedStyle = () => ({ bottom: '0px', top: 'auto' });
  Snackbar.current = null;
  return body;
}

test('writes message and button labels as text, never as HTML', () => {
  const body = useDom();
  const payload = '<img src=x onerror=alert(1)>';
  Snackbar.show({ text: payload, actionText: '<b>Undo</b>', duration: 0 });
  const bar = body.children[0];
  assert.equal(bar.children[0].tagName, 'p');
  assert.equal(bar.children[0].textContent, payload);
  assert.equal(bar.children[1].textContent, '<b>Undo</b>');
  assert.match(bar.className, /snackbar-container\s+snackbar-pos bottom-left/);
  assert.equal(bar.style.opacity, '1');
});

test('keeps node-snackbar defaults: a Dismiss action that fades the bar', () => {
  const body = useDom();
  Snackbar.show({ text: 'Saved', duration: 0 });
  const bar = body.children[0];
  const action = bar.children[1];
  assert.equal(action.textContent, 'Dismiss');
  action.dispatch('click');
  assert.equal(bar.style.opacity, '0');
  bar.dispatch('transitionend', { propertyName: 'opacity' });
  assert.equal(body.children.length, 0);
  assert.equal(Snackbar.current, null);
});

test('calls onActionClick with the bar and honours showAction false', () => {
  const body = useDom();
  let clicked: unknown = null;
  Snackbar.show({ text: 'Deleted', actionText: 'Undo', duration: 0, onActionClick: el => { clicked = el; } });
  const bar = body.children[0];
  bar.children[1].dispatch('click');
  assert.equal(clicked, bar);

  Snackbar.show({ text: 'Plain', showAction: false, duration: 0 });
  assert.equal(Snackbar.current!.children.length, 1);
});

test('installs the global used by existing callers', () => {
  const target: any = {};
  installSnackbar(target);
  assert.equal(target.Snackbar, Snackbar);
});
