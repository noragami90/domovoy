import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultScreens, followRoom, loadScreens, resetScreens, saveScreens } from '../src/panel/screens.ts';
import { Store } from '../src/store/db.ts';

test('screens: a default set from the rooms until the user saves their own', () => {
  const store = new Store(':memory:');
  const rooms = ['Прихожая', 'Санузел'];
  assert.deepEqual(loadScreens(store, rooms), { screens: defaultScreens(rooms), custom: false });
  assert.deepEqual(defaultScreens(rooms)[1]!.panels, ['room:Прихожая', 'room:Санузел', 'room:'], 'devices without a room have a panel too');

  const mine = [{ name: 'Свет', panels: ['room:Прихожая', 'mode'] }, { name: ' Дом ', panels: ['clock'] }];
  saveScreens(store, mine);
  const loaded = loadScreens(store, rooms);
  assert.equal(loaded.custom, true);
  assert.equal(loaded.screens[1]!.name, 'Дом', 'names are trimmed');

  assert.throws(() => saveScreens(store, [{ name: 'А', panels: ['clock'] }, { name: 'Б', panels: ['clock'] }]), /уже есть на другом экране/);
  assert.throws(() => saveScreens(store, [{ name: 'А', panels: ['weather'] }]), /неизвестная панель/);
  assert.throws(() => saveScreens(store, []), /хотя бы один экран/);
  assert.throws(() => saveScreens(store, [{ name: '', panels: [] }]), /нужно имя/);
  assert.equal(loadScreens(store, rooms).screens[0]!.name, 'Свет', 'a rejected layout leaves the saved one');

  resetScreens(store);
  assert.equal(loadScreens(store, rooms).custom, false);
});

test('screens: a renamed room keeps its place, a deleted one leaves', () => {
  const store = new Store(':memory:');
  saveScreens(store, [{ name: 'Дом', panels: ['clock', 'room:Санузел', 'room:Лоджия'] }]);
  followRoom(store, 'Санузел', 'Ванная');
  followRoom(store, 'Лоджия', null);
  assert.deepEqual(loadScreens(store, []).screens[0]!.panels, ['clock', 'room:Ванная']);
});
