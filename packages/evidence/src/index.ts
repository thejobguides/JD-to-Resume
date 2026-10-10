export * from './numbers';
export * from './dates';
export * from './claims';
export * from './gates';

/** True when every violation is soft (then a G7 "entailed" verdict is enough to pass). */
export function onlySoft(violations: Array<{ soft?: boolean }>): boolean {
  return violations.length > 0 && violations.every((v) => v.soft);
}
