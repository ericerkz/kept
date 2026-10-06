const test = require('node:test');
const assert = require('node:assert/strict');
const fixtures = require('../test-fixtures/native-contract.json');
const { nextRepeatDueAt, isRepeatOccurrence } = require('./reminder-recurrence');

for (const fixture of fixtures.recurrence) {
  test(`shared recurrence fixture: ${fixture.id}`, () => {
    assert.equal(nextRepeatDueAt(fixture.dueAtUtc, fixture.rule, fixture.timezone, Date.parse(fixture.now), fixture.anchorAtUtc), fixture.nextDueAtUtc);
  });
}

test('a later valid occurrence remains actionable after the reminder cursor advances', () => {
  assert.equal(isRepeatOccurrence('2030-01-01T09:00:00.000Z', '2030-01-04T09:00:00.000Z', { type: 'daily' }, 'UTC'), true);
  assert.equal(isRepeatOccurrence('2030-01-01T09:00:00.000Z', '2030-01-04T09:01:00.000Z', { type: 'daily' }, 'UTC'), false);
});
