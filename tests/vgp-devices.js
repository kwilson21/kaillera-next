// Shared device list for VGP design-mode and Playwright device test.
// Single source of truth — both tools import from here.

export const SAFARI_PHONE = 80;
export const CHROME_PHONE = 56;
export const SAFARI_TABLET = 50;
export const CHROME_TABLET = 40;

// [name, chrome_reduction, category]
// "name" must match a Playwright devices[] key, except custom entries
// which provide their own viewport in a 4th element: [name, chrome, cat, {width, height}]
export const TEST_DEVICES = [
  // iPhones
  ['iPhone SE', SAFARI_PHONE, 'phone'],
  ['iPhone SE (3rd gen)', SAFARI_PHONE, 'phone'],
  ['iPhone 8', SAFARI_PHONE, 'phone'],
  ['iPhone X', SAFARI_PHONE, 'phone'],
  ['iPhone 12 Mini', SAFARI_PHONE, 'phone'],
  ['iPhone 12', SAFARI_PHONE, 'phone'],
  ['iPhone 12 Pro Max', SAFARI_PHONE, 'phone'],
  ['iPhone 13 Mini', SAFARI_PHONE, 'phone'],
  ['iPhone 13', SAFARI_PHONE, 'phone'],
  ['iPhone 13 Pro Max', SAFARI_PHONE, 'phone'],
  ['iPhone 14', SAFARI_PHONE, 'phone'],
  ['iPhone 14 Plus', SAFARI_PHONE, 'phone'],
  ['iPhone 14 Pro Max', SAFARI_PHONE, 'phone'],
  ['iPhone 15', SAFARI_PHONE, 'phone'],
  ['iPhone 15 Plus', SAFARI_PHONE, 'phone'],
  ['iPhone 15 Pro Max', SAFARI_PHONE, 'phone'],
  ['iPhone 16+', SAFARI_PHONE, 'phone', { width: 430, height: 932 }],
  // Android phones
  ['Pixel 5', CHROME_PHONE, 'phone'],
  ['Pixel 7', CHROME_PHONE, 'phone'],
  ['Galaxy S8', CHROME_PHONE, 'phone'],
  ['Galaxy S9+', CHROME_PHONE, 'phone'],
  ['Galaxy S24', CHROME_PHONE, 'phone'],
  ['Galaxy A55', CHROME_PHONE, 'phone'],
  ['Moto G4', CHROME_PHONE, 'phone'],
  // Tablets
  ['iPad Mini', SAFARI_TABLET, 'tablet'],
  ['iPad (gen 7)', SAFARI_TABLET, 'tablet'],
  ['iPad Pro 11', SAFARI_TABLET, 'tablet'],
  ['Galaxy Tab S4', CHROME_TABLET, 'tablet'],
  ['Galaxy Tab S9', CHROME_TABLET, 'tablet'],
  ['Nexus 10', CHROME_TABLET, 'tablet'],
];
