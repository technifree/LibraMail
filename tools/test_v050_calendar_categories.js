'use strict';

const fs = require('fs');
const assert = require('assert');

const db = fs.readFileSync('engine/lib/db.js', 'utf8');
const backend = fs.readFileSync('engine/backend.js', 'utf8');
const app = fs.readFileSync('resources/js/app.js', 'utf8');
const planner = fs.readFileSync('resources/js/planner.js', 'utf8');
const html = fs.readFileSync('resources/index.html', 'utf8');
const css = fs.readFileSync('resources/css/app.css', 'utf8');
const fr = JSON.parse(fs.readFileSync('resources/locales/fr.json', 'utf8'));
const en = JSON.parse(fs.readFileSync('resources/locales/en.json', 'utf8'));

assert(db.includes('CREATE TABLE IF NOT EXISTS calendar_categories'));
assert(db.includes("ensureColumn('calendar_events', 'category_id'"));
assert(db.includes('function listCalendarCategories'));
assert(db.includes('function saveCalendarCategory'));
assert(db.includes('function reorderCalendarCategories'));
assert(db.includes('function removeCalendarCategory'));
assert(db.includes('function ensureDefaultCalendarCategories'));
assert(db.includes('category_id=?, updated_at=?'));
assert(db.includes('LEFT JOIN calendar_categories cc ON cc.id = ce.category_id'));

for (const method of [
  "'calendar.categories.list'",
  "'calendar.categories.save'",
  "'calendar.categories.reorder'",
  "'calendar.categories.remove'",
]) assert(backend.includes(method));

for (const id of [
  'calendar-category-name', 'calendar-category-color', 'calendar-category-icon',
  'btn-calendar-category-save', 'btn-calendar-category-cancel',
  'calendar-category-list', 'planner-category',
]) assert(html.includes(`id="${id}"`), `ID manquant: ${id}`);

assert(app.includes('function refreshCalendarCategorySettings()'));
assert(app.includes('function saveCalendarCategorySettings()'));
assert(app.includes("rpc('calendar.categories.reorder'"));
assert(app.includes("rpc('calendar.categories.remove'"));

assert(planner.includes('categories: []'));
assert(planner.includes('function populateCategorySelect'));
assert(planner.includes('async function loadCategories()'));
assert(planner.includes('categoryId: Number(document.getElementById'));
assert(planner.includes('event?.categoryColor'));
assert(planner.includes('eventCategoryIcon(event)'));
assert(planner.includes("event === 'calendar.categories.changed'"));

assert(css.includes('LibraMail 0.5.0 - catégories du Planning'));
assert(css.includes('.calendar-category-row'));
assert(css.includes('.planner-event-category-icon'));

for (const locale of [fr, en]) {
  for (const key of [
    'calendarCategory.settingsTitle', 'calendarCategory.category',
    'calendarCategory.none', 'calendarCategory.name', 'calendarCategory.icon',
    'calendarCategory.add', 'calendarCategory.removeConfirm',
  ]) assert(locale[key], `traduction absente: ${key}`);
}


assert(html.includes('id="calendar-category-icon-picker"'));
assert(html.includes('id="btn-calendar-category-icon-picker"'));
assert(html.includes('id="calendar-category-icon-popover"'));
assert(html.includes('id="calendar-category-icon-preview"'));
assert((html.match(/data-category-icon-choice="/g) || []).length >= 30);
for (const icon of ['fa-laptop', 'fa-users', 'fa-stethoscope', 'fa-dumbbell',
  'fa-music', 'fa-cart-shopping', 'fa-train', 'fa-wallet', 'fa-paw',
  'fa-phone', 'fa-video', 'fa-calendar-check']) {
  assert(html.includes(`data-category-icon-choice="${icon}"`), `icône absente: ${icon}`);
  assert(db.includes(`'${icon}'`), `icône backend absente: ${icon}`);
}
assert(app.includes('function selectCalendarCategoryIcon'));
assert(app.includes('function wireCalendarCategoryIconPicker'));
assert(app.includes('function setCalendarCategoryIconPopover'));
assert(css.includes('palette visuelle des icônes de catégories'));
assert(css.includes('.calendar-category-icon-popover'));
assert(css.includes('.calendar-category-icon-trigger'));

console.log('[LibraMail] Test catégories Planning 0.5.0 : OK');
